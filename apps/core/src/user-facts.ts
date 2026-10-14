import { randomUUID } from 'node:crypto';

import {
  createContext,
  DEFAULT_FACT_LABEL,
  factFieldsToScan,
  isFactLabel,
  isFactLowering,
  PolicyError,
  scanText,
  type FactField,
  type FactLabel,
  type Labeled,
} from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { decideApproval, requestDeclassify } from './approvals.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import { applyDeclassifyIn } from './gateway.ts';

/**
 * «Su di te» (D-114, tappa A): the user's profile, single facts each with its
 * label, read and written from Settings in the web chat. An agent never
 * writes a fact nor lowers its label: it may only propose one (profile.propose,
 * tappa D), written "Solo in casa" once the user confirms it in the web chat
 * (`applyFactProposal`).
 *
 * - A new fact is "Solo in casa" (L2) unless the user chooses "Condivisibile" (L1).
 * - The topic is L1 by the user's declaration: the scanner and the values of
 *   the vault check it always; the text only when the fact is L1 (it may
 *   leave). L3 never enters the profile.
 * - Raising a fact (L1 → L2) is immediate. Lowering it (L2 → L1) is a
 *   declassification, as a privacy change of the Settings (D-071): prepared
 *   and shown, then written only by `confirmShare` with that id, within a few
 *   minutes and once, with a declassify approval for the exact text decided
 *   in the web chat and its row in label_changes, in one transaction. The
 *   database refuses the lowering without that row (migration 0061).
 * - The events carry ids, topics and labels, never the text of a fact.
 */

export const MAX_TOPIC = 60;
export const MAX_FACT_TEXT = 300;
/** Most facts of the profile: a short list the user reads at a glance. */
export const MAX_FACTS = 200;
/** How long a lowering stays confirmable, as a privacy change of the Settings. */
export const SHARE_CONFIRM_MS = 5 * 60_000;
const MAX_PENDING = 20;

export type FactsErrorCode = 'invalid' | 'not-found' | 'conflict' | 'needs-confirmation' | 'unknown' | 'expired' | 'changed';

export class FactsError extends Error {
  override name = 'FactsError';
  readonly code: FactsErrorCode;

