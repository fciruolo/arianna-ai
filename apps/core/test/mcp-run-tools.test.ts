// The tools of Arianna's MCP server a run gets (D-261): skills only where D-161
// lets an agent read them, the knowledge base only from the card's cloud_tools,
// and the delegations of the Coder alone.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AgentCard } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { delegationMcp } from '../src/orchestrator/delegate.ts';
import { delegationMcpTools, mcpToolsOf } from '../src/mcp/run-tools.ts';
import { committedAgents } from './support/committed-agents.ts';

const loaded = committedAgents(resolveHome({}));
const cardOf = (name: string): AgentCard => {
  const agent = loaded.get(name);
  assert.ok(agent !== undefined, name);
  return agent.card;
};
const closed = (card: AgentCard): AgentCard => ({ ...card, trifecta: { ...card.trifecta, untrusted_content: false } });

test('the Coder: the knowledge base of its cloud_tools, and the skills when some are assigned', () => {
  const coder = cardOf('coder');
  assert.deepEqual(coder.cloudTools, ['kb.search', 'kb.read']);
  assert.deepEqual(mcpToolsOf('coder', coder, []), ['kb_search', 'kb_read']);
  assert.deepEqual(mcpToolsOf('coder', coder, ['anthropics/skills/pdf']), ['list_skills', 'get_skill', 'kb_search', 'kb_read']);
});

test('a card closing untrusted_content gets no skills, its cloud_tools still', () => {
  assert.deepEqual(mcpToolsOf('coder', closed(cardOf('coder')), ['anthropics/skills/pdf']), ['kb_search', 'kb_read']);
  const withoutKb = closed(cardOf('coder'));
  delete withoutKb.cloudTools;
  assert.deepEqual(mcpToolsOf('coder', withoutKb, ['anthropics/skills/pdf']), []);
});

test('only the Coder has cloud_tools among the committed cards', () => {
  for (const [name, agent] of loaded) assert.equal(agent.card.cloudTools !== undefined, name === 'coder', name);
});

test('GOD, the Designer and Arianna get nothing in a delegation, skills or not', () => {
  assert.deepEqual(delegationMcpTools('god', cardOf('god'), []), []);
  assert.deepEqual(delegationMcpTools('god', cardOf('god'), ['anthropics/skills/pdf']), []);
  assert.deepEqual(delegationMcpTools('designer', cardOf('designer'), ['anthropics/skills/pdf']), []);
  // Arianna never reads skills (D-161), even where the rule alone is asked.
  assert.deepEqual(mcpToolsOf('arianna', cardOf('arianna'), ['anthropics/skills/pdf']), []);
  assert.deepEqual(delegationMcpTools('coder', cardOf('coder'), []), ['kb_search', 'kb_read']);
});

test('delegationMcp: none without the server or tools; the clearance within the task, the card and L1', () => {
  const server = { open: () => ({ token: 'x' }), revoke: () => undefined };
  const dir = join('/', 'tmp', 'mcp');
  const env = (agents: Record<string, { skills?: string[] }>) => ({
    mcp: { server, url: 'http://127.0.0.1:1/mcp', dir },
    settings: () => ({ agents }) as never,
  });
  assert.equal(delegationMcp({ settings: env({}).settings }, { clearance: 'L1' }, 'coder', cardOf('coder')), undefined);
  assert.equal(delegationMcp(env({}), { clearance: 'L1' }, 'god', cardOf('god')), undefined);
  assert.equal(delegationMcp(env({}), { clearance: 'L1' }, 'coder', { ...cardOf('coder'), cloudTools: [] }), undefined);

  const coder = delegationMcp(env({ coder: { skills: ['anthropics/skills/pdf'] } }), { clearance: 'L2' }, 'coder', cardOf('coder'));
  assert.ok(coder !== undefined);
  assert.deepEqual([coder.agent, coder.clearance, coder.url, coder.dir], ['coder', 'L1', 'http://127.0.0.1:1/mcp', dir]);
  assert.deepEqual(coder.tools, ['list_skills', 'get_skill', 'kb_search', 'kb_read']);
  assert.equal(delegationMcp(env({}), { clearance: 'L0' }, 'coder', cardOf('coder'))?.clearance, 'L0');
  // A server that did not start: the step still gets it, and runs without it with an event (runClaudeStep).
  assert.equal(delegationMcp({ ...env({}), mcp: { server, url: undefined, dir } }, { clearance: 'L1' }, 'coder', cardOf('coder'))?.url, undefined);
});
