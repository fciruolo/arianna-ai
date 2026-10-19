// The call of a routine (D-110 tappa B, D-259) without the voice: the greeting
// with the counts only, the titles after the «sì» up to the routine's label,
// the «sì» and the «no» read by code.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReportData } from '../src/routines.ts';
import { countsText, gateAnswer, hasTitles, isVoiceLabel, ROUTINE_CALL_TEXT, routineDetails, routineGreeting, salutation, spokenDue, VOICE_MAX_ITEMS } from '../src/voice/routine-call.ts';

const ROME = 'Europe/Rome';
// Monday 19 October 2026, 10:00 in Rome.
const NOW = new Date('2026-10-19T08:00:00Z');

const DATA: ReportData = {
  todo: {
    shown: [
      { title: 'Pagare la bolletta finta', label: 'L1', due: new Date('2026-10-20T10:00:00Z') },
      { title: 'Rinnovo del documento finto', label: 'L2', due: new Date('2026-10-16T10:00:00Z') },
      { title: 'Comprare il pane', label: 'L0', due: null },
    ],
    more: 2,
    secret: 1,
  },
  waiting: 2,
  notes: 3,
};

test('the greeting says the counts only, never a title, and asks before reading', () => {
  const greeting = routineGreeting(DATA, { kind: 'on-time' }, 'L2', ROME, NOW);
  assert.equal(greeting.text, 'Buongiorno, sono Arianna. È l’ora della tua routine. Hai 6 cose da fare, 2 decisioni in attesa e 3 pensieri da riordinare. Vuoi che ti legga i titoli? Rispondimi: sì grazie, oppure no grazie.');
  assert.equal(greeting.label, 'L2');
  assert.ok(greeting.asks);
  for (const item of DATA.todo?.shown ?? []) assert.ok(!greeting.text.includes(item.title));
});

test('late after the Mac was off: sorry for the delay; the second ring says it calls again', () => {
  const late = routineGreeting(DATA, { kind: 'late', due: new Date('2026-10-19T07:00:00Z') }, 'L2', ROME, NOW);
  assert.match(late.text, /^Buongiorno, sono Arianna\. Scusa il ritardo: la routine era per le 09:00, ma il Mac era spento o non ero attiva\. Hai /);
  const retry = routineGreeting(DATA, { kind: 'retry' }, 'L2', ROME, NOW);
  assert.match(retry.text, /Ti richiamo per la routine di prima\./);
});

test('nothing to read at the ceiling: no question, the report is in the chat', () => {
  const onlySecret: ReportData = { todo: { shown: [{ title: 'Privata finta', label: 'L2', due: null }], more: 0, secret: 1 } };
  const greeting = routineGreeting(onlySecret, { kind: 'on-time' }, 'L1', ROME, NOW);
  assert.ok(!greeting.asks);
  assert.ok(greeting.text.endsWith(ROUTINE_CALL_TEXT.inChat));
  assert.equal(routineDetails(onlySecret, 'L1', ROME, NOW), null);
  assert.ok(hasTitles(onlySecret, 'L2'));
  assert.equal(countsText({}), ROUTINE_CALL_TEXT.nothing);
  assert.equal(countsText({ waiting: 1 }), 'Hai una decisione in attesa.');
  assert.equal(countsText({ cards: { running: { shown: [], more: 0, secret: 0 }, toVerify: 2 }, done: { shown: [], more: 1, secret: 0 } }), 'Hai 2 carte da verificare e una cosa fatta dall’ultimo resoconto.');
});

test('the titles after the «sì»: up to the label of the routine, the rest counted, Segreto never', () => {
  const all = routineDetails(DATA, 'L2', ROME, NOW);
  assert.ok(all !== null);
  assert.equal(
    all.text,
    'Da fare: Pagare la bolletta finta, scade domani; Rinnovo del documento finto, scaduta da 3 giorni; Comprare il pane; e altre 2; una riservata, che non leggo. Il resoconto completo è nella chat della routine. Vuoi altro?',
  );
  assert.equal(all.label, 'L2');
  // Up to Interno: the private title is counted, never read.
  const internal = routineDetails(DATA, 'L1', ROME, NOW);
  assert.ok(internal !== null);
  assert.ok(!internal.text.includes('Rinnovo del documento finto'));
  assert.match(internal.text, /Pagare la bolletta finta, scade domani; Comprare il pane; e altre 2; 2 riservate, che non leggo\./);
  assert.equal(internal.label, 'L2');
  // Up to Pubblico: only the public one.
  const open = routineDetails(DATA, 'L0', ROME, NOW);
  assert.ok(open !== null && !open.text.includes('bolletta') && open.text.includes('Comprare il pane'));
});

