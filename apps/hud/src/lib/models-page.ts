/**
 * Impostazioni → Modelli (I-3, D-137, stage M3): every model, local and
 * cloud, in one list with filters and search, the chosen one in a card. The
 * data come from GET /api/models/overview (models-overview.ts in the core),
 * all L0; roles and switches are the same parts of the settings as before
 * (`roles`, `sprites`, `cloudModels`), saved in one write. Pure: the page
 * asks the core and draws, the rules are here.
 */
import { agentName } from './italian.ts';
import type { ModelAction, TrashView } from './model-actions.ts';
import type { ModelEvalStatus } from './model-evals.ts';
import { MODEL_ROLES, ROLE_TEXT, type CloudModelAlias, type CloudModelsForm, type ModelRole } from './settings.ts';

export const STEP_KINDS = ['extract', 'classify', 'summarize', 'plan', 'judge', 'coding', 'review'] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Where a model sits in the ladder of a kind of step: `tier` 0 is tried first. */
export interface ModelUse {
  kind: StepKind;
  tier: number;
  tiers: number;
  /** Taken only when privacy or the agent keep every cloud candidate out. */
  fallback?: true;
}

export type LocalState = 'loaded' | 'on-disk' | 'missing';
export type CloudState = 'on' | 'off' | 'executor-off' | 'not-connected';
export type EvalStatus = ModelEvalStatus;

export interface LastEvalView {
  id: string;
  role: string;
  status: EvalStatus;
  passed: number | null;
  total: number | null;
  latencyMedianMs: number | null;
  requestedAt: string;
  finishedAt: string | null;
  sameWeights: boolean;
}

export interface LocalModelView {
  locality: 'local';
  id: string;
  family: string;
  runtime: string;
  ramMinGib: number;
  status: string;
  sizeBytes: number;
  provider: string | null;
  contextTokens: number | null;
  strengths: string[];
  license: string | null;
  notes: string | null;
  source: string | null;
  suitedRoles: ModelRole[];
  roles: ModelRole[];
  aliases: string[];
  agents: string[];
  uses: ModelUse[];
  present: boolean;
  state: LocalState;
  /** A folder data/models/<id> exists, complete or not. */
  hasFiles: boolean;
  /** Bytes still to download. */
  missingBytes: number;
  /** The download or verification in progress, or the last one (I-3, M4). */
  action: ModelAction | null;
  loaded: { endpoint: string; gib: number | null; busy: boolean }[];
  lastEval: LastEvalView | null;
}

export interface CloudModelName {
  name: string;
  source: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  description?: string;
}

export interface CloudCard {
  alias: CloudModelAlias;
  provider: string;
  family: string;
  executor: string;
  names: CloudModelName[];
  strengths: { text: string; source: string }[];
  apiPrice?: { input: number; output: number; source: string };
  quotaRatio?: { relativeTo: CloudModelAlias; times: number; source: string };
  terms?: string;
  notes?: string;
}

export interface CloudModelView {
  locality: 'cloud';
  alias: CloudModelAlias;
  executor: string;
  card: CloudCard | null;
  enabled: boolean;
  name: string | null;
  executorEnabled: boolean;
  adapter: boolean;
  state: CloudState;
  budgetApproval: boolean;
  agents: string[];
  uses: ModelUse[];
}

export interface CloudSource {
  id: string;
  url: string;
  read: string;
}

export interface MemoryView {
  memoryGib: number;
  budgets: { endpoint: string; gib: number }[];
  estimatedGib: number;
  swap: { level: string; usedGib: number; totalGib: number; pressure: number | null } | null;
}

/** The body of GET /api/models/overview. */
export interface ModelsOverview {
  local: LocalModelView[];
  cloud: CloudModelView[];
  sources: CloudSource[];
  memory: MemoryView | null;
  /** The bin of the removed models; null when the core has no actions. */
  trash: TrashView | null;
  errors: { catalog: string | null; cloudCatalog: string | null; evals: string | null };
}

export type ModelView = LocalModelView | CloudModelView;
export type Tone = 'ok' | 'warn' | 'info' | 'muted' | 'danger';

/** One row of the list. */
export interface ModelEntry {
  /** `local:<id>` or `cloud:<alias>`: unique across both. */
  key: string;
  view: ModelView;
  name: string;
  /** Provider, where it runs and the id or alias. */
  sub: string;
  /** The short provider, for the filter: "Qwen", "Anthropic". */
  provider: string;
  /** Two letters for the badge. */
  badge: string;
  state: { text: string; tone: Tone };
  /** Local: the roles `[roles]` gives it. */
  roles: ModelRole[];
  /** Cloud: the agents that start on it. */
  agents: string[];
  inUse: boolean;
}

