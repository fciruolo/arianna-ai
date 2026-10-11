// GOD (D-127, G2-G4): a plan in an answer of GOD becomes subtasks, each in a
// clone of its own with the direct chats of the Coder and the Reviewer; the
// tick moves them on from what their chats say. No executor runs here: the
// tasks of the chats are moved by hand, as the engine would.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createConversation, listMessages, loadConversation, writeUserMessage } from '../src/conversations.ts';
import type { DirectPolicy } from '../src/direct-chat.ts';
import { gitEnv } from '../src/git-catalog.ts';
import { createGodApi } from '../src/god/api.ts';
import { carryOf, carryParts } from '../src/god/carry.ts';
import { godPartDir } from '../src/god/clone.ts';
import { createGodWork, GodError } from '../src/god/work.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = { ...gitEnv(process.env, 'file', mkdtempSync(join(tmpdir(), 'arianna-god-githome-'))), GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

/** A fake ARIANNA_HOME on main, with data/ and repos/ ignored. */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'arianna-god-db-'));
  roots.push(home);
  git(home, 'init', '-q');
  writeFileSync(join(home, '.gitignore'), 'data/\nrepos/\n');
  mkdirSync(join(home, 'docs'));
  writeFileSync(join(home, 'docs', 'HANDOFF.md'), '# Consegna\n');
  git(home, 'add', '-A');
  git(home, 'commit', '-q', '-m', 'start');
  return home;
}

/** The tick reads every subtask of the database: the ones of earlier tests are put aside. */
async function fresh(): Promise<void> {
  await db().sql`UPDATE god_subtasks SET state = 'discarded' WHERE state <> 'discarded'`;
}

const policy = (agent: string): DirectPolicy => ({ agent, description: agent, cloud: true, executors: ['claude'], modes: ['work'], project: true });

function setup() {
  const home = fakeHome();
  const parts = (): string[] => {
    const container = join(home, 'repos', 'arianna');
    const found = existsSync(container) ? readdirSync(container).map((name) => `arianna:${name}`) : [];
    return ['arianna:main', ...found];
  };
  const stopped: string[] = [];
  const work = createGodWork({
    sql: db().sql,
    home,
    data: join(home, 'data'),
    parts,
    policy: (agent) => policy(agent),
    models: () => ['sonnet', 'luna'],
    stopTask: (taskId) => {
      stopped.push(taskId);
      return true;
    },
    tickOnApprove: false,
  });
  return { home, work, parts, stopped };
}

const PLAN = [
  'Si fa in due parti.',
  '',
  '```god-plan',
  JSON.stringify({
    title: 'Barra della quota',
    subtasks: [
      { title: 'Calcolo della quota', goal: 'Scrivi il calcolo, con i test.', files: ['apps/core/src/quota.ts', 'apps/core/test/quota.test.ts'], blocked_by: [] },
      { title: 'Barra nella pagina', goal: 'Mostra la barra.', files: ['apps/hud/src/'], blocked_by: [1] },
    ],
  }),
  '```',
].join('\n');

/** A conversation with GOD and an answer of GOD holding `body`. */
async function godAnswer(parts: () => string[], body: string, model = 'luna'): Promise<{ conversationId: string; messageId: string }> {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'work', project: 'arianna:main', projects: parts(), agent: policyFor('god') });
  await sql`UPDATE conversations SET model = ${model} WHERE id = ${conversation.id}`;
  const [message] = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, agent) VALUES (${conversation.id}, 'assistant', 'L1', ${body}, 'god') RETURNING id::text`;
  assert.ok(message !== undefined);
  return { conversationId: conversation.id, messageId: message.id };
}

function policyFor(agent: string): { name: string; modes: ('work' | 'private')[]; project: boolean } {
  return { name: agent, modes: ['work'], project: true };
}

/** What the engine does when an agent answers in its direct chat: the task done, with the agent's message. */
async function answer(conversationId: string, agent: string, body: string): Promise<void> {
  const { sql } = db();
  const [task] = await sql<{ id: string }[]>`SELECT id::text FROM tasks WHERE conversation_id = ${conversationId} ORDER BY created_at DESC, id DESC LIMIT 1`;
  assert.ok(task !== undefined);
  const [message] = await sql<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body, agent, task_id) VALUES (${conversationId}, 'assistant', 'L1', ${body}, ${agent}, ${task.id}) RETURNING id::text`;
  assert.ok(message !== undefined);
  await sql`UPDATE tasks SET status = 'done', evidence = ${sql.json([{ kind: 'message', ref: message.id }])} WHERE id = ${task.id}`;
}

