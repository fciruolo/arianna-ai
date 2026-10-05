import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { type AgentCard } from '@arianna/agents';
import { CLOUD_MODEL_NAME, parseConfig, resolveHome } from '@arianna/config';
import { MODEL_NAME } from '@arianna/executors';
import { candidateKey } from '@arianna/router';

import { agentDefaultModel, agentModels, routerConfigOf, selectableModels } from '../src/orchestrator/routing.ts';
import { committedAgents } from './support/committed-agents.ts';

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

test('a cloud model turned off in [cloud.models] is not a candidate; one with an exact name stays under its alias (D-071)', () => {
  assert.deepEqual(keys('[cloud]\nexecutors = ["claude"]\n\n[cloud.models]\nopus = false\nfable = "claude-fable-5-1"\n'), ['claude/sonnet', 'claude/fable']);
  assert.deepEqual(keys('[cloud]\nexecutors = ["claude"]\n\n[cloud.models]\nsonnet = false\nopus = false\nfable = false\n'), []);
  assert.deepEqual(keys('[cloud]\nexecutors = []\n\n[cloud.models]\nopus = true\n'), [], 'turning a model on never turns its executor on');
});

const AGENTS = committedAgents(resolveHome({}));
const card = (id: string): AgentCard => {
  const agent = AGENTS.get(id);
  assert.ok(agent !== undefined, `agents/${id}.yaml`);
  return agent.card;
};

test("an agent's models are the cloud executors of its card, none for Arianna (D-116)", () => {
  assert.deepEqual(agentModels('coder', card('coder')), ['sonnet', 'opus', 'fable', 'codex']);
  assert.deepEqual(agentModels('arianna', card('arianna')), [], 'local only: her model is the orchestrator of [roles]');
  assert.deepEqual(agentModels('arianna', card('coder')), [], 'by id, whatever the card says');
  assert.deepEqual(agentModels('writer', { ...card('coder'), executors: ['local'] }), [], 'a card without the cloud');
  assert.deepEqual(agentModels('writer', { ...card('coder'), executors: ['claude', 'local'] }), ['sonnet', 'opus', 'fable']);
});

test('a new conversation with an agent starts with its model only while the card allows it and it is selectable (D-116)', () => {
  const config = (text: string) => parseConfig(`${BASE}${text}`, HOME);
  const coder = card('coder');
  const opus = '[cloud]\nexecutors = ["claude"]\n\n[agents.coder]\nmodel = "opus"\n';
  assert.equal(agentDefaultModel(config(opus), 'coder', coder), 'opus');
  assert.equal(agentDefaultModel(config('[cloud]\nexecutors = ["claude"]\n\n[cloud.models]\ndefault = "opus"\n'), 'coder', coder), 'opus', 'the default from before D-116');
  assert.equal(agentDefaultModel(config('[cloud]\nexecutors = ["claude"]\n'), 'coder', coder), undefined, 'no model: the router chooses');
  assert.equal(agentDefaultModel(config('[cloud]\nexecutors = []\n\n[agents.coder]\nmodel = "opus"\n'), 'coder', coder), undefined, 'claude is off');
  assert.equal(agentDefaultModel(config('[cloud]\nexecutors = ["claude"]\n\n[cloud.models]\nopus = false\n\n[agents.coder]\nmodel = "opus"\n'), 'coder', coder), undefined, 'opus is off');
  assert.equal(agentDefaultModel(config('[cloud]\nexecutors = ["claude", "codex"]\n\n[agents.coder]\nmodel = "codex"\n'), 'coder', coder), undefined, 'codex has no adapter yet');
  assert.equal(agentDefaultModel(config(opus), 'coder', { ...coder, executors: ['local'] }), undefined, 'a card without the cloud');
  assert.equal(agentDefaultModel(config(opus), 'coder', undefined), undefined, 'no card');
});

test('the configuration and the Claude adapter check exact model names with the same rule', () => {
  assert.equal(CLOUD_MODEL_NAME.source, MODEL_NAME.source);
});
