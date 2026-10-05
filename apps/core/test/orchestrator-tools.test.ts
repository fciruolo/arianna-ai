import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadAgent, userCard, type LoadedAgent } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { briefCeiling, delegateTargets, delegationRoute, type DelegateEnv } from '../src/orchestrator/delegate.ts';
import { orchestratorTools } from '../src/orchestrator/orchestrator.ts';
import { committedAgents } from './support/committed-agents.ts';

const HOME = resolveHome({});
// Only the committed cards: an agent promoted on this machine would join the list.
const official = committedAgents(HOME);
const arianna = official.get('arianna');
const cards = mkdtempSync(join(tmpdir(), 'arianna-delegates-'));
after(() => {
  rmSync(cards, { recursive: true, force: true });
});

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

test('task.delegate is offered only when an agent can take the step', () => {
  assert.ok(arianna !== undefined);
  assert.ok(!orchestratorTools(arianna, false, true).includes('task.delegate'));
  assert.ok(orchestratorTools(arianna, true).includes('task.delegate'));
});

test('a card that does not list task.update never gets it, with cards or not', () => {
  assert.ok(arianna !== undefined);
  const without = { ...arianna, card: { ...arianna.card, tools: arianna.card.tools.filter((tool) => tool !== 'task.update') } };
  assert.ok(!orchestratorTools(without, false, true).includes('task.update'));
});

/** A user's agent made by the page from `template` (D-119), loaded as the core does. */
function made(name: string, template: string): LoadedAgent {
  const files = userCard({ name, description: `Fa ${name}`, template, prompt: 'Istruzioni.' });
  writeFileSync(join(cards, `${name}.yaml`), files.yaml);
  writeFileSync(join(cards, `${name}.md`), files.md);
  return { ...loadAgent(cards, name), origin: 'user' };
}

function envWith(agents: LoadedAgent[], claude: boolean, local = true): DelegateEnv {
  return {
    sql: undefined as never,
    agents: new Map([...official, ...agents.map((agent): [string, LoadedAgent] => [agent.card.name, agent])]),
    settings: () => ({ cloud: { executors: claude ? ['claude'] : [] } }) as never,
    rules: undefined as never,
    ...(claude ? { claude: {} as never } : {}),
    ...(local ? { model: () => ({}) as never } : {}),
  };
}

test('the agents Arianna may delegate to: the Coder first, then the ones an executor can run (D-119, tappa T3)', () => {
  const agents = [made('traduttore', 'answer'), made('programmatore', 'code'), made('cercatore', 'web'), made('analista', 'answer')];
  assert.deepEqual(
    delegateTargets(envWith(agents, true), 'arianna').map(({ name }) => name),
    ['coder', 'analista', 'programmatore', 'traduttore'],
  );
  // Without Claude only the agents that answer on the local model; without it either, nobody.
  assert.deepEqual(
    delegateTargets(envWith(agents, false), 'arianna').map(({ name }) => name),
    ['analista', 'traduttore'],
  );
  assert.deepEqual(delegateTargets(envWith(agents, false, false), 'arianna'), []);
  // Never the agent that delegates, and the description is the card's.
  assert.ok(!delegateTargets(envWith(agents, true), 'traduttore').some(({ name }) => name === 'traduttore'));
  assert.equal(delegateTargets(envWith(agents, false), 'arianna')[1]?.description, 'Fa traduttore');
});

test('where a delegated step runs, and the highest label of its brief without a declassification', () => {
  const coder = official.get('coder');
  assert.ok(coder !== undefined && arianna !== undefined);
  assert.equal(delegationRoute(coder.card), 'claude');
  assert.equal(delegationRoute(made('prog', 'code').card), 'claude');
  assert.equal(delegationRoute(made('trad', 'answer').card), 'local');
  assert.equal(delegationRoute(made('cerca', 'web').card), undefined);
  assert.equal(delegationRoute(arianna.card), undefined);
  // The Coder in the cloud: L1 (its cloud ceiling), as before T3; an answering agent: its own clearance, L1 when made by the page.
  assert.equal(briefCeiling(coder.card), 'L1');
  assert.equal(briefCeiling(made('prog', 'code').card), 'L1');
  assert.equal(briefCeiling(made('trad', 'answer').card), 'L1');
  assert.equal(briefCeiling({ ...made('trad', 'answer').card, maxLabel: 'L0' }), 'L0');
  assert.equal(briefCeiling({ ...coder.card, cloudMaxLabel: 'L0' }), 'L0');
});
