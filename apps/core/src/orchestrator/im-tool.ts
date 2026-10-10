import type { Project } from '@arianna/config';
import { isAtMost, isLabel, maxLabel, type Label } from '@arianna/policy';

import type { StoredApproval } from '../approvals.ts';
import { addImItem, addItemTo, createIm, currentIm, ImError, listIms, nextImPlan, readIm, type ImSummary, type ImView, type ImWhich } from '../im.ts';
import { checkItemTitle, ImFormatError, longDate, MAX_ITEM_TITLE } from '../im-format.ts';
import { imFolder, KnowledgeError, type KnowledgeEnv } from '../project-knowledge.ts';

/**
 * `im.add` (D-167, P4b): "per il prossimo IM dobbiamo fare le fatture" said
 * to Arianna becomes an item of the IM file of the project. Local only: the
 * file is written by code on this machine, never by a cloud executor.
 *
 * When the step read nothing above the target IM (a work conversation), the
 * item is written at once: it is reversible and the reply names where it went.
 * When the step read more (a private conversation, the secretary), the title
 * would go down to the label of the IM: the user confirms that exact text in
 * the web chat first (an approval of kind `im`), and only then is it written.
 */
export interface ImToolEnv {
  /** The approved projects as containers (D-145), read at each call. */
  projects: () => readonly Project[];
  knowledge: KnowledgeEnv;
  /** The clock of the orchestrator; new Date() without one. */
  now?: () => Date;
}

export interface ImToolCall {
  args: Record<string, unknown>;
  /** The project of the conversation's workspace, when it has one: the default of `project`. */
  workspace: string | undefined;
  /** The effective label of the step: what the title was written from. */
  effective: Label;
}

/** What the user confirms (the detail of an approval of kind `im`): the IM resolved when it was asked, and the exact title. */
export interface ImProposal {
  project: string;
  which: ImWhich;
  number: number;
  date: string;
  /** `longDate(date)`, as the card shows it. */
  dateText: string;
  /** The label of the IM: the title goes down to it. */
  imLabel: Label;
  title: string;
  /** What named the project, when it was not said (a client, D-173): the answer once decided carries it. */
  readLabel?: Label;
}

/** What the model reads: a line in Italian, never the text of the IM beyond the item it added. */
export type ImToolOutcome =
  | { kind: 'done'; text: string; label: Label }
  | { kind: 'error'; error: string }
  | { kind: 'confirm'; proposal: ImProposal };

export const IM_ACTION = 'im.add';
/** The label of an approval of kind `im`: its detail holds the user's text (the database wants L2 at least). */
export const IM_APPROVAL_LABEL: Label = 'L2';

const WHICH: readonly ImWhich[] = ['next', 'current'];
const NO_IM = 'il progetto non ha ancora IM con una data: crea il primo dal cardwall';

function clock(env: ImToolEnv): Date {
  return (env.now ?? (() => new Date()))();
}

export function addImTool(env: ImToolEnv | undefined, call: ImToolCall): ImToolOutcome {
  if (env === undefined) return { kind: 'error', error: 'gli IM dei progetti non sono disponibili in questa installazione' };
  const projects = env.projects();
  const names = projects.map((project) => project.name);
  const known = names.length === 0 ? 'nessun progetto approvato' : `progetti noti: ${names.join(', ')}`;

  const asked = typeof call.args.project === 'string' && call.args.project.trim() !== '' ? call.args.project.trim() : call.workspace;
  if (asked === undefined) return { kind: 'error', error: `manca il progetto: chiedi all'utente di quale si tratta (${known})` };
  const project = projects.find((item) => item.name === asked) ?? projects.find((item) => item.name.toLowerCase() === asked.toLowerCase());
  if (project === undefined) return { kind: 'error', error: `il progetto '${asked}' non esiste fra quelli approvati (${known})` };

  const whichArg = call.args.which ?? 'next';
  const which = WHICH.find((value) => value === whichArg);
  if (which === undefined) return { kind: 'error', error: `"which" deve essere "next" (il prossimo IM) o "current" (questo IM)` };

  let title: string;
  try {
    title = checkItemTitle(typeof call.args.title === 'string' ? call.args.title : '');
  } catch (error) {
    if (error instanceof ImFormatError) return { kind: 'error', error: `il titolo deve essere una riga sola, non vuota, di al massimo ${String(MAX_ITEM_TITLE)} caratteri` };
    throw error;
  }

  try {
    const now = clock(env);
    const target = resolveTarget(projects, project.name, env.knowledge, which, now);
    if (target === null) return { kind: 'error', error: NO_IM };
    if (target.ended) return { kind: 'error', error: ended(project.name) };
    // The title comes from a step that read data up to `effective`: below it, the user decides.
    if (!isAtMost(call.effective, target.label)) {
      return {
        kind: 'confirm',
        proposal: { project: project.name, which, number: target.number, date: target.date, dateText: longDate(target.date), imLabel: target.label, title },
      };
    }
    return written(addItemTo(projects, project.name, env.knowledge, which, title, now), project.name, title, 'Aggiunta a');
  } catch (error) {
    return failure(error, project.name);
  }
}

