import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRouterConfig, RouterConfigError, type Candidate } from '../src/index.ts';

const rejects = (candidates: Candidate[], pattern: RegExp): void => {
  assert.throws(() => createRouterConfig(candidates), (error: unknown) => error instanceof RouterConfigError && pattern.test(error.message));
};

test('a valid configuration is accepted and frozen', () => {
  const config = createRouterConfig([
    { executor: 'local', model: 'local-large', locality: 'local' },
    { executor: 'claude', model: 'sonnet', locality: 'cloud' },
  ]);
  assert.equal(config.candidates.length, 2);
  assert.ok(Object.isFrozen(config.candidates));
  assert.ok(Object.isFrozen(config.candidates[0]));
});

test('claude and codex can never be declared local', () => {
  rejects([{ executor: 'claude', model: 'sonnet', locality: 'local' }], /always runs in the cloud/);
  rejects([{ executor: 'codex', model: 'codex', locality: 'local' }], /always runs in the cloud/);
});

test('an alias belongs to one executor', () => {
  rejects([{ executor: 'local', model: 'opus', locality: 'local' }], /opus runs on claude/);
  rejects([{ executor: 'claude', model: 'local-large', locality: 'cloud' }], /runs on local/);
});

test('unknown aliases, localities and duplicates are rejected', () => {
  rejects([{ executor: 'claude', model: 'haiku' as 'sonnet', locality: 'cloud' }], /unknown model alias/);
  rejects([{ executor: 'local', model: 'local-small', locality: 'lan' as 'local' }], /locality/);
  const sonnet: Candidate = { executor: 'claude', model: 'sonnet', locality: 'cloud' };
  rejects([sonnet, { ...sonnet }], /listed twice/);
});
