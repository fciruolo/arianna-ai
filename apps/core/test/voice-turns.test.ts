import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Message } from '../src/conversations.ts';
import { callReadiness, HISTORY_MESSAGES, parseReply, speakable, summaryToSay, voicePrompt, VOICE_SYSTEM_PROMPT } from '../src/voice/turns.ts';
import type { TrialModel } from '../src/voice/trial.ts';

const message = (role: Message['role'], body: string, label: Message['label'] = 'L1'): Message => ({
  id: '1',
  conversationId: 'c',
  ts: new Date(0),
  role,
  channel: 'web',
  label,
  body,
  taskId: null,
  agent: null,
  model: null,
});

test('voicePrompt: the system prompt, then the latest user and assistant messages, cut; the label is their highest', () => {
  const history = [message('system', 'errore'), message('user', 'ciao', 'L1'), message('assistant', 'x'.repeat(2000), 'L2')];
  const prompt = voicePrompt(history, 'L0');
  assert.equal(prompt.messages[0]?.content, VOICE_SYSTEM_PROMPT);
  assert.deepEqual(prompt.messages.slice(1).map(({ role }) => role), ['user', 'assistant']);
  assert.ok((prompt.messages[2]?.content.length ?? 0) <= 1201);
  assert.equal(prompt.label, 'L2');
  const long = Array.from({ length: 40 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', String(index), 'L0'));
  assert.equal(voicePrompt(long, 'L0').messages.length, HISTORY_MESSAGES + 1);
  assert.equal(voicePrompt([], 'L1').label, 'L1');
});

test('parseReply: a DELEGA line asks for a delegation; anything else is said, cleaned', () => {
  assert.deepEqual(parseReply('DELEGA: controlla le fatture di settembre'), { kind: 'delegate', request: 'controlla le fatture di settembre' });
  assert.deepEqual(parseReply('Va bene.\ndelega: cerca il contratto'), { kind: 'delegate', request: 'cerca il contratto' });
  assert.deepEqual(parseReply('DELEGA:   '), { kind: 'say', text: 'DELEGA:' });
  assert.deepEqual(parseReply('**Certo!** Ecco 🙂'), { kind: 'say', text: 'Certo! Ecco' });
  assert.deepEqual(parseReply('<think>ragiono</think>Sì.'), { kind: 'say', text: 'Sì.' });
});

test('speakable and summaryToSay: no markdown, links or emoji; a long answer is cut on a sentence and points to the chat', () => {
  assert.equal(speakable('# Titolo\n- uno\n- [due](https://x.org)\n```js\ncode\n```'), 'Titolo uno due');
  const long = 'Prima frase lunga abbastanza da contare. '.repeat(20);
  const said = summaryToSay(long);
  assert.ok(said.length < 460);
  assert.match(said, /Il resto te l’ho scritto in chat\.$/);
  assert.equal(summaryToSay('Fatto.'), 'Fatto.');
});

const model = (id: string, family: string, kind: 'stt' | 'tts', present: boolean, assigned: boolean, voices: string[] = []): TrialModel => ({
  id,
  family,
  kind,
  present,
  assigned,
  sizeBytes: 1,
  voices,
});

test('callReadiness: the three roles, with stt and tts on disk, and a voice of the tts model', () => {
  const parakeet = model('p', 'parakeet', 'stt', true, true);
  const kokoro = model('k', 'kokoro', 'tts', true, true, ['if_sara', 'im_nicola']);
  const ready = { ready: true, stt: { id: 'p', family: 'parakeet' }, tts: { id: 'k', family: 'kokoro' } };
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, kokoro], true, 'im_nicola'), { ...ready, voice: 'im_nicola' });
  // The voice of [voice] is not one of the model (D-067): its first voice.
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, kokoro], true, 'it_female'), { ...ready, voice: 'if_sara' });
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, kokoro]), { ...ready, voice: 'if_sara' });
  assert.deepEqual(callReadiness({}, [parakeet, kokoro]), { ready: false, missing: ['voice'] });
  assert.deepEqual(callReadiness({ voice: 'q' }, [{ ...parakeet, present: false }, kokoro]), { ready: false, missing: ['stt'] });
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, { ...kokoro, assigned: false }]), { ready: false, missing: ['tts'] });
  const qwen = model('q', 'qwen3-tts', 'tts', true, true, ['serena', 'vivian']);
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, qwen], true, 'vivian'), {
    ready: true,
    stt: { id: 'p', family: 'parakeet' },
    tts: { id: 'q', family: 'qwen3-tts' },
    voice: 'vivian',
  });
  const fallback = callReadiness({ voice: 'q' }, [parakeet, qwen], true, 'if_sara');
  assert.equal(fallback.ready && fallback.voice, 'serena');
  // A tts model without voices cannot speak.
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, { ...kokoro, voices: [] }]), { ready: false, missing: ['tts'] });
});
