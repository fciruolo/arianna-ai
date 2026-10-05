import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coderWarning, SESSION_COPY } from '../src/lib/draft.ts';
import { CONTEXT_WINDOW, contextMeter, contextTitle } from '../src/lib/direct-chat.ts';

test('the context meter: empty before the first answer, then tokens of the window with a level', () => {
  assert.deepEqual(contextMeter(null), { text: '—', percent: 0, level: 'ok' });
  assert.deepEqual(contextMeter(-1), { text: '—', percent: 0, level: 'ok' });
  assert.deepEqual(contextMeter(34_200), { text: '34k di 200k', percent: 17, level: 'ok' });
  assert.equal(contextMeter(820).text, '820 di 200k');
  assert.equal(contextMeter(130_000).level, 'warn');
  assert.equal(contextMeter(180_000).level, 'full');
  // Never above 100, even when the binary reports more than the window.
  assert.equal(contextMeter(CONTEXT_WINDOW * 2).percent, 100);
  assert.match(contextTitle(contextMeter(null)), /ancora vuoto/);
  assert.match(contextTitle(contextMeter(180_000)), /Quasi pieno/);
  assert.equal(contextTitle(contextMeter(34_200)).includes('Quasi pieno'), false);
});

test('the warning of the direct chat names the project and the copy of the session', () => {
  const text = coderWarning('sito');
  assert.match(text, /così com'è a Claude \(Anthropic\)/);
  assert.match(text, /progetto sito/);
  assert.ok(text.endsWith(SESSION_COPY));
  assert.equal(coderWarning(undefined).includes('progetto undefined'), false);
});