async function subtasks(planId: string): Promise<{ id: string; position: number; part: string; state: string; reason: string | null; review: string | null; conversationId: string | null; reviewConversationId: string | null; commitSha: string | null }[]> {
  return db().sql`
    SELECT id::text, position, part, state, reason, review, conversation_id::text AS "conversationId", review_conversation_id::text AS "reviewConversationId", commit_sha AS "commitSha"
    FROM god_subtasks WHERE plan_id = ${planId} ORDER BY position`;
}

test('a plan of GOD is read by the core from the stored answer, approved once, as queued subtasks', async () => {
  const { work, parts } = setup();
  const { messageId } = await godAnswer(parts, PLAN);
  const shown = await work.messagePlan(messageId);
  assert.equal(shown.proposal?.title, 'Barra della quota');
  assert.equal(shown.approved, undefined);
  const plan = await work.approve(messageId);
  assert.equal(plan.model, 'luna', 'the subtasks start on the model of GOD\'s chat');
  assert.equal(plan.subtasks.length, 2);
  assert.match(plan.subtasks[0]?.part ?? '', /^g\d{3}-calcolo-della-quota$/);
  await assert.rejects(work.approve(messageId), (error: unknown) => error instanceof GodError && error.code === 'conflict');
  // Two clicks at once on another plan: one approves, the other is told it is approved (never a 500).
  const twice = await godAnswer(parts, PLAN);
  const both = await Promise.allSettled([work.approve(twice.messageId), work.approve(twice.messageId)]);
  assert.equal(both.filter((result) => result.status === 'fulfilled').length, 1);
  const lost = both.find((result) => result.status === 'rejected');
  assert.ok(lost?.status === 'rejected' && lost.reason instanceof GodError && lost.reason.code === 'conflict');
  assert.equal((await work.messagePlan(messageId)).approved?.id, plan.id);
});

test('only an answer of GOD in a conversation with GOD carries a plan; a broken plan is refused with why', async () => {
  const { work, parts } = setup();
  const { sql } = db();
  const coderChat = await createConversation(sql, { mode: 'work', project: 'arianna:main', projects: parts(), agent: policyFor('coder') });
  const [other] = await sql<{ id: string }[]>`INSERT INTO messages (conversation_id, role, label, body, agent) VALUES (${coderChat.id}, 'assistant', 'L1', ${PLAN}, 'coder') RETURNING id::text`;
  await assert.rejects(work.approve(other?.id ?? ''), (error: unknown) => error instanceof GodError && error.code === 'not-found');
  await assert.rejects(work.messagePlan('not-a-number'), GodError);
  const broken = await godAnswer(parts, 'x\n```god-plan\n{"title":"t","subtasks":[{"title":"a","goal":"g","files":["a.ts"],"blocked_by":[]},{"title":"b","goal":"g","files":["a.ts"],"blocked_by":[]}]}\n```');
  assert.match((await work.messagePlan(broken.messageId)).error ?? '', /stessi file/);
  await assert.rejects(work.approve(broken.messageId), /stessi file/);
});

/** The subtask at `position` of a plan, as the database holds it now. */
async function at(planId: string, position: number): Promise<SubtaskRow> {
  const row = (await subtasks(planId)).find((item) => item.position === position);
  assert.ok(row !== undefined);
  return row;
}

type SubtaskRow = Awaited<ReturnType<typeof subtasks>>[number];

/** A column that must be set by now. */
function set(value: string | null): string {
  assert.ok(value !== null);
  return value;
}

