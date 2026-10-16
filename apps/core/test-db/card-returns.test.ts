// «Rimanda» (D-235), with the database: an agent's card in Da verificare goes
// back to work with the user's note, on the local model or on Claude, with its
// earlier report; the note keeps the label the user chose for it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { loadApproval } from '../src/approvals.ts';
import { cardDetail } from '../src/card-details.ts';
import { createCard, sendBackCard, startCard, updateCard } from '../src/cardwall.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { createTask, loadTask, type Task } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `card-returns-${randomUUID()}`);
const REPO = join(HOME, 'repos', 'site');
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const BASE = loadConfig();
const PROJECTS = ['site'];
const agents = new Map<string, LoadedAgent>(committedAgents(ROOT));
const OPTIONS = {
  allowedActions: () => [] as readonly string[],
  agentLimits: (task: Task) => {
    const limits = agents.get(task.assignee)?.card.limits;
    return { maxSteps: limits?.maxSteps ?? 30, maxMinutes: limits?.maxMinutes ?? 20 };
  },
};
const NAMES = { projects: PROJECTS, agents: ['coder', 'designer', 'reviewer'] };

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

before(() => {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'README.md'), '# Fake site\n');
  writeFileSync(join(REPO, '.gitignore'), '.fake-claude.json\n');
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

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

function orchestrator(model: LocalModel, cloud: 'claude'[] = []): StepExecutor {
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: cloud, models: defaultCloudModels() },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
  });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES, ...(cloud.length > 0 ? { claude } : {}) });
}

