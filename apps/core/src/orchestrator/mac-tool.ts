import { isMacTool, type MacToolId } from '@arianna/agents';

import { isMacChoice, type MacChoice } from '../approvals.ts';
import type { Queryable } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { siteOf } from '../link-fetch.ts';
import {
  askCommand,
  askSentence,
  displayPath,
  folderToAsk,
  grantedFolder,
  macCall,
  MacPathError,
  MacPermissionError,
  permissionText,
  placeName,
  runMacCall,
  volumeRefusal,
  type MacEnv,
} from '../mac-files.ts';
import { conversationMacFolders, permanentMacFolders } from '../mac-folders.ts';
import type { Task } from '../tasks.ts';
import type { Turn } from './turns.ts';

/**
 * The tools of the folders of the Mac in a chat (D-314, I-22, tappa M1):
 * offered only in a private conversation of the user with Arianna, on the
 * local model. Inside an allowed folder the core reads at once; a folder not
 * allowed yet waits for the card of kind `mac` with three choices («Solo
 * questa volta», «Per tutta questa conversazione», «Sempre»); with a yes the
 * core makes the same call again itself, as the next step, and the model
 * reads its result. Everything read, names included, is L2. In an incognito
 * conversation the tools touch nothing and ask nothing: a fixed answer.
 */

/** The result of a call while the user decides: replaced, in what the model reads, by the decision. */
export const WAITING_MAC = 'waiting for the user to decide in the chat whether Arianna may read this folder of the Mac';

/** What the model reads in an incognito conversation (D-314): nothing is read, nothing is asked. */
export const MAC_INCOGNITO =
  'error: mac: this conversation is incognito: the folders of the Mac are never read here, and the user is not asked. Tell the user, in their language, that in incognito you do not look at the folders of the Mac, and suggest asking the same in a normal private chat.';

/** Every result of a mac tool is L2 (D-314): names of files included. */
export const MAC_RESULT_LABEL = 'L2';


/** What a card names when the step read something that is not the user's before asking (D-314, point 3). */
export const MAX_AFTER = 5;

/**
 * A private conversation of the user with Arianna, where the tools are
 * offered (incognito too: there they answer MAC_INCOGNITO). Not the
 * secretary's, not a chat of an agent, of a trial, of a project, of a tile.
 */
