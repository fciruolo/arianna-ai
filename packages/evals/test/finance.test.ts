import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadAgent, AGENTS_DIR, type ToolId } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';

import { loadCases } from '../src/cases.ts';
import { createFinanceGroup, matchesFinance, type FinanceExpectation } from '../src/finance-group.ts';
import { summarize, type OrchestratorInput } from '../src/orchestrator.ts';
import { runGroup } from '../src/runner.ts';

const reply = (text: string) => ({ action: 'reply' as const, text, schemaOk: true });

describe('matchesFinance', () => {
  const expect: FinanceExpectation = { accept: [{ action: 'reply' }], mentions: ['225,49'], avoids: ['1.624,51'] };

  it('passes a reply that quotes the figure as the tool wrote it', () => {
    assert.ok(matchesFinance(reply('A settembre hai speso 225,49 €.'), expect));
  });

  it('reads a no-break space as a space, on both sides, and ignores case', () => {
    assert.ok(matchesFinance(reply('Hai speso 225,49 €.'), { accept: [{ action: 'reply' }], mentions: ['225,49 €'] }));
    assert.ok(matchesFinance(reply('Hai speso 225,49 €.'), { accept: [{ action: 'reply' }], mentions: ['225,49 €'] }));
    assert.ok(matchesFinance(reply('Rivolgiti a un consulente abilitato.'), { accept: [{ action: 'reply' }], mentions: ['Consulente'] }));
  });

  it('fails a reply without the figure, with a forbidden one, or without text', () => {
    assert.ok(!matchesFinance(reply('Hai speso circa 225 €.'), expect));
    assert.ok(!matchesFinance(reply('Hai speso 225,49 € e risparmiato 1.624,51 €.'), expect));
    assert.ok(!matchesFinance({ action: 'reply', schemaOk: true }, expect));
  });

  it('keeps the orchestrator checks: action and schema', () => {
    assert.ok(!matchesFinance({ action: 'call', tool: 'finance.summary', schemaOk: true }, expect));
    assert.ok(!matchesFinance({ ...reply('225,49'), schemaOk: false }, expect));
    assert.ok(matchesFinance({ action: 'call', tool: 'finance.summary', schemaOk: true }, { accept: [{ action: 'call', tool: 'finance.summary' }] }));
  });
});

describe('summarize keeps the text only when asked', () => {
  const tools: ToolId[] = ['finance.summary', 'user.ask'];

  it('drops it by default, as the orchestrator group always did', () => {
    assert.equal(summarize({ thought: 'x', action: 'reply', text: 'ciao' }, tools).text, undefined);
  });

  it('keeps the reply text and the refusal reason', () => {
    assert.equal(summarize({ thought: 'x', action: 'reply', text: 'ciao' }, tools, true, undefined, undefined, true).text, 'ciao');
    assert.equal(summarize({ thought: 'x', action: 'refuse', reason: 'no' }, tools, true, undefined, undefined, true).text, 'no');
  });
});

describe('finance cases', () => {
  const home = resolveHome({});
  const cases = loadCases(join(home, 'evals', 'finance'));
  const agentTools = loadAgent(join(home, AGENTS_DIR), 'finanze').card.tools;

  it('cover every measure and offer the tools of the Finanze card', () => {
    for (const tag of ['tool', 'figures', 'refusal']) assert.ok(cases.some((c) => c.tags.includes(tag)), tag);
    for (const evalCase of cases) {
      const input = evalCase.input as OrchestratorInput;
      assert.deepEqual([...input.tools].sort(), [...agentTools].sort(), evalCase.id);
      const expectation = evalCase.expect as FinanceExpectation;
      for (const outcome of [...(expectation.accept ?? []), ...(expectation.forbid ?? [])]) {
        if (outcome.tool !== undefined) assert.ok(input.tools.includes(outcome.tool as ToolId), `${evalCase.id}: ${outcome.tool}`);
      }
    }
  });

  it('run on a model and check the figures of its replies', async () => {
    const answers: unknown[] = [];
    const model: LocalModel = {
      chat: (request: ChatRequest) => {
        answers.push(request.model);
        return Promise.resolve({ value: { thought: 't', action: 'reply', text: 'Hai speso 225,49 €.' }, raw: '' });
      },
    } as unknown as LocalModel;
    const group = createFinanceGroup({ model: () => model });
    const report = await runGroup(group, [
      { id: 'ok', input: { tools: agentTools, messages: [{ role: 'user', content: 'Quanto?' }] }, expect: { accept: [{ action: 'reply' }], mentions: ['225,49'] }, tags: ['figures'] },
      { id: 'ko', input: { tools: agentTools, messages: [{ role: 'user', content: 'Quanto?' }] }, expect: { accept: [{ action: 'reply' }], mentions: ['98,30'] }, tags: ['figures'] },
    ]);
    assert.equal(report.status === 'pending' ? -1 : report.passed, 1);
    assert.deepEqual(answers, ['local-large', 'local-large']);
  });
});
