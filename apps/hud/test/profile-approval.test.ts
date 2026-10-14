import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pendingAskText } from '../src/lib/pending-text.ts';
import { factProposal, factShare } from '../src/lib/profile-approval.ts';

// The cards of «Su di te» (D-114, tappe C e D; D-213). Invented facts.

const SHARE: { kind: 'declassify'; action: string; detail: Record<string, unknown> } = {
  kind: 'declassify',
  action: 'share_fact',
  detail: { agent: 'coder', topic: 'città', reason: 'per il fuso orario del progetto', text: 'Vive a Borgo Finto', from: 'L2', to: 'L1' },
};

test('factShare: who asks, why in their words, the exact text that leaves', () => {
  const card = factShare(SHARE);
  assert.ok(card !== undefined);
  assert.equal(card.title, 'Coder chiede: città');
  assert.equal(card.reason, 'per il fuso orario del progetto');
  assert.equal(card.text, 'Vive a Borgo Finto');
  assert.match(card.note, /una volta/);
});

test('factShare: nothing for a plain declassification or a detail that is not whole', () => {
  assert.equal(factShare({ ...SHARE, action: 'declassify' }), undefined);
  assert.equal(factShare({ ...SHARE, detail: { ...SHARE.detail, text: 1 } }), undefined);
  assert.equal(factShare({ ...SHARE, kind: 'im' as const }), undefined);
});

test('factProposal: topic, text and whether it replaces one; nothing for another kind', () => {
  assert.match(factProposal({ kind: 'fact', detail: { topic: 'città', text: 'Borgo Torinese' } })?.note ?? '', /Solo in casa/);
  assert.match(factProposal({ kind: 'fact', detail: { topic: 'città', text: 'Borgo Torinese', replaces: true } })?.note ?? '', /^Sostituisce/);
  assert.equal(factProposal({ kind: 'im', detail: { topic: 'città', text: 'x' } }), undefined);
  assert.equal(factProposal({ kind: 'fact', detail: { topic: 'città' } }), undefined);
});

test('the window of pending decisions names the topic, never the text', () => {
  assert.equal(pendingAskText(SHARE), 'Dare a Coder il dato «città», una volta');
  assert.equal(pendingAskText({ kind: 'fact', action: 'profile.propose', detail: { topic: 'città', text: 'Borgo Torinese' } }), 'Ricordare «città» in «Su di te»');
  assert.doesNotMatch(pendingAskText(SHARE), /Borgo/);
});
