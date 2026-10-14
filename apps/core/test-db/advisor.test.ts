import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { createContext } from '@arianna/policy';
import type { RouterAgent, Step } from '@arianna/router';

import { CloudTextError, type CloudTextRequest } from '../src/cloud-text.ts';
import { appendEvent } from '../src/events.ts';
import { ADVICE_DAILY_CAP, ADVICE_EVENT, createAdvisor, writeAdvisorSettings } from '../src/orchestrator/advisor.ts';
import { createTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const base = resolve('data/test-tmp');
await mkdir(base, { recursive: true });
const dir = await mkdtemp(join(base, 'advisor-db-'));
after(() => rm(dir, { recursive: true, force: true }));

const CODER: RouterAgent = { name: 'coder', executors: ['claude', 'local'], maxLabel: 'L2', cloudMaxLabel: 'L1', difficulty: 'normal' };
const BRIEF = 'sistema il refuso nella pagina di migrazione del sito di prova';
const STEP: Step = { kind: 'coding', agent: CODER, text: BRIEF };
const NOW = new Date('2026-10-14T11:10:00Z');

function fakeAsk(answer: string | Error): { ask: (request: CloudTextRequest) => Promise<string>; asked: CloudTextRequest[] } {
  const asked: CloudTextRequest[] = [];
  return {
    asked,
    ask: (request) => {
      asked.push(request);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

async function newTask(): Promise<string> {
  return (await createTask(db().sql, { title: 'Fake task', assignee: 'coder', label: 'L1', clearance: 'L1', effectiveLabel: 'L1' })).id;
}

async function adviceEvents(taskId: string): Promise<{ label: string; payload: Record<string, unknown> }[]> {
  return db().sql<{ label: string; payload: Record<string, unknown> }[]>`
    SELECT label, payload FROM events WHERE kind = ${ADVICE_EVENT} AND task_id = ${taskId} ORDER BY id`;
}

test('an unsure Interno step gets an opinion, once per step, with no brief in the events', async () => {
  const data = join(dir, 'once');
  const { ask, asked } = fakeAsk('trivial\n');
  const advise = createAdvisor({ sql: db().sql, ask, data, now: () => NOW });
  const taskId = await newTask();
  assert.equal(await advise(STEP, createContext('L1', 'L1'), { taskId, step: 2 }), 'trivial');
  assert.equal(await advise(STEP, createContext('L1', 'L1'), { taskId, step: 2 }), 'trivial');
  assert.equal(asked.length, 1);
  const [request] = asked;
  assert.ok(request !== undefined);
  assert.deepEqual(request.parts.at(1), { text: BRIEF, source: 'task:brief', label: 'L1' });
  assert.equal(request.model, 'sonnet');
  const events = await adviceEvents(taskId);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.payload, { step: 2, reason: 'conflicting-rules', outcome: 'given', advice: 'trivial' });
  assert.ok(!JSON.stringify(events).includes('refuso'));
});

test('a Privato step, or a step the rules are sure of, asks nothing', async () => {
  const { ask, asked } = fakeAsk('trivial');
  const advise = createAdvisor({ sql: db().sql, ask, data: join(dir, 'none'), now: () => NOW });
  const taskId = await newTask();
  assert.equal(await advise(STEP, createContext('L2', 'L2'), { taskId, step: 1 }), undefined);
  assert.equal(await advise({ ...STEP, text: 'correggi un refuso' }, createContext('L1', 'L1'), { taskId, step: 1 }), undefined);
  assert.equal(asked.length, 0);
  assert.deepEqual([...(await adviceEvents(taskId))], []);
});

test('an answer that is not a difficulty is no opinion, and is counted', async () => {
  const { ask } = fakeAsk('Probably hard, it depends');
  const advise = createAdvisor({ sql: db().sql, ask, data: join(dir, 'other'), now: () => NOW });
  const taskId = await newTask();
  assert.equal(await advise(STEP, createContext('L1', 'L1'), { taskId, step: 1 }), undefined);
  assert.equal((await adviceEvents(taskId))[0]?.payload.outcome, 'none');
});

test('Claude out of quota sends and counts nothing; a failure counts', async () => {
  const taskId = await newTask();
  const quota = createAdvisor({ sql: db().sql, ask: fakeAsk(new CloudTextError('quota', 'no')).ask, data: join(dir, 'quota'), now: () => NOW });
  assert.equal(await quota(STEP, createContext('L1', 'L1'), { taskId, step: 1 }), undefined);
  assert.deepEqual([...(await adviceEvents(taskId))], []);
  const off = createAdvisor({ sql: db().sql, ask: fakeAsk(new CloudTextError('unavailable', 'claude is off')).ask, data: join(dir, 'quota'), now: () => NOW });
  assert.equal(await off(STEP, createContext('L1', 'L1'), { taskId, step: 1 }), undefined);
  assert.deepEqual([...(await adviceEvents(taskId))], []);
  const failing = createAdvisor({ sql: db().sql, ask: fakeAsk(new CloudTextError('failed', 'timeout')).ask, data: join(dir, 'quota'), now: () => NOW });
  assert.equal(await failing(STEP, createContext('L1', 'L1'), { taskId, step: 1 }), undefined);
  assert.equal((await adviceEvents(taskId))[0]?.payload.outcome, 'failed');
});

test('the weekly quota above 90% stops the advisor; at 90% it still asks', async () => {
  const data = join(dir, 'week');
  const file = join(dir, 'status.json');
  await writeAdvisorSettings(data, { usageFile: file });
  const week = (percent: number): string =>
    JSON.stringify({ claude: { limits: [{ label: 'Settimana', percent, resetsAt: '2026-10-17T14:00:00Z' }], updatedAt: '2026-10-14T11:00:00Z' } });
  const { ask, asked } = fakeAsk('hard');
  const advise = createAdvisor({ sql: db().sql, ask, data, now: () => NOW });
  await writeFile(file, week(91));
  assert.equal(await advise(STEP, createContext('L1', 'L1'), { taskId: await newTask(), step: 1 }), undefined);
  assert.equal(asked.length, 0);
  await writeFile(file, week(90));
  assert.equal(await advise(STEP, createContext('L1', 'L1'), { taskId: await newTask(), step: 1 }), 'hard');
  assert.equal(asked.length, 1);
});

test('after the daily cap no opinion is asked', async () => {
  // A day of its own: the other tests' events are dated today by the database clock.
  const late = new Date(Date.now() + 60_000);
  const { ask, asked } = fakeAsk('normal');
  const advise = createAdvisor({ sql: db().sql, ask, data: join(dir, 'cap'), now: () => late });
  const [today] = await db().sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM events WHERE kind = ${ADVICE_EVENT} AND ts >= date_trunc('day', now())`;
  for (let index = today?.count ?? 0; index < ADVICE_DAILY_CAP; index += 1) {
    await appendEvent(db().sql, { kind: ADVICE_EVENT, label: 'L0', payload: { step: 0, reason: 'no-rule', outcome: 'given', advice: 'normal' } });
  }
  assert.equal(await advise(STEP, createContext('L1', 'L1'), { taskId: await newTask(), step: 1 }), undefined);
  assert.equal(asked.length, 0);
});
