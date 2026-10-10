/**
 * The catalog of skills in Impostazioni → Agenti (D-161): the shapes the
 * core gives (skills-catalog.ts) and the texts of the section and of the tab
 * "Skill" of an agent. Skills are public text of third parties: the page
 * shows them, an agent reads them as data, never as an instruction.
 */
import { ApiError } from './api.ts';
import { jobErrorText as designJobErrorText, type CatalogJob, type KindChanges } from './design-catalog.ts';
import { errorText } from './italian.ts';

export interface SkillVersion {
  commit: string;
  committedAt: string | null;
  fetchedAt: string;
  skills: number;
  rejected: number;
}

export interface SkillSource {
  /** `owner/repo`. */
  id: string;
  page: string;
  /** Open Design: listed here, updated in its own section. */
  readOnly: boolean;
  license: { name: string | null; file: string | null } | null;
  adopted: (SkillVersion & { adoptedAt: string | null }) | null;
  pending: (SkillVersion & { diff: KindChanges }) | null;
  job: CatalogJob | null;
}

export interface SkillsStatus {
  sources: SkillSource[];
  suggestions: { id: string; page: string }[];
}

export interface SkillSummary {
  /** `owner/repo/slug`. */
  id: string;
  source: string;
  slug: string;
  name: string;
  description: string;
  license: string | null;
  /** Scripts and resources of the skill in its repository: never downloaded; null when not known. */
  otherFiles: number | null;
}

export interface SkillListing {
  skills: SkillSummary[];
}

export interface SkillText {
  id: string;
  name: string;
  source: string;
  commit: string;
  license: string | null;
  notice: string;
  text: string;
}

/** `https://github.com/<owner>/<repo>`, as the core accepts it (a final `/` or `.git` is dropped there). */
export const SOURCE_URL = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}(?:\.git)?\/?$/;

/** Why the address cannot be added; undefined: it can. */
export function sourceUrlProblem(value: string): string | undefined {
  const url = value.trim();
  if (url === '') return 'Scrivi l’indirizzo di un repository GitHub';
  if (!SOURCE_URL.test(url)) return 'Solo https://github.com/<proprietario>/<repository>, senza altre parti';
  return undefined;
}

/** The button of a source: "Scarica" the first time, then "Aggiorna". */
export function sourceButtonText(source: SkillSource): string {
  if (source.job?.status === 'running') return source.job.phase === 'index' ? 'Leggo le skill…' : 'Scarico…';
  return source.adopted === null ? 'Scarica' : 'Aggiorna';
}

/** Why the button of a source cannot be pressed now; undefined: it can. */
export function sourceBlocked(source: SkillSource): string | undefined {
  if (source.readOnly) return 'Si aggiorna dalla sezione Stili di Open Design';
  if (source.job?.status === 'running') return 'Un download è già in corso';
  if (source.pending !== null) return 'Prima usa o scarta la versione scaricata';
  return undefined;
}

