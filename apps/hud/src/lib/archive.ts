import type { Label } from './types.ts';

/**
 * "Da archiviare" in Pensieri (D-195): the proposals of the Archivist (the
 * local model) of where each organized thought goes in kb/, which the user
 * approves, corrects or discards. Nothing moves without a click.
 */

export interface ArchiveFolder {
  /** kb/private/casa */
  path: string;
  label: Label;
}

export interface ArchiveLink {
  path: string;
  title: string;
}

export interface ArchiveItem {
  name: string;
  path: string;
  noteTitle: string | null;
  label: Label;
  capturedAt: string | null;
  /** The version of the note as listed: approving and discarding give it back. */
  version: string;
  state: 'proposed' | 'expired';
  folder: string;
  title: string;
  links: ArchiveLink[];
  reason: string;
  at: string | null;
}

export interface ArchiveListing {
  proposals: ArchiveItem[];
  folders: ArchiveFolder[];
}

/** What the user changed in a proposal before approving it. */
export interface ArchiveEdit {
  folder: string;
  title: string;
  /** The paths of the links kept. */
  links: string[];
}

export interface ApproveItem {
  name: string;
  version: string;
  folder?: string;
  title?: string;
  links?: string[];
}

export type ApproveResult = { name: string; ok: true; path: string; relinked: number } | { name: string; ok: false; code: string; message: string };

/** kb/private/casa → private/casa: the folder as the page shows it. */
export function folderText(path: string): string {
  return path.startsWith('kb/') ? path.slice(3) : path;
}

/** The edit a proposal starts with: what the model proposed. */
export function editOf(item: ArchiveItem): ArchiveEdit {
  return { folder: item.folder, title: item.title, links: item.links.map((link) => link.path) };
}

/** True when the user changed something of the proposal. */
export function isCorrected(item: ArchiveItem, edit: ArchiveEdit): boolean {
  return edit.folder !== item.folder || edit.title.trim() !== item.title || edit.links.length !== item.links.length;
}

/** The request for one note: only the fields the user changed, the version always. */
export function approveItemOf(item: ArchiveItem, edit: ArchiveEdit): ApproveItem {
  const title = edit.title.trim();
  return {
    name: item.name,
    version: item.version,
    ...(edit.folder === item.folder ? {} : { folder: edit.folder }),
    ...(title === item.title ? {} : { title }),
    ...(edit.links.length === item.links.length ? {} : { links: edit.links }),
  };
}

export const MAX_ARCHIVE_TITLE = 80;

/** Why a title cannot be used, or undefined when it can. */
export function titleProblem(title: string): string | undefined {
  const clean = title.trim();
  if (clean === '') return 'Scrivi un titolo.';
  if (clean.length > MAX_ARCHIVE_TITLE) return `Al massimo ${String(MAX_ARCHIVE_TITLE)} caratteri.`;
  return undefined;
}

/** The refusals of the core, in Italian (codes of archivist.ts). */
export const ARCHIVE_ERROR_TEXT: Record<string, string> = {
  changed: 'Il pensiero è cambiato da quando l’hai visto: aggiorna la pagina.',
  expired: 'Il pensiero è cambiato dopo la proposta: chiedine una nuova.',
  'no-proposal': 'Questo pensiero non ha più una proposta.',
  folder: 'Quella cartella non c’è più, o un pensiero non può andarci.',
  exists: 'In quella cartella c’è già una nota con lo stesso nome.',
  label: 'Il pensiero non può andare lì con la sua etichetta.',
  invalid: 'La correzione non è valida.',
  'not-found': 'Il pensiero non c’è più.',
  unavailable: 'Non riesco a scrivere nella cartella adesso.',
};

export function archiveErrorText(code: string): string {
  return ARCHIVE_ERROR_TEXT[code] ?? 'Non sono riuscita a spostarlo.';
}

/** "Spostato in private/casa" and, when it happened, the links rewritten elsewhere. */
export function movedText(result: Extract<ApproveResult, { ok: true }>): string {
  const folder = folderText(result.path.split('/').slice(0, -1).join('/'));
  const relinked = result.relinked === 0 ? '' : result.relinked === 1 ? ' Collegamenti aggiornati in 1 nota.' : ` Collegamenti aggiornati in ${String(result.relinked)} note.`;
  return `Spostato in ${folder}.${relinked}`;
}