  constructor(code: FactsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export const FACTS_STATUS: Record<FactsErrorCode, number> = {
  invalid: 400,
  'not-found': 404,
  conflict: 409,
  'needs-confirmation': 409,
  unknown: 404,
  expired: 410,
  changed: 409,
};

export interface UserFact {
  id: string;
  topic: string;
  text: string;
  label: FactLabel;
  createdAt: string;
  updatedAt: string;
}

/** What the page shows before a fact becomes "Condivisibile": exactly what confirm writes. */
export interface ShareProposal {
  id: string;
  expiresAt: string;
  factId: string;
  topic: string;
  /** The exact text that becomes shareable. */
  text: string;
  from: 'L2';
  to: 'L1';
}

export interface UserFacts {
  list(): Promise<UserFact[]>;
  /** `{ topic, text, label? }`. */
  create(body: Record<string, unknown>): Promise<UserFact>;
  /** `{ topic?, text?, label? }`; `label: 'L1'` on a fact "Solo in casa" is refused: it goes through prepareShare. */
  update(id: string, body: Record<string, unknown>): Promise<UserFact>;
  remove(id: string): Promise<void>;
  /** `{ topic?, text? }`: the fact as it will be once "Condivisibile". */
  prepareShare(id: string, body: Record<string, unknown>): Promise<ShareProposal>;
  /** `{ id }` of a proposal. */
  confirmShare(body: Record<string, unknown>): Promise<UserFact>;
}

export interface UserFactsOptions {
  now?: () => number;
  confirmMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const COLUMNS = `id::text, topic, text, label::text AS label,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;

function invalid(message: string): never {
  throw new FactsError('invalid', message);
}

function only(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) invalid(`unknown field(s): ${unknown.join(', ')}`);
}

function checkId(id: string): string {
  if (!UUID.test(id)) throw new FactsError('not-found', 'no such fact');
  return id.toLowerCase();
}

function topicOf(value: unknown): string {
  if (typeof value !== 'string') invalid('topic must be text');
  const topic = value.trim().replace(/\s+/g, ' ');
  if (topic === '') invalid('topic is empty');
  if (topic.length > MAX_TOPIC) invalid(`topic is longer than ${String(MAX_TOPIC)} characters`);
  if (CONTROL.test(topic)) invalid('topic holds control characters');
  return topic;
}

function textOf(value: unknown): string {
  if (typeof value !== 'string') invalid('text must be text');
  const text = value.trim();
  if (text === '') invalid('text is empty');
  if (text.length > MAX_FACT_TEXT) invalid(`text is longer than ${String(MAX_FACT_TEXT)} characters`);
  return text;
}

function labelOf(value: unknown): FactLabel {
  if (value === undefined) return DEFAULT_FACT_LABEL;
  if (value === 'L3') invalid('health, documents and credentials never enter the profile');
  if (!isFactLabel(value)) invalid('label must be L1 or L2');
  return value;
}

/**
 * The scanner and the values of the vault on what may leave (D-107f): the
 * topic always, the text of an L1 fact. The message names the field and the
 * kind of finding, never the text.
 */
function checkLeaving(fact: { topic: string; text: string }, label: FactLabel): void {
  let fields: FactField[];
  try {
    fields = factFieldsToScan(label);
  } catch (error) {
    if (error instanceof PolicyError) invalid(error.message);
    throw error;
  }
  for (const field of fields) {
    const value = fact[field];
    const kinds = [...new Set(scanText(value).map((finding) => finding.kind))];
    if (kinds.length > 0) invalid(`${field} looks like personal data or a secret (${kinds.join(', ')}): not saved`);
    if (knownSecrets.find(value).length > 0) invalid(`${field} holds a value of the vault: not saved`);
  }
}

function conflictOrThrow(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === '23505') throw new FactsError('conflict', 'another fact has this topic');
  throw error;
}

async function load(sql: Queryable, id: string, lock = false): Promise<UserFact> {
  const [row] = await sql.unsafe<UserFact[]>(`SELECT ${COLUMNS} FROM user_facts WHERE id = $1::uuid${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (row === undefined) throw new FactsError('not-found', 'no such fact');
  return row;
}

export async function listUserFacts(sql: Queryable): Promise<UserFact[]> {
  const rows = await sql.unsafe<UserFact[]>(`SELECT ${COLUMNS} FROM user_facts ORDER BY lower(topic), id LIMIT ${String(MAX_FACTS)}`);
  return [...rows];
}

interface Pending {
  factId: string;
  topic: string;
  text: string;
  /** The fact as it was when the proposal was made: changed meanwhile, confirm refuses. */
  was: { topic: string; text: string; updatedAt: string };
  expires: number;
}

export function createUserFacts(sql: Sql, options: UserFactsOptions = {}): UserFacts {
  const now = options.now ?? Date.now;
  const confirmMs = options.confirmMs ?? SHARE_CONFIRM_MS;
  const pending = new Map<string, Pending>();

  return {
    list: () => listUserFacts(sql),

    async create(body) {
      only(body, ['topic', 'text', 'label']);
      const fact = { topic: topicOf(body.topic), text: textOf(body.text) };
      const label = labelOf(body.label);
      checkLeaving(fact, label);
      return sql.begin(async (tx) => {
        const [{ count } = { count: 0 }] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM user_facts`;
        if (count >= MAX_FACTS) invalid(`the profile holds at most ${String(MAX_FACTS)} facts`);
        let id: string;
        try {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO user_facts (topic, text, label) VALUES (${fact.topic}, ${fact.text}, ${label}::privacy_label)
            RETURNING id::text`;
          if (row === undefined) throw new Error('INSERT INTO user_facts returned no row');
          id = row.id;
        } catch (error) {
          conflictOrThrow(error);
        }
        await appendEvent(tx, { kind: 'user_fact.created', label: 'L1', payload: { factId: id, topic: fact.topic, label } });
        return load(tx, id);
      });
    },

    async update(rawId, body) {
      const id = checkId(rawId);
      only(body, ['topic', 'text', 'label']);
      return sql.begin(async (tx) => {
        const current = await load(tx, id, true);
        const next = {
          topic: body.topic === undefined ? current.topic : topicOf(body.topic),
          text: body.text === undefined ? current.text : textOf(body.text),
        };
        const label = body.label === undefined ? current.label : labelOf(body.label);
        if (isFactLowering(current.label, label)) {
          throw new FactsError('needs-confirmation', 'making a fact shareable must be prepared and confirmed');
        }
        checkLeaving(next, label);
        try {
          await tx`UPDATE user_facts SET topic = ${next.topic}, text = ${next.text}, label = ${label}::privacy_label WHERE id = ${id}::uuid`;
        } catch (error) {
          conflictOrThrow(error);
        }
        const fields = [...(next.topic !== current.topic ? ['topic'] : []), ...(next.text !== current.text ? ['text'] : [])];
        await appendEvent(tx, {
          kind: 'user_fact.updated',
          label: 'L1',
          payload: { factId: id, topic: next.topic, from: current.label, to: label, fields },
        });
        return load(tx, id);
      });
    },

    async remove(rawId) {
      const id = checkId(rawId);
      await sql.begin(async (tx) => {
        const current = await load(tx, id, true);
        await tx`SELECT user_fact_delete(${id}::uuid)`;
        await appendEvent(tx, { kind: 'user_fact.deleted', label: 'L1', payload: { factId: id, topic: current.topic, label: current.label } });
      });
    },

    async prepareShare(rawId, body) {
      const id = checkId(rawId);
      only(body, ['topic', 'text']);
      const current = await load(sql, id);
      if (current.label !== 'L2') invalid('this fact is already shareable');
      const fact = {
        topic: body.topic === undefined ? current.topic : topicOf(body.topic),
        text: body.text === undefined ? current.text : textOf(body.text),
      };
      checkLeaving(fact, 'L1');
      // Old proposals go first; past the cap, the oldest one.
      const at = now();
      for (const [key, entry] of pending) if (entry.expires <= at) pending.delete(key);
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      const proposal = randomUUID();
      const expires = at + confirmMs;
      pending.set(proposal, { factId: id, ...fact, was: { topic: current.topic, text: current.text, updatedAt: current.updatedAt }, expires });
      return { id: proposal, expiresAt: new Date(expires).toISOString(), factId: id, topic: fact.topic, text: fact.text, from: 'L2', to: 'L1' };
    },

    async confirmShare(body) {
      only(body, ['id']);
      if (typeof body.id !== 'string') invalid('id must be text');
      const entry = pending.get(body.id);
      // Once only, whatever comes next.
      pending.delete(body.id);
      if (entry === undefined) throw new FactsError('unknown', 'no such confirmation: prepare the change again');
      if (entry.expires <= now()) throw new FactsError('expired', 'the confirmation expired: prepare the change again');
      // Checked again: the vault may have changed since the proposal.
      checkLeaving(entry, 'L1');
      return sql.begin(async (tx) => {
        const current = await load(tx, entry.factId, true);
        if (current.label !== 'L2' || current.updatedAt !== entry.was.updatedAt || current.topic !== entry.was.topic || current.text !== entry.was.text) {
          throw new FactsError('changed', 'the fact changed after the change was prepared: prepare it again');
        }
        // The text of a fact "Solo in casa", written by the user in the settings: a fresh private context.
        const context = createContext('L2', 'L2');
        const item: Labeled<string> = { value: entry.text, label: 'L2', source: 'profile:fact' };
        const approval = await requestDeclassify(tx, item, 'L1', context);
        // The confirmation in the page is the user's approval, given in the web chat.
        await decideApproval(tx, approval.id, 'approved', 'web');
        await appendEvent(tx, { kind: 'approval.decided', label: 'L0', payload: { approvalId: approval.id, state: 'approved', via: 'web' } });
        await applyDeclassifyIn(tx, item, 'L1', approval.id, context);
        try {
          await tx`UPDATE user_facts SET topic = ${entry.topic}, text = ${entry.text}, label = 'L1' WHERE id = ${entry.factId}::uuid`;
        } catch (error) {
          conflictOrThrow(error);
        }
        await appendEvent(tx, {
          kind: 'user_fact.updated',
          label: 'L1',
          payload: { factId: entry.factId, topic: entry.topic, from: 'L2', to: 'L1', approvalId: approval.id },
        });
        return load(tx, entry.factId);
      });
    },
  };
}

/**
 * A fact Arianna proposes (D-114, tappa D; D-213), checked as the page checks
 * a fact "Solo in casa": topic and text within their limits, the topic past
 * the scanner and the values of the vault (it is L1). The error message, for
 * the model, names the field and the kind of finding, never the text.
 */
export function checkProposal(topic: unknown, text: unknown): { topic: string; text: string } | { error: string } {
  try {
    const fact = { topic: topicOf(topic), text: textOf(text) };
    checkLeaving(fact, DEFAULT_FACT_LABEL);
    return fact;
  } catch (error) {
    if (error instanceof FactsError) return { error: error.message };
    throw error;
  }
}

/**
 * Writes an approved proposal of Arianna (an approval of kind `fact`, decided
 * in the web chat), in the decision's transaction: a new fact, or the text of
 * the fact with that topic replaced; either way "Solo in casa" (L2: raising is
 * immediate, never a lowering). Checked again here, the vault may have changed:
 * a proposal that no longer holds, or a full profile, writes nothing (the next
 * step says so). Events with topic and ids, never the text.
 */
export async function applyFactProposal(tx: Queryable, approval: { id: string; kind: string; state: string; detail: Record<string, unknown> }): Promise<boolean> {
  if (approval.kind !== 'fact' || approval.state !== 'approved') return false;
  const checked = checkProposal(approval.detail.topic, approval.detail.text);
  if ('error' in checked) return false;
  const [current] = await tx<{ id: string; label: string }[]>`
    SELECT id::text, label::text AS label FROM user_facts WHERE lower(topic) = lower(${checked.topic}) FOR UPDATE`;
  // Only what the card said: a fact written meanwhile with that topic is never replaced by a proposal shown as new.
  if ((current !== undefined) !== (approval.detail.replaces === true)) return false;
  if (current !== undefined) {
    await tx`UPDATE user_facts SET text = ${checked.text}, label = 'L2' WHERE id = ${current.id}::uuid`;
    await appendEvent(tx, {
      kind: 'user_fact.updated',
      label: 'L1',
      payload: { factId: current.id, topic: checked.topic, from: current.label, to: 'L2', fields: ['text'], approvalId: approval.id },
    });
    return true;
  }
  const [{ count } = { count: 0 }] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM user_facts`;
  if (count >= MAX_FACTS) return false;
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO user_facts (topic, text, label) VALUES (${checked.topic}, ${checked.text}, 'L2') RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO user_facts returned no row');
  await appendEvent(tx, { kind: 'user_fact.created', label: 'L1', payload: { factId: row.id, topic: checked.topic, label: 'L2', approvalId: approval.id } });
  return true;
}
