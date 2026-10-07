/**
 * Hugging Face in Impostazioni → Modelli (I-10, D-139): search the public
 * models in MLX format, read the card of one, add it to the user catalog as
 * experimental and without a role, promote it to the roles the user picks,
 * take it out of the catalog. The rules and texts are here; the page draws
 * them. What leaves the Mac is only the typed search or the chosen
 * repository id, through the gateway of the core.
 */
import { ApiError } from './api.ts';
import { errorText } from './italian.ts';
import { ROLE_NAME, sizeText, type LocalModelView } from './models-page.ts';
import type { ModelRole } from './settings.ts';

export interface HubSearchResult {
  repo: string;
  downloads: number | null;
  likes: number | null;
  license: string | null;
  pipeline: string | null;
  inCatalog: string | null;
}

export type ExcludedReason = 'pickle' | 'code' | 'other-format' | 'not-needed' | 'unsafe-path' | 'empty';
export type HubProblem = 'gated' | 'private' | 'disabled' | 'not-mlx' | 'no-weights' | 'no-sha256' | 'small-files-too-big' | 'too-many-files' | 'too-big' | 'path-clash';

export interface HubFile {
  path: string;
  sizeBytes: number;
  sha256: string | null;
  lfs: boolean;
  blobId: string | null;
  excluded: ExcludedReason | null;
}

/** The card of a repository, as POST /api/models/huggingface/card gives it (huggingface.ts in the core). */
export interface HubCard {
  repo: string;
  revision: string;
  license: string | null;
  pipeline: string | null;
  modelType: string | null;
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  files: HubFile[];
  sizeBytes: number;
  ramMinGib: number;
  suggestedId: string;
  suggestedRoles: ModelRole[];
  inCatalog: string | null;
  problems: HubProblem[];
}

export const MAX_QUERY_LENGTH = 100;

export const PROBLEM_TEXT: Record<HubProblem, string> = {
  gated: 'È ad accesso controllato: serve un account Hugging Face, e Arianna non fa login.',
  private: 'È privato: serve un account, e Arianna non fa login.',
  disabled: 'Hugging Face l’ha disattivato.',
  'not-mlx': 'Non è in formato MLX: il server locale (oMLX) non lo può usare.',
  'no-weights': 'Non ha pesi in formato .safetensors.',
  'no-sha256': 'Hugging Face non dà l’impronta di tutti i file: non si potrebbe verificare.',
  'small-files-too-big': 'I file piccoli (configurazione, tokenizer) superano i 64 MB.',
  'too-many-files': 'Ha più di 200 file.',
  'too-big': 'Pesa più di 512 GB.',
  'path-clash': 'Ha due file con lo stesso nome a meno di maiuscole: sul Mac diventerebbero uno.',
};

export const EXCLUDED_TEXT: Record<ExcludedReason, string> = {
  pickle: 'pesi in un formato che esegue codice (pickle): esclusi',
  code: 'codice del repository: mai eseguito',
  'other-format': 'formato di un altro runtime',
  'not-needed': 'non serve al modello',
  'unsafe-path': 'percorso non sicuro',
  empty: 'vuoto',
};

/** "1,2 mila", "3,4 mln", "56"; a dash when unknown. */
export function countText(count: number | null): string {
  if (count === null) return '—';
  if (count >= 1e6) return `${(count / 1e6).toLocaleString('it-IT', { maximumFractionDigits: 1 })} mln`;
  if (count >= 1e3) return `${(count / 1e3).toLocaleString('it-IT', { maximumFractionDigits: 1 })} mila`;
  return String(count);
}

/** The line under a result: downloads, likes, license and task, the unknown ones left out. */
export function resultLine(result: Pick<HubSearchResult, 'downloads' | 'likes' | 'license' | 'pipeline'>): string {
  const parts = [`${countText(result.downloads)} download`];
  if (result.likes !== null) parts.push(`${countText(result.likes)} like`);
  parts.push(result.license === null ? 'licenza non indicata' : `licenza ${result.license}`);
  if (result.pipeline !== null) parts.push(result.pipeline);
  return parts.join(' · ');
}

/** The query as the core accepts it: one line, 1-100 characters; undefined when it is not. */
export function cleanQuery(query: string): string | undefined {
  const text = query.trim();
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  return text === '' || text.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(text) ? undefined : text;
}

export function keptFiles(card: HubCard): HubFile[] {
  return card.files.filter((file) => file.excluded === null);
}

export function excludedFiles(card: HubCard): HubFile[] {
  return card.files.filter((file) => file.excluded !== null);
}

/** Why the card cannot be added, in Italian; empty when it can. */
export function cardBlockers(card: HubCard): string[] {
  const reasons = card.problems.map((problem) => PROBLEM_TEXT[problem]);
  if (card.inCatalog !== null) reasons.unshift(`È già nel catalogo come ${card.inCatalog}.`);
  return reasons;
}

