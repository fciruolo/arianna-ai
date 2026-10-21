/**
 * The Wiki (D-280): pages of kb/wiki the local model proposes from the
 * user's notes, which the user approves, discards or asks again. A tree of
 * at most three levels (topic › sub-topic › article); each folder has an
 * index `_indice` composed by the core. Pure helpers here, plus the calls.
 */

export interface WikiPageEntry {
  /** Relative to kb/wiki, without `.md`: `laravel/octane/swoole`. */
  path: string;
  title: string;
  updatedAt: string;
}

export interface WikiListing {
  folders: string[];
  pages: WikiPageEntry[];
  proposals: number;
}

export interface WikiVersion {
  id: string;
  at: string;
}

export interface WikiPageView {
  path: string;
  title: string;
  kind: 'page' | 'index';
  body: string;
  version: string;
  updatedAt: string;
  versions: WikiVersion[];
}

export type WikiDiffKind = 'context' | 'added' | 'removed';

export interface WikiDiff {
  added: number;
  removed: number;
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: { kind: WikiDiffKind; text: string }[] }[];
}

export type ProposalKind = 'create' | 'update' | 'move';

export interface WikiProposal {
  id: string;
  kind: ProposalKind;
  path: string;
  to: string | null;
  title: string;
  state: 'fresh' | 'expired';
  source: { id: string; title: string } | null;
  reason: string;
  createdAt: string;
  diff: WikiDiff;
  moves: { from: string; to: string }[];
}

export const KIND_TEXT: Record<ProposalKind, string> = {
  create: 'Nuova pagina',
  update: 'Aggiornamento',
  move: 'Spostamento',
};

/** One segment of a path, as the core takes it. */
const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function segmentsOk(path: string, min: number, max: number): boolean {
  const segments = path.split('/');
  return segments.length >= min && segments.length <= max && segments.every((segment) => SEGMENT.test(segment) && !segment.includes('--'));
}

/** A page: topic/article or topic/subtopic/article. */
export function isPagePath(path: string): boolean {
  return segmentsOk(path, 2, 3);
}

/** A folder: topic or topic/subtopic. */
export function isFolderPath(path: string): boolean {
  return segmentsOk(path, 1, 2);
}