async function drain(taskIds: readonly string[], executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 30; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (typeof job.payload.taskId !== 'string' || !taskIds.includes(job.payload.taskId)) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

async function chooseExecutor(taskId: string, choice: 'claude' | 'local', options: string[]): Promise<void> {
  const task = await loadTask(db().sql, taskId);
  assert.equal(task?.status, 'waiting_user');
  assert.ok(task.waitingApprovalId !== null);
  const approval = await loadApproval(db().sql, task.waitingApprovalId);
  assert.ok(approval !== undefined);
  assert.deepEqual(approval.detail.options, options);
  await recordDecision(db().sql, approval.id, 'approved', 'web', choice);
}

test('«Rimanda» on the local model: the agent reads its answer and then the note; the note stays in the card (D-235)', async () => {
  const card = await createCard(db().sql, { title: 'Grafica della pagina contatti', assignee: 'designer', project: 'site', goal: 'Una pagina semplice.' }, NAMES);
  await startCard(db().sql, card.id);
  const model = scripted([
    { action: 'reply', text: 'Proposta: intestazione verde e modulo.' },
    { action: 'reply', text: 'Proposta rifatta coi colori del DESIGN.md.' },
  ]);
  const executor = orchestrator(model, ['claude']);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  await chooseExecutor(card.id, 'local', ['local']);
  assert.deepEqual(await drain([card.id], executor), ['to-verify']);

  await sendBackCard(db().sql, card.id, { note: 'Usa i colori del DESIGN.md.' });
  assert.equal((await loadTask(db().sql, card.id))?.status, 'ready');
  // Already at work on the local model: it goes on there, with its answer and the note after it.
  assert.deepEqual(await drain([card.id], executor), ['to-verify']);
  const second = JSON.stringify(model.requests[1]?.messages);
  assert.ok(second.indexOf('intestazione verde') < second.indexOf('sent the card back:\\nUsa i colori del DESIGN.md.'));
  const detail = await cardDetail(db().sql, card.id);
  assert.equal(detail.report?.text, 'Proposta rifatta coi colori del DESIGN.md.');
  assert.deepEqual(
    detail.returns.map(({ note, label }) => ({ note, label })),
    [{ note: 'Usa i colori del DESIGN.md.', label: 'L2' }],
  );
});

test('«Rimanda» on Claude: an Interno note keeps the cloud, a new delegation with the last report; a Privato note keeps it local (D-235)', async () => {
  const parent = await createTask(db().sql, { title: 'Piano', label: 'L1', clearance: 'L1', status: 'inbox' });
  const card = await createTask(db().sql, {
    title: 'Grafica della landing',
    goal: 'Due varianti.',
    parentId: parent.id,
    label: 'L1',
    clearance: 'L1',
    effectiveLabel: 'L1',
    assignee: 'designer',
    project: 'site',
    status: 'inbox',
  });
  try {
    await startCard(db().sql, card.id);
    const executor = orchestrator(scripted([]), ['claude']);
    assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
    await chooseExecutor(card.id, 'claude', ['claude', 'local']);
    assert.deepEqual(await drain([card.id], executor), ['continued', 'to-verify']);

    await sendBackCard(db().sql, card.id, { note: 'Più contrasto nei pulsanti.', label: 'L1' });
    // The Designer asks where it works at each start: Claude is still offered, the card stays Interno.
    assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
    await chooseExecutor(card.id, 'claude', ['claude', 'local']);
    assert.deepEqual(await drain([card.id], executor), ['continued', 'to-verify']);
    const delegations = await loadDelegations(db().sql, card.id);
    assert.equal(delegations.length, 2);
    const brief = delegations[1]?.brief ?? '';
    assert.match(brief, /^Card: Grafica della landing\n\nProject: site\n\nWhat to do:\nDue varianti\.\n\nYour report last time:\nok/);
    assert.match(brief, /sent the card back:\nPiù contrasto nei pulsanti\.$/);
    assert.equal(delegations[1]?.label, 'L1');

    // A Privato note: the card is private now, only the local model is offered.
    await sendBackCard(db().sql, card.id, { note: 'Il logo del cliente Rossi.' });
    assert.equal((await loadTask(db().sql, card.id))?.label, 'L2');
    assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
    await chooseExecutor(card.id, 'local', ['local']);
    // On the local model it reads its last report from Claude, then the note; nothing more leaves.
    const model = scripted([{ action: 'reply', text: 'Logo rifatto.' }]);
    assert.deepEqual(await drain([card.id], orchestrator(model, ['claude'])), ['to-verify']);
    const read = JSON.stringify(model.requests[0]?.messages);
    assert.ok(read.indexOf('Your report last time') < read.indexOf('Il logo del cliente Rossi.'));
    assert.equal((await loadDelegations(db().sql, card.id)).length, 2);
    const [sent] = await db().sql<{ n: number }[]>`SELECT count(*)::int AS n FROM gateway_log WHERE task_id = ${card.id} AND target = 'claude'`;
    assert.equal(sent?.n, 2);
  } finally {
    execFileSync('git', ['-C', REPO, 'clean', '--quiet', '-fd']);
  }
});

test('«Rimanda» is refused without a note, outside Da verificare, for a card of the user, with an unknown label (D-235)', async () => {
  const mine = await createCard(db().sql, { title: 'Chiamare il grafico' }, NAMES);
  await assert.rejects(sendBackCard(db().sql, mine.id, { note: 'Rifai.' }), /only a card to verify/);
  const agent = await createCard(db().sql, { title: 'Testi', assignee: 'coder' }, NAMES);
  await assert.rejects(sendBackCard(db().sql, agent.id, { note: '  ' }), /with a note/);
  await assert.rejects(sendBackCard(db().sql, agent.id, { note: 'Rifai.', label: 'L0' }), /L1 or L2/);
  await assert.rejects(sendBackCard(db().sql, agent.id, { note: 'Rifai.' }), /only a card to verify/);
  // In Da verificare without the engine ever having it, or a card of the user's: refused.
  const never = await createTask(db().sql, { title: 'Mai partita', assignee: 'coder' });
  const own = await createTask(db().sql, { title: 'Mia' });
  await db().sql`UPDATE tasks SET status = 'to_verify' WHERE id IN (${never.id}, ${own.id})`;
  await assert.rejects(sendBackCard(db().sql, never.id, { note: 'Rifai.' }), /never started/);
  await assert.rejects(sendBackCard(db().sql, own.id, { note: 'Rifai.' }), /only the card of an agent/);
  // The note never changes once written.
  await assert.rejects(db().sql`UPDATE card_returns SET note = 'altro'`, /permission denied|never changes/);
});

test('text written on a card of a plan makes it private and lets it read so: its clearance goes up with its label (D-152, D-235)', async () => {
  const card = await createTask(db().sql, { title: 'Testi', label: 'L1', clearance: 'L1', effectiveLabel: 'L1', assignee: 'coder', project: 'site', status: 'inbox' });
  await updateCard(db().sql, card.id, { goal: 'Il nome del cliente.' }, NAMES);
  const after = await loadTask(db().sql, card.id);
  assert.deepEqual([after?.label, after?.clearance], ['L2', 'L2']);
});
