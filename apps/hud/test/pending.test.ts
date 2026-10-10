import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalAnchor, clearFocus, FOCUS_WAIT_MS, messageAnchor, parseAnchor, pendingFocus, requestFocus } from '../src/lib/chat-focus.ts';
import { dismissMode, dismissStep, pendingItems, pendingTotal, sortOldestFirst, type WaitingTask } from '../src/lib/pending.ts';
import {
  hiddenText,
  PENDING_APPROVAL_ELSEWHERE,
  PENDING_KIND_TEXT,
  PENDING_NO_CONVERSATION,
  PENDING_UNTITLED,
  pendingAskText,
  pendingDismissLabel,
  pendingKind,
  pendingKindText,
  stoppedText,
  waitingSinceText,
} from '../src/lib/pending-text.ts';
import { ROUTER_REASON_UNKNOWN, routerReasonText } from '../src/lib/router-reasons.ts';
import type { Approval } from '../src/lib/types.ts';

function approval(id: string, over: Partial<Approval> = {}): Approval {
  return {
    id,
    taskId: null,
    kind: 'action',
    action: 'delete',
    detail: {},
    label: 'L1',
    state: 'pending',
    requestedAt: '2026-10-05T10:00:00.000Z',
    decidedAt: null,
    decidedVia: null,
    ...over,
  };
}

const NOW = new Date('2026-10-05T12:00:00.000Z');

test('pendingKind maps every approval kind; an unknown one is an action', () => {
  assert.equal(pendingKind({ kind: 'declassify' }), 'declassify');
  assert.equal(pendingKind({ kind: 'budget' }), 'budget');
  assert.equal(pendingKind({ kind: 'workspace' }), 'workspace');
  assert.equal(pendingKind({ kind: 'setting' }), 'setting');
  assert.equal(pendingKind({ kind: 'nuovo' as Approval['kind'] }), 'action');
});

test('pendingKindText names privacy, budget, folder; an action by its action, else generic', () => {
  assert.equal(pendingKindText({ kind: 'declassify', action: 'declassify' }), 'Privacy · declassamento');
  assert.equal(pendingKindText({ kind: 'workspace', action: 'dirty-workspace' }), 'Cartella di lavoro');
  assert.equal(pendingKindText({ kind: 'action', action: 'payment' }), 'Pagamento');
  assert.equal(pendingKindText({ kind: 'action', action: 'mystery' }), PENDING_KIND_TEXT.action);
});

test('pendingAskText never shows the declassified text', () => {
  const ask = pendingAskText({ kind: 'declassify', action: 'declassify', detail: { from: 'L2', to: 'L1', text: 'segreto di prova' } });
  assert.equal(ask, 'Far uscire un testo declassato (Privato → Interno) dalla macchina');
  assert.ok(!ask.includes('segreto'));
  assert.equal(pendingAskText({ kind: 'declassify', action: 'declassify', detail: {} }), 'Far uscire un testo declassato dalla macchina');
});

test('pendingAskText names repo, model and executor when the detail has them', () => {
  assert.match(pendingAskText({ kind: 'workspace', action: 'dirty-workspace', detail: { repo: 'demo', files: ['a'] } }), /in demo sopra/);
  assert.equal(pendingAskText({ kind: 'workspace', action: 'dirty-workspace', detail: {} }), 'Lavorare in una cartella con modifiche non ancora committate');
  assert.equal(pendingAskText({ kind: 'budget', action: 'budget', detail: { executor: 'claude', model: 'opus' } }), 'Usare Claude Opus su Claude Code, oltre il piano');
  assert.equal(pendingAskText({ kind: 'budget', action: 'budget', detail: { model: 3 } }), 'Usare un modello che costa oltre il piano');
  assert.equal(pendingAskText({ kind: 'action', action: 'delete', detail: {} }), 'Serve la tua approvazione: cancellazione');
  assert.equal(pendingAskText({ kind: 'action', action: 'boh', detail: {} }), 'Serve la tua approvazione per un’azione');
});