function written(im: ImView, project: string, title: string, verb: string): ImToolOutcome {
  const when = im.date === null ? '' : ` (${longDate(im.date)})`;
  return { kind: 'done', text: `${verb} IM-${String(im.number)}${when} di ${project}: ${title}`, label: im.label };
}

/** The IM of the project have ended (D-169): what the model reads. */
function ended(project: string): string {
  return `gli IM di ${project} sono terminati (data di fine nel calendario degli IM): non nasce un IM nuovo; dillo all'utente`;
}

function failure(error: unknown, project: string): ImToolOutcome {
  if (error instanceof ImError && error.code === 'ended') return { kind: 'error', error: ended(project) };
  if (error instanceof ImError) return { kind: 'error', error: imErrorText(error) };
  if (error instanceof KnowledgeError) return { kind: 'error', error: `non riesco ad aprire gli IM di ${project}` };
  throw error;
}

/**
 * The IM `addItemTo` would write in at `now`, without writing: its number,
 * date and label (a new IM is labeled as a new file of the folder). Null when
 * the project has no IM with a date.
 */
function resolveTarget(projects: readonly Project[], project: string, knowledge: KnowledgeEnv, which: ImWhich, now: Date): { number: number; date: string; label: Label; ended: boolean } | null {
  const folder = imFolder(projects, project, knowledge, false);
  if (folder === null) return null;
  const list = listIms(projects, project, knowledge);
  // The IM to make: number and date as createIm gives them (the calendar of the project and its last day, P4d).
  const fresh = (): { number: number; date: string; label: Label; ended: boolean } | null => {
    const last = list.at(-1);
    if (last === undefined || last.date === null) return null;
    const plan = nextImPlan(projects, project, knowledge, now);
    return plan === null ? null : { ...plan, label: folder.labelOf(`IM-${String(plan.number)}.md`, []) };
  };
  const of = (im: ImSummary): { number: number; date: string; label: Label; ended: boolean } | null => (im.date === null ? null : { number: im.number, date: im.date, label: im.label, ended: false });
  const current = currentIm(projects, project, knowledge, now);
  if (current === undefined) return fresh();
  if (which === 'current') return of(current);
  const after = list.find((im) => im.number > current.number);
  return after === undefined ? fresh() : of(after);
}

/** The proposal of an approval of kind `im`, or undefined when its detail is not one. */
export function imProposalOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): ImProposal | undefined {
  if (approval.kind !== 'im') return undefined;
  const { project, which, number, date, dateText, imLabel, title, readLabel } = approval.detail;
  const kind = WHICH.find((value) => value === which);
  if (typeof project !== 'string' || kind === undefined || typeof number !== 'number' || typeof date !== 'string' || typeof title !== 'string' || !isLabel(imLabel)) return undefined;
  if (readLabel !== undefined && !isLabel(readLabel)) return undefined;
  return { project, which: kind, number, date, dateText: typeof dateText === 'string' ? dateText : longDate(date), imLabel, title, ...(readLabel === undefined ? {} : { readLabel }) };
}

const fold = (value: string): string => value.normalize('NFC').toLowerCase();

/**
 * The item the user confirmed, written exactly where the card said: the IM
 * `number` (created now if it was the next one to make), only while its label
 * is still the one the user saw or higher. An item already there counts as
 * written (a step that runs again after a crash finds it).
 */
export function applyImProposal(env: ImToolEnv | undefined, proposal: ImProposal): ImToolOutcome {
  if (env === undefined) return { kind: 'error', error: 'gli IM dei progetti non sono disponibili in questa installazione' };
  const projects = env.projects();
  const { project, number, title } = proposal;
  if (!projects.some((item) => item.name === project)) return { kind: 'error', error: `il progetto '${project}' non è più fra quelli approvati` };
  try {
    const list = listIms(projects, project, env.knowledge);
    let view: ImView;
    if (list.some((im) => im.number === number)) {
      view = readIm(projects, project, env.knowledge, number);
    } else {
      const last = list.at(-1);
      if (last !== undefined && last.number + 1 !== number) return { kind: 'error', error: `gli IM di ${project} sono cambiati: IM-${String(number)} non è più il prossimo` };
      view = createIm(projects, project, env.knowledge);
      if (view.number !== number) return { kind: 'error', error: `gli IM di ${project} sono cambiati: IM-${String(number)} non è più il prossimo` };
    }
    if (!isAtMost(proposal.imLabel, view.label)) return { kind: 'error', error: `IM-${String(number)} ora ha un livello più basso di quello confermato: non scrivo` };
    if (view.items.some((item) => fold(item.title) === fold(title) && item.part === null)) return written(view, project, title, 'Già presente in');
    return written(addImItem(projects, project, env.knowledge, number, title, view.version), project, title, 'Aggiunta a');
  } catch (error) {
    return failure(error, project);
  }
}

