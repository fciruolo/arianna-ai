// The contract evaluator on the fake binary: the real one runs in `pnpm eval:live`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createClaudeExecutor } from '@arianna/executors';

import { createContractEvaluator, matchesContract } from '../src/contract.ts';

const ROOT = resolveHome({});
const DATA = join(ROOT, 'data', 'test-tmp', `contract-${randomUUID()}`);
const FAKE = join(ROOT, 'packages', 'executors', 'test', 'fixtures', 'fake-claude.ts');

after(() => {
  rmSync(DATA, { recursive: true, force: true });
});

const evaluate = createContractEvaluator(
  () => createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE] }, killGraceMs: 200 }),
  () => DATA,
);

test('runs the steps in one workspace, resuming the session, and removes the workspace', async () => {
  const actual = await evaluate({ steps: [{ prompt: 'scenario: ok' }, { prompt: 'scenario: ok', resume: true }, { prompt: 'scenario: hang', timeoutMs: 200 }] });
  // The fake binary writes what it received into the workspace: `changed`.
  assert.deepEqual(actual, [
    { ok: true, changed: true, text: 'ok' },
    { ok: true, changed: true, text: 'resumed' },
    { ok: false, changed: true, error: 'timeout' },
  ]);
  assert.ok(matchesContract(actual, [{ text: 'OK.' }, { text: 'resumed' }, { error: 'timeout' }]));
  assert.equal(matchesContract(actual, [{ changed: false }, {}, { error: 'timeout' }]), false);
  assert.deepEqual(existsSync(join(DATA, 'evals')) ? readdirSync(join(DATA, 'evals')) : [], []);
});

test('matchesContract: a wrong answer, a wrong error kind or a missing step fails', () => {
  assert.equal(matchesContract([{ ok: true, changed: false, text: 'no' }], [{ text: 'ok' }]), false);
  assert.equal(matchesContract([{ ok: true, changed: false, text: 'denied' }], [{ changed: false }]), true);
  assert.equal(matchesContract([{ ok: false, error: 'exit' }], [{ error: 'timeout' }]), false);
  assert.equal(matchesContract([{ ok: false, error: 'timeout' }], [{ text: 'ok' }]), false);
  assert.equal(matchesContract([], [{ text: 'ok' }]), false);
  assert.equal(matchesContract('ok', [{ text: 'ok' }]), false);
});