test('waitingSinceText counts minutes, hours and days; a bad date is empty', () => {
  assert.equal(waitingSinceText('2026-10-05T11:59:30.000Z', NOW), 'da adesso');
  assert.equal(waitingSinceText('2026-10-05T12:00:30.000Z', NOW), 'da adesso');
  assert.equal(waitingSinceText('2026-10-05T11:57:00.000Z', NOW), 'da 3 min');
  assert.equal(waitingSinceText('2026-10-05T09:00:00.000Z', NOW), 'da 3 h');
  assert.equal(waitingSinceText('2026-10-04T11:00:00.000Z', NOW), 'da ieri');
  assert.equal(waitingSinceText('2026-10-01T12:00:00.000Z', NOW), 'da 4 giorni');
  assert.equal(waitingSinceText('non una data', NOW), '');
});

test('pendingItems: oldest first, only pending, with the conversation title', () => {
  const rows = pendingItems(
    [
      approval('new', { taskId: 't1', requestedAt: '2026-10-05T11:00:00.000Z' }),
      approval('old', { taskId: 't2', kind: 'budget', action: 'budget', requestedAt: '2026-10-05T09:00:00.000Z' }),
      approval('done', { state: 'approved', requestedAt: '2026-10-05T08:00:00.000Z' }),
      approval('loose', { requestedAt: '2026-10-05T10:00:00.000Z' }),
    ],
    { t1: { conversationId: 'c1' }, t2: { conversationId: 'c2' } },
    { c1: 'Preventivo finto', c2: '  ' },
  );
  assert.deepEqual(
    rows.map((row) => row.approvalId),
    ['old', 'loose', 'new'],
  );
  assert.deepEqual(
    rows.map(({ conversationId, conversationTitle, kind, key }) => ({ conversationId, conversationTitle, kind, key })),
    [
      { conversationId: 'c2', conversationTitle: PENDING_UNTITLED, kind: 'budget', key: 'approval-old' },
      { conversationId: null, conversationTitle: PENDING_NO_CONVERSATION, kind: 'action', key: 'approval-loose' },
      { conversationId: 'c1', conversationTitle: 'Preventivo finto', kind: 'action', key: 'approval-new' },
    ],
  );
});

test('pendingItems: a task that could not be read leaves no conversation', () => {
  const [row] = pendingItems([approval('a', { taskId: 'missing' })], {}, {});
  assert.equal(row?.conversationId, null);
});

