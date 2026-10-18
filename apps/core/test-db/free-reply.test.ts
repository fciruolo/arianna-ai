import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Answer } from '@arianna/agents';
import { DEFAULT_APPEARANCE, defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, submitTask, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { REPLY_INSTRUCTION } from '../src/orchestrator/free-reply.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTurns } from '../src/orchestrator/turns.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

// The reply of the local orchestrator written as free text in Markdown (D-251).

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = committedAgents(HOME);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const kb = createKb({ home: HOME, rules: RULES });
const CONFIG = {
  ...loadConfig(),
  characters: {},
  appearance: { ...DEFAULT_APPEARANCE },
  personas: {},
};
const OPTIONS = {
  allowedActions: () => agents.get('arianna')?.card.approvals ?? [],
  agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }),
};

const DRAFT = '| Voce | Importo | |---|---| | Affitto | 800 € | | Luce | 60 € |';
const TABLE = 'Le spese della casa:\n\n| Voce | Importo |\n|---|---|\n| Affitto | 800 € |\n| Luce | 60 € |';

/** JSON answers for the calls with the schema, free texts for those without, each in order. */
function scripted(answers: Answer[], free: (string | LocalModelError)[] = []): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let answered = 0;
  let written = 0;
  return {
    requests,
    chat(request) {
      requests.push(request);
      const base = {
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 20 },
        endpoint: 'stub',
        model: 'stub',
        durationMs: 1,
      };
      if (request.schema === undefined) {
        const next = free[written++];
        if (next === undefined) return Promise.reject(new Error('no free text scripted'));
        if (next instanceof LocalModelError) return Promise.reject(next);
        for (const piece of next.match(/[\s\S]{1,7}/g) ?? []) request.onText?.(piece);
        return Promise.resolve({ ...base, text: next });
      }
      const next = answers[answered++];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = { thought: 'Ragiono.', ...next };
      const text = JSON.stringify(value);
      request.onText?.(text);
      return Promise.resolve({ ...base, text, value });
    },
  };
}

const orchestrator = (model: LocalModel, freeReplies = true) =>
  createOrchestrator({
    sql: db().sql,
    agents,
    kb,
    model: () => model,
    settings: () => ({
      ...CONFIG,
      cloud: { executors: [], models: defaultCloudModels() },
    }),
    rules: RULES,
    freeReplies,
  });

async function drain(taskId: string, executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 40; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (job.payload.taskId !== taskId) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

async function ask(body: string) {
  const conversation = await createConversation(db().sql, { mode: 'private' });
  return postUserMessage(db().sql, conversation.id, body);
}

async function stored(taskId: string): Promise<string | undefined> {
  const [row] = await db().sql<{ body: string }[]>`SELECT body FROM messages WHERE task_id = ${taskId} AND role = 'assistant' ORDER BY id`;
  return row?.body;
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a reply is written again as free text: the stored message keeps its line breaks, and it streams live (D-251)', async () => {
  const { task } = await ask('Quanto spendo al mese per la casa?');
  const model = scripted([{ action: 'reply', text: DRAFT }], [TABLE]);
  const live = await startLiveFeed(db().sql);
  const received: LiveMessage[] = [];
  const stop = await live.subscribe({
    send: (message) => received.push(message),
  });
  try {
    assert.deepEqual(await drain(task.id, orchestrator(model)), ['answered']);
    await waitFor(
      () =>
        received
          .filter((message) => message.type === 'delta' && message.taskId === task.id && message.part === undefined)
          .map((message) => (message.type === 'delta' ? message.text : ''))
          .join('') === TABLE,
    );
  } finally {
    stop();
    await live.close();
  }
  assert.equal(await stored(task.id), TABLE);
  // Only the free text went live as text: the draft's string, never.
  const text = received
    .flatMap((message) => (message.type === 'delta' && message.taskId === task.id && message.part === undefined ? [message.text] : []))
    .join('');
  assert.equal(text, TABLE);

  const [first, second] = model.requests;
  assert.equal(model.requests.length, 2);
  assert.ok(first?.schema !== undefined);
  // Same messages, then the draft as the model's answer and the instruction: the prefix stays in the cache (D-075).
  assert.ok(second !== undefined);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(second.messages.slice(first.messages.length), [
    {
      role: 'assistant',
      content: JSON.stringify({ action: 'reply', text: DRAFT }),
    },
    { role: 'user', content: REPLY_INSTRUCTION },
  ]);
  assert.equal(second.schema, undefined);
  assert.equal(second.thinking, false);
  assert.equal(second.temperature, 0);
  // The turn holds what the user read; the tokens of both calls count.
  const [turn] = await loadTurns(db().sql, task.id);
  assert.deepEqual(turn?.answer, { action: 'reply', text: TABLE });
  const [usage] = await db().sql<{ tokens: string }[]>`SELECT sum(tokens_in)::text AS tokens FROM runs WHERE task_id = ${task.id}`;
  assert.equal(usage?.tokens, '200');
});

