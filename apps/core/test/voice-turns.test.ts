import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Message } from '../src/conversations.ts';
import { agentCallText, agentVoiceSystem, AGENT_VOICE_FRAME, CALL_TEXT, callReadiness, delegationRequest, greetingFor, HISTORY_CHARS, HISTORY_MAX_MESSAGES, HISTORY_MESSAGES, opensDelegation, parseReply, sentenceSplitter, speakable, summaryToSay, voicePrompt, VOICE_SYSTEM_PROMPT } from '../src/voice/turns.ts';
import type { TrialModel } from '../src/voice/trial.ts';

const message = (role: Message['role'], body: string, label: Message['label'] = 'L1', id = '1'): Message => ({
  id,
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
  assert.ok((prompt.messages[2]?.content.length ?? 0) <= HISTORY_CHARS + 1);
  assert.equal(prompt.label, 'L2');
  const long = Array.from({ length: 40 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', String(index), 'L0'));
  assert.equal(voicePrompt(long, 'L0').messages.length, HISTORY_MESSAGES + 1);
  assert.equal(voicePrompt([], 'L1').label, 'L1');
});

/** A conversation of `count` spoken messages, ids from 1. */
const conversation = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', `m${String(index + 1)}`, 'L0', String(index + 1)));

test('voicePrompt: the window stays anchored to its first message, so each prompt extends the previous one (D-072)', () => {
  const first = voicePrompt(conversation(20), 'L0');
  assert.equal(first.anchor, String(20 - HISTORY_MESSAGES + 1));
  // Two turns later: the same start, two messages more, the earlier prompt as its prefix.
  const later = voicePrompt(conversation(22), 'L0', first.anchor);
  assert.equal(later.anchor, first.anchor);
  assert.equal(later.messages.length, first.messages.length + 2);
  assert.deepEqual(later.messages.slice(0, first.messages.length), first.messages);
  // A system message in between is left out without moving the start.
  const withSystem = [...conversation(22), message('system', 'errore', 'L0', '23')];
  assert.deepEqual(voicePrompt(withSystem, 'L0', first.anchor).messages, later.messages);
});

test('voicePrompt: past the maximum, or when the anchor is gone, the window starts again from the latest messages', () => {
  const anchor = String(20 - HISTORY_MESSAGES + 1);
  const full = voicePrompt(conversation(20 - HISTORY_MESSAGES + HISTORY_MAX_MESSAGES), 'L0', anchor);
  assert.equal(full.anchor, anchor);
  assert.equal(full.messages.length, HISTORY_MAX_MESSAGES + 1);
  const over = voicePrompt(conversation(20 - HISTORY_MESSAGES + HISTORY_MAX_MESSAGES + 1), 'L0', anchor);
  assert.notEqual(over.anchor, anchor);
  assert.equal(over.messages.length, HISTORY_MESSAGES + 1);
  const gone = voicePrompt(conversation(20), 'L0', '999');
  assert.equal(gone.anchor, String(20 - HISTORY_MESSAGES + 1));
  // The label covers the whole window, not only the latest messages.
  const labelled = conversation(12);
  labelled[2] = message('user', 'privato', 'L2', '3');
  assert.equal(voicePrompt(labelled, 'L0', '3').label, 'L2');
  assert.equal(voicePrompt(labelled, 'L0').label, 'L0');
  // An empty conversation keeps the anchor it had (none).
  assert.equal(voicePrompt([], 'L0').anchor, undefined);
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
  // A copied voice that is gone is never replaced by another person's (D-069).
  const base = model('b', 'qwen3-tts-base', 'tts', true, true, ['anna', 'moglie']);
  assert.equal(callReadiness({ voice: 'q' }, [parakeet, base], true, 'moglie').ready, true);
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, base], true, 'cancellata'), { ready: false, missing: ['tts'] });
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, base]), { ready: false, missing: ['tts'] });
  // A tts model without voices cannot speak.
  assert.deepEqual(callReadiness({ voice: 'q' }, [parakeet, { ...kokoro, voices: [] }]), { ready: false, missing: ['tts'] });
});

/** The pieces a splitter gives for text arriving in these chunks. */
function split(...chunks: string[]): string[] {
  const splitter = sentenceSplitter();
  return [...chunks.flatMap((chunk) => splitter.push(chunk)), ...splitter.end()];
}

test('the splitter cuts sentences as they are written (D-070)', () => {
  assert.deepEqual(split('Ciao', ', sono Ari', 'anna. Dim', 'mi pure! Va bene?', ' Sì'), ['Ciao, sono Arianna.', 'Dimmi pure!', 'Va bene?', 'Sì']);
  const splitter = sentenceSplitter();
  // A full stop waits for the space that follows: "3.5" is not two sentences.
  assert.deepEqual(splitter.push('Costa 3.'), []);
  assert.deepEqual(splitter.push('5 euro. Poi'), ['Costa 3.5 euro.']);
  assert.deepEqual(splitter.end(), ['Poi']);
});