export async function macConversation(sql: Queryable, conversationId: string | null): Promise<boolean> {
  if (conversationId === null) return false;
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT true AS ok FROM conversations
    WHERE id = ${conversationId} AND mode = 'private' AND clearance = 'L2'::privacy_label AND origin = 'user'
      AND purged_at IS NULL AND archived_at IS NULL AND NOT secretary AND agent IS NULL
      AND trial_model IS NULL AND dashboard_of IS NULL AND workspace IS NULL`;
  return row?.ok === true;
}

export interface MacToolEnv {
  mac: MacEnv;
  sql: Queryable;
  task: Task;
  incognito: boolean;
  /** The turns of the task before this step: what it read before asking. */
  turns: readonly Turn[];
  /** «Solo questa volta» (or any yes) just given for this very call: the folder holds for it. */
  once?: string;
}

export type MacToolOutcome =
  | { kind: 'done'; text: string; detail: string }
  | { kind: 'error'; text: string; detail: string }
  | { kind: 'ask'; detail: MacAskDetail; activity: string };

/** What the card of kind `mac` stores and shows (migration 0094). */
export interface MacAskDetail {
  tool: MacToolId;
  step: number;
  /** The folder the permission is for, as written (absolute). */
  folder: string;
  /** How the card names it: «Scrivania», «Fatture» in Documenti. */
  place: string;
  /** Written by the core from the arguments, never by the model. */
  sentence: string;
  /** The equivalent command, shown in small: not what runs. */
  command: string;
  /** What the step read before asking that is not the user's: pages, files. */
  after: string[];
}

/** Runs one call of a mac tool: done, an error the model reads, or a card to ask. */
export async function macTool(tool: MacToolId, args: Record<string, unknown>, step: number, env: MacToolEnv): Promise<MacToolOutcome> {
  if (env.incognito) return { kind: 'error', text: MAC_INCOGNITO, detail: 'mac · in incognito non guardo le cartelle' };
  const home = env.mac.home;
  let call;
  try {
    call = macCall(tool, args, env.mac);
  } catch (error) {
    if (error instanceof MacPathError) return { kind: 'error', text: `error: ${tool}: ${error.message}`, detail: `mac · ${error.message}` };
    throw error;
  }
  const folders = [...(await permanentMacFolders(env.sql)), ...(env.task.conversationId === null ? [] : await conversationMacFolders(env.sql, env.task.conversationId)), ...(env.once === undefined ? [] : [env.once])];
  const folder = grantedFolder(call.path, folders);
  if (folder === undefined) {
    const asked = folderToAsk(call, home);
    if (asked === undefined) {
      return { kind: 'error', text: `error: ${tool}: the whole home folder is never asked for: ask the user which folder inside it (Scrivania, Documenti, Scaricati...)`, detail: 'mac · scegli una cartella' };
    }
    // A folder the user said «No» to in this answer: not asked again.
    if (await refusedInTask(env.sql, env.task.id, asked)) {
      return { kind: 'error', text: `error: ${tool}: the user did not allow reading ${displayPath(asked, home)} in this answer. Do not ask again; tell the user you did not look.`, detail: `mac · ${placeName(asked, home)}: hai detto No` };
    }
    // An external disk that is an alias of the system disk: refused before any card.
    const volume = await volumeRefusal(asked, env.mac);
    if (volume !== undefined) return { kind: 'error', text: `error: ${tool}: ${volume}`, detail: `mac · ${volume}` };
    const place = placeName(asked, home);
    return {
      kind: 'ask',
      detail: { tool, step, folder: asked, place, sentence: askSentence(call, home), command: askCommand(call, home), after: readBefore(env.turns) },
      activity: `mac · ${place}: chiedo a te il permesso`,
    };
  }
  try {
    const read = await runMacCall(call, folder, env.mac);
    return { kind: 'done', text: read.text, detail: `mac · ${read.place}` };
  } catch (error) {
    if (error instanceof MacPermissionError) {
      const text = permissionText(error.folder, env.mac);
      return { kind: 'error', text: `error: ${tool}: ${text} Tell the user this, in these words.`, detail: `mac · ${text}` };
    }
    if (error instanceof MacPathError) return { kind: 'error', text: `error: ${tool}: ${error.message}`, detail: `mac · ${error.message}` };
    throw error;
  }
}

/** The card of kind `mac` (D-314): written with the turn, in the transaction of the step; L2, it names a folder of the user. */
export async function requestMacRead(tx: Queryable, options: { taskId: string; detail: MacAskDetail }): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO approvals (task_id, kind, action, detail, label)
    VALUES (${options.taskId}, 'mac', 'mac.read', ${tx.json({ ...options.detail })}, 'L2'::privacy_label)
    RETURNING id::text`;
  if (row === undefined) throw new Error('the approval of the folder was not written');
  return row.id;
}

/**
 * What the step read before that is not the user's own (D-314, point 3): the
 * pages of web.fetch and of the browser, the files of the Mac. Short texts
 * written by the core from the calls, at most MAX_AFTER.
 */
export function readBefore(turns: readonly Turn[]): string[] {
  const seen: string[] = [];
  for (const turn of turns) {
    if (turn.answer.action !== 'call' || turn.result === null || turn.result.startsWith('error: ') || turn.result === WAITING_MAC) continue;
    const { tool, arguments: args } = turn.answer;
    let text: string | undefined;
    if ((tool === 'web.fetch' || tool === 'browser.open') && typeof args.url === 'string') text = `la pagina web ${siteOf(args.url) ?? 'di un sito'}`;
    else if (tool === 'browser.read') text = 'una pagina del browser';
    else if (tool === 'mac.read' && typeof args.path === 'string') text = `il file ${args.path.trim().slice(0, 120)}`;
    // Names of files are written by anyone too.
    else if ((tool === 'mac.list' || tool === 'mac.find') && typeof args.path === 'string') text = `i nomi dei file di ${args.path.trim().slice(0, 120)}`;
    if (text !== undefined && !seen.includes(text)) seen.push(text);
    if (seen.length >= MAX_AFTER) break;
  }
  return seen;
}

interface MacAsk {
  id: string;
  state: string;
  choice: string | null;
  folder: string;
  place: string;
  /** «Sempre» that really added the folder (a full list keeps the decision for this call only). */
  listed: boolean;
}

