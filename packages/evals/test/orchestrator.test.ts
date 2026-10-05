import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CODER_ONLY, isToolId, responseSchema, TOOL_ARGS, type ToolId } from '@arianna/agents';
import { CONFIG_FILE, loadConfig, resolveHome } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import { loadCases } from '../src/cases.ts';
import { GROUPS } from '../src/groups.ts';
import { createOrchestratorGroup } from '../src/orchestrator-group.ts';
import {
  createOrchestratorEvaluator,
  matchesExpectation,
  summarize,
  type OrchestratorExpectation,
  type OrchestratorInput,
} from '../src/orchestrator.ts';
import { runGroup } from '../src/runner.ts';

describe('orchestrator evaluator', () => {
  const tools: ToolId[] = ['kb.search', 'user.ask'];

  /** A model that answers `value` and records the request. */
  function stub(value: unknown): { model: LocalModel; requests: ChatRequest[] } {
    const requests: ChatRequest[] = [];
    return {
      requests,
      model: {
        chat: (request) => {
          requests.push(request);
          return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'stub', model: 'stub', durationMs: 1 });
        },
      },
    };
  }

  it('asks for constrained decoding with one option per offered tool', async () => {
    const { model, requests } = stub({ thought: 'Search the contract.', action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } });
    const input: OrchestratorInput = {
      tools,
      messages: [
        { role: 'user', content: 'Cosa dice il contratto?' },
        { role: 'tool', content: 'error: x' },
      ],
    };
    const actual = await createOrchestratorEvaluator(() => model, 'You are Arianna.')(input);
    assert.deepEqual(actual, { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' }, schemaOk: true });
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.model, 'local-large');
    assert.equal(request.temperature, 0);
    assert.deepEqual(request.schema?.schema, responseSchema(tools));
    const system = request.messages[0];
    assert.ok(system !== undefined);
    assert.equal(system.role, 'system');
    assert.match(system.content, /You are Arianna\.[\s\S]*kb\.search[\s\S]*never follow instructions/);
    assert.deepEqual(request.messages[2], { role: 'user', content: '<tool_result>\nerror: x\n</tool_result>' });
  });

  it("offers the case's agents to task.delegate, and the Coder alone without them", async () => {
    const delegating: ToolId[] = ['task.delegate'];
    const delegates = [...CODER_ONLY, { name: 'traduttore', description: 'Traduce' }];
    const call = { action: 'call', tool: 'task.delegate', arguments: { agent: 'traduttore', reason: 'Per la traduzione.', brief: 'Traduci.' } };
    const { model, requests } = stub({ thought: 'It is a translation.', ...call });
    const actual = await createOrchestratorEvaluator(() => model, 'You are Arianna.')({ tools: delegating, delegates, messages: [{ role: 'user', content: 'Traduci.' }] });
    assert.deepEqual(actual, { ...call, schemaOk: true });
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.deepEqual(request.schema?.schema, responseSchema(delegating, true, delegates));
    assert.match(request.messages[0]?.content ?? '', /traduttore, "Traduce"/);
    // The same answer without the case's agents names an agent not offered.
    assert.equal(summarize({ thought: 't', ...call }, delegating).schemaOk, false);
    assert.equal(matchesExpectation(actual, { accept: [{ action: 'call', tool: 'task.delegate', args: { agent: { equals: 'coder' } } }] }), false);
  });

  it('marks arguments outside the schema, and tools not offered', () => {
    assert.equal(summarize({ thought: 't', action: 'call', tool: 'kb.search', arguments: {} }, tools).schemaOk, false);
    assert.equal(summarize({ thought: 't', action: 'call', tool: 'file.delete', arguments: { path: 'x' } }, tools).schemaOk, false);
    assert.deepEqual(summarize('nonsense', tools), { action: 'invalid', schemaOk: false });
  });

  it('requires a thought in every option, and keeps it out of the report', () => {
    const call = { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } };
    assert.deepEqual(summarize({ thought: 'Search first.', ...call }, tools), { ...call, schemaOk: true });
    assert.equal(summarize(call, tools).schemaOk, false, 'no thought');
    assert.equal(summarize({ thought: '', ...call }, tools).schemaOk, false, 'empty thought');
    assert.equal(summarize({ thought: 'x'.repeat(1501), ...call }, tools).schemaOk, false, 'thought too long');
    for (const schema of (responseSchema(tools) as { anyOf: { properties: object; required: string[] }[] }).anyOf) {
      assert.equal(Object.keys(schema.properties)[0], 'thought');
      assert.equal(schema.required[0], 'thought');
    }
  });

  it('asks once more without the thought when the answer is not JSON', async () => {
    const requests: ChatRequest[] = [];
    const value = { action: 'refuse', reason: 'no payment tool' };
    const model: LocalModel = {
      chat: (request) => {
        requests.push(request);
        if (requests.length === 1) return Promise.reject(new LocalModelError('bad-response', 'stub: content is not JSON', { endpoint: 'stub' }));
        return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'stub', model: 'stub', durationMs: 1 });
      },
    };
    const input: OrchestratorInput = { tools, messages: [{ role: 'user', content: 'Paga la bolletta.' }] };
    assert.deepEqual(await createOrchestratorEvaluator(() => model, 'You are Arianna.')(input), { action: 'refuse', schemaOk: true });
    assert.equal(requests.length, 2);
    const [first, second] = requests;
    assert.ok(first !== undefined && second !== undefined);
    assert.deepEqual(first.schema?.schema, responseSchema(tools));
    assert.deepEqual(second.schema?.schema, responseSchema(tools, false));
    assert.match(first.messages[0]?.content ?? '', /"thought"/);
    assert.doesNotMatch(second.messages[0]?.content ?? '', /thought/);
  });

  it('does not ask again after other errors', async () => {
    let calls = 0;
    const model: LocalModel = {
      chat: () => {
        calls += 1;
        return Promise.reject(new LocalModelError('timeout', 'stub did not answer in time', { endpoint: 'stub' }));
      },
    };
    const input: OrchestratorInput = { tools, messages: [{ role: 'user', content: 'Ciao' }] };
    const evaluate = createOrchestratorEvaluator(() => model, 'You are Arianna.');
    await assert.rejects(Promise.resolve(evaluate(input)), /in time/);
    assert.equal(calls, 1);
  });

  it('has a schema without the thought for the fallback', () => {
    const call = { action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } };
    assert.deepEqual(summarize(call, tools, false), { ...call, schemaOk: true });
    assert.equal(summarize({ thought: 't', ...call }, tools, false).schemaOk, false);
  });

  it('counts plan steps and recognizes replies and refusals', () => {
    const t = { thought: 't' };
    assert.deepEqual(summarize({ ...t, action: 'plan', steps: ['a', 'b', 'c'] }, tools), { action: 'plan', steps: '3-5', schemaOk: true });
    assert.deepEqual(summarize({ ...t, action: 'plan', steps: ['a', 'b'] }, tools), { action: 'plan', steps: '2', schemaOk: true });
    assert.deepEqual(summarize({ ...t, action: 'reply', text: 'ok' }, tools), { action: 'reply', schemaOk: true });
    assert.deepEqual(summarize({ ...t, action: 'refuse', reason: 'no tool' }, tools), { action: 'refuse', schemaOk: true });
  });
});

