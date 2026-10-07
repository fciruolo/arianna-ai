import assert from 'node:assert/strict';
import { test } from 'node:test';

import { choiceAgent, draftFromAddress, draftPath, sameChoice } from '../src/lib/draft.ts';
import {
  assumedNotice,
  closedCause,
  closedText,
  closingLines,
  closingSoonText,
  deletedText,
  END_RETRIES,
  END_RETRY_MS,
  endRetryDelay,
  entryFromState,
  incognitoAction,
  incognitoState,
  INCOGNITO_PATH,
  isIncognitoPath,
  NOTE_OFF_TEXT,
  officeMayNote,
  noteRefusal,
  noticeLines,
  parseEndResult,
  parseNotice,
  remainsText,
  splitApprovals,
  withoutIncognito,
  type EndResult,
} from '../src/lib/incognito.ts';
import { parseServerMessage } from '../src/lib/protocol.ts';

const ID = '0b5f8e3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

test('an incognito conversation has one fixed address, never its id', () => {
  assert.equal(INCOGNITO_PATH, '/incognito');
  assert.ok(isIncognitoPath('/incognito'));
  assert.ok(isIncognitoPath('/incognito/'));
  assert.ok(!isIncognitoPath(`/incognito/${ID}`));
  assert.ok(!isIncognitoPath(`/c/${ID}`));
  assert.equal(draftPath({ mode: 'work', project: 'sito-demo', incognito: true }), '/incognito');
  assert.equal(draftPath({ mode: 'private', incognito: true }), '/incognito');
  assert.equal(draftPath({ mode: 'private' }), '/nuova?tipo=privata');
  // The address of a normal draft never turns into an incognito one.
  assert.equal(draftFromAddress('/incognito', '?tipo=privata'), undefined);
});

test('the state of the history entry holds the draft or the id, and nothing forged', () => {
  assert.deepEqual(entryFromState(incognitoState({ conversationId: ID })), { conversationId: ID });
  assert.deepEqual(entryFromState(incognitoState({ conversationId: ID.toUpperCase() })), { conversationId: ID });
  assert.deepEqual(entryFromState(incognitoState({ draft: { mode: 'work', project: ' sito-demo ' } })), { draft: { mode: 'work', project: 'sito-demo' } });
  assert.deepEqual(entryFromState(incognitoState({ draft: { mode: 'private' } })), { draft: { mode: 'private' } });
  // A private draft has no project, whatever the state says.
  assert.deepEqual(entryFromState({ incognito: { draft: { mode: 'private', project: 'x' } } }), { draft: { mode: 'private' } });
  assert.equal(entryFromState(null), undefined);
  assert.equal(entryFromState({}), undefined);
  assert.equal(entryFromState({ incognito: { conversationId: 'not-an-id' } }), undefined);
  assert.equal(entryFromState({ incognito: { draft: { mode: 'secret' } } }), undefined);
  assert.equal(entryFromState({ incognito: 'x' }), undefined);
});

test('an incognito draft is with Arianna only, and differs from a normal one', () => {
  assert.equal(choiceAgent({ mode: 'work', agent: 'coder', incognito: true }), undefined);
  assert.equal(choiceAgent({ mode: 'work', agent: 'coder' }), 'coder');
  assert.ok(sameChoice({ mode: 'private', incognito: true }, { mode: 'private', incognito: true }));
  assert.ok(!sameChoice({ mode: 'private', incognito: true }, { mode: 'private' }));
  assert.ok(sameChoice({ mode: 'private' }, { mode: 'private', incognito: false }));
});

test('the notice of the core is read only in its shape', () => {
  assert.deepEqual(parseNotice({ cloud: true, project: 'sito-demo', localCache: true }), { cloud: true, project: 'sito-demo', localCache: true });
  assert.deepEqual(parseNotice({ cloud: false, project: null, localCache: false }), { cloud: false, project: null, localCache: false });
  // A core without the field: no cache said.
  assert.deepEqual(parseNotice({ cloud: false, project: '  ' }), { cloud: false, project: null, localCache: false });
  assert.equal(parseNotice({ cloud: false, project: null, localCache: 'yes' }), undefined);
  assert.equal(parseNotice({ cloud: 'yes', project: null }), undefined);
  assert.equal(parseNotice({ cloud: true, project: 3 }), undefined);
  assert.equal(parseNotice(null), undefined);
});

