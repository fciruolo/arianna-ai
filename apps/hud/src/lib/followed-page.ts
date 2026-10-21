/**
 * «Seguiti» (D-272): one page for what Arianna follows on GitHub for ideas —
 * projects and accounts (D-202, D-271), the releases of oMLX (D-265), the
 * news of Open Design (D-186) — and, as a list with a link, the sources of
 * the catalogs of skills (D-161) and agents (D-079), which keep being managed
 * in the settings. Pure: the rows of the catalogs come from the statuses the
 * page already reads, with no new request to GitHub.
 */
import type { AgentsStatus } from './agents-catalog.ts';
import { dayText, type CatalogJob } from './design-catalog.ts';
import { settingsPathFor } from './route.ts';
import type { SkillsStatus } from './skills-catalog.ts';

export const FOLLOWED_TITLE = 'Seguiti';
export const FOLLOWED_INTRO =
  'Quello che Arianna segue su GitHub per prendere idee: progetti e account, il server dei modelli, Open Design e i cataloghi. Si legge solo quando lo chiedi tu (oMLX una volta al giorno) ed esce solo il nome del progetto; il codice non cambia da solo.';

/** Where the catalogs are managed: the sections of the settings (D-192). */
export const CATALOG_PLACES = {
  skills: { label: 'Gestisci in Skill e stili', path: settingsPathFor('skill-e-stili'), kind: 'Skill' },
  agents: { label: 'Gestisci in Catalogo agenti', path: settingsPathFor('catalogo-agenti'), kind: 'Agenti' },
} as const;

export const OPEN_DESIGN_PLACE = { label: 'Aggiorna il catalogo in Skill e stili', path: settingsPathFor('skill-e-stili') } as const;

export interface CatalogRow {
  kind: keyof typeof CATALOG_PLACES;
  /** `owner/repo`. */
  id: string;
  page: string;
  /** The version in use, in words. */
  inUse: string;
  /** The version waiting to be chosen, in words; null with none. */
  pending: string | null;
  /** A download running, or the last one failed. */
  job: string | null;
}

function versionWords(version: { committedAt: string | null } | null): string | null {
  if (version === null) return null;
  const day = dayText(version.committedAt);
  return day === null ? 'versione scaricata' : `versione del ${day}`;
}

function jobWords(job: CatalogJob | null, queued = false): string | null {
  if (job?.status === 'running') return 'download in corso';
  if (queued) return 'in coda per il download';
  if (job?.status === 'failed') return 'ultimo download non riuscito';
  return null;
}

function row(kind: CatalogRow['kind'], source: { id: string; page: string; adopted: { committedAt: string | null } | null; pending: { committedAt: string | null } | null; job: CatalogJob | null }, queued = false): CatalogRow {
  const pending = versionWords(source.pending);
  return {
    kind,
    id: source.id,
    page: source.page,
    inUse: source.adopted === null ? 'non ancora scaricata' : `in uso la ${versionWords(source.adopted) ?? ''}`,
    pending: pending === null ? null : `in attesa la ${pending}`,
    job: jobWords(source.job, queued),
  };
}

/**
 * The sources of the two catalogs, skills first. Open Design among the skills
 * is left out: it has its own section on the page. A status that did not load
 * gives no rows.
 */
export function catalogRows(skills: SkillsStatus | null, agents: AgentsStatus | null): CatalogRow[] {
  return [
    ...(skills?.sources ?? []).filter((source) => !source.readOnly).map((source) => row('skills', source)),
    ...(agents?.sources ?? []).map((source) => row('agents', source, source.queued)),
  ];
}
