import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { AGENTS_DIR, loadAgents } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { orchestratorTools } from '../src/orchestrator/orchestrator.ts';

const arianna = loadAgents(join(resolveHome({}), AGENTS_DIR)).get('arianna');

test('task.update is offered only when the conversation has an open card (task 1.10)', () => {
  assert.ok(arianna !== undefined);
  assert.ok(!orchestratorTools(arianna).includes('task.update'));
  assert.ok(orchestratorTools(arianna, false, true).includes('task.update'));
  // The other tools do not depend on it.
  assert.deepEqual(
    orchestratorTools(arianna, false, true).filter((tool) => tool !== 'task.update'),
    orchestratorTools(arianna),
  );
});

test('task.delegate is offered only when a cloud executor can take the step', () => {
  assert.ok(arianna !== undefined);
  assert.ok(!orchestratorTools(arianna, false, true).includes('task.delegate'));
  assert.ok(orchestratorTools(arianna, true).includes('task.delegate'));
});

test('a card that does not list task.update never gets it, with cards or not', () => {
  assert.ok(arianna !== undefined);
  const without = { ...arianna, card: { ...arianna.card, tools: arianna.card.tools.filter((tool) => tool !== 'task.update') } };
  assert.ok(!orchestratorTools(without, false, true).includes('task.update'));
});