const COPY_LINE = 'Copia passa dagli appunti del sistema, che possono conservarne una copia.';
const CACHE_LINE = 'Il modello locale tiene una cache su disco derivata dai testi (non leggibile come testo), finché non viene sostituita.';

test('"Cosa resta fuori da Arianna" says the texts of the document, by mode', () => {
  const private_ = noticeLines({ cloud: false, project: null, localCache: false });
  assert.equal(private_[0], 'Niente esce dal Mac.');
  assert.ok(private_.some((line) => line.startsWith('Alla chiusura Arianna cancella testi, riassunti e attività.')));
  assert.ok(private_.some((line) => line.includes('registro di sicurezza, senza testo') && line.includes('il disco cifrato li protegge')));
  assert.ok(private_.includes(COPY_LINE));
  assert.ok(!private_.includes(CACHE_LINE));
  assert.ok(!private_.some((line) => line.includes('Claude')));
  const work = noticeLines({ cloud: true, project: 'sito-demo', localCache: false });
  assert.ok(!work.includes('Niente esce dal Mac.'));
  assert.ok(work.includes('Ciò che gli agenti su Claude ricevono va a Claude (Anthropic) e resta presso di loro secondo il tuo abbonamento.'));
  assert.ok(work.includes('I file che il Coder cambia nel progetto sito-demo restano.'));
  // The session is not saved; the rest of the profile is not verified yet: never said as a certainty.
  assert.ok(work.includes('Claude Code non salva la sessione; altri file del suo profilo (cronologie, copie dei file, debug) non sono ancora verificati.'));
  assert.ok(!work.includes('Claude Code non salva la sessione.'));
  assert.ok(work.includes(COPY_LINE));
  // Work without a project: no sentence about files.
  assert.ok(!noticeLines({ cloud: true, project: null, localCache: false }).some((line) => line.includes('I file')));
  // The local cache, in both modes, only when the core says it is on.
  assert.ok(noticeLines({ cloud: false, project: null, localCache: true }).includes(CACHE_LINE));
  assert.ok(noticeLines({ cloud: true, project: null, localCache: true }).includes(CACHE_LINE));
});

test('until the core answers, a work conversation is taken as one that reaches Claude, and the cache as on', () => {
  assert.deepEqual(assumedNotice('work', 'sito-demo'), { cloud: true, project: 'sito-demo', localCache: true });
  assert.deepEqual(assumedNotice('work', undefined), { cloud: true, project: null, localCache: true });
  assert.deepEqual(assumedNotice('private', 'sito-demo'), { cloud: false, project: null, localCache: true });
});

const RESULT: EndResult = {
  deleted: { messages: 14, tasks: 3, summaries: 1 },
  remains: {
    files: [
      { project: 'sito-demo', path: 'index.html' },
      { project: 'sito-demo', path: 'style.css' },
    ],
    cloud: [{ model: 'opus', bytes: 3200 }],
  },
};

test('the answer of "Termina" is read only in the shape of the contract', () => {
  assert.deepEqual(parseEndResult(RESULT), RESULT);
  assert.deepEqual(parseEndResult({ deleted: { messages: 0, tasks: 0, summaries: 0 }, remains: { files: [], cloud: [] } }), {
    deleted: { messages: 0, tasks: 0, summaries: 0 },
    remains: { files: [], cloud: [] },
  });
  assert.equal(parseEndResult({ deleted: { messages: -1, tasks: 0, summaries: 0 }, remains: { files: [], cloud: [] } }), undefined);
  assert.equal(parseEndResult({ deleted: { messages: 1, tasks: 0 }, remains: { files: [], cloud: [] } }), undefined);
  assert.equal(parseEndResult({ deleted: { messages: 1, tasks: 0, summaries: 0 }, remains: { files: [{ project: 'x' }], cloud: [] } }), undefined);
  assert.equal(parseEndResult({ deleted: { messages: 1, tasks: 0, summaries: 0 }, remains: { files: [], cloud: [{ model: 'opus', bytes: 1.5 }] } }), undefined);
  assert.equal(parseEndResult({ ok: true }), undefined);
});

