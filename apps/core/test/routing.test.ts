import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { parseConfig } from '@arianna/config';
import { candidateKey } from '@arianna/router';

import { routerConfigOf, selectableModels } from '../src/orchestrator/routing.ts';

const BASE = `
[paths]
data = "data"

[database]
host = "127.0.0.1"
port = 54329
name = "arianna"
user = "arianna"
`;
const HOME = resolve('some-home');
const CATALOG = {
  version: 1 as const,
  models: [
    { id: 'big', family: 'qwen', ramMinGib: 1, roles: ['orchestrator' as const], files: [], status: 'experimental' as const },
    { id: 'small', family: 'qwen', ramMinGib: 1, roles: ['extractor' as const], files: [], status: 'experimental' as const },
  ],
};

function keys(text: string): string[] {
  return routerConfigOf(parseConfig(`${BASE}${text}`, HOME, CATALOG as never)).candidates.map(candidateKey);
}

test('the router candidates follow the roles and the enabled cloud executors', () => {
  assert.deepEqual(keys(''), []);
  assert.deepEqual(keys('[roles]\norchestrator = "big"\n'), ['local/local-large']);
  assert.deepEqual(keys('[roles]\norchestrator = "big"\nextractor = "small"\n[cloud]\nexecutors = ["claude"]\n'), [
    'local/local-large',
    'local/local-small',
    'claude/sonnet',
    'claude/opus',
    'claude/fable',
  ]);
});

test('codex is not a candidate until its adapter exists, enabled or not', () => {
  assert.deepEqual(keys('[cloud]\nexecutors = ["codex"]\n'), []);
  assert.deepEqual(keys('[cloud]\nexecutors = ["claude", "codex"]\n'), ['claude/sonnet', 'claude/opus', 'claude/fable']);
});

test('the selectable models of a work conversation are the cloud candidates', () => {
  assert.deepEqual(selectableModels(parseConfig(`${BASE}[roles]\norchestrator = "big"\n`, HOME, CATALOG as never)), []);
  assert.deepEqual(
    selectableModels(parseConfig(`${BASE}[cloud]\nexecutors = ["claude"]\n`, HOME)).map((entry) => `${entry.executor}/${entry.model}`),
    ['claude/sonnet', 'claude/opus', 'claude/fable'],
  );
});
