import type { Project } from '@arianna/config';
import { anonymize, anonymizeInput, MAX_ANONYMIZE_TEXT, type AnonymizeFailure, type LocalModel } from '@arianna/executors';
import { createContext, scanText, type FindingKind, type Labeled } from '@arianna/policy';

import { decideApproval, requestDeclassify } from './approvals.ts';
import { writeUserMessage } from './conversations.ts';
import type { Queryable, Sql } from './db/client.ts';
import { MAX_DECLASSIFY_LENGTH } from './engine.ts';
import { appendEvent } from './events.ts';
import { applyDeclassifyIn, passGateway } from './gateway.ts';
import { modelUnavailable } from './organize.ts';
import { readProjectNote, type KnowledgeEnv } from './project-knowledge.ts';

/**
 * The exceptional release of a private note (I-11, tappa P5, D-187). Never
 * automatic: the user opens a Private (L2) note of a project, the local model
 * proposes an anonymous version, the user reads it beside the original and
 * corrects it, chooses a work conversation of the same project and approves
 * with the master password. Only that text leaves, once: a declassify
 * approval for its sha256 (L2 → L1), decided at once, its label_changes row,
 * and the message in the conversation, all in one transaction. The note stays
 * Private. Reserved (L3) notes and finance data never leave (D-183): the
 * policy refuses both, and the note is read again here, by the core.
 */

/** How the master password compares with the hash in the vault. */
export type PasswordCheck = 'ok' | 'wrong' | 'unset';

export interface ReleaseEnv {
  sql: Sql;
  model: () => LocalModel;
  projects: () => readonly Project[];
  knowledge: KnowledgeEnv;
  /** Compares a password with `master-password-hash` of the vault; never stores nor logs it. */
  checkPassword: (password: string) => Promise<PasswordCheck>;
  /** For the tests: the clock of the lock after wrong passwords. */
  now?: () => number;
}

export type ReleaseErrorCode = 'invalid' | 'not-private' | 'changed' | 'no-password' | 'wrong-password' | 'locked' | 'target' | 'busy';

export class ReleaseError extends Error {
  override name = 'ReleaseError';
  readonly code: ReleaseErrorCode;

