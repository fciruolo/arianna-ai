/**
 * The catalog of agents in Impostazioni → Catalogo agenti (D-079): the shapes
 * the core gives (agents-catalog.ts) and the texts of the section. A role is
 * public text of third parties: the page shows it, and it becomes an agent
 * only through a disabled card the user confirms (in «+ Nuovo agente»).
 */
import { ApiError } from './api.ts';
import { dayText, jobErrorText as designJobErrorText, type CatalogJob, type KindChanges } from './design-catalog.ts';
import { errorText } from './italian.ts';

export interface AgentVersion {
  commit: string;
  committedAt: string | null;
  fetchedAt: string;
  roles: number;
  divisions: number;
  rejected: number;
  bytes: number;
}

export interface AgentSource {
  /** `owner/repo`. */
  id: string;
  page: string;
  /** null until the first download: nothing is known of the license yet. */
  license: { name: string | null; file: string | null } | null;
  adopted: (AgentVersion & { adoptedAt: string | null }) | null;
  pending: (AgentVersion & { diff: KindChanges }) | null;
  job: CatalogJob | null;
  /** Waiting for its download behind another one. */
  queued: boolean;
  /** Why it left the queue without downloading. */
  queueError: string | null;
}

export interface AgentsStatus {
  sources: AgentSource[];
  suggestions: { id: string; page: string }[];
  ignored: { entry: string; reason: string }[];
  limits: { sources: number; maxSources: number; bytes: number; maxBytes: number };
}

export interface AgentRoleSummary {
  /** `owner/repo/slug`. */
  id: string;
  source: string;
  slug: string;
  division: string;
  name: string;
  description: string;
  emoji: string | null;
  license: string | null;
  /** The license file at the root of its source; null with none. */
  licenseFile: string | null;
}

export interface AgentRoleListing {
  roles: AgentRoleSummary[];
}

export interface AgentRoleText {
  id: string;
  source: string;
  page: string;
  commit: string;
  path: string;
  sha256: string;
  division: string;
  name: string;
  description: string;
  emoji: string | null;
  license: string | null;
  licenseFile: string | null;
  text: string;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The button of a source: "Scarica" the first time, then "Aggiorna"; what runs or waits. */
export function agentSourceButtonText(source: AgentSource): string {
  if (source.job?.status === 'running') return source.job.phase === 'index' ? 'Leggo i ruoli…' : 'Scarico…';
  if (source.queued) return 'In coda…';
  return source.adopted === null ? 'Scarica' : 'Aggiorna';
}

/** Why the button of a source cannot be pressed now; undefined: it can. */
export function agentSourceBlocked(source: AgentSource): string | undefined {
  if (source.job?.status === 'running') return 'Un download è già in corso';
  if (source.queued) return 'Aspetta in coda: si scarica una sorgente alla volta';
  if (source.pending !== null) return 'Prima usa o scarta la versione scaricata';
  return undefined;
}

/** The status is read again every 1.5 s while a download runs or waits in the queue. */
export function shouldPollAgents(status: AgentsStatus | null): boolean {
  return status?.sources.some((source) => source.job?.status === 'running' || source.queued) ?? false;
}

/** "+12 ruoli, 3 modificati, 1 tolto". */
export function roleChangesText(changes: KindChanges): string {
  return `+${plural(changes.added, 'ruolo', 'ruoli')}, ${plural(changes.changed, 'modificato', 'modificati')}, ${plural(changes.removed, 'tolto', 'tolti')}`;
}

/** The license of a source as the page says it; `warn` when there is none at the root. */
export function agentLicenseText(source: AgentSource): { text: string; warn: boolean } {
  if (source.license === null) return { text: 'licenza: si saprà al primo download', warn: false };
  if (source.license.name !== null) return { text: `licenza ${source.license.name}`, warn: false };
  if (source.license.file !== null) return { text: `licenza in ${source.license.file}`, warn: false };
  return { text: 'nessuna licenza alla radice: prima di usarne un ruolo te lo chiederà', warn: true };
}

/** One line under a source: roles, divisions and the date of the version in use; never a commit. */
export function agentSourceSummaryText(source: AgentSource): string {
  if (source.adopted === null) return 'non ancora scaricata';
  const day = dayText(source.adopted.committedAt);
  return `${rolesText(source.adopted.roles, source.adopted.divisions)}${day === null ? '' : ` · versione del ${day}`}`;
}

/** "1 raccolta su 100 · spazio 12,4 MiB su 512 MiB". */
export function limitsText(limits: AgentsStatus['limits']): string {
  return `${plural(limits.sources, 'raccolta', 'raccolte')} su ${String(limits.maxSources)} · spazio ${spaceText(limits.bytes, limits.maxBytes)}`;
}

/** "1 ruolo in 1 divisione", "259 ruoli in 16 divisioni". */
export function rolesText(roles: number, divisions: number): string {
  return `${plural(roles, 'ruolo', 'ruoli')} in ${plural(divisions, 'divisione', 'divisioni')}`;
}

/** The license of one role: its source's by name, else its file, else none at the root. */
export function roleLicenseText(role: Pick<AgentRoleSummary, 'license' | 'licenseFile'>): string {
  if (role.license !== null) return `licenza ${role.license}`;
  if (role.licenseFile !== null) return `licenza in ${role.licenseFile} della raccolta`;
  return 'senza licenza alla radice della raccolta';
}

/** The starting point of a role, as the core gives it (`agencyPreset`): code for engineering and testing, answer otherwise. */
export function catalogPresetOf(division: string): 'code' | 'answer' {
  return division === 'engineering' || division === 'testing' ? 'code' : 'answer';
}

/** The name a card of a role starts with: its slug within the 40 characters of a name; the core numbers it when taken. */
export function roleCardName(slug: string): string {
  return slug.slice(0, 40).replace(/-+$/, '');
}

/** No license at the root of the role's source: the page asks before creating the card. */
export function roleUnlicensed(role: Pick<AgentRoleSummary, 'license' | 'licenseFile'>): boolean {
  return role.license === null && role.licenseFile === null;
}

/** "12,4 MiB su 512 MiB". */
export function spaceText(bytes: number, maxBytes: number): string {
  const mib = (value: number): string => (value / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 });
  return `${mib(bytes)} MiB su ${mib(maxBytes)} MiB`;
}