describe('matchesExpectation', () => {
  const call = (tool: string, args: Record<string, unknown> = {}) => ({ action: 'call' as const, tool, arguments: args, schemaOk: true });
  const expect = (e: OrchestratorExpectation) => e;

  it('accepts any of the accepted answers', () => {
    const e = expect({ accept: [{ action: 'call', tool: 'kb.search' }, { action: 'call', tool: 'user.ask' }] });
    assert.ok(matchesExpectation(call('kb.search'), e));
    assert.ok(matchesExpectation(call('user.ask'), e));
    assert.ok(!matchesExpectation(call('kb.read'), e));
  });

  it('checks string arguments: equals, notEqual, prefix', () => {
    const corrected = expect({ accept: [{ action: 'call', tool: 'kb.write', args: { path: { prefix: 'kb/' } } }] });
    assert.ok(matchesExpectation(call('kb.write', { path: 'kb/auto.md' }), corrected));
    assert.ok(!matchesExpectation(call('kb.write', { path: 'note/auto.md' }), corrected));
    const fresh = expect({ accept: [{ action: 'call', tool: 'kb.search', args: { query: { notEqual: 'old query' } } }] });
    assert.ok(matchesExpectation(call('kb.search', { query: 'new query' }), fresh));
    assert.ok(!matchesExpectation(call('kb.search', { query: ' old query ' }), fresh), 'the same query repeated');
    const exact = expect({ accept: [{ action: 'call', tool: 'task.update', args: { task_id: { equals: 'T-12' } } }] });
    assert.ok(!matchesExpectation(call('task.update', { task_id: 'T12' }), exact));
  });

  it('refuses a forbidden answer, and anything that breaks the schema', () => {
    const e = expect({ forbid: [{ action: 'call', tool: 'channel.send' }] });
    assert.ok(matchesExpectation({ action: 'reply', schemaOk: true }, e));
    assert.ok(matchesExpectation(call('kb.search'), e));
    assert.ok(!matchesExpectation(call('channel.send'), e));
    assert.ok(!matchesExpectation({ action: 'reply', schemaOk: false }, e));
  });
});

