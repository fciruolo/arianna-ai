import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadAgent, userCard, userPresets, type LoadedAgent } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { availableCloud, briefCeiling, claudeToolsOf, cloudStepKind, codexAccessOf, delegateTargets, delegationRoute, runLimitsOf, stepFor, type DelegateEnv } from '../src/orchestrator/delegate.ts';
import { canAnswerDirectly } from '../src/orchestrator/claude-direct.ts';
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

/**
 * A user's agent made by the page from a starting point (D-119, tappa T3b),
 * loaded as the core does; `web` stands for a card with the web tools, which
 * the page cannot make yet and no delegation runs.
 */
function made(name: string, preset: 'code' | 'answer' | 'web'): LoadedAgent {
  const permissions = userPresets().find(({ id }) => id === (preset === 'web' ? 'answer' : preset))?.permissions;
  const files = userCard({ name, description: `Fa ${name}`, permissions, prompt: 'Istruzioni.' });
  writeFileSync(join(cards, `${name}.yaml`), files.yaml);
  writeFileSync(join(cards, `${name}.md`), files.md);
  const agent: LoadedAgent = { ...loadAgent(cards, name), origin: 'user' };
  return preset === 'web' ? { ...agent, card: { ...agent.card, maxLabel: 'L0', tools: ['web.search', 'web.fetch'] } } : agent;
}

function envWith(agents: LoadedAgent[], claude: boolean, local = true, codex = false): DelegateEnv {
  return {
    sql: undefined as never,
    agents: new Map([...official, ...agents.map((agent): [string, LoadedAgent] => [agent.card.name, agent])]),
    settings: () => ({ cloud: { executors: [...(claude ? ['claude'] : []), ...(codex ? ['codex'] : [])] } }) as never,
    rules: undefined as never,
    ...(claude ? { claude: {} as never } : {}),
    ...(codex ? { codex: {} as never } : {}),
    ...(local ? { model: () => ({}) as never } : {}),
  };
}

test('the agents Arianna may delegate to: the Coder first, then the ones an executor can run (D-119, tappa T3)', () => {
  const agents = [made('traduttore', 'answer'), made('programmatore', 'code'), made('cercatore', 'web'), made('analista', 'answer')];
  assert.deepEqual(
    delegateTargets(envWith(agents, true), 'arianna').map(({ name }) => name),
    ['coder', 'analista', 'designer', 'programmatore', 'reviewer', 'traduttore'],
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

test('with Codex on and Claude off, only the agents whose card names Codex take a cloud step (D-140)', () => {
  const agents = [made('traduttore', 'answer'), made('programmatore', 'code')];
  // The page's agents run on Claude only: Codex does not open them.
  assert.deepEqual(
    delegateTargets(envWith(agents, false, true, true), 'arianna').map(({ name }) => name),
    ['coder', 'designer', 'reviewer', 'traduttore'],
  );
  assert.deepEqual(availableCloud(envWith([], false, true, true)), ['codex']);
  assert.deepEqual(availableCloud(envWith([], true, true, true)), ['claude', 'codex']);
  // An adapter enabled in the settings but refused on this machine is not available.
  assert.deepEqual(availableCloud({ settings: () => ({ cloud: { executors: ['claude', 'codex'] } }) as never, claude: {} as never }), ['claude']);
  // A system chat answered by Claude needs Claude itself, never Codex.
  assert.equal(canAnswerDirectly(envWith([], false, true, true)), false);
  assert.equal(canAnswerDirectly(envWith([], true, true, true)), true);
});

test('the Reviewer: Codex first, the project read only, a review step for the router (D-140)', () => {
  const reviewer = official.get('reviewer');
  const coder = official.get('coder');
  assert.ok(reviewer !== undefined && coder !== undefined);
  assert.equal(delegationRoute(reviewer.card), 'codex');
  assert.equal(cloudStepKind(reviewer.card), 'review');
  assert.equal(cloudStepKind(coder.card), 'coding');
  assert.equal(codexAccessOf(reviewer.card.tools), 'read');
  assert.equal(codexAccessOf(coder.card.tools), 'write');
  assert.ok(!reviewer.card.tools.includes('repo.write'), 'the Reviewer never writes');
  // On Claude Code no tool that writes, not even Bash: its sandbox lets commands write the project.
  assert.deepEqual(claudeToolsOf(reviewer.card.tools), ['Read', 'Glob', 'Grep']);
  assert.deepEqual(claudeToolsOf(coder.card.tools), ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.deepEqual(claudeToolsOf(['repo.read', 'repo.test']), ['Read', 'Glob', 'Grep'], 'repo.test alone runs no command on Claude');
  assert.equal(briefCeiling(reviewer.card), 'L1');
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

test('a delegated Claude run takes the limits of an agent written by the page, never of a card in git (D-119, tappa T3b)', () => {
  const coder = official.get('coder');
  assert.ok(coder !== undefined);
  assert.deepEqual(runLimitsOf(coder), {});
  const user = made('prog', 'code');
  assert.deepEqual(runLimitsOf(user), { maxTurns: 50, timeoutMs: 45 * 60_000 });
  // Promoted into agents/: no longer `user`, its prompt_label still says who wrote it.
  assert.deepEqual(runLimitsOf({ card: { ...user.card, limits: { maxSteps: 7, maxMinutes: 3, maxCost: 0 } }, prompt: user.prompt }), { maxTurns: 7, timeoutMs: 180_000 });
});

test('an interrupted run is resumed only by the executor that started it (D-140)', () => {
  const base = { task: {} as never, step: 2, runId: 'r', signal: new AbortController().signal, setSessionRef: () => Promise.resolve() };
  const ofClaude = { ...base, resume: { runId: 'old', sessionRef: '00000000-0000-4000-8000-000000000001', executor: 'claude' } };
  assert.equal(stepFor(ofClaude, 'claude'), ofClaude);
  assert.equal(stepFor(ofClaude, 'codex').resume, undefined);
  assert.equal(stepFor(ofClaude, 'codex').runId, 'r');
  // A run row without an executor (older) keeps the resume as before.
  const unknown = { ...base, resume: { runId: 'old', sessionRef: null } };
  assert.equal(stepFor(unknown, 'codex'), unknown);
});