/** The roles whose name, description, division or source holds every word of the query. */
export function filterRoles(roles: readonly AgentRoleSummary[], query: string, division = '', source = ''): AgentRoleSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  return roles.filter((role) => {
    if (division !== '' && role.division !== division) return false;
    if (source !== '' && role.source !== source) return false;
    const text = `${role.name} ${role.slug} ${role.description} ${role.division}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The divisions of a list of roles with how many each, most first. */
export function divisionCounts(roles: readonly AgentRoleSummary[]): { division: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role.division, (counts.get(role.division) ?? 0) + 1);
  return [...counts.entries()].map(([division, count]) => ({ division, count })).sort((a, b) => b.count - a.count || a.division.localeCompare(b.division));
}

const REFUSALS: [RegExp, string][] = [
  [/^the address must be/, 'Solo https://github.com/<proprietario>/<repository>.'],
  [/^this source is already followed/, 'Questa sorgente c’è già.'],
  [/^at most \d+ sources/, 'Hai raggiunto il numero massimo di sorgenti (100).'],
  [/^no such source of agents/, 'Questa sorgente non è più seguita: ricarica la pagina.'],
  [/^the list of sources is being changed/, 'L’elenco delle sorgenti è occupato da un altro processo (per esempio pnpm agents:catalog): riprova.'],
  [/^this source already waits/, 'Questa sorgente è già in coda.'],
  [/^a download of the catalog is already running/, 'Un download di questa sorgente è già in corso.'],
  [/^a download of the catalog is running/, 'Aspetta la fine del download in corso.'],
  [/^Il catalogo è occupato da un altro processo/, 'La sorgente è occupata da un altro processo (per esempio pnpm agents:catalog): riprova quando ha finito.'],
  [/^Prima usa o scarta la versione scaricata/, 'Prima usa o scarta la versione scaricata.'],
  [/^no new version is waiting/, 'Nessuna versione nuova in attesa: ricarica la pagina.'],
  [/^the version waiting is not the one shown/, 'La versione in attesa è cambiata: ricarica la pagina e rivedi il riepilogo.'],
  [/^this source has not been downloaded/, 'La sorgente non è ancora stata scaricata.'],
  [/^no such role in the catalog/, 'Il ruolo non è nella versione in uso della sua sorgente.'],
  [/^the role changed on the disk|^the license of the source changed/, 'Un file della sorgente è cambiato sul disco dopo l’indice: aggiorna la sorgente.'],
  [/^the role is no longer on the disk/, 'Il file del ruolo non c’è più: aggiorna la sorgente.'],
];

/** A failed download, as the job says it. */
export function agentJobErrorText(error: string | null): string {
  if (error !== null && /^the catalog of agents would take/.test(error)) return 'Con questa versione il catalogo agenti supererebbe lo spazio massimo: la versione nuova non è stata tenuta. Togli qualche sorgente e riprova.';
  return designJobErrorText(error);
}

export function agentsErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    for (const [pattern, text] of REFUSALS) if (pattern.test(cause.message)) return text;
    if (cause.status === 404 && cause.message === 'not found') return 'Questa versione di Arianna non ha il catalogo agenti: riavviala dopo l’aggiornamento.';
  }
  return errorText(cause);
}
