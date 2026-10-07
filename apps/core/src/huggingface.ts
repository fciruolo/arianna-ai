import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  HUB_REVISION,
  HUB_URL,
  hubFileUrl,
  isHubRepo,
  loadCatalog,
  loadUserCatalog,
  MODEL_ROLES,
  writeUserCatalog,
  type CatalogEntry,
  type ModelFile,
  type ModelRole,
} from '@arianna/config';
import { createContext, spendAllowed, type Context, type Decision, type Labeled, type Target } from '@arianna/policy';

import { HubError, type HubClient } from './hub-http.ts';
import { TRASH_DIR } from './model-actions.ts';
import { MODELS_DIR } from './model-files.ts';

/**
 * Hugging Face from the "Modelli" page (I-10, D-139): search the public
 * models in MLX format, read the card of one (files, sizes, sha256 of the
 * weights from the API), add it to the user catalog
 * (config/models.user-catalog.yaml) as `experimental` and without a role,
 * promote it to the roles the user picks, take it out of the catalog.
 *
 * What leaves the machine: the text typed in the search field, or the id of
 * a repository the user chose, and nothing else. Each passes the gateway as
 * L0 towards the web target and is logged in gateway_log before the request
 * (without the text: bytes and sha256 only). No token, no login: gated and
 * private repositories are refused. The weights are downloaded later by the
 * actions of the page (model-actions.ts), from the addresses of the catalog.
 */

export type HubGateway = (payload: readonly Labeled<unknown>[], context: Context, target: Target, meta: { summary?: string }) => Promise<Decision>;

/** One model of a search: everything is public and L0. */
export interface HubSearchResult {
  repo: string;
  downloads: number | null;
  likes: number | null;
  license: string | null;
  /** The task of the model on Hugging Face (`text-generation`...). */
  pipeline: string | null;
  /** The id of the entry when the repository is already in the catalog. */
  inCatalog: string | null;
}

/**
 * Why a file of the repository stays out of the catalog. `pickle`: weights in
 * a format that runs code when loaded; `code`: a program of the repository
 * (never run: no `trust_remote_code`); `other-format`: weights for another
 * runtime; `not-needed`: README, images and the like; `unsafe-path`: a path
 * that would leave the folder of the model; `empty`: zero bytes.
 */
export type ExcludedReason = 'pickle' | 'code' | 'other-format' | 'not-needed' | 'unsafe-path' | 'empty';

export interface HubFile {
  path: string;
  sizeBytes: number;
  /** From the API for the files kept by Git LFS (the weights); null for the small ones, computed when the model is added. */
  sha256: string | null;
  lfs: boolean;
  /** The id of the file in the commit (sha1 of git): a small file read when the model is added must match it. */
  blobId: string | null;
  excluded: ExcludedReason | null;
}

/**
 * Why a model cannot be added. `gated`, `private`, `disabled`: the files need
 * a login, which Arianna never does; `not-mlx`: not in the format of the local
 * server; `no-weights`: no `.safetensors` file; `no-sha256`: a weight without
 * its sha256 in the API; `small-files-too-big`, `too-many-files`, `too-big`:
 * over the limits of D-139; `path-clash`: two files that differ only by case,
 * one file on the disk of a Mac.
 */
export type HubProblem = 'gated' | 'private' | 'disabled' | 'not-mlx' | 'no-weights' | 'no-sha256' | 'small-files-too-big' | 'too-many-files' | 'too-big' | 'path-clash';

export interface HubCard {
  repo: string;
  /** The commit the card was read at: the catalog entry is pinned to it. */
  revision: string;
  license: string | null;
  pipeline: string | null;
  /** `model_type` of the configuration (`qwen3`...), the family of the entry. */
  modelType: string | null;
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  files: HubFile[];
  /** The bytes of the files that would go into the catalog. */
  sizeBytes: number;
  /** An estimate from the weights: the catalog needs one, the page says it is an estimate. */
  ramMinGib: number;
  /** The id the entry would take (also the folder in data/models and the name oMLX serves). */
  suggestedId: string;
  /** The roles the task of the model suggests, offered first when promoting it. */
  suggestedRoles: ModelRole[];
  inCatalog: string | null;
  problems: HubProblem[];
}