/** What the user typed as a path, tidied: spaces and capitals become what the core takes («Laravel Octane» → «laravel-octane»). */
export function tidyPath(text: string): string {
  return text
    .trim()
    .split('/')
    .map((segment) =>
      segment
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter((segment) => segment !== '')
    .join('/');
}

/** Why a path cannot be used, in Italian; undefined when it can. */
export function pathProblem(path: string, kind: 'page' | 'folder'): string | undefined {
  if (path === '') return 'Scrivi un percorso.';
  if (kind === 'page' ? isPagePath(path) : isFolderPath(path)) return undefined;
  return kind === 'page' ? 'Un articolo è argomento/articolo o argomento/sotto-argomento/articolo.' : 'Una cartella è argomento o argomento/sotto-argomento.';
}

/** A node of the tree as the page draws it. */
export interface WikiNode {
  kind: 'folder' | 'page';
  /** For a folder its path, for a page its path. */
  path: string;
  name: string;
  children: WikiNode[];
}

/** The display name of a folder: its last segment with spaces, capitalized. */
export function folderName(path: string): string {
  if (path === '') return 'Wiki';
  const name = (path.split('/').at(-1) ?? path).replace(/-/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The folders and pages as a tree: folders first, then pages, each sorted by name. */
export function buildWikiTree(folders: readonly string[], pages: readonly WikiPageEntry[]): WikiNode[] {
  const root: WikiNode = { kind: 'folder', path: '', name: 'Wiki', children: [] };
  const byPath = new Map<string, WikiNode>([['', root]]);
  const folderNode = (path: string): WikiNode => {
    const found = byPath.get(path);
    if (found !== undefined) return found;
    const node: WikiNode = { kind: 'folder', path, name: folderName(path), children: [] };
    byPath.set(path, node);
    folderNode(path.split('/').slice(0, -1).join('/')).children.push(node);
    return node;
  };
  for (const folder of [...folders].sort()) folderNode(folder);
  for (const page of pages) folderNode(page.path.split('/').slice(0, -1).join('/')).children.push({ kind: 'page', path: page.path, name: page.title, children: [] });
  const sort = (node: WikiNode): void => {
    node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'it') : a.kind === 'folder' ? -1 : 1));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** The address of the index of a folder, `_indice` for the root. */
export function indexPath(folder: string): string {
  return folder === '' ? '_indice' : `${folder}/_indice`;
}

/**
 * Where a wikilink of a page leads: a page or an index of the Wiki
 * (`[[wiki/laravel/octane/_indice|…]]`), or a note of kb/ to open in Conoscenza.
 */
export function wikilinkTarget(target: string): { wiki: string } | { note: string } {
  const clean = (target.split('|')[0] ?? '').split('#')[0]?.trim().replace(/\.md$/, '') ?? '';
  if (clean.startsWith('wiki/')) return { wiki: clean.slice('wiki/'.length) };
  return { note: `${clean}.md` };
}

/** The folders a page sits in, from the top: for opening them in the tree. */
export function ancestorsOf(path: string): string[] {
  const segments = path.split('/').slice(0, -1);
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
}

/** What the core said about a page the user wrote («invalid: line 3: citation»), in Italian; undefined for another error. */
function invalidText(detail: string): string | undefined {
  const line = /^line (\d+): (citation|link|header)$/.exec(detail);
  if (line !== null) {
    const where = `Riga ${line[1] ?? ''}: `;
    if (line[2] === 'citation') return `${where}la citazione [[…]] non porta a una tua nota (fino a Privata) né a una pagina della Wiki che c’è.`;
    if (line[2] === 'header') return `${where}l’intestazione la scrive Arianna, togli le righe «---».`;
    return `${where}niente link, immagini, indirizzi o HTML: la pagina resta sul Mac.`;
  }
  if (detail === 'title') return 'Il titolo non va bene: non vuoto, al più 80 caratteri, senza [ ] | # < >.';
  if (detail === 'too-long') return 'La pagina è troppo lunga.';
  if (detail.includes('deeper')) return 'Le pagine andrebbero oltre tre livelli.';
  if (detail.includes('inside itself')) return 'Una cartella non può andare dentro se stessa.';
  return undefined;
}

/** An error of the core («expired: …») said in Italian. */
export function wikiErrorText(status: number, message: string): string {
  const code = message.split(':')[0] ?? '';
  if (code === 'invalid') {
    const text = invalidText(message.slice(code.length + 1).trim());
    if (text !== undefined) return text;
  }
  if (code === 'expired') return 'La pagina è cambiata dopo la proposta: chiedine una nuova.';
  if (code === 'exists') return 'C’è già una pagina o una cartella con questo percorso: scegline un altro.';
  if (code === 'changed') return 'La pagina è cambiata intanto: ricarica.';
  if (code === 'edited') return 'La proposta non è più una pagina scritta da Arianna: scartala.';
  if (code === 'full') return 'Troppe proposte in attesa: approvane o scartane qualcuna.';
  if (status === 404) return 'Non c’è più.';
  if (status === 503) return 'La Wiki non può proporre adesso: riprova fra poco.';
  if (status === 400) return 'Il percorso non va bene.';
  return 'Non ci sono riuscito: riprova.';
}

/** What is dragged in the tree of the Wiki. */
export interface WikiDragged {
  kind: 'page' | 'folder';
  path: string;
}

/**
 * Where a page or folder dropped on `folder` ('' for the root) goes: its
 * name under that folder. Null when it stays where it is; a problem in
 * Italian when it cannot go there (a page at the root, a folder inside
 * itself, deeper than three levels).
 */
export function dropDestination(item: WikiDragged, folder: string): { to: string } | { problem: string } | null {
  const name = item.path.split('/').at(-1) ?? item.path;
  const to = folder === '' ? name : `${folder}/${name}`;
  if (to === item.path) return null;
  if (item.kind === 'folder' && (folder === item.path || folder.startsWith(`${item.path}/`))) return { problem: 'Una cartella non può andare dentro se stessa.' };
  if (item.kind === 'page' && folder === '') return { problem: 'Un articolo sta sempre in una cartella: trascinalo su una cartella.' };
  if (item.kind === 'page' ? !isPagePath(to) : !isFolderPath(to)) return { problem: 'Lì andrebbe oltre tre livelli: argomento › sotto-argomento › articolo.' };
  return { to };
}

/** The folder a dropped item lands in when dropped on a row: the folder itself, or the folder of a page. */
export function dropFolder(row: WikiDragged): string {
  return row.kind === 'folder' ? row.path : row.path.split('/').slice(0, -1).join('/');
}

/** A path after a move of `from` to `to` (a page, or a folder and everything under it); the same path when untouched. */
export function movedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

/** A version time («2026-10-21T09:30:12») as the page shows it. */
export function versionText(at: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  return match === null ? at : `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''} ${match[4] ?? ''}:${match[5] ?? ''}`;
}
