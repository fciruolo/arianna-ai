// «Consumi» (D-093, idea 10) on a real database, read as arianna_app: runs,
// delegations, router decisions, gateway exits and failures of the period,
// grouped by model, agent and kind of task, without any text of the tasks.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createConversation } from '../src/conversations.ts';
import { recordFailure } from '../src/failures.ts';
import { endRun, startRun } from '../src/runs.ts';
import { createTask } from '../src/tasks.ts';
import { loadUsage } from '../src/usage.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
// Every text of the made-up tasks carries this word: the report must never hold it.
const MARK = 'segretofinto';

test('the report counts the work of the period per model, agent and kind, and holds no text', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'work' });
  const chat = await createTask(sql, { title: `Domanda ${MARK}`, goal: `Obiettivo ${MARK}`, conversationId: conversation.id });
  const card = await createTask(sql, { title: `Scheda ${MARK}` });

  const local = await startRun(sql, { taskId: chat.id, step: 1, agent: 'arianna', executor: 'local', model: 'local-large', locality: 'local', effectiveLabel: 'L0' });
  await endRun(sql, local.id, 'ok', { steps: 3, tokensIn: 1200, tokensOut: 300 });
  const cloud = await startRun(sql, { taskId: card.id, step: 1, agent: 'coder', executor: 'claude', model: 'sonnet', locality: 'cloud', effectiveLabel: 'L1' });
  await endRun(sql, cloud.id, 'failed');
  // A run of ten days ago: in 30 days, not in 7.
  await owner`
    INSERT INTO runs (task_id, step, agent, executor, model, locality, status, steps_used, started_at, last_seen_at, ended_at)
    VALUES (${card.id}, 2, 'coder', 'claude', 'sonnet', 'cloud', 'ok', 4, now() - interval '10 days', now() - interval '10 days', now() - interval '10 days' + interval '90 seconds')`;

  await owner`
    INSERT INTO task_delegations (task_id, step, agent, brief, label, status, executor, model, result, result_label, ended_at)
    VALUES (${chat.id}, 2, 'coder', ${`Brief ${MARK}`}, 'L1', 'failed', 'claude', 'sonnet', ${`Errore ${MARK}`}, 'L1', now())`;
  await owner`
    INSERT INTO router_decisions (task_id, label, difficulty, decision, executor, model, locality, candidates, reason)
    VALUES (${chat.id}, 'L0', 'trivial', 'route', 'local', 'local-large', 'local', '[]', 'rule'),
           (${card.id}, 'L1', 'hard', 'route', 'claude', 'sonnet', 'cloud', '[]', 'rule')`;
  await owner`
    INSERT INTO gateway_log (task_id, target_kind, target, locality, label, decision, rule, reason, bytes_out, summary)
    VALUES (${card.id}, 'executor', 'claude', 'cloud', 'L1', 'allow', 'label', 'up to L1', 640, ${`Riassunto ${MARK}`}),
           (${card.id}, 'executor', 'claude', 'cloud', 'L2', 'block', 'label', 'above L1', NULL, NULL)`;
  await recordFailure(sql, card.id, { origin: 'claude', code: 'claude.exit', details: {} });

  const week = await loadUsage(sql, '7d');
  assert.equal(week.period, '7d');
  assert.deepEqual(
    week.models.map((row) => [row.executor, row.model, row.locality, row.runs, row.steps, row.ok, row.failed, row.delegations, row.delegationsFailed]),
    [
      ['claude', 'sonnet', 'cloud', 1, 1, 0, 1, 1, 1],
      ['local', 'local-large', 'local', 1, 3, 1, 0, 0, 0],
    ],
  );
  const localRow = week.models.find((row) => row.executor === 'local');
  assert.equal(localRow?.tokensIn, 1200);
  assert.equal(localRow.tokensOut, 300);
  assert.equal(week.models.find((row) => row.executor === 'claude')?.tokensIn, null);
  assert.deepEqual(week.agents.map((row) => [row.agent, row.runs]).sort(), [['arianna', 1], ['coder', 1]]);
  assert.deepEqual(week.kinds.map((row) => [row.kind, row.runs]).sort(), [['card', 1], ['conversation', 1]]);
  assert.deepEqual(week.difficulties.map((row) => [row.difficulty, row.local, row.cloud]), [['trivial', 1, 0], ['hard', 0, 1]]);
  assert.deepEqual(week.exits.map((row) => [row.target, row.allowed, row.blocked, row.bytes]), [['claude', 1, 1, 640]]);
  assert.deepEqual(week.failures, [{ origin: 'claude', code: 'claude.exit', count: 1 }]);
  assert.deepEqual({ ...week.totals, seconds: 0 }, { runs: 2, steps: 4, seconds: 0, delegations: 1, cloudExits: 1, blocked: 1, failures: 1, advice: 0 });
  assert.doesNotMatch(JSON.stringify(week), new RegExp(MARK));

  const month = await loadUsage(sql, '30d');
  const sonnet = month.models.find((row) => row.executor === 'claude');
  assert.equal(sonnet?.runs, 2);
  assert.equal(sonnet.steps, 5);
  assert.ok(sonnet.seconds >= 90);
  assert.doesNotMatch(JSON.stringify(month), new RegExp(MARK));
});