test('sortOldestFirst puts bad dates last and keeps ties in order', () => {
  const rows = sortOldestFirst([
    { id: 'x', since: 'boh' },
    { id: 'b', since: '2026-10-05T10:00:00.000Z' },
    { id: 'a', since: '2026-10-05T09:00:00.000Z' },
    { id: 'c', since: '2026-10-05T10:00:00.000Z' },
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a', 'b', 'c', 'x'],
  );
});

function waitingTask(id: string, over: Partial<WaitingTask> = {}): WaitingTask {
  return {
    id,
    conversationId: `c-${id}`,
    conversationTitle: `Conversazione ${id}`,
    mode: 'private',
    archived: false,
    title: `Task ${id}`,
    since: '2026-10-05T10:00:00.000Z',
    reason: 'other',
    question: null,
    approvalId: null,
    messageId: null,
    waitingReason: 'finished without evidence',
    label: 'L2',
    ...over,
  };
}

test('pendingItems lists the waiting tasks: a question, a stopped task, oldest first, with their anchors', () => {
  const rows = pendingItems(
    [],
    {},
    {},
    [
      waitingTask('q', { reason: 'question', question: 'Martedì o giovedì?', messageId: '42', since: '2026-10-05T11:00:00.000Z' }),
      waitingTask('s', { messageId: '7', archived: true, waitingReason: 'limit reached: 5 of 5 steps', since: '2026-10-05T09:00:00.000Z' }),
      waitingTask('n', { conversationId: null, conversationTitle: null, messageId: '9', waitingReason: 'qualcosa di nuovo', since: '2026-10-05T10:00:00.000Z' }),
    ],
  );
  assert.deepEqual(
    rows.map(({ key, kind, kindText, conversationId, conversationTitle, archived, ask, anchor, approvalId }) => ({
      key,
      kind,
      kindText,
      conversationId,
      conversationTitle,
      archived,
      ask,
      anchor,
      approvalId,
    })),
    [
      {
        key: 'task-s',
        kind: 'stopped',
        kindText: 'Task fermo',
        conversationId: 'c-s',
        conversationTitle: 'Conversazione s',
        archived: true,
        ask: 'Si è fermato: limite raggiunto: 5 su 5 passi',
        anchor: 'message-7',
        approvalId: null,
      },
      {
        key: 'task-n',
        kind: 'stopped',
        kindText: 'Task fermo',
        conversationId: null,
        conversationTitle: PENDING_NO_CONVERSATION,
        archived: false,
        ask: 'Si è fermato e aspetta una tua risposta',
        anchor: null,
        approvalId: null,
      },
      {
        key: 'task-q',
        kind: 'question',
        kindText: 'Domanda di Arianna',
        conversationId: 'c-q',
        conversationTitle: 'Conversazione q',
        archived: false,
        ask: 'Martedì o giovedì?',
        anchor: 'message-42',
        approvalId: null,
      },
    ],
  );
});

test('pendingItems: a task behind a listed approval is the approval row only, with the conversation of the task', () => {
  const rows = pendingItems(
    [approval('a1', { taskId: 't1', kind: 'budget', action: 'budget', requestedAt: '2026-10-05T10:30:00.000Z' })],
    {},
    {},
    [
      waitingTask('t1', { reason: 'approval', approvalId: 'a1', conversationTitle: 'Preventivo finto', messageId: '3' }),
      waitingTask('t2', { reason: 'approval', approvalId: 'a-decided', since: '2026-10-05T11:00:00.000Z' }),
    ],
  );
  assert.deepEqual(
    rows.map(({ key, kind, conversationId, conversationTitle, anchor, ask }) => ({ key, kind, conversationId, conversationTitle, anchor, ask })),
    [
      { key: 'approval-a1', kind: 'budget', conversationId: 'c-t1', conversationTitle: 'Preventivo finto', anchor: 'approval-a1', ask: 'Usare un modello che costa oltre il piano' },
      { key: 'task-t2', kind: 'action', conversationId: 'c-t2', conversationTitle: 'Conversazione t2', anchor: 'approval-a-decided', ask: PENDING_APPROVAL_ELSEWHERE },
    ],
  );
  // The same total in the window and on the row of the panel: rows plus the tasks above L2.
  assert.equal(pendingTotal(rows, 0), 2);
  assert.equal(pendingTotal(rows, 3), 5);
  assert.equal(pendingTotal([], -1), 0);
});

test('pendingItems: an approval without a conversation has no anchor; an untitled conversation is named so', () => {
  const [loose, untitled] = pendingItems([approval('x', { requestedAt: '2026-10-05T08:00:00.000Z' })], {}, {}, [waitingTask('u', { conversationTitle: '  ' })]);
  assert.equal(loose?.anchor, null);
  assert.equal(untitled?.conversationTitle, PENDING_UNTITLED);
});

test('stoppedText and hiddenText', () => {
  assert.equal(stoppedText('finished without evidence'), 'Si è fermato: finito senza prove');
  assert.equal(stoppedText(null), 'Si è fermato e aspetta una tua risposta');
  assert.match(hiddenText(1), /^Un altro task in attesa riguarda dati Segreti/);
  assert.match(hiddenText(2), /^Altri 2 task in attesa/);
});

test('parseAnchor accepts only an approval uuid or a message number', () => {
  const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(parseAnchor(`#approval-${uuid}`), `approval-${uuid}`);
  assert.equal(parseAnchor(`approval-${uuid.toUpperCase()}`), `approval-${uuid}`);
  assert.equal(parseAnchor('#message-42'), 'message-42');
  assert.equal(parseAnchor('#message-4x'), undefined);
  assert.equal(parseAnchor('#approval-nope'), undefined);
  assert.equal(parseAnchor('#message-1"><img'), undefined);
  assert.equal(parseAnchor(''), undefined);
  assert.equal(parseAnchor('#altro-1'), undefined);
  assert.equal(approvalAnchor('a'), 'approval-a');
  assert.equal(messageAnchor('1'), 'message-1');
});

test('a focus request is for one conversation, replaced by the next, dropped once old or carried out', () => {
  requestFocus('c1', 'message-1', 1000);
  assert.equal(pendingFocus('c2', 1000), undefined);
  assert.equal(pendingFocus('c1', 1000 + FOCUS_WAIT_MS), 'message-1');
  requestFocus('c2', 'approval-x', 2000);
  assert.equal(pendingFocus('c1', 2000), undefined);
  assert.equal(pendingFocus('c2', 2000), 'approval-x');
  assert.equal(pendingFocus('c2', 2001 + FOCUS_WAIT_MS), undefined);
  // Expired: gone for good.
  assert.equal(pendingFocus('c2', 2000), undefined);
  requestFocus('c3', 'message-2', 3000);
  clearFocus();
  assert.equal(pendingFocus('c3', 3000), undefined);
  assert.equal(pendingFocus(null, 3000), undefined);
});

const HEAD = 'coding at L1 for coder, difficulty hard (default normal; rules: long-brief, many-files)';

test('routerReasonText translates a route, with the user choice and the budget approval', () => {
  assert.equal(routerReasonText(`${HEAD}; claude/sonnet`), 'Claude Sonnet su Claude Code');
  assert.equal(routerReasonText(`${HEAD}; claude/opus (chosen by the user)`), 'Claude Opus su Claude Code (scelto da te)');
  assert.equal(
    routerReasonText(`${HEAD}; claude/fable (tier 2 unavailable), needs budget approval`),
    'Claude Fable (con approvazione) su Claude Code (il livello previsto non era disponibile), serve l’approvazione del budget',
  );
  assert.equal(routerReasonText('plan at L2 for arianna, difficulty normal (default normal); local/qwen-large'), 'qwen-large su modello locale');
});

test('routerReasonText translates every wait of the router', () => {
  assert.equal(routerReasonText(`${HEAD}; no model reads L3`), 'nessun modello può leggere dati L3');
  assert.equal(routerReasonText(`${HEAD}; label above the clearance L1 of the agent`), 'l’etichetta supera il livello L1 consentito all’agente');
  assert.equal(routerReasonText(`${HEAD}; no stronger executor is allowed after the failed attempts`), 'dopo i tentativi falliti nessun esecutore più forte è consentito');
  assert.equal(routerReasonText(`${HEAD}; budget exhausted with no expected reset`), 'budget esaurito, senza un ripristino previsto');
  assert.equal(routerReasonText(`${HEAD}; no executor allowed for this step is installed`), 'nessun esecutore consentito per questo passo è installato');
  assert.match(routerReasonText(`${HEAD}; budget exhausted, retry at 2026-10-05T14:30:00.000Z`), /^budget esaurito, riprova alle \d\d:\d\d$/);
  assert.equal(routerReasonText(`${HEAD}; budget exhausted, retry at domani`), 'budget esaurito, riprova più tardi');
});

test('routerReasonText adds the notes it knows and leaves out the others', () => {
  assert.equal(
    routerReasonText(`${HEAD}; context not issued by the policy, read as L2; cloud excluded: privacy; local/qwen-large`),
    'qwen-large su modello locale (contesto non etichettato dalla policy, trattato come Privato; cloud escluso per privacy)',
  );
  assert.equal(
    routerReasonText(`${HEAD}; preferred opus excluded: privacy; preferred fable not installed; something new; claude/sonnet`),
    'Claude Sonnet su Claude Code (il modello scelto (Claude Opus) è escluso per privacy; il modello scelto (Claude Fable (con approvazione)) non è installato)',
  );
});

test('routerReasonText names the budget causes of an excluded preferred model', () => {
  assert.equal(routerReasonText(`${HEAD}; preferred opus excluded: cap; claude/sonnet`), 'Claude Sonnet su Claude Code (il modello scelto (Claude Opus) è escluso per il tetto di spesa di Arianna)');
  assert.equal(routerReasonText(`${HEAD}; preferred opus excluded: quota; claude/sonnet`), 'Claude Sonnet su Claude Code (il modello scelto (Claude Opus) è escluso per la quota esaurita dell’abbonamento)');
  assert.equal(routerReasonText(`${HEAD}; preferred opus excluded: weird; claude/sonnet`), 'Claude Sonnet su Claude Code (il modello scelto (Claude Opus) è escluso)');
});

test('routerReasonText: an unknown or empty reason gets the generic text', () => {
  assert.equal(routerReasonText(`${HEAD}; the moon is full`), ROUTER_REASON_UNKNOWN);
  assert.equal(routerReasonText(''), ROUTER_REASON_UNKNOWN);
  assert.equal(routerReasonText(null), ROUTER_REASON_UNKNOWN);
});

test('dismissMode: no task, none; a plain wait, direct; with an approval, confirm (D-109)', () => {
  assert.equal(dismissMode(null, 'a1'), 'none');
  assert.equal(dismissMode(null, null), 'none');
  assert.equal(dismissMode('t1', null), 'direct');
  assert.equal(dismissMode('t1', 'a1'), 'confirm');
  // A confirm row arms on the first click and closes on the second; a direct row closes at once.
  assert.equal(dismissStep('confirm', false), 'arm');
  assert.equal(dismissStep('confirm', true), 'close');
  assert.equal(dismissStep('direct', false), 'close');
  assert.equal(dismissStep('none', true), 'ignore');
});

test('pendingItems: rows carry the task Chiudi closes; an approval without task cannot be closed here (D-109)', () => {
  const waiting: WaitingTask[] = [
    {
      id: 't-stopped',
      conversationId: 'c1',
      conversationTitle: 'Saluti di prova',
      mode: 'private',
      archived: false,
      title: 'Ciao',
      since: '2026-10-03T10:00:00.000Z',
      reason: 'other',
      question: null,
      approvalId: null,
      messageId: '7',
      waitingReason: 'the orchestrator is not available yet (task 1.10)',
      label: 'L2',
    },
  ];
  const items = pendingItems([approval('a-free'), approval('a-task', { taskId: 't-approval' })], {}, {}, waiting);
  const byKey = new Map(items.map((item) => [item.key, item]));
  assert.equal(byKey.get('task-t-stopped')?.taskId, 't-stopped');
  assert.equal(byKey.get('task-t-stopped')?.dismiss, 'direct');
  assert.equal(byKey.get('approval-a-task')?.taskId, 't-approval');
  assert.equal(byKey.get('approval-a-task')?.dismiss, 'confirm');
  assert.equal(byKey.get('approval-a-free')?.taskId, null);
  assert.equal(byKey.get('approval-a-free')?.dismiss, 'none');
});

test('pendingDismissLabel names the row and differs from the window close button (D-109)', () => {
  assert.equal(pendingDismissLabel('Saluti di prova', false), 'Chiudi l’attesa: Saluti di prova');
  assert.equal(pendingDismissLabel('Saluti di prova', true), 'Sicuro? Conferma la chiusura dell’attesa: Saluti di prova');
  assert.notEqual(pendingDismissLabel('x', false), 'Chiudi');
});

test('the cardwall in the window: a plan and the choice of where a card runs; the choice of a plan card opens the plan conversation (D-159)', () => {
  assert.equal(pendingAskText({ kind: 'plan', action: 'task.plan', detail: { title: 'Landing', cards: [{}, {}] } }), 'Creare 2 card per «Landing»');
  assert.equal(pendingAskText({ kind: 'executor', action: 'card.executor', detail: { title: 'Grafica' } }), 'Scegliere con chi lavora la card «Grafica»');
  assert.equal(pendingKindText({ kind: 'executor', action: 'card.executor' }), 'Con chi lavora?');
  const [row] = pendingItems([approval('e1', { kind: 'executor', action: 'card.executor', taskId: 'card', conversationId: 'c1', chatTaskId: 'chat' })], { card: { conversationId: null } }, { c1: 'Sito' });
  assert.deepEqual([row?.conversationId, row?.conversationTitle], ['c1', 'Sito']);
});