export const LOCAL_STATE_TEXT: Record<LocalState, { text: string; tone: Tone }> = {
  loaded: { text: 'in memoria', tone: 'ok' },
  'on-disk': { text: 'sul disco', tone: 'info' },
  missing: { text: 'da scaricare', tone: 'warn' },
};

export const CLOUD_STATE_TEXT: Record<CloudState, { text: string; tone: Tone }> = {
  on: { text: 'acceso', tone: 'ok' },
  off: { text: 'spento', tone: 'muted' },
  'executor-off': { text: 'esecutore spento', tone: 'warn' },
  'not-connected': { text: 'non collegato', tone: 'warn' },
};

export const STEP_TEXT: Record<StepKind, string> = {
  extract: 'Estrazione',
  classify: 'Classificazione',
  summarize: 'Riassunti',
  plan: 'Pianificazione',
  judge: 'Giudizio',
  coding: 'Coding',
  review: 'Revisione',
};

/** The roles of the local models, as the filter and the card call them. */
export const ROLE_NAME = Object.fromEntries(MODEL_ROLES.map((role) => [role, ROLE_TEXT[role].title])) as Record<ModelRole, string>;

/**
 * The reasons the core gives when a catalog or the trials cannot be read
 * (models-overview.ts, in English and without what the file holds), in Italian.
 */
export function overviewErrorText(error: string): string {
  const invalid = /^(config\/[\w.-]+) is not valid(?: at (.+))?$/.exec(error);
  if (invalid !== null) return `${invalid[1] ?? ''} non è valido${invalid[2] === undefined ? '' : ` (in ${invalid[2]})`}: correggilo a mano.`;
  const unreadable = /^(config\/[\w.-]+) cannot be read$/.exec(error);
  if (unreadable !== null) return `${unreadable[1] ?? ''} non si legge.`;
  if (error === 'the trials cannot be read') return 'Le prove non si leggono: il database non risponde.';
  return error;
}

/** The name of a cloud model in the list (the selector of a conversation says "con approvazione" for Fable: here a fact of the card). */
export const CLOUD_NAME: Record<string, string> = {
  sonnet: 'Claude Sonnet',
  opus: 'Claude Opus',
  fable: 'Claude Fable',
  codex: 'Codex (ChatGPT)',
};

/** "Qwen (Alibaba); conversione MLX di mlx-community" → "Qwen": who makes it, without the converter. */
export function providerName(provider: string | null | undefined): string {
  const head = (provider ?? '').split(';')[0]?.split(' (')[0]?.trim() ?? '';
  return head === '' ? 'Sconosciuto' : head;
}

function badgeOf(text: string): string {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '');
  const two = letters.slice(0, 2);
  return two === '' ? '?' : two.charAt(0).toUpperCase() + two.slice(1).toLowerCase();
}

export function entryOf(view: ModelView): ModelEntry {
  if (view.locality === 'local') {
    const provider = providerName(view.provider);
    return {
      key: `local:${view.id}`,
      view,
      name: view.id,
      sub: `${provider} · Mac · ${view.family}`,
      provider,
      badge: badgeOf(provider === 'Sconosciuto' ? view.id : provider),
      state: LOCAL_STATE_TEXT[view.state],
      roles: view.roles,
      agents: view.agents,
      inUse: view.roles.length > 0,
    };
  }
  const provider = view.card?.provider ?? (view.executor === 'claude' ? 'Anthropic' : view.executor === 'codex' ? 'OpenAI' : 'Sconosciuto');
  return {
    key: `cloud:${view.alias}`,
    view,
    name: CLOUD_NAME[view.alias] ?? view.alias,
    sub: `${provider} · cloud · alias ${view.alias}`,
    provider,
    badge: view.alias === 'codex' ? 'Cx' : badgeOf(view.alias),
    state: CLOUD_STATE_TEXT[view.state],
    roles: [],
    agents: view.agents,
    inUse: view.state === 'on',
  };
}

/** Every model, the local ones first (by the catalog's order), then the cloud ones (by the router's). */
export function modelEntries(overview: ModelsOverview | null): ModelEntry[] {
  if (overview === null) return [];
  return [...overview.local.map(entryOf), ...overview.cloud.map(entryOf)];
}

/** The providers of the list, once each, in order of appearance. */
export function providersOf(entries: readonly ModelEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.provider))];
}

/** `use`: '' every one, `role:<role>` a local role, `step:<kind>` a kind of step of the router. */
export interface ModelFilter {
  where: 'all' | 'local' | 'cloud';
  provider: string;
  use: string;
  inUse: boolean;
  query: string;
}