test('the closing card says the real counts, as in the document', () => {
  assert.equal(deletedText(RESULT.deleted), 'Cancellati: 14 messaggi, 3 passi, 1 riassunto.');
  assert.equal(deletedText({ messages: 1, tasks: 1, summaries: 0 }), 'Cancellati: 1 messaggio, 1 passo, 0 riassunti.');
  assert.equal(remainsText(RESULT.remains), 'Restano fuori: 2 file cambiati in sito-demo (index.html, style.css); 1 invio a Claude Opus (3,2 kB).');
  assert.equal(
    remainsText({ files: [{ project: 'a', path: 'x.ts' }, { project: 'a', path: 'x.ts' }], cloud: [{ model: 'sonnet', bytes: 400 }, { model: 'sonnet', bytes: 700 }] }),
    'Restano fuori: 1 file cambiato in a (x.ts); 2 invii a Claude Sonnet (1,1 kB).',
  );
  assert.equal(remainsText({ files: [], cloud: [] }), 'Fuori da Arianna non resta niente di questa conversazione.');
  const many = Array.from({ length: 8 }, (_, index) => ({ project: 'p', path: `f${String(index)}.ts` }));
  assert.match(remainsText({ files: many, cloud: [] }), /8 file cambiati in p \(f0\.ts, .*f5\.ts e altri 2\)/);
  // An unknown model keeps its id.
  assert.match(remainsText({ files: [], cloud: [{ model: 'nuovo', bytes: 10 }] }), /1 invio a nuovo \(10 B\)/);
});

test('the closing card adds the advice on files only when files stay', () => {
  const lines = closingLines(RESULT);
  assert.equal(lines[0], 'Cancellati: 14 messaggi, 3 passi, 1 riassunto.');
  assert.ok(lines.some((line) => line.includes('git status')));
  assert.ok(!closingLines({ ...RESULT, remains: { files: [], cloud: [] } }).some((line) => line.includes('git status')));
  // Without the core's counts the card says only what is sure.
  assert.ok(!closingLines(undefined).some((line) => /\d/.test(line)));
});

test('a conversation closed elsewhere says why, without its texts', () => {
  assert.match(closedText('restart'), /^Conversazione incognita chiusa al riavvio di Arianna/);
  assert.match(closedText('idle'), /10 minuti/);
  assert.equal(closedText('user'), 'Questa conversazione incognita è chiusa.');
  assert.equal(closedText('gone'), 'Questa conversazione incognita è chiusa.');
  assert.match(closedText('lost'), /scollegata/);
  assert.match(closingSoonText(60), /fra 1 minuto/);
  assert.match(closingSoonText(300), /fra 5 minuti/);
});

test('the 404 of a closed incognito conversation carries its cause; any other 404 none', () => {
  assert.equal(closedCause({ error: 'not found', closed: 'restart' }), 'restart');
  assert.equal(closedCause({ error: 'not found', closed: 'idle' }), 'idle');
  assert.equal(closedCause({ error: 'not found', closed: 'user' }), 'user');
  assert.equal(closedCause({ error: 'not found' }), undefined);
  assert.equal(closedCause({ error: 'not found', closed: 'boredom' }), undefined);
  assert.equal(closedCause(null), undefined);
});

test("an incognito conversation's approvals are shown only in its page", () => {
  const normal = { id: 'a', taskId: 't1', conversationId: OTHER };
  const hidden = { id: 'b', taskId: 't2', incognito: true, conversationId: ID };
  const oldCore = { id: 'c', taskId: 't3' };
  assert.deepEqual(withoutIncognito([normal, hidden, oldCore]), [normal, oldCore]);
  // On another page: the incognito one is neither in the chat nor elsewhere.
  assert.deepEqual(splitApprovals([normal, hidden, oldCore], new Set(['t1']), OTHER), { inChat: [normal], elsewhere: [oldCore] });
  // On its page: by its task, or by the id of the conversation before its task is read.
  assert.deepEqual(splitApprovals([normal, hidden], new Set(['t2']), ID), { inChat: [hidden], elsewhere: [normal] });
  assert.deepEqual(splitApprovals([normal, hidden], new Set(), ID), { inChat: [hidden], elsewhere: [normal] });
  // No conversation open: nothing incognito anywhere.
  assert.deepEqual(splitApprovals([hidden, oldCore], new Set(), null), { inChat: [], elsewhere: [oldCore] });
});

