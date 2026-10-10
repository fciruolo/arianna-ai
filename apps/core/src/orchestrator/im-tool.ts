import type { Project } from '@arianna/config';
import { isAtMost, isLabel, type Label } from '@arianna/policy';

import type { StoredApproval } from '../approvals.ts';
import { addImItem, addItemTo, createIm, currentIm, ImError, listIms, readIm, type ImSummary, type ImView, type ImWhich } from '../im.ts';
import { addDays, checkItemTitle, ImFormatError, longDate, MAX_ITEM_TITLE } from '../im-format.ts';
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

function failure(error: unknown, project: string): ImToolOutcome {
  if (error instanceof ImError) return { kind: 'error', error: imErrorText(error) };
  if (error instanceof KnowledgeError) return { kind: 'error', error: `non riesco ad aprire gli IM di ${project}` };
  throw error;
}

/**
 * The IM `addItemTo` would write in at `now`, without writing: its number,
 * date and label (a new IM is labeled as a new file of the folder). Null when
 * the project has no IM with a date.
 */
function resolveTarget(projects: readonly Project[], project: string, knowledge: KnowledgeEnv, which: ImWhich, now: Date): { number: number; date: string; label: Label } | null {
  const folder = imFolder(projects, project, knowledge, false);
  if (folder === null) return null;
  const list = listIms(projects, project, knowledge);
  const fresh = (): { number: number; date: string; label: Label } | null => {
    const last = list.at(-1);
    if (last === undefined || last.date === null) return null;
    const number = last.number + 1;
    return { number, date: addDays(last.date, 7), label: folder.labelOf(`IM-${String(number)}.md`, []) };
  };
  const of = (im: ImSummary): { number: number; date: string; label: Label } | null => (im.date === null ? null : { number: im.number, date: im.date, label: im.label });
  const current = currentIm(projects, project, knowledge, now);
  if (current === undefined) return fresh();
  if (which === 'current') return of(current);
  const after = list.find((im) => im.number > current.number);
  return after === undefined ? fresh() : of(after);
}

/** The proposal of an approval of kind `im`, or undefined when its detail is not one. */
export function imProposalOf(approval: Pick<StoredApproval, 'kind' | 'detail'>): ImProposal | undefined {
  if (approval.kind !== 'im') return undefined;
  const { project, which, number, date, dateText, imLabel, title } = approval.detail;
  const kind = WHICH.find((value) => value === which);
  if (typeof project !== 'string' || kind === undefined || typeof number !== 'number' || typeof date !== 'string' || typeof title !== 'string' || !isLabel(imLabel)) return undefined;
  return { project, which: kind, number, date, dateText: typeof dateText === 'string' ? dateText : longDate(date), imLabel, title };
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
  }
}