export const EMPTY_FILTER: ModelFilter = { where: 'all', provider: '', use: '', inUse: false, query: '' };

/** The choices of the filter by use: the local roles, then the kinds of step. */
export const USE_CHOICES: readonly { value: string; text: string }[] = [
  ...(Object.keys(ROLE_NAME) as ModelRole[]).map((role) => ({ value: `role:${role}`, text: `Ruolo: ${ROLE_NAME[role]}` })),
  ...STEP_KINDS.map((kind) => ({ value: `step:${kind}`, text: `Passo: ${STEP_TEXT[kind]}` })),
];

function searchText(entry: ModelEntry): string {
  const { view } = entry;
  const parts = [entry.name, entry.sub, entry.provider];
  if (view.locality === 'local') parts.push(view.id, view.family, view.provider ?? '', ...view.aliases);
  else parts.push(view.alias, view.card?.family ?? '', view.name ?? '', ...(view.card?.names.map((item) => item.name) ?? []));
  return parts.join(' ').toLowerCase();
}

function matchesUse(entry: ModelEntry, use: string): boolean {
  if (use === '') return true;
  const [kind, value] = use.split(':');
  if (kind === 'role') return entry.view.locality === 'local' && entry.view.roles.includes(value as ModelRole);
  if (kind === 'step') return entry.view.uses.some((item) => item.kind === value);
  return false;
}

/** The entries that pass every filter; every word of the query must be found. */
export function filterModels(entries: readonly ModelEntry[], filter: ModelFilter): ModelEntry[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '');
  return entries.filter(
    (entry) =>
      (filter.where === 'all' || entry.view.locality === filter.where) &&
      (filter.provider === '' || entry.provider === filter.provider) &&
      (!filter.inUse || entry.inUse) &&
      matchesUse(entry, filter.use) &&
      words.every((word) => searchText(entry).includes(word)),
  );
}

/** "1 modello", "4 modelli". */
export function countText(count: number): string {
  return count === 1 ? '1 modello' : `${String(count)} modelli`;
}

/** The chosen key if it is still in the list, else the first one shown. */
export function chosenKey(entries: readonly ModelEntry[], wanted: string | null): string | null {
  if (wanted !== null && entries.some((entry) => entry.key === wanted)) return wanted;
  return entries[0]?.key ?? null;
}

const ORDINAL = ['primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto'];

/** "Coding: secondo gradino di 3", "Pianificazione: sempre", "Revisione: solo se il cloud non è ammesso". */
export function useText(use: ModelUse): string {
  const step = STEP_TEXT[use.kind];
  if (use.fallback === true) return `${step}: solo quando il cloud non è ammesso (dati riservati o agente locale)`;
  if (use.tiers <= 1) return `${step}: sempre`;
  const ordinal = ORDINAL[use.tier] ?? `${String(use.tier + 1)}°`;
  return `${step}: ${ordinal} gradino di ${String(use.tiers)}`;
}

/** What a model does in Arianna, from its roles, the router's ladders and the agents: never written by hand. */
export function usageLines(view: ModelView): string[] {
  const lines: string[] = [];
  if (view.locality === 'local') {
    for (const role of view.roles) {
      const aliases = view.aliases.length === 0 ? '' : ` (alias ${view.aliases.join(', ')})`;
      lines.push(`Ruolo ${ROLE_NAME[role]}${aliases}`);
    }
  }
  lines.push(...view.uses.map(useText));
  if (view.agents.length > 0) lines.push(`Agenti che partono con questo modello: ${view.agents.map(agentName).join(', ')}`);
  return lines;
}

/** "16,1 GB", "820 MB": decimal, as a download says it. */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('it-IT', { maximumFractionDigits: 1 })} GB`;
  return `${String(Math.max(1, Math.round(bytes / 1e6)))} MB`;
}

/** "1M token", "200k token"; null: not stated by any source. */
export function contextText(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined) return 'non indicato';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toLocaleString('it-IT', { maximumFractionDigits: 1 })}M token`;
  if (tokens >= 1000) return `${String(Math.round(tokens / 1000))}k token`;
  return `${String(tokens)} token`;
}

/** The memory strip: what the core made the local servers load, on their ceiling. */
export function memorySummary(memory: MemoryView | null, local: readonly LocalModelView[]): { value: string; ratio: number; detail: string } | null {
  if (memory === null) return null;
  const budget = memory.budgets.reduce((total, item) => total + item.gib, 0);
  const ceiling = budget > 0 ? budget : memory.memoryGib;
  const loaded = local.filter((model) => model.state === 'loaded').map((model) => model.id);
  const round = (gib: number): string => gib.toLocaleString('it-IT', { maximumFractionDigits: 1 });
  return {
    value: `${round(memory.estimatedGib)} di ${round(ceiling)} GiB`,
    ratio: ceiling > 0 ? Math.min(1, memory.estimatedGib / ceiling) : 0,
    detail: loaded.length === 0 ? 'Nessun modello caricato da Arianna' : `In memoria: ${loaded.join(', ')}`,
  };
}