test('a free text that opens with an empty «Ecco …:» line is stored and streamed without it (D-253)', async () => {
  const { task } = await ask('Quanto spendo al mese per la casa?');
  const model = scripted([{ action: 'reply', text: DRAFT }], [`Ecco la tabella:\n\n${TABLE}`]);
  const live = await startLiveFeed(db().sql);
  const received: LiveMessage[] = [];
  const stop = await live.subscribe({
    send: (message) => received.push(message),
  });
  const streamed = () =>
    received
      .flatMap((message) => (message.type === 'delta' && message.taskId === task.id && message.part === undefined ? [message.text] : []))
      .join('');
  try {
    assert.deepEqual(await drain(task.id, orchestrator(model)), ['answered']);
    await waitFor(() => streamed() === TABLE);
  } finally {
    stop();
    await live.close();
  }
  assert.equal(await stored(task.id), TABLE);
});

test('the draft of the JSON is stored when the free text fails or is empty (D-251)', async () => {
  for (const free of [new LocalModelError('unavailable', 'down'), '   ']) {
    const { task } = await ask('Quanto spendo al mese per la casa?');
    const model = scripted([{ action: 'reply', text: DRAFT }], [free]);
    assert.deepEqual(await drain(task.id, orchestrator(model)), ['answered']);
    assert.equal(await stored(task.id), DRAFT);
    assert.equal(model.requests.length, 2);
    // The reason, never a text: an event for the trial on the real model.
    const events = await db().sql<{ payload: { reason: string } }[]>`SELECT payload FROM events WHERE kind = 'reply.draft-kept' AND task_id = ${task.id}`;
    assert.deepEqual(
      events.map((event) => event.payload.reason),
      [free instanceof LocalModelError ? 'failed' : 'empty'],
    );
  }
});

test('no free text for a tool call, a plan, a refusal, a question, a card, or with the option off (D-251)', async () => {
  // A tool call, then the reply: only the reply is written again.
  const { task } = await ask('Cerca la caparra.');
  const steps = scripted(
    [
      { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } },
      { action: 'reply', text: 'Tre mensilità.' },
    ],
    ['**Tre** mensilità.'],
  );
  assert.deepEqual(await drain(task.id, orchestrator(steps)), ['continued', 'answered']);
  assert.deepEqual(
    steps.requests.map((request) => request.schema === undefined),
    [false, false, true],
  );
  assert.equal(await stored(task.id), '**Tre** mensilità.');

  // A plan continues, a refusal and a question end the task: none is written again.
  const { task: planned } = await ask('Organizza la giornata.');
  const plan = scripted([
    { action: 'plan', steps: ['Cerca', 'Rispondi'] },
    { action: 'refuse', reason: 'Non posso.' },
  ]);
  assert.deepEqual(await drain(planned.id, orchestrator(plan)), ['continued', 'answered']);
  assert.ok(plan.requests.every((request) => request.schema !== undefined));
  assert.equal(await stored(planned.id), 'Non posso.');
  const { task: asked } = await ask('Prenota.');
  const question = scripted([
    {
      action: 'call',
      tool: 'user.ask',
      arguments: { question: 'Per quando?' },
    },
  ]);
  assert.deepEqual(await drain(asked.id, orchestrator(question)), ['answered']);
  assert.equal(question.requests.length, 1);

  // A card has no chat: its text stays the JSON's, in the turn.
  const card = await submitTask(db().sql, {
    title: 'Saluta',
    assignee: 'arianna',
    label: 'L0',
    clearance: 'L0',
    effectiveLabel: 'L0',
  });
  const cardModel = scripted([{ action: 'reply', text: 'Ciao.' }]);
  await drain(card.id, orchestrator(cardModel));
  assert.equal(cardModel.requests.length, 1);

  // The option off: one call, as before.
  const { task: off } = await ask('Quanto spendo?');
  const once = scripted([{ action: 'reply', text: DRAFT }]);
  assert.deepEqual(await drain(off.id, orchestrator(once, false)), ['answered']);
  assert.equal(once.requests.length, 1);
  assert.equal(await stored(off.id), DRAFT);
});