test('"Termina" is asked again only while the work is stopping, a few times', () => {
  assert.equal(endRetryDelay(409, 'busy', 0), END_RETRY_MS);
  assert.equal(endRetryDelay(409, 'busy', END_RETRIES - 1), END_RETRY_MS);
  assert.equal(endRetryDelay(409, 'busy', END_RETRIES), undefined);
  // The code, not the text: an old message is not recognized.
  assert.equal(endRetryDelay(409, 'the conversation is still at work: try again in a moment', 0), undefined);
  assert.equal(endRetryDelay(409, 'not incognito', 0), undefined);
  assert.equal(endRetryDelay(500, 'busy', 0), undefined);
  assert.equal(endRetryDelay(404, 'not found', 0), undefined);
});

test('tasks waiting for the user of an incognito conversation stay out of every place outside it', () => {
  const normal = { id: 't1', conversationId: OTHER, incognito: false };
  const hidden = { id: 't2', conversationId: ID, incognito: true };
  const oldCore = { id: 't3', conversationId: OTHER };
  assert.deepEqual(withoutIncognito([normal, hidden, oldCore]), [normal, oldCore]);
  assert.deepEqual(withoutIncognito([{ id: 't4', incognito: null }]), [{ id: 't4', incognito: null }]);
});

test('the office never notes the live lines of an incognito conversation', () => {
  const known = new Set([ID]);
  assert.equal(officeMayNote(ID, known), false);
  assert.equal(officeMayNote(ID.toUpperCase(), known), false);
  assert.equal(officeMayNote(OTHER, known), true);
  assert.equal(officeMayNote(ID, new Set()), true);
});

test('"/nota" is refused only in incognito', () => {
  assert.equal(noteRefusal(true, true), NOTE_OFF_TEXT);
  assert.equal(noteRefusal(true, false), undefined);
  assert.equal(noteRefusal(false, true), undefined);
});

test('the live feed closes only the incognito conversation of this page', () => {
  const closed = { type: 'conversation.incognito-closed' as const, conversationId: ID, cause: 'idle' as const };
  const closing = { type: 'conversation.incognito-closing' as const, conversationId: ID, inSeconds: 60 };
  assert.equal(incognitoAction(closed, [ID, null], new Set()), 'closed');
  assert.equal(incognitoAction(closing, [null, ID], new Set()), 'closing');
  assert.equal(incognitoAction(closed, [OTHER, null], new Set()), 'ignore');
  assert.equal(incognitoAction(closed, [null, null], new Set()), 'ignore');
  // After "Termina" on this page the card with the counts stays.
  assert.equal(incognitoAction({ ...closed, cause: 'user' }, [ID], new Set([ID])), 'ignore');
});

test('the frames of the feed about incognito are parsed, the malformed ones dropped', () => {
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: 'conversation.incognito-closed', conversationId: ID, cause: 'restart' })), {
    type: 'conversation.incognito-closed',
    conversationId: ID,
    cause: 'restart',
  });
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: 'conversation.incognito-closing', conversationId: ID.toUpperCase(), inSeconds: 60 })), {
    type: 'conversation.incognito-closing',
    conversationId: ID,
    inSeconds: 60,
  });
  assert.equal(parseServerMessage(JSON.stringify({ type: 'conversation.incognito-closed', conversationId: ID, cause: 'boredom' })), undefined);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'conversation.incognito-closed', conversationId: 'x', cause: 'idle' })), undefined);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'conversation.incognito-closing', conversationId: ID, inSeconds: -5 })), undefined);
  assert.equal(parseServerMessage(JSON.stringify({ type: 'conversation.incognito-closing', conversationId: ID })), undefined);
});

test('an activity frame keeps the incognito sign of the core, and only `true`', () => {
  const frame = { type: 'activity', conversationId: ID, taskId: 't', step: 1, kind: 'read', detail: 'kb/x.md' };
  assert.equal((parseServerMessage(JSON.stringify({ ...frame, incognito: true })) as { incognito?: true } | undefined)?.incognito, true);
  assert.equal('incognito' in (parseServerMessage(JSON.stringify(frame)) ?? {}), false);
  assert.equal('incognito' in (parseServerMessage(JSON.stringify({ ...frame, incognito: 'yes' })) ?? {}), false);
});
