// Who the user may talk with directly, and how (D-111d): from the card only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LoadedAgent } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { directPolicies, directPolicyOf } from '../src/direct-chat.ts';
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
  assert.deepEqual(directPolicyOf('coder', coder, { claude: true }), { agent: 'coder', description: coder.card.description, cloud: true, modes: ['work'], project: true });
  assert.equal(directPolicyOf('coder', coder, { claude: false }), undefined);
});

test('a local agent: no project; private too only when its card may read Privato', () => {
  assert.deepEqual(directPolicyOf('traduttore', answering('L2'), { claude: false })?.modes, ['private', 'work']);
  assert.deepEqual(directPolicyOf('traduttore', answering('L1'), { claude: false })?.modes, ['work']);
  assert.equal(directPolicyOf('traduttore', answering('L1'), { claude: false })?.project, false);
  assert.equal(directPolicyOf('traduttore', answering('L1'), { claude: false })?.cloud, false);
});

test('never Arianna; the Coder first in the list', () => {
  const arianna = loaded.get('arianna');
  assert.ok(arianna !== undefined);
  assert.equal(directPolicyOf('arianna', arianna, { claude: true }), undefined);
  const agents = new Map<string, LoadedAgent>([['zeta', answering('L1')], ['coder', coder], ['arianna', arianna], ['alfa', answering('L1')]]);
  assert.deepEqual(directPolicies(agents, { claude: true }).map((policy) => policy.agent), ['coder', 'alfa', 'zeta']);
});