test('at most VOICE_MAX_ITEMS titles per list, the others counted', () => {
  const many: ReportData = { todo: { shown: Array.from({ length: 7 }, (_, index) => ({ title: `Carta finta ${String(index + 1)}`, label: 'L0' as const, due: null })), more: 3, secret: 0 } };
  const details = routineDetails(many, 'L2', ROME, NOW);
  assert.ok(details !== null);
  assert.ok(details.text.includes(`Carta finta ${String(VOICE_MAX_ITEMS)}`) && !details.text.includes(`Carta finta ${String(VOICE_MAX_ITEMS + 1)}`));
  assert.match(details.text, /e altre 5\./);
});

test('the «sì» opens, the «no» closes, the rest is unclear', () => {
  for (const yes of ['Sì', 'sì.', 'Si, grazie', 'certo', 'va bene', 'Ok!', 'sì, leggili pure', 'dimmi', 'sì Arianna']) assert.equal(gateAnswer(yes), 'yes', yes);
  for (const no of ['No', 'no grazie', 'non ora', 'dopo', 'lascia stare', 'no, va bene così', 'basta']) assert.equal(gateAnswer(no), 'no', no);
  for (const other of ['', 'che tempo fa domani a Roma', 'sì no', 'forse', 'chi sei', 'aspetta un attimo che prendo la penna']) assert.equal(gateAnswer(other), 'unclear', other);
  // Never a «sì» when in doubt: a question, a greeting, a goodbye, «bene» without «va».
  for (const doubt of ['Ciao Arianna, tutto bene?', 'sicuro?', 'sì?', 'ok, ciao', 'sicuro', 'tutto bene', 'bene', 'va']) assert.notEqual(gateAnswer(doubt), 'yes', doubt);
  assert.equal(gateAnswer('va bene, ciao'), 'no');
  assert.equal(gateAnswer('ciao'), 'no');
  assert.equal(gateAnswer('sì?'), 'unclear');
});

test('a «sì» as Parakeet writes it: with a capital and a stop, doubled, thanked, or heard as English or Russian (D-259)', () => {
  for (const yes of ['Sì.', 'Sì!', 'Si', 'Sí.', 'sì sì', 'Sì, sì.', 'Sì grazie', 'Sì, grazie.', 'Sì, certo.', 'Certo!', 'Va bene!', 'Ok.']) assert.equal(gateAnswer(yes), 'yes', yes);
  // Measured on a lone «Sì.» and «Sì!» of Kokoro, transcribed by Parakeet v3.
  for (const heard of ['See ya.', 'See yeah.', 'Si é', 'Сиє.', 'Sia Arianna.']) assert.equal(gateAnswer(heard), 'yes', heard);
  for (const no of ['No.', 'No', 'No, grazie.', 'No grazie!']) assert.equal(gateAnswer(no), 'no', no);
  // Only the whole answer: the same sounds beside other words, or asked, are not a «sì».
  for (const doubt of ['See ya?', 'see you', 'sia chiaro', 'see legally', 'Сиє, ciao', 'see the titles of the day', 'see', 'sia', 'see you', 'Sia.']) assert.notEqual(gateAnswer(doubt), 'yes', doubt);
});

test('the deadline and the hello as they are said; the labels of the voice', () => {
  assert.equal(spokenDue(new Date('2026-10-19T20:00:00Z'), ROME, NOW), 'scade oggi');
  assert.equal(spokenDue(new Date('2026-10-18T10:00:00Z'), ROME, NOW), 'scaduta ieri');
  assert.equal(spokenDue(new Date('2026-10-24T10:00:00Z'), ROME, NOW), 'scade fra 5 giorni');
  assert.equal(salutation(new Date('2026-10-19T12:30:00Z'), ROME), 'Buon pomeriggio');
  assert.equal(salutation(new Date('2026-10-19T19:00:00Z'), ROME), 'Buonasera');
  assert.equal(salutation(new Date('2026-10-19T01:00:00Z'), ROME), 'Ciao');
  assert.ok(isVoiceLabel('L0') && isVoiceLabel('L2') && !isVoiceLabel('L3') && !isVoiceLabel('Privato'));
});
