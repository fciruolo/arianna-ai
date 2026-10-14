// Who the user may talk with directly, and how (D-111d): from the card only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LoadedAgent } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { CODEX_CHAT_OFF, directPolicies, directPolicyOf, offInterlocutors, projectFits } from '../src/direct-chat.ts';
import { committedAgents } from './support/committed-agents.ts';

const loaded = committedAgents(resolveHome({}));
const found = loaded.get('coder');
assert.ok(found !== undefined);
const coder: LoadedAgent = found;

/** A card that only answers on the local model, reading up to `maxLabel`. */
function answering(maxLabel: 'L1' | 'L2'): LoadedAgent {
  const card = { ...coder.card, name: 'traduttore', executors: ['local'], tools: [], maxLabel };
  delete (card as { cloudMaxLabel?: unknown }).cloudMaxLabel;
  return { ...coder, card } as unknown as LoadedAgent;
}

test('an agent on Claude: a work conversation on a project, and only while Claude is on', () => {
  assert.deepEqual(directPolicyOf('coder', coder, { claude: true, codex: false }), {
    agent: 'coder',
    description: coder.card.description,
    cloud: true,
    executors: ['claude'],
    modes: ['work'],
    project: true,
  });
  assert.equal(directPolicyOf('coder', coder, { claude: false, codex: false }), undefined);
});

test('an agent on Codex too (D-140): either executor of its card opens the chat, in the order of the card', () => {
  assert.deepEqual(directPolicyOf('coder', coder, { claude: false, codex: true })?.executors, ['codex']);
  assert.deepEqual(directPolicyOf('coder', coder, { claude: true, codex: true })?.executors, ['claude', 'codex']);
  const reviewer = { ...coder, card: { ...coder.card, name: 'reviewer', executors: ['codex', 'claude', 'local'] } } as unknown as LoadedAgent;
  assert.deepEqual(directPolicyOf('reviewer', reviewer, { claude: true, codex: true })?.executors, ['codex', 'claude']);
  const claudeOnly = { ...coder, card: { ...coder.card, executors: ['claude', 'local'] } } as unknown as LoadedAgent;
  assert.equal(directPolicyOf('scrittore', claudeOnly, { claude: false, codex: true }), undefined, 'Codex on does not open an agent whose card does not name it');
});

test('a local agent: no project; private too only when its card may read Privato', () => {
  assert.deepEqual(directPolicyOf('traduttore', answering('L2'), { claude: false, codex: false })?.modes, ['private', 'work']);
  assert.deepEqual(directPolicyOf('traduttore', answering('L1'), { claude: false, codex: false })?.modes, ['work']);
  assert.equal(directPolicyOf('traduttore', answering('L1'), { claude: false, codex: false })?.project, false);
  assert.equal(directPolicyOf('traduttore', answering('L1'), { claude: false, codex: false })?.cloud, false);
});

test('never Arianna; the plain chat with Claude, then the Coder first in the list', () => {
  const arianna = loaded.get('arianna');
  assert.ok(arianna !== undefined);
  assert.equal(directPolicyOf('arianna', arianna, { claude: true, codex: false }), undefined);
  const agents = new Map<string, LoadedAgent>([['zeta', answering('L1')], ['coder', coder], ['arianna', arianna], ['alfa', answering('L1')]]);
  assert.deepEqual(directPolicies(agents, { claude: true, codex: false }).map((policy) => policy.agent), ['claude', 'coder', 'alfa', 'zeta']);
});

test('GOD (D-127): read only, on Claude or Codex, and only on a part of the container of Arianna\'s clones', () => {
  const god = loaded.get('god');
  assert.ok(god !== undefined);
  assert.deepEqual(god.card.tools, ['repo.read'], 'GOD never writes: the subtasks do');
  assert.equal(god.card.maxLabel, 'L1');
  const policy = directPolicyOf('god', god, { claude: true, codex: true });
  assert.ok(policy !== undefined);
  assert.equal(policy.container, 'arianna');
  assert.deepEqual(policy.executors, ['claude', 'codex']);
  assert.equal(directPolicyOf('coder', coder, { claude: true, codex: false })?.container, undefined);
  assert.equal(projectFits(policy, 'arianna:main'), true);
  assert.equal(projectFits(policy, 'arianna'), true);
  assert.equal(projectFits(policy, 'demo'), false);
  assert.equal(projectFits(policy, 'ariannax:main'), false);
  assert.equal(projectFits(policy, undefined), false);
  assert.equal(projectFits({}, 'demo'), true, 'an agent without a container: any project');
});

test('«Con chi parli» (D-111, tappa B): the local model only in private, Claude without a project only while Claude is on, ChatGPT off', () => {
  const local = loaded.get('local-chat');
  assert.ok(local !== undefined);
  assert.deepEqual(directPolicyOf('local-chat', local, { claude: true, codex: true }), {
    agent: 'local-chat',
    description: local.card.description,
    cloud: false,
    executors: [],
    modes: ['private'],
    project: false,
    interlocutor: true,
  });
  const on = directPolicies(loaded, { claude: true, codex: true });
  assert.deepEqual(on.slice(0, 3).map((policy) => policy.agent), ['local-chat', 'claude', 'coder']);
  const claude = on.find((policy) => policy.agent === 'claude');
  assert.deepEqual(claude && { cloud: claude.cloud, modes: claude.modes, project: claude.project, executors: claude.executors }, { cloud: true, modes: ['work'], project: false, executors: ['claude'] });
  // Claude off: no plain chat, and it is listed off with why; ChatGPT is always off for now.
  assert.ok(!directPolicies(loaded, { claude: false, codex: true }).some((policy) => policy.agent === 'claude' || policy.agent === 'codex'));
  assert.deepEqual(offInterlocutors({ claude: false, codex: true }).map((off) => off.agent), ['claude', 'codex']);
  assert.deepEqual(offInterlocutors({ claude: true, codex: true }).map((off) => [off.agent, off.reason]), [['codex', CODEX_CHAT_OFF]]);
  // A card named after an executor never becomes a direct chat of its own.
  assert.equal(directPolicyOf('claude', coder, { claude: true, codex: true }), undefined);
});
