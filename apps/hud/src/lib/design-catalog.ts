/**
 * "Stili di Open Design" in Impostazioni → Agenti (D-160): the shapes the
 * core gives (design-catalog.ts) and the texts of the section. The catalog is
 * public text of a third party: the page shows it, never as an instruction.
 */
import { ApiError } from './api.ts';
import { errorText } from './italian.ts';

export interface KindChanges {
  added: number;
  removed: number;
  changed: number;
  addedSlugs: string[];
  removedSlugs: string[];
  changedSlugs: string[];
}

export interface CatalogVersion {
  commit: string;
  committedAt: string | null;
  fetchedAt: string;
  styles: number;
  skills: number;
  rejected: number;
}

export interface CatalogJob {
  status: 'running' | 'done' | 'failed';
  phase: 'download' | 'index' | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'pending' | 'unchanged' | null;
  error: string | null;
}

export interface CatalogStatus {
  repository: string;
  page: string;
  license: { name: string; copyright: string | null; notice: string | null };
  adopted: (CatalogVersion & { adoptedAt: string }) | null;
  pending: (CatalogVersion & { diff: { styles: KindChanges; skills: KindChanges } }) | null;
  job: CatalogJob | null;
}

export interface StyleSummary {
  slug: string;
  name: string;
  description: string;
  category?: string;
}

export interface StyleListing {
  commit: string | null;
  styles: StyleSummary[];
  skills: { slug: string; name: string; description: string }[];
}

export interface StyleText {
  slug: string;
  name: string;
  commit: string;
  notice: string;
  text: string;
}

/** The button: "Scarica catalogo" the first time, then "Aggiorna catalogo". */
export function updateButtonText(status: CatalogStatus | null): string {
  if (status?.job?.status === 'running') return status.job.phase === 'index' ? 'Leggo il catalogo…' : 'Scarico…';
  return status?.adopted === null || status === null ? 'Scarica catalogo' : 'Aggiorna catalogo';
}

/** Why the button cannot be pressed now; undefined: it can. */
export function updateBlocked(status: CatalogStatus | null): string | undefined {
  if (status === null) return 'Leggo lo stato del catalogo…';
  if (status.job?.status === 'running') return 'Un download è già in corso';
  if (status.pending !== null) return 'Prima usa o scarta la versione scaricata';
  return undefined;
}

/** The status is read again every 1.5 s while a download runs. */
export function shouldPoll(status: CatalogStatus | null): boolean {
  return status?.job?.status === 'running';
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** "5 stili nuovi, 2 cambiati, 1 tolto"; "skill" for the skills. */
export function changesText(changes: KindChanges, kind: 'style' | 'skill'): string {
  if (kind === 'style') return `${plural(changes.added, 'stile nuovo', 'stili nuovi')}, ${plural(changes.changed, 'cambiato', 'cambiati')}, ${plural(changes.removed, 'tolto', 'tolti')}`;
  return `${plural(changes.added, 'skill nuova', 'skill nuove')}, ${plural(changes.changed, 'cambiata', 'cambiate')}, ${plural(changes.removed, 'tolta', 'tolte')}`;
}

/** A date of the core as the page shows it: day and time, local. */
export function dateText(iso: string | null): string {
  if (iso === null) return 'data sconosciuta';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'data sconosciuta';
  return date.toLocaleString('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The credit line under the section: where the text comes from and its license. */
export function creditText(status: CatalogStatus): string {
  return `Testi di Open Design (nexu-io/open-design), licenza ${status.license.name}${status.license.copyright === null ? '' : `, ${status.license.copyright}`}. Si leggono come dati: nessun file del catalogo viene eseguito.`;
}

/** The styles whose name, slug, category or description holds the query. */
export function filterStyles(styles: readonly StyleSummary[], query: string): StyleSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...styles];
  return styles.filter((style) => {
    const text = `${style.name} ${style.slug} ${style.category ?? ''} ${style.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

const REFUSALS: [RegExp, string][] = [
  [/^a download of the catalog is already running/, 'Un download del catalogo è già in corso.'],
  [/^a download of the catalog is running/, 'Aspetta la fine del download in corso.'],
  [/^no new version is waiting/, 'Nessuna versione nuova in attesa: ricarica la pagina.'],
  [/^the version waiting is not the one shown/, 'La versione in attesa è cambiata: ricarica la pagina e rivedi il riepilogo.'],
  [/^the catalog of Open Design has not been downloaded/, 'Il catalogo non è ancora stato scaricato.'],
  [/^no such style in the catalog/, 'Lo stile non è nel catalogo in uso.'],
  [/^the style changed on the disk/, 'Il file dello stile è cambiato sul disco dopo l’indice: aggiorna il catalogo.'],
  [/^the style is no longer on the disk/, 'Il file dello stile non c’è più: aggiorna il catalogo.'],
];

/** A failed download, as the job says it. */
export function jobErrorText(error: string | null): string {
  if (error === null) return 'Il download non è riuscito.';
  if (/^the gateway did not let/.test(error)) return 'Il gateway non ha lasciato uscire la richiesta: nulla è stato scaricato.';
  if (/Apache-2\.0/.test(error)) return 'La licenza del repository non è più Apache-2.0: la versione nuova non è stata tenuta.';
  if (/took too long/.test(error)) return 'Il download ha impiegato troppo: riprova più tardi.';
  if (/more than|larger than|deeper than/.test(error)) return 'Il repository è più grande dei limiti del catalogo: la versione nuova non è stata tenuta.';
  if (/^git /.test(error)) return `Il download con git non è riuscito (rete o repository): ${error.replace(/^git \S+: /, '')}`;
  return `Il download non è riuscito: ${error}`;
}

export function catalogErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of REFUSALS) if (pattern.test(cause.message)) return text;
    if (cause.status === 404 && cause.message === 'not found') return 'Il nucleo non ha il catalogo di Open Design: riavvialo dopo l’aggiornamento.';
  }
  return errorText(cause);
}