/** Search: what the user types, one line. */
export const MAX_QUERY_LENGTH = 100;
const SEARCH_LIMIT = 20;
/** The small files (configuration, tokenizer) are read once to compute their sha256. */
const MAX_SMALL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 200;
/** Above this a model does not fit any Mac the installer supports (D-139). */
const MAX_MODEL_BYTES = 512 * 1024 ** 3;
/** RAM estimate: the weights plus a fifth for the context and the runtime. */
const RAM_FACTOR = 1.2;

const KEPT = ['.safetensors', '.json', '.jinja', '.txt', '.model', '.tiktoken'];
const PICKLE = ['.bin', '.pt', '.pth', '.pkl', '.pickle', '.ckpt', '.joblib', '.npy', '.npz'];
const CODE = ['.py', '.pyc', '.sh', '.js', '.ipynb', '.so', '.dylib', '.exe', '.bat'];
const OTHER_FORMATS = ['.gguf', '.onnx', '.h5', '.msgpack', '.ot', '.tflite', '.mlmodel'];

const SHA256 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex -- control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;
const SHA1 = /^[0-9a-f]{40}$/;

/** The roles a task of Hugging Face suggests; the user may pick others. */
export function suggestedRolesOf(pipeline: string | null): ModelRole[] {
  switch (pipeline) {
    case 'text-generation':
    case 'image-text-to-text':
    case 'text2text-generation':
      return ['orchestrator', 'extractor', 'voice'];
    case 'feature-extraction':
    case 'sentence-similarity':
      return ['embedder'];
    case 'automatic-speech-recognition':
      return ['stt'];
    case 'text-to-speech':
    case 'text-to-audio':
      return ['tts'];
    default:
      return [];
  }
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

function unsafePath(path: string): boolean {
  return path === '' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..') || CONTROL.test(path);
}

/** Why a file stays out, or null when it goes into the catalog. */
export function excludedReason(path: string, sizeBytes: number): ExcludedReason | null {
  if (unsafePath(path)) return 'unsafe-path';
  // `.gitattributes` and the like: never part of a model.
  if (path.split('/').some((part) => part.startsWith('.'))) return 'not-needed';
  const extension = extensionOf(path);
  if (PICKLE.includes(extension)) return 'pickle';
  if (CODE.includes(extension)) return 'code';
  if (OTHER_FORMATS.includes(extension)) return 'other-format';
  if (!KEPT.includes(extension) || /(^|\/)readme\./i.test(path)) return 'not-needed';
  if (sizeBytes <= 0) return 'empty';
  return null;
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function countOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
}

function licenseOf(tags: readonly string[], cardData: unknown): string | null {
  const fromCard = typeof cardData === 'object' && cardData !== null ? (cardData as Record<string, unknown>).license : undefined;
  if (typeof fromCard === 'string' && fromCard !== '') return fromCard;
  const tag = tags.find((item) => item.startsWith('license:'));
  return tag === undefined ? null : tag.slice('license:'.length) || null;
}

/** A catalog id from the name of the repository: lowercase, the owner added when the name is taken. */
export function suggestedIdOf(repo: string, taken: ReadonlySet<string>): string {
  const clean = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 100);
  const [owner = '', name = ''] = repo.split('/');
  const free = (id: string): boolean => id !== '' && id !== TRASH_DIR && !taken.has(id);
  const plain = clean(name);
  if (free(plain)) return plain;
  const owned = clean(`${owner}-${name}`);
  if (free(owned)) return owned;
  for (let count = 2; ; count += 1) {
    const numbered = `${owned || 'model'}-${String(count)}`;
    if (free(numbered)) return numbered;
  }
}

/** The id of the catalog entry whose page is this repository. */
function entryOfRepo(models: readonly CatalogEntry[], repo: string): string | null {
  const page = `${HUB_URL}/${repo}`.toLowerCase();
  return models.find((model) => model.source?.toLowerCase() === page)?.id ?? null;
}

