// Claude writes the cards of a plan in a work conversation (D-164): who
// plans, what Claude reads and how its answer is read.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { responseSchema, systemPrompt, validate } from '@arianna/agents';

import { PLANNER_PROMPT, planInAnswer, plannerBrief, plannerModelOf } from '../src/orchestrator/claude-plan.ts';

test('Claude plans only in a work conversation: the model chosen there, else Sonnet, else Opus, among those switched on', () => {
  assert.equal(plannerModelOf({ mode: 'work', model: null }, ['sonnet', 'opus', 'gpt-5']), 'sonnet');
  assert.equal(plannerModelOf({ mode: 'work', model: 'opus' }, ['sonnet', 'opus']), 'opus');
  assert.equal(plannerModelOf({ mode: 'work', model: 'opus' }, ['sonnet']), 'sonnet', 'a model switched off is not used');
  assert.equal(plannerModelOf({ mode: 'work', model: 'gpt-5' }, ['opus', 'gpt-5']), 'opus');
  assert.equal(plannerModelOf({ mode: 'work', model: null }, ['gpt-5']), undefined, 'no Claude model on: the local model plans');
  assert.equal(plannerModelOf({ mode: 'private', model: null }, ['sonnet']), undefined, 'never in a private conversation');
  assert.equal(plannerModelOf(undefined, ['sonnet']), undefined);
});

test('the brief: the prompt, the agents and the request with its label, nothing else', () => {
  const brief = plannerBrief({ title: 'Landing', request: 'Una landing per le torte.', label: 'L1', agents: [{ name: 'designer', description: 'Mockup HTML' }] });
  assert.deepEqual(
    brief.map((part) => [part.source, part.label]),
    [
      ['prompt:claude-plan', 'L0'],
      ['agents:delegates', 'L1'],
      ['plan:request', 'L1'],
    ],
  );
  assert.equal(brief[0]?.text, PLANNER_PROMPT);
  assert.match(brief[1]?.text ?? '', /- designer: Mockup HTML/);
  assert.equal(brief[2]?.text, 'Title: Landing\nRequest:\nUna landing per le torte.');
  assert.match(plannerBrief({ title: 'T', request: 'R', label: 'L0', agents: [] })[1]?.text ?? '', /every card is the user's/);
});

test('the plan in Claude’s answer: one JSON object, a code fence tolerated', () => {
  const plan = { title: 'Sito', cards: [] };
  assert.deepEqual(planInAnswer(JSON.stringify(plan)), plan);
  assert.deepEqual(planInAnswer(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``), plan);
  assert.equal(planInAnswer('non saprei'), undefined);
  assert.equal(planInAnswer('{ non è json }'), undefined);
  assert.equal(planInAnswer('[1, 2]'), undefined);
});

test('task.plan for Claude: the local model writes the title and the request, never the cards', () => {
  const claude = responseSchema(['task.plan'], false, undefined, 'claude');
  const call = (args: unknown) => ({ action: 'call', tool: 'task.plan', arguments: args });
  assert.deepEqual(validate(claude, call({ title: 'Landing', request: 'Una landing.' })), []);
  assert.notDeepEqual(validate(claude, call({ title: 'Landing', cards: [] })), []);
  const self = responseSchema(['task.plan'], false);
  assert.notDeepEqual(validate(self, call({ title: 'Landing', request: 'Una landing.' })), []);
  // The prompt of the local model plans as before outside a work conversation, byte for byte.
  assert.equal(systemPrompt('P', ['task.plan']), systemPrompt('P', ['task.plan'], true, '', undefined, 'self'));
  assert.match(systemPrompt('P', ['task.plan'], true, '', undefined, 'claude'), /the planner writes the cards/);
  assert.doesNotMatch(systemPrompt('P', ['task.plan']), /planner/);
});