/** Why a cloud model is not a candidate of the router, with what to do; undefined when it is on. */
export function cloudNotice(view: CloudModelView): string | undefined {
  if (view.state === 'not-connected') {
    return view.executor === 'codex'
      ? 'Non collegato: manca l’adattatore di Codex (task 1.16). Servono anche il binario codex con il tuo accesso ChatGPT, fatto da te nel terminale, e Codex acceso in Esecutori cloud. La scelta qui si salva e vale dopo.'
      : 'Non collegato: il nucleo non ha l’adattatore di Claude su questa installazione.';
  }
  if (view.state === 'executor-off') return `L’esecutore ${view.executor === 'claude' ? 'Claude Code' : view.executor} è spento in Esecutori cloud: finché resta spento il modello non riceve lavori.`;
  if (view.state === 'off') return 'Spento: fuori dal router e dal selettore delle conversazioni.';
  return undefined;
}

/** The fixed rule of privacy for where a model runs. */
export function privacyText(view: ModelView): string {
  return view.locality === 'local'
    ? 'Gira sul Mac: può leggere dati Privati e Riservati; niente esce.'
    : 'Esce verso il cloud: riceve solo dati Pubblici e Interni, sempre attraverso il gateway.';
}

/** The source of a cloud fact, for the line "letta il …". */
export function sourceOf(sources: readonly CloudSource[], id: string): CloudSource | undefined {
  return sources.find((source) => source.id === id);
}

/** The sources a cloud card names, once each. */
export function cardSources(card: CloudCard | null, sources: readonly CloudSource[]): CloudSource[] {
  if (card === null) return [];
  const ids = [...card.names.map((item) => item.source), ...card.strengths.map((item) => item.source), card.apiPrice?.source, card.quotaRatio?.source];
  return [...new Set(ids.filter((id): id is string => id !== undefined))].map((id) => sourceOf(sources, id)).filter((source): source is CloudSource => source !== undefined);
}

/** The exact name the card describes: the one chosen, else the first of the catalog. */
export function shownName(card: CloudCard | null, chosen: string): CloudModelName | undefined {
  if (card === null) return undefined;
  const name = chosen.trim();
  return card.names.find((item) => item.name === name) ?? (name === '' ? card.names[0] : undefined);
}

/** "$2 / $10 per milione di token (entrata / uscita)". */
export function priceText(price: CloudCard['apiPrice']): string | undefined {
  if (price === undefined) return undefined;
  const dollars = (value: number): string => `$${value.toLocaleString('it-IT', { maximumFractionDigits: 2 })}`;
  return `${dollars(price.input)} entrata · ${dollars(price.output)} uscita, per milione di token`;
}

/**
 * The roles after a click on a role of a model's card: it takes the role from
 * whoever had it; clicking the role it already holds leaves the role empty.
 */
export function toggleRole(roles: Partial<Record<ModelRole, string>>, role: ModelRole, id: string): Partial<Record<ModelRole, string>> {
  if (roles[role] !== id) return { ...roles, [role]: id };
  return Object.fromEntries(Object.entries(roles).filter(([key]) => key !== role));
}

/** The keys of the list with edits not saved: both models of a role that changed hands, and the cloud rows changed. */
export function unsavedKeys(
  form: { roles: Partial<Record<ModelRole, string | undefined>>; cloudModels: CloudModelsForm },
  base: { roles: Partial<Record<ModelRole, string | undefined>>; cloudModels: CloudModelsForm },
): Set<string> {
  const keys = new Set<string>();
  const roles = new Set([...Object.keys(form.roles), ...Object.keys(base.roles)]) as Set<ModelRole>;
  for (const role of roles) {
    const now = form.roles[role] ?? undefined;
    const before = base.roles[role] ?? undefined;
    if (now === before) continue;
    if (now !== undefined) keys.add(`local:${now}`);
    if (before !== undefined) keys.add(`local:${before}`);
  }
  for (const row of form.cloudModels.rows) {
    const old = base.cloudModels.rows.find((item) => item.alias === row.alias);
    if (old === undefined || old.enabled !== row.enabled || old.name !== row.name) keys.add(`cloud:${row.alias}`);
  }
  return keys;
}