/** The git id of a file: what the API calls `blobId`, for the files outside Git LFS. */
export function gitBlobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${String(content.length)}\0`).update(content).digest('hex');
}

/** Reads the answer of `GET /api/models/<repo>?blobs=true` into a card. */
export function cardOf(raw: unknown, repo: string, models: readonly CatalogEntry[]): HubCard {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new HubError('upstream', 'huggingface.co answered with an unexpected card');
  const info = raw as Record<string, unknown>;
  const revision = info.sha;
  if (typeof revision !== 'string' || !HUB_REVISION.test(revision)) throw new HubError('upstream', 'the card has no commit id');
  const tags = tagsOf(info.tags);
  const problems = new Set<HubProblem>();
  if (info.gated !== false && info.gated !== undefined && info.gated !== null) problems.add('gated');
  if (info.private === true) problems.add('private');
  if (info.disabled === true) problems.add('disabled');
  if (info.library_name !== 'mlx' && !tags.includes('mlx')) problems.add('not-mlx');

  const files: HubFile[] = [];
  let smallBytes = 0;
  for (const sibling of Array.isArray(info.siblings) ? (info.siblings as unknown[]) : []) {
    if (typeof sibling !== 'object' || sibling === null) continue;
    const item = sibling as Record<string, unknown>;
    const path = item.rfilename;
    if (typeof path !== 'string') continue;
    const lfsRaw = typeof item.lfs === 'object' && item.lfs !== null ? (item.lfs as Record<string, unknown>) : undefined;
    const lfs = lfsRaw !== undefined;
    const sizeBytes = countOr(lfsRaw?.size) ?? countOr(item.size) ?? 0;
    const sha256 = lfs && typeof lfsRaw.sha256 === 'string' && SHA256.test(lfsRaw.sha256) ? lfsRaw.sha256 : null;
    const excluded = excludedReason(path, sizeBytes);
    const blobId = typeof item.blobId === 'string' && SHA1.test(item.blobId) ? item.blobId : null;
    files.push({ path, sizeBytes, sha256, lfs, blobId, excluded });
    if (excluded !== null) continue;
    if (lfs && sha256 === null) problems.add('no-sha256');
    if (!lfs && blobId === null) problems.add('no-sha256');
    if (!lfs) smallBytes += sizeBytes;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const kept = files.filter((file) => file.excluded === null);
  if (!kept.some((file) => extensionOf(file.path) === '.safetensors')) problems.add('no-weights');
  if (smallBytes > MAX_SMALL_BYTES) problems.add('small-files-too-big');
  if (kept.length > MAX_FILES) problems.add('too-many-files');
  if (new Set(kept.map((file) => file.path.toLowerCase())).size !== kept.length) problems.add('path-clash');
  const sizeBytes = kept.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (sizeBytes > MAX_MODEL_BYTES) problems.add('too-big');
  const config = typeof info.config === 'object' && info.config !== null ? (info.config as Record<string, unknown>) : {};
  const pipeline = stringOr(info.pipeline_tag);
  return {
    repo,
    revision,
    license: licenseOf(tags, info.cardData),
    pipeline,
    modelType: stringOr(config.model_type),
    downloads: countOr(info.downloads),
    likes: countOr(info.likes),
    lastModified: stringOr(info.lastModified),
    files,
    sizeBytes,
    ramMinGib: Math.max(1, Math.ceil((sizeBytes / 1024 ** 3) * RAM_FACTOR)),
    suggestedId: suggestedIdOf(repo, new Set(models.map((model) => model.id))),
    suggestedRoles: suggestedRolesOf(pipeline),
    inCatalog: entryOfRepo(models, repo),
    problems: [...problems],
  };
}

export interface HuggingFaceOptions {
  /** ARIANNA_HOME: the catalogs are read at each request, the user one written there. */
  home: string;
  /** data/: a model with a folder in data/models is never taken out of the catalog. */
  dataDir: string;
  client: HubClient;
  /** passGateway: decides and writes gateway_log before anything leaves. */
  gateway: HubGateway;
  /** The roles of the running configuration. */
  roles: () => Partial<Record<ModelRole, string>>;
  /** A download or verification of the model is running (model-actions.ts). */
  busy: (modelId: string) => boolean;
  /** One L0 event: the kind and the model id with the outcome. */
  onEvent: (kind: string, payload: Record<string, string | number>) => void;
  now?: () => Date;
}

export interface HuggingFace {
  search(query: unknown): Promise<HubSearchResult[]>;
  card(repo: unknown): Promise<HubCard>;
  /** Adds the repository at `revision` to the user catalog; the id of the new entry. */
  add(repo: unknown, revision: unknown): Promise<{ modelId: string }>;
  /** Gives a model of the user catalog the roles it may have (none taken away that `[roles]` uses). */
  promote(modelId: unknown, roles: unknown): { modelId: string; roles: ModelRole[] };
  /** Takes a model out of the user catalog; `confirm` must be its id. */
  forget(modelId: unknown, confirm: unknown): { modelId: string };
}

export function createHuggingFace(options: HuggingFaceOptions): HuggingFace {
  const now = options.now ?? (() => new Date());
  let adding = false;

  /** The texts that leave, after the gateway allowed and logged them. */
  async function pass(texts: string[], summary: string): Promise<readonly string[]> {
    const payload = texts.map((value) => ({ value, label: 'L0' as const, source: 'models-page:huggingface' }));
    const decision = await options.gateway(payload, createContext('L0'), { kind: 'web' }, { summary });
    if (decision.decision !== 'allow') throw new HubError('blocked', `the gateway did not let it out (${decision.rule}): ${decision.reason}`);
    const spent = spendAllowed(decision);
    // What leaves is exactly what was checked: the URL is built from these texts.
    if (spent?.target.kind !== 'web' || spent.texts.length !== texts.length || spent.texts.some((text, index) => text !== texts[index])) throw new HubError('blocked', 'the gateway decision cannot be spent');
    return spent.texts;
  }

  function repoOf(value: unknown): string {
    if (!isHubRepo(value)) throw new HubError('invalid', 'repo must be owner/name of a model of huggingface.co');
    return value;
  }

  function userEntry(modelId: unknown): CatalogEntry {
    const entry = loadUserCatalog(options.home).models.find((model) => model.id === modelId);
    if (entry === undefined) throw new HubError('not-found', 'the model is not among those added from Hugging Face');
    return entry;
  }

  async function readCard(repo: string, revision?: string): Promise<HubCard> {
    const texts = await pass(revision === undefined ? [repo] : [repo, revision], 'huggingface.co: scheda di un modello');
    const [sentRepo = '', sentRevision] = texts;
    const path = sentRevision === undefined ? `/api/models/${sentRepo}?blobs=true` : `/api/models/${sentRepo}/revision/${sentRevision}?blobs=true`;
    return cardOf(await options.client.json(`${HUB_URL}${path}`), repo, loadCatalog(options.home).models);
  }

  return {
    async search(query) {
      if (typeof query !== 'string') throw new HubError('invalid', 'query must be text');
      const text = query.trim();
      if (text === '' || text.length > MAX_QUERY_LENGTH || CONTROL.test(text)) throw new HubError('invalid', `query must be one line of 1-${String(MAX_QUERY_LENGTH)} characters`);
      const [sent = ''] = await pass([text], 'huggingface.co: ricerca di modelli');
      const params = new URLSearchParams({ search: sent, filter: 'mlx', sort: 'downloads', direction: '-1', limit: String(SEARCH_LIMIT) });
      const raw = await options.client.json(`${HUB_URL}/api/models?${params.toString()}`);
      if (!Array.isArray(raw)) throw new HubError('upstream', 'huggingface.co answered with an unexpected list');
      const models = loadCatalog(options.home).models;
      const results: HubSearchResult[] = [];
      for (const item of raw as unknown[]) {
        if (typeof item !== 'object' || item === null) continue;
        const model = item as Record<string, unknown>;
        if (!isHubRepo(model.id) || model.private === true) continue;
        results.push({
          repo: model.id,
          downloads: countOr(model.downloads),
          likes: countOr(model.likes),
          license: licenseOf(tagsOf(model.tags), undefined),
          pipeline: stringOr(model.pipeline_tag),
          inCatalog: entryOfRepo(models, model.id),
        });
        if (results.length === SEARCH_LIMIT) break;
      }
      return results;
    },

    card: async (repo) => readCard(repoOf(repo)),

    async add(repoValue, revisionValue) {
      const repo = repoOf(repoValue);
      if (typeof revisionValue !== 'string' || !HUB_REVISION.test(revisionValue)) throw new HubError('invalid', 'revision must be the commit id of the card');
      if (adding) throw new HubError('conflict', 'another model is being added: wait for it');
      adding = true;
      try {
        // Read again at the commit the user saw: nothing the page sends is trusted but the two ids.
        const card = await readCard(repo, revisionValue);
        if (card.revision !== revisionValue) throw new HubError('conflict', 'huggingface.co answered for another commit');
        if (card.inCatalog !== null) throw new HubError('conflict', `the model is already in the catalog as ${card.inCatalog}`);
        if (card.problems.length > 0) throw new HubError('conflict', `the model cannot be added: ${card.problems.join(', ')}`);
        const files: ModelFile[] = [];
        for (const file of card.files) {
          if (file.excluded !== null) continue;
          const url = hubFileUrl(repo, card.revision, file.path);
          let sha256 = file.sha256;
          if (!file.lfs) {
            // A small file has no sha256 in the API: read it once, check it is the file of the commit, hash it.
            const content = await options.client.bytes(url, file.sizeBytes);
            if (content.length !== file.sizeBytes || gitBlobId(content) !== file.blobId) throw new HubError('upstream', `${file.path} is not the file of the commit`);
            sha256 = createHash('sha256').update(content).digest('hex');
          }
          if (sha256 === null) throw new HubError('upstream', `${file.path} has no sha256`);
          files.push({ path: file.path, url, sizeBytes: file.sizeBytes, sha256 });
        }
        // From here to the write nothing waits: no other write of this process comes in between.
        const taken = new Set(loadCatalog(options.home).models.map((model) => model.id));
        const id = taken.has(card.suggestedId) ? suggestedIdOf(repo, taken) : card.suggestedId;
        const owner = repo.slice(0, repo.indexOf('/'));
        const entry: CatalogEntry = {
          id,
          family: card.modelType ?? 'huggingface',
          runtime: 'mlx',
          ramMinGib: card.ramMinGib,
          roles: [],
          status: 'experimental',
          provider: `${owner} (Hugging Face)`,
          ...(card.license === null ? {} : { license: card.license }),
          notes: `Aggiunto da Hugging Face il ${now().toISOString().slice(0, 10)}, commit ${card.revision.slice(0, 7)}. RAM stimata dal peso dei file.`,
          source: `${HUB_URL}/${repo}`,
          files,
        };
        const user = loadUserCatalog(options.home);
        writeUserCatalog(options.home, { version: 1, models: [...user.models, entry] });
        options.onEvent('model.catalog.added', { modelId: id, repo, outcome: 'ok' });
        return { modelId: id };
      } finally {
        adding = false;
      }
    },

    promote(modelId, rolesValue) {
      const entry = userEntry(modelId);
      if (!Array.isArray(rolesValue) || rolesValue.length === 0 || rolesValue.some((role) => !(MODEL_ROLES as readonly unknown[]).includes(role))) {
        throw new HubError('invalid', `roles must be one or more of ${MODEL_ROLES.join(', ')}`);
      }
      const roles = MODEL_ROLES.filter((role) => (rolesValue as unknown[]).includes(role));
      // A role [roles] gives the model now cannot go: arianna.toml would no longer load.
      const assigned = Object.entries(options.roles()).filter(([, id]) => id === entry.id).map(([role]) => role as ModelRole);
      const lost = assigned.filter((role) => !roles.includes(role));
      if (lost.length > 0) throw new HubError('conflict', `the model has the role ${lost.join(', ')}: give it to another model first`);
      const user = loadUserCatalog(options.home);
      writeUserCatalog(options.home, { version: 1, models: user.models.map((model) => (model.id === entry.id ? { ...model, roles } : model)) });
      options.onEvent('model.catalog.promoted', { modelId: entry.id, roles: roles.join(','), outcome: 'ok' });
      return { modelId: entry.id, roles };
    },

    forget(modelId, confirm) {
      const entry = userEntry(modelId);
      if (confirm !== entry.id) throw new HubError('invalid', 'taking a model out of the catalog needs its id as confirmation');
      const assigned = Object.entries(options.roles()).filter(([, id]) => id === entry.id).map(([role]) => role);
      if (assigned.length > 0) throw new HubError('conflict', `the model has the role ${assigned.join(', ')}: give it to another model first`);
      if (options.busy(entry.id)) throw new HubError('conflict', 'a download or verification of the model is running: stop it first');
      if (existsSync(join(options.dataDir, MODELS_DIR, entry.id))) throw new HubError('conflict', 'the model still has files on the disk: remove them from the disk first');
      const user = loadUserCatalog(options.home);
      writeUserCatalog(options.home, { version: 1, models: user.models.filter((model) => model.id !== entry.id) });
      options.onEvent('model.catalog.removed', { modelId: entry.id, outcome: 'ok' });
      return { modelId: entry.id };
    },
  };
}
