// The milestones of the cardwall (D-313), without the database: the texts the
// code writes, the label of a milestone, the notices without text. Fake data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { closedAnswer, closeQuestion, doneWords, dueWords, keptAnswer, milestoneLabel } from '../src/milestones.ts';
import { noticeOf } from '../src/notifications.ts';
import { reminderText } from '../src/reminders.ts';
import { approvalNotice, isWebOnly } from '../src/telegram/texts.ts';

const NAMES = { projects: [{ name: 'panificio-rossi', label: 'L1' as const }, { name: 'demo', label: 'L0' as const }] };

test('the question and the answers name the milestone and its project only', () => {
  assert.equal(closeQuestion('Accessi', 'panificio-rossi'), 'La milestone «Accessi» di panificio-rossi non ha più card aperte. La chiudo?');
  assert.match(closedAnswer('Accessi', 'panificio-rossi'), /^Ho chiuso la milestone «Accessi» di panificio-rossi\.$/);
  assert.match(keptAnswer('Accessi', 'panificio-rossi'), /resta aperta/);
});

test('the label: the words written by hand are Privato, never below the project; an unknown project is Privato', () => {
  assert.equal(milestoneLabel('panificio-rossi', NAMES), 'L2');
  assert.equal(milestoneLabel('demo', NAMES, 'L0'), 'L0');
  assert.equal(milestoneLabel('panificio-rossi', NAMES, 'L0'), 'L1');
  assert.equal(milestoneLabel('sconosciuto', NAMES, 'L0'), 'L2');
});

test('the words of the morning: due day and count', () => {
  assert.equal(dueWords('2026-10-24', '2026-10-24'), 'scade oggi');
  assert.equal(dueWords('2026-10-25', '2026-10-24'), 'scade domani');
  assert.equal(dueWords('2026-10-27', '2026-10-24'), 'scade fra 3 giorni (27 ottobre)');
  assert.equal(dueWords('2026-10-20', '2026-10-24'), 'è scaduta il 20 ottobre');
  assert.equal(doneWords(2, 3), '2 di 3 card fatte');
  assert.equal(doneWords(1, 1), '1 di 1 card fatta');
  assert.equal(doneWords(0, 0), 'nessuna card');
});

test('the morning message lists the milestones due soon; the other moments do not', () => {
  const lines = ['La milestone «Accessi» di panificio-rossi scade domani: 2 di 3 card fatte.'];
  const morning = reminderText('morning', '2026-10-24', [], [], [], [], lines);
  assert.match(morning ?? '', /Milestone in scadenza:\n- La milestone «Accessi»/);
  assert.equal(reminderText('afternoon', '2026-10-24', [], [], [], [], lines), undefined);
  assert.equal(reminderText('morning', '2026-10-24', [], [], [], [], []), undefined);
});

test('the question notifies as an approval, its answer does not notify; neither carries text', () => {
  const conversationId = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(noticeOf({ kind: 'message.created', taskId: null, payload: { role: 'assistant', conversationId, approval: 'a1' } }), { kind: 'approval', conversationId });
  assert.equal(noticeOf({ kind: 'message.created', taskId: null, payload: { role: 'assistant', conversationId, silent: true } }), undefined);
  // A plain reply still notifies as before.
  assert.deepEqual(noticeOf({ kind: 'message.created', taskId: null, payload: { role: 'assistant', conversationId } }), { kind: 'reply', conversationId });
  // The approval event without a task: no notice of its own (the message gives it).
  assert.equal(noticeOf({ kind: 'approval.requested', taskId: null, payload: { approvalId: 'a1', milestoneId: 'm1' } }), undefined);
});

test('the closing of a milestone is decided in the web chat only', () => {
  assert.equal(isWebOnly('milestone'), true);
  assert.match(approvalNotice('milestone', 'milestone.close'), /solo dalla chat web/);
  assert.doesNotMatch(approvalNotice('milestone', 'milestone.close'), /Accessi/);
});
