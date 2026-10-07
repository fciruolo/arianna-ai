import { join } from 'node:path';

import type { CatalogEntry, ModelCatalog, ModelRole } from '@arianna/config';
import { LocalModelError, type ChatMessage, type LocalModel } from '@arianna/executors';
import { TRIAL_ALIAS } from '@arianna/evals/library';
import { maxLabel, type Label } from '@arianna/policy';

import { isUuid } from '../conversations.ts';
import type { Queryable, Sql } from '../db/client.ts';
import type { StepContext, StepOutcome } from '../engine.ts';
import { openReply, postActivity } from '../reply.ts';
import type { FileSize } from '../voice/trial.ts';

/**
 * The trial chat of a local model (D-142): "Prova in chat" in the card of a
 * model of the Modelli page opens an incognito private conversation whose
 * messages go to that model only. No prompt of Arianna, no tools, no archive,
 * no delegation: the model reads the messages of the conversation and
 * answers, streamed like Arianna. Nothing leaves the Mac, and the incognito
 * deletes the texts when it closes (D-136).
 */

/** The roles of a model that writes text: a model with only other roles (embedder, stt, tts) has no chat. The chat keeps the same list (apps/hud/src/lib/models-page.ts). */
const CHAT_ROLES: readonly ModelRole[] = ['orchestrator', 'extractor', 'voice'];
/** The last messages the model reads: a trial is a short chat, and a small model has a short context. */
export const TRIAL_HISTORY = 40;
/** Longest message the model reads. */
const MAX_TEXT = 8_000;
/** Room for the answer. */
const MAX_TOKENS = 2_048;

/**
 * Why a model cannot open a trial chat (L0, catalog ids only), undefined when
 * it can: in the catalog, one that writes text (a role among CHAT_ROLES, or
 * none yet, as a model just added from Hugging Face), every file on the disk
 * with its size. The sha256 is "Verifica"'s: a trial reads what is there.
 */
export function trialRefusal(catalog: ModelCatalog, modelId: string, modelsDir: string, size: FileSize): string | undefined {
  const entry: CatalogEntry | undefined = catalog.models.find((model) => model.id === modelId);
  if (entry === undefined) return 'the model is not in the catalog';
  if (entry.roles.length > 0 && !entry.roles.some((role) => CHAT_ROLES.includes(role))) return 'the model does not write text: it has no chat';
  if (!entry.files.every((file) => size(join(modelsDir, entry.id, file.path)) === file.sizeBytes)) return 'the files of the model are not on the disk: download them first';
  return undefined;
}

/** The model under trial of the task's conversation, or undefined for any other task. */
export async function trialModelOf(sql: Queryable, conversationId: string | null): Promise<string | undefined> {
  if (conversationId === null || !isUuid(conversationId)) return undefined;
  const [row] = await sql<{ trialModel: string | null }[]>`SELECT trial_model AS "trialModel" FROM conversations WHERE id = ${conversationId}`;
  return row?.trialModel ?? undefined;
}

interface Line {
  role: 'user' | 'assistant';
  body: string;
  label: Label;
}

/**
 * What the model reads: the user's and the model's messages up to the one
 * that started this task, the last TRIAL_HISTORY of them, oldest first, two of
 * the same role joined (chat templates want them alternating).
 */
export async function trialHistory(sql: Queryable, conversationId: string, taskId: string): Promise<{ messages: ChatMessage[]; label: Label }> {
  const rows = await sql<Line[]>`
    SELECT role, body, label FROM (
      SELECT m.role, m.body, m.label, m.id FROM messages m
      WHERE m.conversation_id = ${conversationId} AND m.role IN ('user', 'assistant')
        AND m.id <= (SELECT max(a.id) FROM messages a WHERE a.conversation_id = ${conversationId} AND a.task_id = ${taskId} AND a.role = 'user')
      ORDER BY m.id DESC LIMIT ${TRIAL_HISTORY}
    ) last ORDER BY id`;
  const messages: ChatMessage[] = [];
  let label: Label = 'L0';
  for (const row of rows) {
    label = maxLabel(label, row.label);
    const content = row.body.length > MAX_TEXT ? `${row.body.slice(0, MAX_TEXT)}\n[cut at ${String(MAX_TEXT)} characters]` : row.body;
    const last = messages.at(-1);
    if (last !== undefined && last.role === row.role) last.content = `${last.content}\n\n${content}`;
    else messages.push({ role: row.role, content });
  }
  // A chat starts with the user: an answer left first by the cut goes.
  while (messages[0]?.role === 'assistant') messages.shift();
  return { messages, label };
}

/** One answer of the model under trial, streamed into the conversation. */
export async function runTrialChat(sql: Sql, ctx: StepContext, modelId: string, model: LocalModel | undefined): Promise<StepOutcome> {
  const { task, step, runId } = ctx;
  if (task.conversationId === null) return { kind: 'wait-user', reason: 'a trial chat answers only in its conversation' };
  if (model === undefined) return { kind: 'wait-user', reason: 'trial chats are not available in this core' };
  const { messages, label: read } = await trialHistory(sql, task.conversationId, task.id);
  if (messages.length === 0) return { kind: 'wait-user', reason: 'the message to answer is missing' };
  const label = maxLabel(task.effectiveLabel, read);

  await postActivity(sql, { conversationId: task.conversationId, taskId: task.id, step, kind: 'thinking', detail: `local/${modelId}` }).catch(() => undefined);
  // messages.model names a cloud model only (0014): the conversation's trial_model says who answered.
  const reply = await openReply(sql, task.id, { runId });
  let pending = Promise.resolve();
  let result;
  try {
    result = await model.chat({
      // The trial endpoints serve the model under this alias (trialEndpoints, as the trials of D-081).
      model: TRIAL_ALIAS,
      messages,
      maxTokens: MAX_TOKENS,
      signal: ctx.signal,
      onText: (piece) => {
        // In order, one at a time: a fragment refused (a vault secret) is not shown, the answer still is checked at the end.
        pending = pending.then(() => reply.delta(piece)).catch(() => undefined);
      },
    });
  } catch (error) {
    if (error instanceof LocalModelError && error.kind === 'no-endpoint') {
      return { kind: 'wait-user', reason: 'no local server in arianna.toml serves the model under trial' };
    }
    if (error instanceof LocalModelError && error.kind === 'bad-response') {
      return { kind: 'wait-user', reason: `${modelId} gave an answer the core cannot read` };
    }
    // Down, stuck, refused for memory or cancelled: the engine retries the step, or stops it.
    throw error;
  }
  await pending;
  const usage = { steps: 1, tokensIn: result.usage?.promptTokens ?? 0, tokensOut: result.usage?.completionTokens ?? 0 };
  const text = result.text.trim();
  if (text === '') return { kind: 'wait-user', reason: `${modelId} gave no answer`, usage };
  const saved = await reply.finish(text, label);
  if (!saved.stored) {
    const why = saved.reason === 'blocked' ? 'the gateway blocked the answer' : 'the answer is above what the conversation may hold';
    return { kind: 'wait-user', reason: why, usage };
  }
  return { kind: 'answered', messageId: saved.message.id, usage };
}
