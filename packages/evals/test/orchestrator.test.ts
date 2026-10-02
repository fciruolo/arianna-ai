import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { isToolId, type ToolId } from '@arianna/agents';
import { loadConfig, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { loadCases } from '../src/cases.ts';
import { GROUPS } from '../src/groups.ts';
import {
  createOrchestratorEvaluator,
  matchesExpectation,
  responseSchema,
  summarize,
  TOOL_ARGS,
  type OrchestratorExpectation,
  type OrchestratorInput,
} from '../src/orchestrator.ts';
import { runGroup } from '../src/runner.ts';
import { validate } from '../src/schema.ts';

describe('validate', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 3 },
      n: { type: 'integer', minimum: 1, maximum: 5 },
      kind: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('accepts a conforming value', () => {
    assert.deepEqual(validate(schema, { name: 'ab', n: 3, kind: 'a', list: ['x'] }), []);
  });

  it('reports each kind of violation', () => {
    assert.deepEqual(validate(schema, {}), ['$.name: required']);
    assert.deepEqual(validate(schema, { name: '' }), ['$.name: too short']);
    assert.deepEqual(validate(schema, { name: 'abcd' }), ['$.name: too long']);
    assert.deepEqual(validate(schema, { name: 'a', n: 1.5 }), ['$.n: expected an integer']);
    assert.deepEqual(validate(schema, { name: 'a', n: 9 }), ['$.n: above maximum']);
    assert.deepEqual(validate(schema, { name: 'a', kind: 'c' }), ['$.kind: not one of ["a","b"]']);
    assert.deepEqual(validate(schema, { name: 'a', list: [] }), ['$.list: too few items']);
    assert.deepEqual(validate(schema, { name: 'a', list: [1] }), ['$.list[0]: expected a string']);
    assert.deepEqual(validate(schema, { name: 'a', extra: 1 }), ['$.extra: not allowed']);
    assert.deepEqual(validate(schema, []), ['$: expected an object']);
  });

  it('handles const and anyOf', () => {
    const either = { anyOf: [{ const: 'x' }, { type: 'integer' }] };
    assert.deepEqual(validate(either, 'x'), []);
    assert.deepEqual(validate(either, 2), []);
    assert.deepEqual(validate(either, 'y'), ['$: matches no option']);
  });

  it('rejects keywords it does not implement, instead of ignoring them', () => {
    assert.throws(() => validate({ type: 'string', pattern: '^a' }, 'a'), /unsupported schema keyword/);
    assert.throws(() => validate({ type: 'null' }, null), /unsupported type/);
  });
});

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
    const { model, requests } = stub({ action: 'call', tool: 'kb.search', arguments: { query: 'caparra' } });
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

  it('marks arguments outside the schema, and tools not offered', () => {
    assert.equal(summarize({ action: 'call', tool: 'kb.search', arguments: {} }, tools).schemaOk, false);
    assert.equal(summarize({ action: 'call', tool: 'file.delete', arguments: { path: 'x' } }, tools).schemaOk, false);
    assert.deepEqual(summarize('nonsense', tools), { action: 'invalid', schemaOk: false });
  });

  it('counts plan steps and recognizes replies and refusals', () => {
    assert.deepEqual(summarize({ action: 'plan', steps: ['a', 'b', 'c'] }, tools), { action: 'plan', steps: '3-5', schemaOk: true });
    assert.deepEqual(summarize({ action: 'plan', steps: ['a', 'b'] }, tools), { action: 'plan', steps: '2', schemaOk: true });
    assert.deepEqual(summarize({ action: 'reply', text: 'ok' }, tools), { action: 'reply', schemaOk: true });
    assert.deepEqual(summarize({ action: 'refuse', reason: 'no tool' }, tools), { action: 'refuse', schemaOk: true });
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

  // Only meaningful until a local model is configured: then the real run is `pnpm eval:models`.
  const configured = loadConfig({}).local.endpoints.length > 0;
  it('fail clearly when no local endpoint is configured', { skip: configured }, async () => {
    const group = GROUPS.find((candidate) => candidate.name === 'orchestrator');
    assert.ok(group !== undefined);
    const first = cases[0];
    assert.ok(first !== undefined);
    const report = await runGroup(group, [first]);
    assert.ok(report.status === 'failed' && /local\.endpoints/.test(report.results[0]?.error ?? ''), JSON.stringify(report));
  });
});