/** The status is read again every 1.5 s while a download of any source runs. */
export function shouldPollSkills(status: SkillsStatus | null): boolean {
  return status?.sources.some((source) => source.job?.status === 'running') ?? false;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** "3 nuove, 1 cambiata, 0 tolte". */
export function skillChangesText(changes: KindChanges): string {
  return `${plural(changes.added, 'nuova', 'nuove')}, ${plural(changes.changed, 'cambiata', 'cambiate')}, ${plural(changes.removed, 'tolta', 'tolte')}`;
}

/** The license of a source as the page says it. */
export function sourceLicenseText(source: SkillSource): string {
  if (source.license === null) return 'licenza: si vede dopo il download';
  if (source.license.name !== null) return `licenza ${source.license.name}`;
  if (source.license.file !== null) return `licenza in ${source.license.file}`;
  return 'nessuna licenza alla radice: vale quella di ciascuna skill';
}

/** The license of one skill as the page says it: "see X" of the core in Italian. */
export function skillLicenseText(license: string | null): string {
  if (license === null) return 'nessuna licenza dichiarata: i diritti restano agli autori';
  return license.replace(/^see /, 'vedi ');
}

/** "2 file non scaricati" for the scripts and resources a skill has in its repository. */
export function otherFilesText(count: number | null): string | undefined {
  if (count === null || count === 0) return undefined;
  return `${plural(count, 'altro file', 'altri file')} nel repository (script o risorse): mai scaricati né eseguiti`;
}

/** The skills whose name, id, description or license holds every word of the query. */
export function filterSkills(skills: readonly SkillSummary[], query: string): SkillSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...skills];
  return skills.filter((skill) => {
    const text = `${skill.name} ${skill.id} ${skill.description} ${skill.license ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The assigned list after adding `id` (at the end, once) or removing it. */
export function withSkill(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [...list] : [...list, id];
}

export function withoutSkill(list: readonly string[], id: string): string[] {
  return list.filter((item) => item !== id);
}

/** Why an agent takes no skills, from the core's reason (D-161); undefined when it may. */
export function skillRefusalText(reason: string | null | undefined): string | undefined {
  if (reason === null) return undefined;
  if (reason === undefined) return 'Il nucleo non conosce questo agente: le skill non si possono assegnare.';
  if (/^Arianna/.test(reason)) return 'Arianna non riceve skill: il testo di terzi non diventa mai un’istruzione per lei. Assegnale agli agenti a cui delega.';
  if (/untrusted_content/.test(reason)) return 'La scheda di questo agente non legge testo non fidato (untrusted_content chiuso): non riceve skill.';
  return `Questo agente non riceve skill: ${reason}`;
}

const REFUSALS: [RegExp, string][] = [
  [/^the address must be/, 'Solo https://github.com/<proprietario>/<repository>.'],
  [/^this source is already followed/, 'Questa sorgente c’è già.'],
  [/^Open Design is already a source/, 'Open Design è già una sorgente: le sue skill arrivano con il catalogo degli stili.'],
  [/^the skills of Open Design are updated/, 'Le skill di Open Design si aggiornano dalla sezione Stili di Open Design.'],
  [/^at most \d+ sources/, 'Hai raggiunto il numero massimo di sorgenti.'],
  [/^no such source of skills/, 'Questa sorgente non è più seguita: ricarica la pagina.'],
  [/^the list of sources is being changed/, 'L’elenco delle sorgenti è occupato da un altro processo (per esempio pnpm skills:catalog): riprova.'],
  [/^a download of the catalog is already running/, 'Un download di questa sorgente è già in corso.'],
  [/^a download of the catalog is running/, 'Aspetta la fine del download in corso.'],
  [/^Il catalogo è occupato da un altro processo/, 'La sorgente è occupata da un altro processo (per esempio pnpm skills:catalog): riprova quando ha finito.'],
  [/^Prima usa o scarta la versione scaricata/, 'Prima usa o scarta la versione scaricata.'],
  [/^no new version is waiting/, 'Nessuna versione nuova in attesa: ricarica la pagina.'],
  [/^the version waiting is not the one shown/, 'La versione in attesa è cambiata: ricarica la pagina e rivedi il riepilogo.'],
  [/^this source has not been downloaded/, 'La sorgente non è ancora stata scaricata.'],
  [/^no such skill in the catalog/, 'La skill non è nella versione in uso della sua sorgente.'],
  [/^the skill changed on the disk/, 'Il file della skill è cambiato sul disco dopo l’indice: aggiorna la sorgente.'],
  [/^the skill is no longer on the disk/, 'Il file della skill non c’è più: aggiorna la sorgente.'],
  [/^the catalog of Open Design has not been downloaded/, 'Il catalogo di Open Design non è ancora stato scaricato.'],
];

/** A failed download, as the job says it. */
export function skillJobErrorText(error: string | null): string {
  return designJobErrorText(error);
}

export function skillsErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of REFUSALS) if (pattern.test(cause.message)) return text;
    if (cause.status === 404 && cause.message === 'not found') return 'Il nucleo non ha il catalogo di skill: riavvialo dopo l’aggiornamento.';
  }
  return errorText(cause);
}
