// `im.add` from any conversation of Arianna (D-167, P4b): in a work
// conversation the item is written at once; from a step that read more than
// the IM holds (a private conversation), the user confirms the exact text in
// the web chat first, and only an approval writes it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { createLabelRules } from '@arianna/policy';

import { loadApproval } from '../src/approvals.ts';
import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, recordDecision, STEP_QUEUE } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import type { ImToolEnv } from '../src/orchestrator/im-tool.ts';
import { requestIm } from '../src/orchestrator/im-step.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = committedAgents(HOME);
const OPTIONS = { allowedActions: () => agents.get('arianna')?.card.approvals ?? [], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const kb = createKb({ home: HOME, rules: RULES });

// A fake container, fake data only.
const ROOT = join(HOME, 'data', 'test-tmp', `im-confirm-${randomUUID()}`);
const BOX = join(ROOT, 'repos', 'progetto-test');
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});
function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}
write(BOX, {
  'IM/IM-33.md': '---\nim: 33\ndata: 2026-10-15 10:00\nstato: previsto\n---\n\n# IM-33\n\n## Lavori\n\n- [ ] Fatture\n',
  'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n',
});
mkdirSync(join(ROOT, 'arianna', 'kb'), { recursive: true });
const PROJECTS: Project[] = [{ name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' }];
const IMS: ImToolEnv = {
  projects: () => PROJECTS,
  knowledge: { home: join(ROOT, 'arianna'), rules: createLabelRules({ folders: [], sources: [] }) },
  now: () => new Date(2026, 9, 10, 9, 0),
};
const im = (number: number): string => readFileSync(join(BOX, 'IM', `IM-${String(number)}.md`), 'utf8');

function scripted(answers: Answer[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = JSON.stringify(request.schema?.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

async function drain(taskId: string, model: LocalModel): Promise<string[]> {
  const executor = createOrchestrator({
    sql: db().sql,
    agents,
    kb,
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() } }),
    rules: RULES,
    ims: IMS,
  });
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (job.payload.taskId !== taskId) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

async function answers(taskId: string): Promise<{ body: string; label: string }[]> {
  return db().sql<{ body: string; label: string }[]>`SELECT body, label FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id`;
}

async function pendingOf(taskId: string) {
  const task = await loadTask(db().sql, taskId);
  assert.equal(task?.status, 'waiting_user');
  assert.ok(task.waitingApprovalId !== null);
  const approval = await loadApproval(db().sql, task.waitingApprovalId);
  assert.ok(approval !== undefined);
  return approval;
}

test('in a work conversation the item is written at once and the model reads where it went', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per questo IM di progetto-test: il pagamento');
  const model = scripted([
    { action: 'call', tool: 'im.add', arguments: { project: 'progetto-test', title: 'Pagamento', which: 'current' } },
    { action: 'reply', text: 'Fatto.' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  assert.match(im(33), /- \[ \] Pagamento\n/);
  assert.match(JSON.stringify(model.requests[1]?.messages), /Aggiunta a IM-33 \(giovedì 15 ottobre 2026, 10:00\) di progetto-test: Pagamento/);
  const [approvals] = await db().sql<{ count: number }[]>`SELECT count(*)::int AS count FROM approvals WHERE task_id = ${task.id}`;
  assert.equal(approvals?.count, 0);
});

test('from a private conversation: the exact text confirmed in the web chat, then written by the code', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per il prossimo IM di progetto-test dobbiamo fare la migrazione');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { project: 'progetto-test', title: 'Migrazione database' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.deepEqual([approval.kind, approval.action, approval.label], ['im', 'im.add', 'L2']);
  assert.deepEqual(approval.detail, {
    project: 'progetto-test',
    which: 'next',
    number: 34,
    date: '2026-10-22 10:00',
    dateText: 'giovedì 22 ottobre 2026, 10:00',
    imLabel: 'L1',
    title: 'Migrazione database',
    step: 1,
  });
  // Nothing written while it waits; the events never carry the text.
  assert.equal(existsSync(join(BOX, 'IM', 'IM-34.md')), false);
  const events = await db().sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE task_id = ${task.id}`;
  assert.ok(events.every((event) => !JSON.stringify(event.payload).includes('Migrazione')));

  // Only the web chat decides it.
  await assert.rejects(recordDecision(db().sql, approval.id, 'approved', 'telegram'), /approvals_im_via_web/);
  await recordDecision(db().sql, approval.id, 'approved', 'web');
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal(model.requests.length, 1);
  assert.match(im(34), /- \[ \] Migrazione database\n/);
  const [reply] = await answers(task.id);
  assert.deepEqual(reply, { body: 'Aggiunta a IM-34 (giovedì 22 ottobre 2026, 10:00) di progetto-test: Migrazione database.', label: 'L2' });
});

test('a rejected confirmation writes nothing', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per questo IM di progetto-test: il cambio di banca');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { project: 'progetto-test', title: 'Cambio di banca', which: 'current' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const before = im(33);
  const approval = await pendingOf(task.id);
  await recordDecision(db().sql, approval.id, 'rejected', 'web');
  assert.deepEqual(await drain(task.id, model), ['answered']);
  assert.equal(im(33), before);
  const [reply] = await answers(task.id);
  assert.equal(reply?.body, 'Va bene, non scrivo «Cambio di banca» nell’IM-33 di progetto-test.');
});

test('the database: L2 at least, a task, the action im.add, one pending per step', async () => {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Prova');
  const proposal = { project: 'progetto-test', which: 'next' as const, number: 34, date: '2026-10-22 10:00', dateText: 'giovedì 22 ottobre 2026, 10:00', imLabel: 'L1' as const, title: 'Prova' };
  await requestIm(db().sql, { taskId: task.id, step: 7, label: 'L1', proposal });
  await assert.rejects(requestIm(db().sql, { taskId: task.id, step: 7, label: 'L2', proposal }), /approvals_im_pending_step_idx/);
  await assert.rejects(db().sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'im', 'im.add', '{}', 'L1')`, /approvals_im_fields/);
  await assert.rejects(db().sql`INSERT INTO approvals (kind, action, detail, label) VALUES ('im', 'im.add', '{}', 'L2')`, /approvals_im_fields/);
  await assert.rejects(db().sql`INSERT INTO approvals (task_id, kind, action, detail, label) VALUES (${task.id}, 'im', 'kb.write', '{}', 'L2')`, /approvals_im_fields/);
});

// "Per il prossimo IM del cliente Rossi…" (I-17 S3, D-173): the client's project, read at the client's label.
async function rossi(): Promise<void> {
  const [found] = await db().sql<{ id: string }[]>`SELECT id::text FROM clients WHERE display_name = 'Pasticceria Finta Rossi Srl'`;
  if (found !== undefined) return;
  const [client] = await db().sql<{ id: string }[]>`INSERT INTO clients (display_name) VALUES ('Pasticceria Finta Rossi Srl') RETURNING id::text`;
  if (client === undefined) throw new Error('no client');
  await db().sql`INSERT INTO client_projects (client_id, project) VALUES (${client.id}::uuid, 'progetto-test')`;
}

test('a client in place of the project: in a private conversation its project, confirmed first', async () => {
  await rossi();
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per il prossimo IM del cliente Rossi la pagina del dettaglio clienti');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { client: 'Rossi', title: 'Pagina del dettaglio clienti' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.equal(approval.kind, 'im');
  assert.equal(approval.detail.project, 'progetto-test');
  assert.equal(approval.detail.title, 'Pagina del dettaglio clienti');
});

test('a client in place of the project: a work conversation cannot read the clients and writes nothing', async () => {
  await rossi();
  const before = im(33);
  const conversation = await createConversation(db().sql, { mode: 'work' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per questo IM del cliente Rossi: il logo');
  const model = scripted([
    { action: 'call', tool: 'im.add', arguments: { client: 'Rossi', title: 'Logo', which: 'current' } },
    { action: 'reply', text: 'Di quale progetto?' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  assert.match(JSON.stringify(model.requests[1]?.messages), /non posso leggere i clienti/);
  assert.doesNotMatch(JSON.stringify(model.requests[1]?.messages), /Pasticceria/);
  assert.equal(im(33), before);
});

test('a client named the project: the approval and the answer once decided keep the label of the client', async () => {
  await rossi();
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per il prossimo IM del cliente Rossi: le vetrine');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { client: 'cliente Rossi', title: 'Vetrine' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.deepEqual([approval.label, approval.detail.readLabel, approval.detail.project], ['L2', 'L2', 'progetto-test']);
  await recordDecision(db().sql, approval.id, 'approved', 'web');
  assert.deepEqual(await drain(task.id, model), ['answered']);
  const [reply] = await answers(task.id);
  assert.equal(reply?.label, 'L2');
  assert.match(im(34), /- \[ \] Vetrine\n/);
});

test('a client said as the project ("Rossi") is tried as a client in a private conversation', async () => {
  await rossi();
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per il prossimo IM di Rossi: il menu');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { project: 'Rossi', title: 'Menu' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.deepEqual([approval.detail.project, approval.detail.title], ['progetto-test', 'Menu']);
});

test('the model leaves the client out: "del cliente Rossi" in the user\'s message is used', async () => {
  await rossi();
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Segna che per il prossimo IM del cliente Rossi dobbiamo fare il carrello');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { title: 'Carrello' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.deepEqual([approval.detail.project, approval.detail.title, approval.detail.readLabel], ['progetto-test', 'Carrello', 'L2']);
});

test('a project heard in an older message of a work conversation is never written without the user\'s yes', async () => {
  const before = im(33);
  const conversation = await createConversation(db().sql, { mode: 'work' });
  // An older message of the conversation, about something else (its task is left in the queue: drain skips it).
  await postUserMessage(db().sql, conversation.id, 'Com\'è andata la riunione di progetto-test?');
  const { task } = await postUserMessage(db().sql, conversation.id, 'Segna per questo IM: rivedere le fatture');
  const model = scripted([{ action: 'call', tool: 'im.add', arguments: { title: 'Rivedere le fatture', which: 'current' } }]);
  assert.deepEqual(await drain(task.id, model), ['waiting-approval']);
  const approval = await pendingOf(task.id);
  assert.equal(approval.detail.project, 'progetto-test');
  assert.equal(im(33), before);
});

test('a message the user sent after the task began is not looked at', async () => {
  await rossi();
  const conversation = await createConversation(db().sql, { mode: 'private' });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Per il prossimo IM: il logo');
  await postUserMessage(db().sql, conversation.id, 'ah, è del cliente Rossi');
  const model = scripted([
    { action: 'call', tool: 'im.add', arguments: { title: 'Logo' } },
    { action: 'reply', text: 'Di quale progetto?' },
  ]);
  assert.deepEqual(await drain(task.id, model), ['continued', 'answered']);
  assert.match(JSON.stringify(model.requests[1]?.messages), /manca il progetto/);
});
