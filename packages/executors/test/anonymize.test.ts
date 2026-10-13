// The anonymous version of a private note (D-187): what the model's answer may be.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anonymize, anonymizeInput, LocalModelError, MAX_ANONYMIZE_TEXT, readAnonymized, type ChatRequest, type LocalModel } from '@arianna/executors';

function model(answer: unknown, requests: ChatRequest[] = []): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ text: '', value: answer, finishReason: 'stop', endpoint: 'stub', model: 'stub-model', durationMs: 1 });
    },
  };
}

describe('readAnonymized', () => {
  it('takes the text of {"text": ...} only', () => {
    assert.deepEqual(readAnonymized({ value: { text: 'Fattura al [cliente].' }, finishReason: 'stop' }), { text: 'Fattura al [cliente].' });
    assert.deepEqual(readAnonymized({ value: { text: 'x' }, finishReason: 'length' }), { reason: 'truncated' });
    for (const value of [undefined, null, 'testo', ['x'], { text: '' }, { text: '   ' }, { text: 3 }, { text: 'x', note: 'y' }, { text: 'x'.repeat(MAX_ANONYMIZE_TEXT + 1) }]) {
      assert.deepEqual(readAnonymized({ value, finishReason: 'stop' }), { reason: 'bad-response' });
    }
  });
});

describe('anonymize', () => {
  it('sends the note as JSON data with its schema, and returns the text', async () => {
    const requests: ChatRequest[] = [];
    const outcome = await anonymize(model({ text: 'Al [cliente].' }, requests), anonymizeInput('Al cliente Rossi.'));
    assert.deepEqual(outcome, { ok: true, text: 'Al [cliente].', model: 'stub-model' });
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.messages[1]?.content, '{"note":"Al cliente Rossi."}');
    assert.equal(request.schema?.name, 'anonymous_note');
    assert.equal(request.temperature, 0);
  });

  it('says why it failed, never with the text', async () => {
    assert.deepEqual(await anonymize(model({ nope: 1 }), anonymizeInput('x')), { ok: false, reason: 'bad-response' });
    assert.deepEqual(await anonymize(model(new LocalModelError('timeout', 'slow')), anonymizeInput('x')), { ok: false, reason: 'timeout' });
    assert.deepEqual(await anonymize(model({ text: 'x' }), 'x'.repeat(MAX_ANONYMIZE_TEXT + 100)), { ok: false, reason: 'too-large' });
    const failed = await anonymize(model(new Error('boom')), anonymizeInput('x'));
    if (failed.ok) assert.fail('anonymize did not fail');
    assert.equal(failed.reason, 'model-error');
  });
});
