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
  const clean = (target.replace(/\\\|/g, '|').split('|')[0] ?? '').split('#')[0]?.trim().replace(/\\$/, '').replace(/\.md$/, '') ?? '';
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
  if (detail === 'session') return 'La sessione di scrittura non è valida: ricarica la pagina.';
  if (detail === 'not-empty') return 'La cartella non è vuota: sposta o elimina prima le sue pagine e sotto-cartelle.';
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
  if (to === item.path || (item.kind === 'folder' && folder === item.path)) return null;
  if (item.kind === 'folder' && folder.startsWith(`${item.path}/`)) return { problem: 'Una cartella non può andare dentro se stessa.' };
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

/** Whether a folder of the listing holds nothing: no page and no sub-folder (then «Elimina cartella» is offered). */
export function isEmptyFolder(folder: string, folders: readonly string[], pages: readonly { path: string }[]): boolean {
  const inside = (path: string): boolean => path.startsWith(`${folder}/`);
  return folder !== '' && folders.includes(folder) && !folders.some(inside) && !pages.some((page) => inside(page.path));
}

/** A version time («2026-10-21T09:30:12») as the page shows it. */
export function versionText(at: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  return match === null ? at : `${match[3] ?? ''}/${match[2] ?? ''}/${match[1] ?? ''} ${match[4] ?? ''}:${match[5] ?? ''}`;
}

// ---------------------------------------------------------------------------
// The Wiki as Notion (D-284): the tree on the side, its menu, the path on top

/** The width of the tree on the side: what the user can drag it to, and where it starts. */
export const TREE_WIDTH = { min: 200, max: 480, start: 264 } as const;

/** A width of the tree within what it may be; the start for anything that is not a number. */
export function clampTreeWidth(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return TREE_WIDTH.start;
  return Math.round(Math.min(TREE_WIDTH.max, Math.max(TREE_WIDTH.min, number)));
}

/** The folder a page or the index of a folder sits in: `laravel/octane/swoole` → `laravel/octane`. */
export function folderOf(path: string): string {
  if (path === '_indice') return '';
  if (path.endsWith('/_indice')) return path.slice(0, -'/_indice'.length);
  return path.split('/').slice(0, -1).join('/');
}

/** The path on top of the page: Wiki › Laravel › Octane, each a folder to open. */
export function breadcrumb(path: string): { text: string; folder: string }[] {
  const folder = folderOf(path);
  const out = [{ text: 'Wiki', folder: '' }];
  if (folder === '') return out;
  const segments = folder.split('/');
  segments.forEach((_segment, index) => {
    const at = segments.slice(0, index + 1).join('/');
    out.push({ text: folderName(at), folder: at });
  });
  return out;
}

/** An entry of the menu of the tree (right click, «…»). */
export interface WikiMenuItem {
  id: string;
  text: string;
  /** Why it cannot be used here, in Italian: the entry is shown off, with the reason. */
  off?: string;
  danger?: boolean;
  /** A heading over the entries that follow («Trasforma in»): not an entry. */
  group?: boolean;
  /** The entry that is the state now («Trasforma in» marks the kind of the block). */
  on?: boolean;
}

const DEEP = 'Qui non c’è posto per una cartella: al più argomento › sotto-argomento › articolo.';

/**
 * The menu of a row of the tree, or of the empty part (`null`: the root).
 * A page makes its new pages and folders in its own folder; a folder in
 * itself. `empty` says whether the folder holds nothing (only then it can be
 * deleted).
 */
export function treeMenu(node: WikiDragged | null, empty = false): WikiMenuItem[] {
  if (node === null) {
    return [
      { id: 'new-page', text: 'Nuova pagina' },
      { id: 'new-folder', text: 'Nuova cartella' },
    ];
  }
  const where = node.kind === 'folder' ? node.path : folderOf(node.path);
  const deep = where.split('/').length >= 2;
  const items: WikiMenuItem[] = [
    { id: 'new-page', text: 'Nuova pagina' },
    { id: 'new-folder', text: 'Nuova cartella', ...(deep ? { off: DEEP } : {}) },
    { id: 'rename', text: 'Rinomina' },
    { id: 'move', text: 'Sposta in…' },
  ];
  if (node.kind === 'page') items.push({ id: 'duplicate', text: 'Duplica' });
  items.push({ id: 'cite', text: 'Copia citazione' });
  items.push({ id: 'delete', text: 'Elimina', danger: true, ...(node.kind === 'folder' && !empty ? { off: 'La cartella non è vuota: sposta o elimina prima le sue pagine e sotto-cartelle.' } : {}) });
  return items;
}

/** The citation of a page or a folder to paste in another page: `[[wiki/laravel/octane/swoole]]`. */
export function citationOf(node: WikiDragged): string {
  return node.kind === 'page' ? `[[wiki/${node.path}]]` : `[[wiki/${indexPath(node.path)}]]`;
}

/**
 * What a name typed in the tree for a new page or folder in `folder` makes:
 * the path (the name tidied, as the core takes it) and, for a page, the
 * title as typed. A name may say a folder too («Docker/Volumi»); a page at
 * the root needs one. A problem in Italian when it cannot be.
 */
