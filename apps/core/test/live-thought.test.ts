import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { answerThought } from '../src/orchestrator/orchestrator.ts';
import { MAX_THOUGHT, replyStream, storedThought, type ChatReply } from '../src/reply.ts';

/** A reply that only records what it was given. */
function recorder(): { reply: ChatReply; sent: string[] } {
  const sent: string[] = [];
  const reply: ChatReply = {
    id: 'r',
    delta: (text) => {
      sent.push(`text:${text}`);
      return Promise.resolve();
    },
    thought: (text) => {
      sent.push(`thought:${text}`);
      return Promise.resolve();
    },
    finish: () => Promise.reject(new Error('not used')),
  };
  return { reply, sent };
}

describe('the thinking of an answer (D-249)', () => {
  it('joins the thoughts of the steps since the last answer, with their times', () => {
    const turns = [
      { thought: 'vecchio', thoughtMs: 900, messageId: null },
      { thought: 'risposta prima', thoughtMs: 1000, messageId: '7' },
      { thought: 'cerco nella KB', thoughtMs: 2000, messageId: null },
      { thought: null, thoughtMs: null, messageId: null },
    ];
    assert.deepEqual(answerThought(turns, 'ora rispondo', 3000), { thought: 'cerco nella KB\n\nora rispondo', thoughtMs: 5000 });
    // Negative: no step thought, nothing given (the reply keeps what came live).
    assert.deepEqual(answerThought([{ thought: null, thoughtMs: null, messageId: null }], undefined, undefined), {});
    assert.deepEqual(answerThought([], '  ', 10), {});
    // Without times, the thought alone.
    assert.deepEqual(answerThought([], 'solo testo', undefined), { thought: 'solo testo' });
  });

  it('stores the thinking trimmed and cut', () => {
    assert.equal(storedThought('  ciao \n'), 'ciao');
    assert.equal(Array.from(storedThought('x'.repeat(MAX_THOUGHT + 10))).length, MAX_THOUGHT);
    assert.equal(storedThought(''), '');
  });

  it('streams cloud runs: pieces live, whole blocks only when not already streamed, one paragraph each', async () => {
    const { reply, sent } = recorder();
    const stream = replyStream(reply);
    await stream.live({ kind: 'thought', text: '' });
    await stream.live({ kind: 'thought', text: 'Ci penso' });
    await stream.live({ kind: 'text', text: 'Pri' });
    await stream.live({ kind: 'text', text: 'mo' });
    await stream.block('Primo', true);
    await stream.block('Secondo');
    await stream.live({ kind: 'text', text: 'Terzo' });
    await stream.block('Terzo', true);
    assert.deepEqual(sent, ['thought:', 'thought:Ci penso', 'text:Pri', 'text:mo', 'text:\n\nSecondo', 'text:\n\nTerzo']);
    // A new start opens the reply again.
    stream.restart();
    await stream.block('Di nuovo');
    assert.equal(sent.at(-1), 'text:Di nuovo');
    // A piece refused (a value of the vault) does not stop the live text, but its whole block fails: the run stops, as before.
    const refusing: ChatReply = { ...reply, delta: (text) => (text.includes('segreto') ? Promise.reject(new Error('vault')) : Promise.resolve()) };
    const guarded = replyStream(refusing);
    await guarded.live({ kind: 'text', text: 'il segreto' });
    await assert.rejects(guarded.block('il segreto', true), /vault/);
    // Negative: an accepted block streamed in pieces goes through.
    await guarded.live({ kind: 'text', text: 'pulito' });
    await guarded.block('pulito', true);
    // Without a reply (a card) nothing is shown and nothing fails.
    const none = replyStream(undefined);
    await none.live({ kind: 'thought', text: 'x' });
    await none.block('y');
  });
});