test('the splitter cuts at line breaks and at ellipses', () => {
  assert.deepEqual(split('Prima riga\nSeconda… ', 'terza'), ['Prima riga', 'Seconda…', 'terza']);
  assert.deepEqual(split('\n\n', '  '), []);
});

test('the splitter holds open think blocks and code fences', () => {
  assert.deepEqual(split('<think>Penso. Ancora. ', 'Fine.</think> Eccomi. Ciao'), ['<think>Penso. Ancora. Fine.</think> Eccomi.', 'Ciao']);
  assert.deepEqual(split('Ecco. ```js\nuno. due\n', '``` Fatto. Sì'), ['Ecco.', '```js\nuno. due\n``` Fatto.', 'Sì']);
});

test('a delegation is seen at the start of a piece only', () => {
  assert.equal(opensDelegation('DELEGA: cerca le fatture.'), true);
  assert.equal(opensDelegation('  delega: cerca'), true);
  assert.equal(opensDelegation('Ti DELEGA: no'), false);
  assert.equal(opensDelegation('Va bene.'), false);
});

test('an open think block or code fence at the end is never said', () => {
  assert.deepEqual(split('Ecco. <think>penso ancora'), ['Ecco.']);
  assert.deepEqual(split('Ecco: ```js\nuno'), ['Ecco:']);
});

test('a delegation is seen once the piece is cleaned as it would be said', () => {
  assert.equal(opensDelegation('**DELEGA:** cerca'), true);
  assert.equal(opensDelegation('<think>no</think> DELEGA: cerca'), true);
  assert.equal(delegationRequest(['**DELEGA:** cerca le fatture.', 'Di ottobre.']), 'cerca le fatture. Di ottobre.');
});


test('an agent of a direct chat in a call does not need the voice role; Arianna does (D-158)', () => {
  const models: TrialModel[] = [
    { id: 's', family: 'parakeet', kind: 'stt', present: true, assigned: true, sizeBytes: 1, voices: [] },
    { id: 't', family: 'kokoro', kind: 'tts', present: true, assigned: true, sizeBytes: 1, voices: ['if_sara'] },
  ];
  assert.equal(callReadiness({}, models, true, undefined, false).ready, true);
  assert.deepEqual(callReadiness({}, models), { ready: false, missing: ['voice'] });
});

test('an agent of a direct chat in a call (D-158): its greeting says its name, the cloud one says it passes the words on; Arianna keeps hers', () => {
  assert.equal(greetingFor(CALL_TEXT.greeting, { kind: 'arianna' }), CALL_TEXT.greeting);
  assert.equal(greetingFor(CALL_TEXT.greeting, { kind: 'local', agent: 'traduttore', name: 'traduttore', nameLabel: 'L1', model: 'local-large' }), 'Ciao, sono traduttore. Dimmi pure.');
  const coder = greetingFor(CALL_TEXT.greeting, { kind: 'cloud', agent: 'coder', name: 'Coder', nameLabel: 'L0' });
  assert.equal(coder, 'Ciao, sono la linea del Coder: quello che mi dici lo passo al Coder. Dimmi pure.');
  assert.ok(!coder.includes('Arianna'));
  // A greeting that does not start with Arianna's name keeps all its words after the agent's.
  assert.equal(greetingFor('Ti chiamo.', { kind: 'local', agent: 'x', name: 'x', nameLabel: 'L1', model: 'm' }), 'Ciao, sono x. Ti chiamo.');
  // Another cloud agent goes by its id, without the article of the Coder.
  assert.equal(
    greetingFor(CALL_TEXT.greeting, { kind: 'cloud', agent: 'pippo', name: 'pippo', nameLabel: 'L1' }),
    'Ciao, sono la linea di pippo: quello che mi dici lo passo a pippo. Dimmi pure.',
  );
  assert.equal(agentCallText('Coder').bridged, 'Lo passo al Coder, ti dico quando ha finito.');
  assert.equal(agentCallText('scrittore').bridged, 'Lo passo a scrittore, ti dico quando ha finito.');
  assert.ok(agentCallText('Coder').busy.startsWith('Coder sta ancora lavorando'));
});

test('voicePrompt with the system of an agent: its instructions after our frame, their label counted; never the prompt of Arianna', () => {
  const system = { content: agentVoiceSystem('Traduci in inglese.'), label: 'L1' as const };
  const prompt = voicePrompt([message('user', 'ciao', 'L0')], 'L0', undefined, system);
  assert.ok(prompt.messages[0]?.content.startsWith(AGENT_VOICE_FRAME));
  assert.ok(prompt.messages[0]?.content.endsWith('Traduci in inglese.'));
  assert.notEqual(prompt.messages[0]?.content, VOICE_SYSTEM_PROMPT);
  assert.equal(prompt.messages[0]?.label, 'L1');
  assert.equal(prompt.label, 'L1');
  // Without a system, Arianna's L0 prompt as before.
  assert.equal(voicePrompt([message('user', 'ciao', 'L0')], 'L0').label, 'L0');
});