export function newItemPath(folder: string, typed: string, kind: 'page' | 'folder'): { path: string; title: string } | { problem: string } {
  const text = typed.replace(/\s+/g, ' ').trim();
  if (text === '') return { problem: kind === 'page' ? 'Scrivi il titolo della pagina.' : 'Scrivi il nome della cartella.' };
  const parts = text.split('/').map((part) => part.trim());
  const title = parts.at(-1) ?? '';
  if (title === '') return { problem: 'Dopo «/» scrivi il nome.' };
  if (title.length > 80) return { problem: 'Al più 80 caratteri.' };
  const path = tidyPath([folder, ...parts].filter((part) => part !== '').join('/'));
  if (kind === 'page' && !path.includes('/')) return { problem: 'Una pagina sta in una cartella: scrivi «Argomento/Titolo».' };
  const problem = pathProblem(path, kind);
  if (problem !== undefined) return { problem: path.split('/').length > (kind === 'page' ? 3 : 2) ? 'Andrebbe oltre tre livelli: argomento › sotto-argomento › articolo.' : problem };
  return { path, title };
}

/** The new path of a folder renamed in the tree: the same parent, the name tidied. */
export function renamedFolder(path: string, name: string): string {
  const parent = folderOf(path);
  const last = tidyPath(name.replace(/\//g, ' '));
  return parent === '' ? last : `${parent}/${last}`;
}

/** Where «Duplica» puts the copy: next to the page, `<nome>-copia`, then `-copia-2`… never over a page or folder taken. */
export function copyPath(path: string, taken: ReadonlySet<string>): string {
  const folder = folderOf(path);
  const name = path.split('/').at(-1) ?? path;
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? '-copia' : `-copia-${String(n)}`;
    const candidate = `${folder}/${name.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${folder}/${name.slice(0, 28).replace(/-+$/, '')}-copia-100`;
}

/** The title of the copy: «<titolo> (copia)», within the 80 characters of a title. */
export function copyTitle(title: string): string {
  const suffix = ' (copia)';
  return `${title.slice(0, 80 - suffix.length).trim()}${suffix}`;
}

/** The folders «Sposta in…» offers for a page or a folder: only where it may go, '' for the root. */
export function moveChoices(item: WikiDragged, folders: readonly string[]): { folder: string; to: string }[] {
  const out: { folder: string; to: string }[] = [];
  for (const folder of ['', ...[...folders].sort()]) {
    const where = dropDestination(item, folder);
    if (where !== null && 'to' in where) out.push({ folder, to: where.to });
  }
  return out;
}

/** «Salvataggio…», «Salvato» and the rest, as the page shows them next to the path. */
export type SaveState = 'idle' | 'waiting' | 'saving' | 'saved' | 'changed' | 'problem';

export const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  waiting: 'Modifiche non salvate',
  saving: 'Salvataggio…',
  saved: 'Salvato',
  changed: 'La pagina è cambiata: ricarica',
  problem: 'Non salvata',
};

/** How long the page waits after the last change before saving by itself. */
export const SAVE_DELAY_MS = 1500;

/** Random hex: `getRandomValues` works also where `randomUUID` does not (a page not in a secure context). */
function randomText(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A new token for a writing session (D-284): one per opening of a page, as the core takes it. */
export function sessionToken(random: () => string = randomText): string {
  return random().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).padEnd(16, '0');
}

// ---------------------------------------------------------------------------
// «Confronta» an old version with the page now (D-285)

/** What the core gives for «Confronta»: from the old version to the page now, title on top. */
export interface VersionComparison {
  version: string;
  at: string;
  title: { then: string; now: string };
  /** The page as compared: «Ripristina questa versione» goes only over this. */
  base: string;
  diff: WikiDiff;
  lines: { then: number; now: number };
}

/** A row of a diff of the Wiki: a line, or the lines that do not change, closed. */
export interface WikiDiffRow {
  kind: WikiDiffKind | 'gap';
  text: string;
}

/** «1 riga uguale», «5 righe uguali». */
export function sameLinesText(count: number): string {
  return count === 1 ? '1 riga uguale' : `${String(count)} righe uguali`;
}

/**
 * The rows of a diff as the Wiki shows them (Proposte, Confronta): the lines
 * changed with their context, and between them the lines that do not change
 * closed in one row that says how many. With `oldTotal` (the lines of the old
 * side) the lines after the last change are counted too.
 */
export function wikiDiffRows(hunks: WikiDiff['hunks'], oldTotal?: number): WikiDiffRow[] {
  const rows: WikiDiffRow[] = [];
  // The next line of the old side not shown yet (1-based).
  let next = 1;
  for (const hunk of hunks) {
    // A hunk with no old lines starts after its oldStart (as in a unified diff).
    const start = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    if (start > next) rows.push({ kind: 'gap', text: sameLinesText(start - next) });
    for (const line of hunk.lines) rows.push({ kind: line.kind, text: line.text });
    next = start + hunk.oldLines;
  }
  if (oldTotal !== undefined && hunks.length > 0 && oldTotal + 1 > next) rows.push({ kind: 'gap', text: sameLinesText(oldTotal + 1 - next) });
  return rows;
}

/** An error of «Confronta» or «Ripristina» of a version in Italian: a version gone (beyond the 20 kept) says so (D-285). */
export function versionErrorText(status: number, message: string): string {
  if (status === 404) return 'Questa versione non c’è più: l’elenco delle versioni è aggiornato.';
  if (message.startsWith('edited')) return 'Questa versione non è una pagina scritta da Arianna o da te: non si ripristina.';
  return wikiErrorText(status, message);
}
