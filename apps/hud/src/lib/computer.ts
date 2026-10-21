import { taskIds, type ChatState, type TerminalCall } from './chat-state.ts';
import { canPreview } from './delegations.ts';
import type { DelegationFile, MessageCredit, SavedTerminal, TaskStatus } from './types.ts';

/**
 * The "Computer" panel of a conversation (D-095, tappa 1): what the Coder's
 * run is doing, read only, in three tabs. Pure logic of the chat, tested
 * without a browser; the texts are in the component and italian.ts.
 *
 * - Terminale: commands and outputs of Bash, live while the run works, then
 *   as saved with the delegation (migration 0062).
 * - File: while the run works, only the paths of its changes (from the live
 *   changes of D-117); once it ended, the files of the delegation (D-082),
 *   whose contents the existing route GET /api/delegations/:id/files/:index
 *   gives. During the run no content is ever asked: the files are not yet
 *   those of the delegation, and the paths come from the binary.
 * - Attività: the activity lines (D-054 live, D-083 saved).
 * - Browser: the live screen of Arianna's browser, view only (D-264, passo 4).
 *   It needs no task of the Coder: the panel opens on it from «Guarda».
 */
export type ComputerTab = 'terminal' | 'files' | 'activity' | 'browser';
export const COMPUTER_TABS: readonly ComputerTab[] = ['terminal', 'files', 'activity', 'browser'];

/** The tabs the panel offers: all of them with a task of the Coder to show, otherwise only the browser. */
export function computerTabs(coderTask: string | undefined): readonly ComputerTab[] {
  return coderTask === undefined ? ['browser'] : COMPUTER_TABS;
}

/** The tab to show: the one asked when offered, otherwise the first offered. */
export function shownTab(asked: ComputerTab, tabs: readonly ComputerTab[]): ComputerTab {
  return tabs.includes(asked) ? asked : (tabs[0] ?? 'browser');
}

/** A task in these states is at work: live data only. */
const AT_WORK: readonly TaskStatus[] = ['inbox', 'ready', 'running'];

/** Unknown status counts as not at work: the panel never says "al lavoro" for a task it does not know. */
export function atWork(status: TaskStatus | undefined): boolean {
  return status !== undefined && AT_WORK.includes(status);
}

/** The latest credit of a task with a delegation of the Coder (D-082): its files and the delegation to read them from. */
export function delegationCredit(chat: ChatState, credits: ReadonlyMap<string, MessageCredit>, taskId: string): MessageCredit | undefined {
  let found: MessageCredit | undefined;
  for (const message of chat.messages) {
    if (message.taskId !== taskId) continue;
    const credit = credits.get(message.id);
    if (credit?.delegationId !== null && credit?.delegationId !== undefined) found = credit;
  }
  return found;
}

/**
 * The task the panel shows: the newest of the conversation with something of
 * a run of the Coder to show (a terminal, changed paths, a delegation); none
 * when the conversation has no such task. A task at work without any of these
 * (Arianna answering on her own) is not the Coder's.
 */
export function computerTask(chat: ChatState, credits: ReadonlyMap<string, MessageCredit>): string | undefined {
  const ids = taskIds(chat);
  for (const id of Object.keys(chat.terminal)) if (!ids.includes(id)) ids.push(id);
  for (const id of ids.reverse()) {
    if ((chat.terminal[id]?.length ?? 0) > 0 || (chat.touched[id]?.length ?? 0) > 0) return id;
    if (delegationCredit(chat, credits, id) !== undefined) return id;
  }
  return undefined;
}

/** What the "File" tab shows. */
export type FilesView =
  /** The run works, or ended without a list: the paths its changes named, nothing else. */
  | { mode: 'live'; paths: string[] }
  /** The run ended: the files of the delegation, each readable through the existing route. */
  | { mode: 'final'; delegationId: string; repo: string | null; files: DelegationFile[] };

export function filesView(chat: ChatState, taskId: string, status: TaskStatus | undefined, credit: MessageCredit | undefined): FilesView {
  if (!atWork(status) && credit !== undefined && credit.delegationId !== null && credit.files !== null) {
    return { mode: 'final', delegationId: credit.delegationId, repo: credit.repo, files: credit.files };
  }
  return { mode: 'live', paths: chat.touched[taskId] ?? [] };
}

/** Whether a file of the tab may be read: only a file of an ended delegation, still there. */
export function mayReadFile(view: FilesView, index: number): view is Extract<FilesView, { mode: 'final' }> {
  if (view.mode !== 'final') return false;
  const file = view.files[index];
  return file !== undefined && canPreview(file);
}

/** The calls of the terminal of a task, oldest first. */
export function terminalCalls(chat: ChatState, taskId: string): TerminalCall[] {
  return chat.terminal[taskId] ?? [];
}

/** The saved terminal of a task (D-095, migration 0062) as the calls the panel shows: a command and its output paired by call. */
export function savedCalls(rows: readonly SavedTerminal[]): TerminalCall[] {
  const calls: TerminalCall[] = [];
  for (const row of rows) {
    let call = calls.find((item) => item.callId === row.callId);
    if (call === undefined) {
      call = { callId: row.callId, step: row.step };
      calls.push(call);
    }
    call[row.part] = { total: 1, pieces: {}, text: row.text, truncated: row.truncated, hidden: row.hidden, refused: row.refused, error: row.error };
  }
  return calls;
}

/**
 * Messages that the cage of the run prints when it refuses something: a read
 * or a write outside the project folder refused by the sandbox, or the network
 * (no domain is allowed). The panel marks these outputs; an ordinary error is
 * not one.
 */
const SANDBOX_REFUSAL = /Operation not permitted|Could not resolve host|CONNECT tunnel failed|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|Network is unreachable|blocked by (?:the )?sandbox/i;

/** Whether an output of the terminal shows the cage refusing something. */
export function sandboxRefusal(text: string | undefined): boolean {
  return text !== undefined && SANDBOX_REFUSAL.test(text);
}