  constructor(code: ReleaseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Wrong passwords in a row before the release locks, and for how long. */
export const MAX_WRONG_PASSWORDS = 5;
export const LOCK_MS = 10 * 60_000;

export interface ReleaseTarget {
  id: string;
  title: string | null;
  /** The project or `<project>:<part>` of the conversation. */
  workspace: string;
  /** Null for a conversation with Arianna; the agent of a direct chat. */
  agent: string | null;
}

/**
 * `warnings`: what the scanner still finds in the proposal (IBAN, tax code…):
 * the page says so, and a work conversation refuses such a text anyway.
 */
export type ProposalOutcome = { ok: true; text: string; model: string; version: string; warnings: FindingKind[] } | { ok: false; reason: AnonymizeFailure | 'blocked' | 'unavailable'; version: string };

export interface ReleaseInput {
  path: string;
  /** The version of the note the user saw beside the text. */
  version: string;
  /** The exact text that leaves. */
  text: string;
  conversationId: string;
  password: string;
}

export interface NoteReleaser {
  targets(project: string): Promise<ReleaseTarget[]>;
  propose(project: string, path: string, signal?: AbortSignal): Promise<ProposalOutcome>;
  release(project: string, input: ReleaseInput): Promise<{ conversationId: string; messageId: string; approvalId: string }>;
}

/** A Private note of the tab Conoscenza, read by the core: anything else is refused. */
function privateNote(env: ReleaseEnv, project: string, path: string): { body: string; version: string } {
  const note = readProjectNote(env.projects(), project, env.knowledge, path);
  if (note.label !== 'L2') {
    throw new ReleaseError('not-private', note.label === 'L3' ? 'a Reserved note never leaves' : 'only a Private note is released this way: this one is not Private');
  }
  return { body: note.body, version: note.version };
}

/** The work conversations of `project` (or of one of its parts) a released text may go to. */
export async function releaseTargets(sql: Queryable, project: string, conversationId?: string): Promise<ReleaseTarget[]> {
  const rows = await sql<ReleaseTarget[]>`
    SELECT c.id::text, c.title, c.workspace, c.agent FROM conversations c
    WHERE c.mode = 'work' AND c.purged_at IS NULL AND c.archived_at IS NULL AND NOT c.finance AND NOT c.incognito
      AND c.workspace IS NOT NULL AND (c.workspace = ${project} OR left(c.workspace, ${project.length + 1}) = ${`${project}:`})
      ${conversationId === undefined ? sql`` : sql`AND c.id = ${conversationId}::uuid`}
    ORDER BY (SELECT max(m.ts) FROM messages m WHERE m.conversation_id = c.id) DESC NULLS LAST, c.created_at DESC
    LIMIT 100`;
  return [...rows];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createNoteReleaser(env: ReleaseEnv): NoteReleaser {
  const now = env.now ?? Date.now;
  let wrong = 0;
  let lockedUntil = 0;
  let checking = false;

  return {
    targets: (project) => releaseTargets(env.sql, project),

    async propose(project, path, signal) {
      const note = privateNote(env, project, path);
      if (note.body.trim() === '') throw new ReleaseError('invalid', 'the note has no text');
      if (note.body.length > MAX_ANONYMIZE_TEXT) return { ok: false, reason: 'too-large', version: note.version };
      // Private text to the local model: the gateway logs it, nothing goes to the cloud.
      const decision = await passGateway(
        env.sql,
        [{ value: anonymizeInput(note.body), label: 'L2', source: `project:${project}:knowledge` }],
        createContext('L2', 'L2'),
        { kind: 'executor', id: 'local', locality: 'local' },
      );
      if (decision.decision !== 'allow') return { ok: false, reason: 'blocked', version: note.version };
      const outcome = await anonymize(env.model(), decision.texts.join('\n'), signal === undefined ? {} : { signal });
      if (outcome.ok) return { ok: true, text: outcome.text, model: outcome.model, version: note.version, warnings: [...new Set(scanText(outcome.text).map((finding) => finding.kind))] };
      if (outcome.reason === 'model-error' && modelUnavailable(outcome.error)) return { ok: false, reason: 'unavailable', version: note.version };
      return { ok: false, reason: outcome.reason, version: note.version };
    },

    async release(project, input) {
      const text = input.text;
      if (typeof text !== 'string' || text.trim() === '') throw new ReleaseError('invalid', 'the text to release is empty');
      if (text.length > MAX_DECLASSIFY_LENGTH) throw new ReleaseError('invalid', `the text to release is longer than ${String(MAX_DECLASSIFY_LENGTH)} characters`);
      if (!UUID.test(input.conversationId)) throw new ReleaseError('target', 'choose a work conversation of the project');
      if (now() < lockedUntil) throw new ReleaseError('locked', 'too many wrong passwords: try again in a few minutes');
      // One check at a time: requests in parallel would each try a password before the lock counts them.
      if (checking) throw new ReleaseError('busy', 'another release is being checked: wait for it');
      checking = true;
      let checked: PasswordCheck;
      try {
        checked = await env.checkPassword(input.password);
      } finally {
        checking = false;
      }
      if (checked === 'unset') throw new ReleaseError('no-password', 'no master password in the vault: set it with pnpm vault:master and pnpm vault:edit');
      if (checked === 'wrong') {
        wrong += 1;
        if (wrong >= MAX_WRONG_PASSWORDS) {
          wrong = 0;
          lockedUntil = now() + LOCK_MS;
        }
        throw new ReleaseError('wrong-password', 'wrong master password');
      }
      wrong = 0;

      // Read again after the password: the note the user saw, still Private.
      const note = privateNote(env, project, input.path);
      if (note.version !== input.version) throw new ReleaseError('changed', 'the note changed after it was opened: open it again');

      return env.sql.begin(async (tx) => {
        const [target] = await releaseTargets(tx, project, input.conversationId);
        if (target === undefined) throw new ReleaseError('target', 'choose a work conversation of the project');
        // A fresh context of the note: Private, never finance (the tab holds no finance data).
        const context = createContext('L2', 'L2');
        const item: Labeled<string> = { value: text, label: 'L2', source: `project:${project}:knowledge` };
        const approval = await requestDeclassify(tx, item, 'L1', context);
        // The master password is the user's approval, given in the web chat.
        await decideApproval(tx, approval.id, 'approved', 'web');
        await appendEvent(tx, { kind: 'approval.decided', label: 'L0', payload: { approvalId: approval.id, state: 'approved', via: 'web' } });
        const lowered = await applyDeclassifyIn(tx, item, 'L1', approval.id, context);
        const { message, task } = await writeUserMessage(tx, target.id, lowered.value, { channel: 'web' });
        await appendEvent(tx, {
          kind: 'note.released',
          taskId: task.id,
          label: 'L0',
          payload: { project, approvalId: approval.id, conversationId: target.id, messageId: message.id },
        });
        return { conversationId: target.id, messageId: message.id, approvalId: approval.id };
      });
    },
  };
}

/** Why a release was refused, for the page: a closed list. */
export const RELEASE_STATUS: Record<ReleaseErrorCode, number> = {
  invalid: 400,
  'not-private': 403,
  changed: 409,
  'no-password': 503,
  'wrong-password': 403,
  locked: 429,
  target: 400,
  busy: 409,
};