function imErrorText(error: ImError): string {
  switch (error.code) {
    case 'not-found':
      return /no IM with a date/.test(error.message) ? NO_IM : "l'IM non si trova più nel file: riprova";
    case 'invalid': {
      const same = /^IM-(\d+) has this item already/.exec(error.message);
      return same === null ? "la voce non è valida per il file dell'IM" : `IM-${same[1] ?? ''} ha già questa voce`;
    }
    case 'changed':
      return "l'IM è cambiato nel file mentre lo scrivevo: riprova";
    case 'refused':
      return 'la cartella IM del progetto non si può scrivere (un collegamento o un file troppo grande)';
    case 'unavailable':
      return "non riesco a scrivere il file dell'IM: riprova più tardi";
    case 'ended':
      return 'gli IM del progetto sono terminati: non nasce un IM nuovo';
  }
}

/** A client as the tool reads it (I-17 S3, D-173): the same shape as `clientsForIm` of clients.ts. */
export interface ImClientInfo {
  name: string;
  legalName: string | null;
  label: Label;
  projects: readonly string[];
}

/** What "del cliente Rossi" became: the project to write in, or an error for the model; both carry the label they were read at. */
export type ImClientOutcome = { kind: 'project'; project: string; client: string; label: Label } | { kind: 'error'; error: string; label: Label };

/** Words a model may add around a name ("cliente Rossi", "il Rossi"): left out of the match, unless nothing else is said. */
const FILLERS = new Set(['cliente', 'client', 'il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'da', 'per', 'the']);

const words = (value: string): string[] =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    // "D'Amico" is one word, as "Damico" is.
    .replace(/['’]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');

/**
 * The clients a name points to: one named exactly so (display or legal
 * name, without case or accents), otherwise those whose names hold every
 * word said ("Rossi" → "Pasticceria Finta Rossi Srl").
 */
export function matchClients<T extends ImClientInfo>(clients: readonly T[], asked: string): T[] {
  const all = words(asked);
  const kept = all.filter((word) => !FILLERS.has(word));
  const said = kept.length === 0 ? all : kept;
  if (said.length === 0) return [];
  const same = (name: string | null): boolean => name !== null && words(name).join(' ') === said.join(' ');
  const exact = clients.filter((client) => same(client.name) || same(client.legalName));
  if (exact.length > 0) return exact;
  return clients.filter((client) => {
    const held = new Set([...words(client.name), ...words(client.legalName ?? '')]);
    return said.every((word) => held.has(word));
  });
}

/**
 * `client` of `im.add` (I-17 S3, D-173): the project of the client the user
 * named. Clients are Private (L2 at least): those above the clearance of the
 * task are never seen nor named, and whatever names a client is read at its
 * label, so a title written after it asks the user first when the IM is lower.
 * With more projects (and no `project` among them) the model asks which.
 */
export function clientProject(clients: readonly ImClientInfo[], asked: string, project: string | undefined, clearance: Label): ImClientOutcome {
  if (!isAtMost('L2', clearance)) {
    return { kind: 'error', error: 'in questa conversazione non posso leggere i clienti, che sono Privati: chiedi all’utente il progetto', label: 'L0' };
  }
  const visible = clients.filter((client) => isAtMost(client.label, clearance));
  const found = matchClients(visible, asked);
  if (found.length === 0) return { kind: 'error', error: `nessun cliente corrisponde a '${asked}': chiedi all’utente il progetto o il nome del cliente`, label: 'L2' };
  const label = maxLabel('L2', ...found.map((client) => client.label));
  const [only] = found;
  if (only === undefined || found.length > 1) {
    return { kind: 'error', error: `più clienti corrispondono a '${asked}' (${found.map((client) => client.name).join(', ')}): chiedi all’utente quale`, label };
  }
  if (only.projects.length === 0) return { kind: 'error', error: `il cliente ${only.name} non ha progetti approvati collegati: chiedi all’utente il progetto`, label };
  if (project !== undefined) {
    const chosen = only.projects.find((name) => name.toLowerCase() === project.toLowerCase());
    if (chosen === undefined) return { kind: 'error', error: `il progetto '${project}' non è del cliente ${only.name} (progetti: ${only.projects.join(', ')}): chiedi all’utente quale`, label };
    return { kind: 'project', project: chosen, client: only.name, label };
  }
  const [single] = only.projects;
  if (single === undefined || only.projects.length > 1) {
    return { kind: 'error', error: `il cliente ${only.name} ha più progetti (${only.projects.join(', ')}): chiedi all’utente per quale progetto`, label };
  }
  return { kind: 'project', project: single, client: only.name, label };
}