async function macAsksByStep(sql: Queryable, taskId: string): Promise<Map<number, MacAsk>> {
  const rows = await sql<{ id: string; state: string; choice: string | null; folder: string | null; place: string | null; step: number | null; listed: boolean }[]>`
    SELECT id::text, state::text, choice, detail ->> 'folder' AS folder, detail ->> 'place' AS place, (detail ->> 'step')::int AS step,
      EXISTS (SELECT FROM mac_folders f WHERE f.approval_id = approvals.id
        OR (f.path = approvals.detail ->> 'folder' AND f.added_at <= approvals.decided_at)) AS listed
    FROM approvals WHERE task_id = ${taskId} AND kind = 'mac'`;
  const asks = new Map<number, MacAsk>();
  for (const row of rows) if (row.step !== null) asks.set(row.step, { id: row.id, state: row.state, choice: row.choice, folder: row.folder ?? '', place: row.place ?? 'the folder', listed: row.listed });
  return asks;
}

async function refusedInTask(sql: Queryable, taskId: string, folder: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM approvals
    WHERE task_id = ${taskId} AND kind = 'mac' AND state IN ('rejected', 'expired') AND detail ->> 'folder' = ${folder}`;
  return (row?.n ?? 0) > 0;
}

const CHOICE_TEXT: Readonly<Record<MacChoice, string>> = {
  once: 'for this call only',
  conversation: 'for this whole conversation',
  always: 'always: it is now in the list of the settings',
};

/** What the model reads once the user decided; the same bytes at every later step (the prefix cache). */
export function macResultText(state: string, choice: string | null, place: string, tool: string, listed = true): string {
  const shown = place;
  if (state === 'approved' && choice === 'always' && !listed) return `the user allowed reading ${shown} always, but the list of the settings is full (or the folder could not be added): it holds for this call only. Tell the user. The same ${tool} was made again right after, its result follows.`;
  if (state === 'approved') return `the user allowed reading ${shown} (${isMacChoice(choice) ? CHOICE_TEXT[choice] : 'for this call only'}): the same ${tool} was made again right after, its result follows.`;
  if (state === 'pending') return WAITING_MAC;
  return `error: ${tool}: the user did not allow reading ${shown}. Do not ask again for this folder; tell the user you did not look.`;
}

/** The turns' results as the model reads them: a waiting card becomes the user's decision. */
export async function macResults(sql: Queryable, taskId: string, turns: readonly Turn[]): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  if (!turns.some((turn) => turn.result === WAITING_MAC)) return results;
  const asks = await macAsksByStep(sql, taskId);
  for (const turn of turns) {
    if (turn.result !== WAITING_MAC || turn.answer.action !== 'call') continue;
    const ask = asks.get(turn.step);
    results.set(turn.step, macResultText(ask?.state ?? 'rejected', ask?.choice ?? null, ask?.place ?? 'the folder', turn.answer.tool, ask?.listed ?? true));
  }
  return results;
}

/** The call to make again right after a yes (as D-286 for the browser): the last turn waited for a card now approved. */
export interface MacRedo {
  answer: Extract<Turn['answer'], { action: 'call' }>;
  approvalId: string;
  folder: string;
}

export async function macRedo(sql: Queryable, taskId: string, turns: readonly Turn[], tools: readonly string[]): Promise<MacRedo | undefined> {
  const last = turns.reduce<Turn | undefined>((latest, turn) => (latest === undefined || turn.step > latest.step ? turn : latest), undefined);
  if (last?.result !== WAITING_MAC || last.answer.action !== 'call' || !isMacTool(last.answer.tool) || !tools.includes(last.answer.tool)) return undefined;
  const ask = (await macAsksByStep(sql, taskId)).get(last.step);
  if (ask?.state !== 'approved' || ask.folder === '') return undefined;
  return { answer: last.answer, approvalId: ask.id, folder: ask.folder };
}

/** A step that asked before a crash: it waits again while the card is pending; decided, the steps go on. */
export async function macReplay(sql: Queryable, ctx: StepContext, turn: Turn): Promise<StepOutcome | undefined> {
  if (turn.result !== WAITING_MAC) return undefined;
  const ask = (await macAsksByStep(sql, ctx.task.id)).get(turn.step);
  if (ask === undefined) return undefined;
  return ask.state === 'pending' ? { kind: 'confirm', approvalId: ask.id, usage: { steps: 0 } } : { kind: 'continue', usage: { steps: 0 } };
}