/** What the confirmation of "Aggiungi al catalogo" says: what is written, what leaves, what comes next. */
export function addLines(card: HubCard): string[] {
  const kept = keptFiles(card);
  const small = kept.filter((file) => !file.lfs);
  return [
    `Scrive ${card.suggestedId} in config/models.user-catalog.yaml (fuori da git), con ${String(kept.length)} file per ${sizeText(Math.max(card.sizeBytes, 1))}, fissati al commit ${card.revision.slice(0, 7)}.`,
    'Entra come sperimentale e senza ruoli: per usarlo lo promuovi a uno o più ruoli dalla sua scheda, poi gli assegni il ruolo e salvi.',
    `Le impronte sha256 dei pesi vengono dall’API di Hugging Face; ${small.length === 0 ? 'non ci sono file piccoli da leggere' : `i ${String(small.length)} file piccoli (configurazione, tokenizer) li leggo ora una volta per calcolarle, controllando che siano quelli del commit`}.`,
    `Esce solo l’id ${card.repo} con il commit, passando dal gateway. I pesi non si scaricano adesso: dopo, con «Scarica».`,
    `RAM minima stimata: ${String(card.ramMinGib)} GiB (dal peso dei file).`,
  ];
}

/** What the confirmation of a promotion says. */
export function promoteLines(view: LocalModelView, roles: readonly ModelRole[]): string[] {
  const names = roles.map((role) => ROLE_NAME[role]).join(', ');
  return [
    `${view.id} potrà avere ${roles.length === 1 ? 'il ruolo' : 'i ruoli'} ${names}: compare nei menu dei ruoli, e l’assegnazione resta una tua scelta da salvare.`,
    'Resta sperimentale: diventa verificato solo dopo le prove (pnpm eval e pnpm eval:models).',
  ];
}

/** Why "Togli dal catalogo" cannot be pressed now; undefined: it can. */
export function forgetBlocked(view: LocalModelView, assigned: readonly ModelRole[]): string | undefined {
  if (assigned.length > 0) return `Ha il ruolo ${assigned.map((role) => ROLE_NAME[role]).join(', ')}: prima assegna il ruolo a un altro modello e salva.`;
  if (view.action?.status === 'running') return 'Prima ferma lo scaricamento o la verifica in corso.';
  if (view.hasFiles) return 'Ha ancora file sul disco: prima «Togli dal disco».';
  return undefined;
}

/** The roles of `[roles]` that cannot be taken away by a new promotion. */
export function lockedRoles(view: LocalModelView, assigned: readonly ModelRole[]): ModelRole[] {
  return assigned.filter((role) => view.suitedRoles.includes(role));
}

const REFUSALS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^the gateway did not let it out \(scanner\)/, () => 'Il gateway l’ha fermata: il testo sembra contenere un dato personale (per esempio un IBAN o un codice fiscale). Non è uscito nulla.'],
  [/^the gateway did not let it out/, () => 'Il gateway non l’ha lasciata uscire: non è uscito nulla.'],
  [/^query must be/, () => `Scrivi da 1 a ${String(MAX_QUERY_LENGTH)} caratteri, su una riga.`],
  [/^repo must be/, () => 'Serve l’id di un modello di Hugging Face, nella forma proprietario/nome.'],
  [/^huggingface\.co cannot be reached|^no answer from huggingface\.co/, () => 'Hugging Face non risponde: controlla la connessione e riprova.'],
  [/^huggingface\.co answered (401|404)/, () => 'Su Hugging Face non c’è, oppure è privato.'],
  [/^huggingface\.co answered (\d+)/, (match) => `Hugging Face ha risposto con un errore (${match[1] ?? ''}): riprova più tardi.`],
  [/^the model is already in the catalog as (\S+)/, (match) => `È già nel catalogo come ${match[1] ?? ''}.`],
  [/^the model cannot be added: (.+)$/, (match) => (match[1] ?? '').split(', ').map((problem) => (PROBLEM_TEXT as Record<string, string | undefined>)[problem] ?? problem).join(' ')],
  [/^another model is being added/, () => 'Sto già aggiungendo un altro modello: aspetta che finisca.'],
  [/^huggingface\.co answered for another commit/, () => 'Il modello è cambiato su Hugging Face da quando hai aperto la scheda: riaprila.'],
  [/ is not the file of the commit$/, () => 'Un file non corrisponde al commit: non ho scritto nulla nel catalogo.'],
  [/^the model has the role (.+): give it to another model first$/, (match) => `Il modello ha il ruolo ${(match[1] ?? '').split(', ').map((role) => (ROLE_NAME as Record<string, string | undefined>)[role] ?? role).join(', ')}: prima assegnalo a un altro modello e salva.`],
  [/^the model still has files on the disk/, () => 'Ha ancora file sul disco: prima «Togli dal disco».'],
  [/^a download or verification of the model is running/, () => 'Prima ferma lo scaricamento o la verifica in corso.'],
  [/^taking a model out of the catalog needs its id/, () => 'Per confermare scrivi l’id esatto del modello.'],
  [/^roles must be/, () => 'Scegli almeno un ruolo.'],
  [/^the model is not among those added from Hugging Face/, () => 'Il modello non è fra quelli aggiunti da Hugging Face.'],
];

export function hubErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of REFUSALS) {
      const match = pattern.exec(cause.message);
      if (match !== null) return text(match);
    }
    if (cause.status === 404) return 'Il nucleo non ha la ricerca su Hugging Face: riavvialo dopo l’aggiornamento.';
  }
  return errorText(cause);
}