test('the tick starts a subtask in its own clone with the Coder, then the Reviewer, and reads the verdict', async () => {
  await fresh();
  const { home, work, parts } = setup();
  const { sql } = db();
  const { messageId } = await godAnswer(parts, PLAN);
  const plan = await work.approve(messageId);
  await work.tick();
  let first = await at(plan.id, 1);
  let second = await at(plan.id, 2);
  assert.equal(first.state, 'working');
  assert.equal(git(godPartDir(home, first.part), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), `god/${first.part}`);
  assert.equal(second.state, 'queued', 'it waits for the first to be merged into main');
  assert.match(second.reason ?? '', /aspetta «Calcolo della quota»/);
  const coderChat = set(first.conversationId);
  const chat = await loadConversation(sql, coderChat);
  assert.ok(chat !== undefined);
  assert.equal(chat.agent, 'coder');
  assert.equal(chat.workspace, `arianna:${first.part}`);
  assert.equal(chat.model, 'luna');
  const [brief] = await listMessages(sql, coderChat, { limit: 5 });
  assert.match(brief?.body ?? '', /Sottocompito 1 di 2 del piano «Barra della quota»/);

  await answer(coderChat, 'coder', 'Fatto, test verdi.');
  await work.tick();
  first = await at(plan.id, 1);
  assert.equal(first.state, 'reviewing');
  const reviewChat = set(first.reviewConversationId);
  assert.equal((await loadConversation(sql, reviewChat))?.agent, 'reviewer');

  await answer(reviewChat, 'reviewer', 'ESITO: da correggere\n- manca un test');
  await work.tick();
  first = await at(plan.id, 1);
  assert.equal(first.state, 'reviewed');
  assert.equal(first.review, 'changes');

  // The user asks the Coder for the fix: the work is on again, then a new review in the same chat of the Reviewer.
  await sql.begin((tx) => writeUserMessage(tx, coderChat, 'Aggiungi il test che manca.'));
  await work.tick();
  assert.equal((await at(plan.id, 1)).state, 'working');
  await answer(coderChat, 'coder', 'Aggiunto.');
  await work.tick();
  first = await at(plan.id, 1);
  assert.equal(first.state, 'reviewing');
  assert.equal(first.reviewConversationId, reviewChat);
  await answer(reviewChat, 'reviewer', 'ESITO: approvato');
  await work.tick();
  first = await at(plan.id, 1);
  assert.equal(first.review, 'ok');

  // "Prepara il ramo": the core commits on the subtask's branch; once merged in main, the second one starts.
  const clone = godPartDir(home, first.part);
  writeFileSync(join(clone, 'quota.txt'), 'fake\n');
  const branch = await work.prepareBranch(first.id);
  assert.equal(branch.state, 'branch');
  assert.match(branch.commitSha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(branch.merged, false);
  const sha = branch.commitSha ?? '';
  assert.deepEqual(branch.mergeCommands, [`git fetch repos/arianna/${first.part} god/${first.part}`, `git diff --stat main...${sha}`, `git merge --no-ff ${sha}`]);
  git(home, 'fetch', '-q', clone, `god/${first.part}`);
  git(home, 'merge', '-q', '--no-ff', '-m', 'merge', sha);
  await work.tick();
  second = await at(plan.id, 2);
  assert.equal(second.state, 'working');
});

test('a Coder that does not finish asks for the user; Ferma, Riprendi and Scarta', async () => {
  await fresh();
  const { home, work, parts, stopped } = setup();
  const { sql } = db();
  const { messageId } = await godAnswer(parts, PLAN.replace('"blocked_by":[1]', '"blocked_by":[]'));
  const plan = await work.approve(messageId);
  await work.tick();
  const first = await at(plan.id, 1);
  assert.equal(first.state, 'working');
  const coderChat = set(first.conversationId);
  await sql`UPDATE tasks SET status = 'running' WHERE conversation_id = ${coderChat}`;
  const halted = await work.stop(first.id);
  assert.equal(halted.state, 'stopped');
  assert.equal(stopped.length, 1, 'the running step is stopped');
  await sql`UPDATE tasks SET status = 'failed' WHERE conversation_id = ${coderChat}`;
  const resumed = await work.resume(first.id);
  assert.equal(resumed.state, 'working');
  await sql`UPDATE tasks SET status = 'waiting_user', waiting_reason = 'serve una risposta' WHERE conversation_id = ${coderChat}`;
  await work.tick();
  assert.equal((await at(plan.id, 1)).state, 'attention');
  const dir = godPartDir(home, first.part);
  assert.equal(existsSync(dir), true);
  const gone = await work.discard(first.id);
  assert.equal(gone.state, 'discarded');
  assert.equal(existsSync(dir), false);
  await assert.rejects(work.discard(first.id), GodError);
});

test('the page of GOD lists its conversations and the quota', async () => {
  const { home, parts } = setup();
  const { sql } = db();
  const { conversationId } = await godAnswer(parts, 'Una risposta qualsiasi.');
  const api = createGodApi({ sql, home, data: join(home, 'data'), projects: () => [], available: () => true });
  const status = await api.status();
  assert.equal(status.project, 'missing');
  assert.equal(status.main.exists, false);
  assert.ok(status.conversations.some((item) => item.id === conversationId));
  assert.ok(status.quota.concurrency >= 1);
});

test('"Riassumi e riparti": a new conversation with GOD, same part and model, with the summary of the old one for its first session', async () => {
  const { work, parts } = setup();
  const { sql } = db();
  const { conversationId, messageId } = await godAnswer(parts, `Ecco come.\n${PLAN}`);
  await work.approve(messageId);
  await sql`INSERT INTO messages (conversation_id, role, label, body) VALUES (${conversationId}, 'user', 'L1', 'Aggiungi la barra della quota')`;
  const next = await work.restart(conversationId);
  assert.notEqual(next.id, conversationId);
  assert.equal(next.agent, 'god');
  assert.equal(next.workspace, 'arianna:main');
  assert.equal(next.model, 'luna');
  assert.match(next.title ?? '', /^Ripresa:/);
  const carry = await carryOf(sql, next.id);
  assert.ok(carry !== undefined);
  assert.equal(carry.label, 'L1');
  assert.equal(carry.from, conversationId);
  assert.match(carry.body, /Aggiungi la barra della quota/);
  assert.match(carry.body, /Ecco come\./);
  assert.doesNotMatch(carry.body, /god-plan/, 'the plan block is told as its subtasks, not as JSON');
  assert.match(carry.body, /Plan «Barra della quota»:\n- 1\. Calcolo della quota — /);
  const parts2 = await carryParts(sql, next.id);
  assert.equal(parts2.length, 2);
  assert.equal(parts2[0]?.label, 'L0');
  assert.deepEqual(await carryParts(sql, conversationId), [], 'the old conversation carries nothing');
  // Only a conversation with GOD restarts; an empty one has nothing to summarize.
  const coderChat = await createConversation(sql, { mode: 'work', project: 'arianna:main', projects: parts(), agent: policyFor('coder') });
  await assert.rejects(work.restart(coderChat.id), (error: unknown) => error instanceof GodError && error.code === 'not-found');
  const empty = await createConversation(sql, { mode: 'work', project: 'arianna:main', projects: parts(), agent: policyFor('god') });
  await assert.rejects(work.restart(empty.id), (error: unknown) => error instanceof GodError && error.code === 'invalid');
  assert.equal(await work.carry(conversationId), null);
});

test('deleting a conversation with GOD: the plan stays unlinked, the summaries go (purge and erase)', async () => {
  await fresh();
  const { work, parts } = setup();
  const { sql } = db();
  // "Elimina" from the archive (purge_conversation, 0026): the texts go, the row stays.
  const first = await godAnswer(parts, `Ecco.\n${PLAN}`);
  const plan = await work.approve(first.messageId);
  const restarted = await work.restart(first.conversationId);
  await sql`UPDATE conversations SET archived_at = now() WHERE id = ${first.conversationId}`;
  await sql`SELECT purge_conversation(${first.conversationId})`;
  const [kept] = await sql<{ conversationId: string | null; messageId: string | null }[]>`
    SELECT conversation_id::text AS "conversationId", message_id::text AS "messageId" FROM god_plans WHERE id = ${plan.id}`;
  assert.ok(kept !== undefined);
  assert.equal(kept.messageId, null, 'the message is gone, the plan stays');
  assert.equal(kept.conversationId, first.conversationId);
  assert.equal(await carryOf(sql, restarted.id), undefined, 'the summary quoting a deleted conversation goes with it');

  // "Elimina" for good (erase_conversation, 0043): the rows go, the plan and its subtasks stay unlinked.
  const second = await godAnswer(parts, `Ecco.\n${PLAN}`);
  const other = await work.approve(second.messageId);
  await work.tick();
  const started = await at(other.id, 1);
  const coderChat = set(started.conversationId);
  const again = await work.restart(second.conversationId);
  await sql`SELECT erase_conversation(${second.conversationId})`;
  await sql`SELECT erase_conversation(${coderChat})`;
  const [unlinked] = await sql<{ conversationId: string | null; messageId: string | null }[]>`
    SELECT conversation_id::text AS "conversationId", message_id::text AS "messageId" FROM god_plans WHERE id = ${other.id}`;
  assert.ok(unlinked !== undefined);
  assert.equal(unlinked.conversationId, null);
  assert.equal(unlinked.messageId, null);
  assert.equal(await carryOf(sql, again.id), undefined);
  assert.equal((await at(other.id, 1)).conversationId, null);
  await work.tick();
  assert.equal((await at(other.id, 1)).state, 'attention', 'a subtask whose chat was erased asks for the user');
});

test('«Prepara il ramo» does not commit a .gitignore, a link or what the installation ignores: the subtask asks for the user', async () => {
  await fresh();
  const { home, work, parts } = setup();
  const { sql } = db();
  // What the installation ignores: data/, repos/ and, here, kb/inbox/.
  writeFileSync(join(home, '.gitignore'), 'data/\nrepos/\nkb/inbox/\n');
  git(home, 'commit', '-q', '-am', 'ignore kb/inbox');
  const { messageId } = await godAnswer(parts, PLAN.replace('"blocked_by":[1]', '"blocked_by":[]'));
  const plan = await work.approve(messageId);
  await work.tick();
  const first = await at(plan.id, 1);
  const coderChat = set(first.conversationId);
  await answer(coderChat, 'coder', 'Fatto.');
  await sql`UPDATE god_subtasks SET state = 'reviewed' WHERE id = ${first.id}`;
  const clone = godPartDir(home, first.part);
  const head = git(clone, 'rev-parse', 'HEAD').trim();
  for (const [path, write] of [
    ['kb/inbox/nota.md', () => {
      // The clone's own .gitignore was copied from the installation: changed by the Coder, it lets the file in.
      writeFileSync(join(clone, '.gitignore'), 'data/\nrepos/\n');
      mkdirSync(join(clone, 'kb', 'inbox'), { recursive: true });
      writeFileSync(join(clone, 'kb', 'inbox', 'nota.md'), 'privata finta\n');
    }],
    ['link', () => {
      symlinkSync('/etc/hosts', join(clone, 'link'));
    }],
  ] as const) {
    write();
    const refused = await work.prepareBranch(first.id);
    assert.equal(refused.state, 'attention', path);
    assert.match(refused.reason ?? '', /ramo non preparato/);
    assert.equal(git(clone, 'rev-parse', 'HEAD').trim(), head, 'nothing committed');
    assert.equal(git(clone, 'diff', '--cached', '--name-only').trim(), '', 'nothing left staged');
    rmSync(join(clone, path), { recursive: true, force: true });
    git(clone, 'checkout', '--', '.gitignore');
  }
  // Only code: committed.
  writeFileSync(join(clone, 'quota.txt'), 'fake\n');
  const ready = await work.prepareBranch(first.id);
  assert.equal(ready.state, 'branch');
  assert.notEqual(git(clone, 'rev-parse', 'HEAD').trim(), head);
});
