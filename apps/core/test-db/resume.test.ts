// Fatto quando del task 1.8: kill -9 of the core → the task resumes.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { submitTask } from '../src/engine.ts';
import { loadTask } from '../src/tasks.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const WORKER_MAIN = join(import.meta.dirname, 'support', 'worker-main.ts');
const LOCK_TIMEOUT_MS = 1_000;

// Whatever happens in the test, no core process outlives it.
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

function startCore(schema: string, mode: 'hang' | 'finish'): ChildProcess {
  // Without NODE_TEST_CONTEXT: the child would take itself for a test file of this runner.
  const child = spawn(process.execPath, [WORKER_MAIN, schema, mode, String(LOCK_TIMEOUT_MS)], {
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  return child;
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('after kill -9 of the core, a new core resumes the interrupted step', { timeout: 60_000 }, async () => {
  const { sql, schema } = db();
  const task = await submitTask(sql, { title: 'Fake task to resume', assignee: 'coder' });

  const first = startCore(schema, 'hang');
  await until(async () => {
    const rows = await sql`SELECT 1 FROM runs WHERE task_id = ${task.id} AND status = 'running' AND session_ref = 'session-1'`;
    return rows.length === 1;
  }, 'the first core to start the step');
  first.kill('SIGKILL');
  await once(first, 'exit');

  const second = startCore(schema, 'finish');
  try {
    await until(async () => (await loadTask(sql, task.id))?.status === 'to_verify', 'the task to finish');
  } finally {
    if (second.exitCode === null && second.signalCode === null) {
      second.kill('SIGTERM');
      await once(second, 'exit');
    }
  }

  const runs = await sql<{ id: string; step: number; status: string; session_ref: string | null; resumed_from: string | null }[]>`
    SELECT id::text, step, status, session_ref, resumed_from::text FROM runs WHERE task_id = ${task.id} ORDER BY started_at`;
  assert.equal(runs.length, 2);
  const [interrupted, resumed] = runs;
  assert.deepEqual([interrupted?.step, interrupted?.status, interrupted?.session_ref], [1, 'interrupted', 'session-1']);
  assert.deepEqual([resumed?.step, resumed?.status, resumed?.resumed_from], [1, 'ok', interrupted?.id]);
  assert.deepEqual((await loadTask(sql, task.id))?.evidence, [{ resumed: 'session-1' }]);

  const [job] = await sql<{ status: string; attempts: number }[]>`
    SELECT status, attempts FROM jobs WHERE payload->>'taskId' = ${task.id}`;
  assert.deepEqual(job, { status: 'done', attempts: 2 });
});