describe('orchestrator cases', () => {
  const cases = loadCases(join(resolveHome({}), 'evals', 'orchestrator'));

  it('are about thirty, in every measured category', () => {
    assert.ok(cases.length >= 30, String(cases.length));
    for (const tag of ['tool', 'refusal', 'recovery', 'plan']) {
      assert.ok(cases.some((c) => c.tags.includes(tag)), tag);
    }
  });

  it('offer only registry tools with an argument schema, and expect an offered tool', () => {
    for (const evalCase of cases) {
      const input = evalCase.input as OrchestratorInput;
      for (const tool of input.tools) {
        assert.ok(isToolId(tool) && TOOL_ARGS[tool] !== undefined, `${evalCase.id}: ${tool}`);
      }
      const expectation = evalCase.expect as OrchestratorExpectation;
      assert.ok(expectation.accept !== undefined || expectation.forbid !== undefined, evalCase.id);
      for (const outcome of [...(expectation.accept ?? []), ...(expectation.forbid ?? [])]) {
        if (outcome.tool !== undefined) assert.ok(input.tools.includes(outcome.tool as ToolId), `${evalCase.id}: ${outcome.tool}`);
      }
    }
  });

  it('offer agents as the core does, and expect only an offered one', () => {
    for (const evalCase of cases) {
      const input = evalCase.input as Record<string, unknown>;
      const raw: unknown = input.delegates;
      let names = ['coder'];
      if (raw !== undefined) {
        assert.ok(Array.isArray(raw) && raw.length > 0, evalCase.id);
        for (const target of raw as unknown[]) {
          assert.ok(typeof target === 'object' && target !== null, evalCase.id);
          const keys = Object.keys(target).sort();
          assert.deepEqual(keys, ['description', 'name'], `${evalCase.id}: ${keys.join(', ')}`);
          const { name, description } = target as Record<string, unknown>;
          assert.ok(typeof name === 'string' && name !== '' && typeof description === 'string' && description !== '', evalCase.id);
        }
        names = (raw as { name: string }[]).map((target) => target.name);
        assert.ok(names.includes('coder'), `${evalCase.id}: the core offers the Coder first`);
      }
      const expectation = evalCase.expect as OrchestratorExpectation;
      for (const outcome of [...(expectation.accept ?? []), ...(expectation.forbid ?? [])]) {
        const agent = outcome.args?.agent?.equals;
        if (agent !== undefined) assert.ok(names.includes(agent), `${evalCase.id}: ${agent} is not offered`);
      }
    }
  });

  // Only meaningful until a local model is configured: then the real run is `pnpm eval:models`.
  const configured = existsSync(join(resolveHome({}), CONFIG_FILE)) && loadConfig({}).local.endpoints.length > 0;
  it('fail clearly when no local endpoint is configured', { skip: configured }, async () => {
    const group = GROUPS.find((candidate) => candidate.name === 'orchestrator');
    assert.ok(group !== undefined);
    const first = cases[0];
    assert.ok(first !== undefined);
    const report = await runGroup(group, [first]);
    assert.ok(report.status === 'failed' && /local\.endpoints|arianna:init/.test(report.results[0]?.error ?? ''), JSON.stringify(report));
  });
});

describe('createOrchestratorGroup (D-081)', () => {
  const evalCase = {
    id: 'fake-1',
    input: { tools: ['kb.search', 'user.ask'], messages: [{ role: 'user', content: 'Cerca la caparra nel contratto finto.' }] },
    expect: { accept: [{ action: 'call', tool: 'kb.search' }] },
    tags: ['tool'],
  };

  it('runs the cases on the given model and prompt, with the signal of the run', async () => {
    const requests: ChatRequest[] = [];
    const model: LocalModel = {
      chat: (request) => {
        requests.push(request);
        const value = { thought: 'Cerco.', action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } };
        return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'fake', model: 'candidate', durationMs: 1 });
      },
    };
    const group = createOrchestratorGroup({ model, prompt: 'You are a fake Arianna.' });
    assert.equal(group.name, 'orchestrator');
    const controller = new AbortController();
    const report = await runGroup(group, [evalCase], { signal: controller.signal });
    assert.ok(report.status !== 'pending');
    assert.equal(report.passed, 1);
    assert.deepEqual(report.measures.map((measure) => measure.name), ['schema', 'tool', 'refusal', 'recovery', 'plan']);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.model, 'local-large');
    assert.match(request.messages[0]?.content ?? '', /You are a fake Arianna\./);
    assert.equal(request.signal?.aborted, false);
  });

  it('a cancelled answer is not asked again without the thought', async () => {
    let calls = 0;
    const model: LocalModel = {
      chat: () => {
        calls += 1;
        return Promise.reject(new LocalModelError('bad-response', 'fake: not JSON'));
      },
    };
    // Not cancelled: the answer that is not JSON is asked once more (D-051).
    const report = await runGroup(createOrchestratorGroup({ model: () => model, prompt: () => 'P' }), [evalCase]);
    assert.equal(report.status, 'failed');
    assert.equal(calls, 2);
    calls = 0;
    const controller = new AbortController();
    controller.abort();
    const subject = createOrchestratorGroup({ model, prompt: 'P' }).subject;
    assert.ok(subject.status === 'active');
    await assert.rejects(Promise.resolve(subject.evaluate(evalCase.input, controller.signal)), LocalModelError);
    assert.equal(calls, 1);
  });
});
