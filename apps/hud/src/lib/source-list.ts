/**
 * The rows of SourceList.vue (D-161, D-079): what the list of GitHub sources
 * of a catalog says about each one, built from the status of the skills or
 * of the agents. Pure, so the texts are tested without the page.
 */
import {
  agentJobErrorText,
  agentLicenseText,
  agentSourceBlocked,
  agentSourceButtonText,
  agentSourceSummaryText,
  roleChangesText,
  rolesText,
  type AgentSource,
} from './agents-catalog.ts';
import { versionText } from './design-catalog.ts';
import { skillChangesText, skillJobErrorText, sourceBlocked, sourceButtonText, sourceSummaryText, type SkillSource } from './skills-catalog.ts';

/** One group of the details of a version waiting: "Nuovi: a, b". */
export interface SourceDetail {
  label: string;
  items: string[];
}

export interface SourceRow {
  /** `owner/repo`. */
  id: string;
  page: string;
  summary: string;
  /** After the summary: the license, in the warning color when there is none. */
  note?: { text: string; warn: boolean };
  /** Absent for a read-only source (Open Design among the skills). */
  button?: { text: string; primary: boolean; blocked?: string };
  /** A download runs: the source cannot be taken away. */
  running: boolean;
  removeText: string;
  readOnlyText?: string;
  /** What runs, waits or ended without news. */
  progress?: { text: string; ok: boolean };
  failure?: string;
  pending: {
    commit: string;
    title: string;
    changes: string;
    warn?: string;
    rejected?: string;
    details: SourceDetail[];
  } | null;
}

function details(diff: { addedSlugs: string[]; changedSlugs: string[]; removedSlugs: string[] }, added: string, changed: string, removed: string, show: boolean): SourceDetail[] {
  if (!show) return [];
  return [
    { label: added, items: diff.addedSlugs },
    { label: changed, items: diff.changedSlugs },
    { label: removed, items: diff.removedSlugs },
  ];
}

export function skillSourceRow(source: SkillSource): SourceRow {
  const running = source.job?.status === 'running';
  const row: SourceRow = {
    id: source.id,
    page: source.page,
    summary: sourceSummaryText(source),
    running,
    removeText: `Togliere ${source.id}? Le sue skill spariscono dal catalogo e dagli agenti a cui sono assegnate.`,
    pending: null,
  };
  if (source.readOnly) row.readOnlyText = 'Le skill di Open Design: si aggiornano con gli stili, in «Stili per il Designer».';
  else {
    const blocked = sourceBlocked(source);
    row.button = { text: sourceButtonText(source), primary: source.adopted === null, ...(blocked === undefined ? {} : { blocked }) };
  }
  if (running) row.progress = { text: source.job?.phase === 'index' ? 'Leggo nomi e descrizioni…' : 'Scarico da GitHub solo i testi delle skill e le licenze…', ok: false };
  else if (source.job?.status === 'done' && source.job.outcome === 'unchanged') row.progress = { text: 'Nessuna novità: la versione in uso è la più recente.', ok: true };
  else if (source.job?.status === 'failed') row.failure = skillJobErrorText(source.job.error);
  if (source.pending !== null) {
    const { diff } = source.pending;
    row.pending = {
      commit: source.pending.commit,
      title: `${source.adopted === null ? 'Scaricata' : 'Versione nuova'}: ${versionText(source.pending.committedAt)}, ${String(source.pending.skills)} skill`,
      changes: skillChangesText(diff),
      ...(source.pending.rejected > 0 ? { rejected: `${String(source.pending.rejected)} file scartati (senza intestazione, troppo grandi, nomi insoliti o collegamenti)` } : {}),
      details: details(diff, 'Nuove', 'Cambiate', 'Tolte', source.adopted !== null && diff.added + diff.changed + diff.removed > 0),
    };
  }
  return row;
}

export function agentSourceRow(source: AgentSource): SourceRow {
  const running = source.job?.status === 'running';
  const blocked = agentSourceBlocked(source);
  const row: SourceRow = {
    id: source.id,
    page: source.page,
    summary: agentSourceSummaryText(source),
    note: agentLicenseText(source),
    button: { text: agentSourceButtonText(source), primary: source.adopted === null, ...(blocked === undefined ? {} : { blocked }) },
    running,
    removeText: `Togliere ${source.id}? I suoi ruoli spariscono dal catalogo; gli agenti già nati da qui restano tuoi, con il testo che hanno.`,
    pending: null,
  };
  if (running) row.progress = { text: source.job?.phase === 'index' ? 'Leggo nomi e descrizioni dei ruoli…' : 'Scarico da GitHub solo i testi dei ruoli e la licenza…', ok: false };
  else if (source.queued) row.progress = { text: 'In coda: si scarica appena finisce il download in corso (una sorgente alla volta).', ok: false };
  else if (source.queueError !== null) row.failure = `Non è partita dalla coda: ${source.queueError}`;
  else if (source.job?.status === 'done' && source.job.outcome === 'unchanged') row.progress = { text: 'Nessuna novità: la versione in uso è la più recente.', ok: true };
  else if (source.job?.status === 'failed') row.failure = agentJobErrorText(source.job.error);
  if (source.pending !== null) {
    const { diff } = source.pending;
    row.pending = {
      commit: source.pending.commit,
      title: `${source.adopted === null ? 'Scaricata' : 'Versione nuova'}: ${versionText(source.pending.committedAt)}, ${rolesText(source.pending.roles, source.pending.divisions)}`,
      changes: roleChangesText(diff),
      ...(source.adopted !== null && diff.changed > 0 ? { warn: 'Gli agenti nati da un ruolo modificato non cambiano: dopo «Usa» potrai riadottarli uno per uno.' } : {}),
      ...(source.pending.rejected > 0 ? { rejected: `${String(source.pending.rejected)} file scartati (documenti senza intestazione, nomi insoliti, troppo grandi o fuori dalle divisioni)` } : {}),
      details: details(diff, 'Nuovi', 'Modificati', 'Tolti', source.adopted !== null && diff.added + diff.changed + diff.removed > 0),
    };
  }
  return row;
}
