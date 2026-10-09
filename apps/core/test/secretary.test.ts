// The secretary (I-12, D-144): what the code computes and writes without the model.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { responseSchema, systemPrompt } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { decisionText, findCommitment, listText, ofRange, proposalOf, proposeAdd, proposeMove, proposeReport, type Commitment } from '../src/commitments.ts';
import { orchestratorTools } from '../src/orchestrator/orchestrator.ts';
import { isPostponement, isSecretaryTool, SECRETARY_TOOLS } from '../src/orchestrator/secretary.ts';
import { committedAgents } from './support/committed-agents.ts';

const arianna = committedAgents(resolveHome({})).get('arianna');
const TODAY = '2026-10-09';

function commitment(id: string, body: string, day = TODAY, time: string | null = null, status: Commitment['status'] = 'open'): Commitment {
  return { id, body, day, time, status, reason: null, label: 'L2', conversationId: null, createdAt: new Date(), doneAt: null, rescheduledFrom: null, postponedFrom: null };
}

test('the commitment tools only in the secretary’s conversation, which delegates nothing', () => {
  assert.ok(arianna !== undefined);
  const ordinary = orchestratorTools(arianna, true, true);
  assert.ok(SECRETARY_TOOLS.every((tool) => !ordinary.includes(tool)));
  assert.ok(ordinary.includes('task.delegate'));
  const secretary = orchestratorTools(arianna, true, true, false, true);
  assert.deepEqual(
    secretary.filter((tool) => isSecretaryTool(tool)),
    ['commitment.add', 'commitment.list', 'commitment.done', 'commitment.move', 'commitment.report'],
  );
  // No step of the secretary leaves in a brief, towards the cloud or another agent.
  assert.ok(!secretary.includes('task.delegate'));
  // Never in an incognito conversation: what they note would outlive it.
  assert.ok(SECRETARY_TOOLS.every((tool) => !orchestratorTools(arianna, true, true, true, true).includes(tool)));
});

test('the model is told to pass the user’s words for the day, never a date it computed', () => {
  const tools = [...SECRETARY_TOOLS];
  const prompt = systemPrompt('Prompt.', tools);
  assert.match(prompt, /never compute the date yourself/);
  assert.match(prompt, /writes the list in the chat/);
  assert.doesNotThrow(() => responseSchema(tools));
});

test('commitment.add: the day is computed by the code, with the clock when said', () => {
  assert.deepEqual(proposeAdd({ text: '  Pagare la fideiussione   in banca ', day: 'giovedì', time: 'alle 15' }, TODAY), {
    op: 'add',
    text: 'Pagare la fideiussione in banca',
    day: '2026-10-15',
    time: '15:00',
    dayText: 'giovedì 15 ottobre 2026',
  });
  assert.deepEqual(proposeAdd({ text: 'Rilascio X per il cliente Y', day: 'domani alle 9:30' }, TODAY), {
    op: 'add',
    text: 'Rilascio X per il cliente Y',
    day: '2026-10-10',
    time: '09:30',
    dayText: 'sabato 10 ottobre 2026',
  });
});

test('commitment.add: what the code cannot compute is an error the model reads, never a guess', () => {
  assert.match((proposeAdd({ text: 'Banca', day: 'quando posso' }, TODAY) as { error: string }).error, /not one the core can compute/);
  assert.match((proposeAdd({ text: 'Banca', day: '2026-01-01' }, TODAY) as { error: string }).error, /not one the core can compute/);
  assert.match((proposeAdd({ text: ' ', day: 'domani' }, TODAY) as { error: string }).error, /empty/);
  assert.match((proposeAdd({ text: 'x'.repeat(301), day: 'domani' }, TODAY) as { error: string }).error, /longer/);
  assert.match((proposeAdd({ text: 'Banca', day: 'domani', time: 'dopo pranzo' }, TODAY) as { error: string }).error, /not a clock/);
});

test('commitment.done: the open commitment named by its words or its id, never a guess between two', () => {
  const open = [
    commitment('aaaaaaaa-0000-4000-8000-000000000001', 'Rilascio della funzionalità X per il cliente Y'),
    commitment('bbbbbbbb-0000-4000-8000-000000000002', 'Pagare la fideiussione in banca'),
    commitment('cccccccc-0000-4000-8000-000000000003', 'Chiamare la banca per il mutuo'),
  ];
  assert.equal((findCommitment(open, 'il rilascio l’ho fatto') as { found: Commitment }).found.id, open[0]?.id);
  assert.equal((findCommitment(open, 'fideiussione pagata') as { found: Commitment }).found.id, open[1]?.id);
  assert.equal((findCommitment(open, 'cccccccc') as { found: Commitment }).found.id, open[2]?.id);
  assert.equal((findCommitment(open, 'la banca') as { several: Commitment[] }).several.length, 2);
  assert.deepEqual(findCommitment(open, 'la spesa'), { none: true });
});

test('the list is written by the code: day, clock, text, status; the late ones for today', () => {
  const items = [commitment('1', 'Banca', TODAY, '15:00'), commitment('2', 'Rilascio X', TODAY, null, 'done')];
  const late = [commitment('3', 'Dentista', '2026-10-07')];
  assert.equal(
    listText(items, { from: TODAY, to: TODAY, text: 'oggi, venerdì 9 ottobre 2026' }, TODAY, late),
    'Oggi, venerdì 9 ottobre 2026:\n- 15:00 · Banca\n- Rilascio X (fatto)\n\nAncora da fare dai giorni scorsi:\n- mercoledì 7 ottobre 2026 · Dentista',
  );
  assert.equal(listText([], { from: '2026-10-10', to: '2026-10-10', text: 'domani, sabato 10 ottobre 2026' }, TODAY), 'Domani, sabato 10 ottobre 2026: nessun impegno segnato.');
  assert.equal(listText([], undefined, TODAY), 'Non hai impegni aperti.');
  assert.equal(
    listText([commitment('1', 'Banca', '2026-10-15', '15:00')], { from: TODAY, to: '2026-10-11', text: 'questa settimana' }, TODAY),
    'Impegni di questa settimana:\n- giovedì 15 ottobre 2026, 15:00 · Banca',
  );
});

test('the answer after the confirmation is written by the code', () => {
  const add = { op: 'add' as const, text: 'Banca', day: '2026-10-10', time: '15:00', dayText: '' };
  assert.equal(decisionText(add, 'approved', TODAY), 'Segnato per domani, sabato 10 ottobre 2026, alle 15:00: Banca.');
  assert.match(decisionText(add, 'rejected', TODAY), /non l’ho segnato/);
  const done = { op: 'done' as const, commitmentId: 'x', text: 'Banca', day: TODAY, time: null, dayText: '' };
  assert.equal(decisionText(done, 'approved', TODAY), 'Segnato come fatto: Banca.');
  assert.equal(decisionText(done, 'rejected', TODAY), 'Va bene, resta da fare.');
});

test('an approval detail that is not a proposal (purged, another kind) is not read as one', () => {
  assert.equal(proposalOf({ kind: 'commitment', detail: { purged: true } }), undefined);
  assert.equal(proposalOf({ kind: 'declassify', detail: { op: 'add', text: 'x', day: TODAY } }), undefined);
  assert.equal(proposalOf({ kind: 'commitment', detail: { op: 'add', text: 'x', day: TODAY } })?.op, 'add');
});

test('a range is named with "di" joined to its article', () => {
  assert.equal(ofRange('questa settimana'), 'di questa settimana');
  assert.equal(ofRange('la settimana prossima'), 'della settimana prossima');
  assert.equal(ofRange('i prossimi 7 giorni'), 'dei prossimi 7 giorni');
  assert.equal(ofRange('il mese prossimo'), 'del mese prossimo');
  assert.equal(ofRange('questo mese'), 'di questo mese');
});

test('commitment.move (D-148): the new day computed by the code, the clock kept unless said', () => {
  // 2026-10-09 is a Friday: "venerdì" is the next one.
  const bank = commitment('aaaaaaaa-0000-4000-8000-000000000001', 'Andare in banca', '2026-10-15', '15:00');
  assert.deepEqual(proposeMove(bank, { which: 'banca', day: 'venerdì' }, TODAY), {
    op: 'move',
    commitmentId: bank.id,
    text: 'Andare in banca',
    day: '2026-10-16',
    time: '15:00',
    dayText: 'venerdì 16 ottobre 2026',
    fromDay: '2026-10-15',
    fromTime: '15:00',
    fromDayText: 'giovedì 15 ottobre 2026',
  });
  assert.equal((proposeMove(bank, { which: 'banca', day: 'venerdì alle 10' }, TODAY) as { time: string }).time, '10:00');
  assert.equal((proposeMove(bank, { which: 'banca', day: 'venerdì', time: '9:30' }, TODAY) as { time: string }).time, '09:30');
  // A clock alone moves it on the same day.
  const clockOnly = proposeMove(bank, { which: 'banca', time: '17' }, TODAY) as { day: string; time: string };
  assert.deepEqual([clockOnly.day, clockOnly.time], ['2026-10-15', '17:00']);
});

test('commitment.move: what the code cannot compute, or a move to where it is, is an error the model reads', () => {
  const bank = commitment('aaaaaaaa-0000-4000-8000-000000000001', 'Andare in banca', '2026-10-15', '15:00');
  assert.match((proposeMove(bank, { which: 'banca' }, TODAY) as { error: string }).error, /say where to move it/);
  assert.match((proposeMove(bank, { which: 'banca', day: 'prima o poi' }, TODAY) as { error: string }).error, /not one the core can compute/);
  assert.match((proposeMove(bank, { which: 'banca', day: 'giovedì', time: '15:00' }, TODAY) as { error: string }).error, /already on/);
  assert.match((proposeMove(bank, { which: 'banca', time: 'presto' }, TODAY) as { error: string }).error, /not a clock/);
  // A late one: a clock alone would leave it on a day already past.
  const late = commitment('aaaaaaaa-0000-4000-8000-000000000002', 'Pagare la bolletta', '2026-10-07');
  assert.match((proposeMove(late, { which: 'bolletta', time: '10' }, TODAY) as { error: string }).error, /already past/);
  assert.equal((proposeMove(late, { which: 'bolletta', day: 'domani' }, TODAY) as { day: string }).day, '2026-10-10');
});

test('commitment.move: the approval detail read back, and the answers written by the code', () => {
  const detail = { op: 'move', commitmentId: 'x', text: 'Andare in banca', day: '2026-10-16', time: '15:00', fromDay: '2026-10-15', fromTime: '15:00', step: 2 };
  const proposal = proposalOf({ kind: 'commitment', detail });
  assert.ok(proposal?.op === 'move');
  assert.equal(decisionText(proposal, 'approved', TODAY), 'Spostato a venerdì 16 ottobre 2026, alle 15:00: Andare in banca.');
  assert.equal(decisionText(proposal, 'rejected', TODAY), 'Va bene, resta per giovedì 15 ottobre 2026, alle 15:00.');
  // Without where it was, it is not a move.
  assert.equal(proposalOf({ kind: 'commitment', detail: { ...detail, fromDay: undefined } }), undefined);
});

const BANK = '11111111-1111-4111-8111-111111111111';
const BREAD = '22222222-2222-4222-8222-222222222222';
const PLANTS = '33333333-3333-4333-8333-333333333333';
const OPEN = [
  commitment(BANK, 'Andare in banca per il mutuo finto', TODAY, '15:00'),
  commitment(BREAD, 'Comprare il pane finto'),
  commitment(PLANTS, 'Innaffiare le piante finte', '2026-10-07'),
];

test('commitment.report (D-151): each commitment with its outcome and reason, the new day computed by the code', () => {
  const report = proposeReport(
    OPEN,
    {
      items: [
        { which: 'banca', outcome: 'done' },
        { which: 'pane', outcome: 'postponed', day: 'domani', reason: '  il forno   era chiuso ' },
        { which: 'piante', outcome: 'not_done', reason: 'ero fuori casa' },
      ],
    },
    TODAY,
  );
  assert.ok(!('error' in report) && report.op === 'report');
  const [bank, bread, plants] = report.entries;
  assert.deepEqual(bank, { commitmentId: BANK, text: 'Andare in banca per il mutuo finto', day: TODAY, time: '15:00', dayText: 'venerdì 9 ottobre 2026', outcome: 'done', reason: null });
  assert.equal(bread?.reason, 'il forno era chiuso', 'the reason in the user’s words, spaces collapsed');
  assert.equal(bread.toDay, '2026-10-10');
  assert.equal(bread.toTime, null);
  assert.equal(bread.toDayText, 'sabato 10 ottobre 2026');
  assert.equal(plants?.outcome, 'not_done');
  // The clock goes with a postponement unless another is said.
  const kept = proposeReport(OPEN, { items: [{ which: 'banca', outcome: 'postponed', day: 'lunedì' }] }, TODAY);
  assert.ok(!('error' in kept) && kept.op === 'report' && kept.entries[0]?.toTime === '15:00' && kept.entries[0].toDay === '2026-10-12');
  const clock = proposeReport(OPEN, { items: [{ which: 'banca', outcome: 'postponed', day: 'lunedì', time: '9' }] }, TODAY);
  assert.ok(!('error' in clock) && clock.op === 'report' && clock.entries[0]?.toTime === '09:00');
  // A late one can be postponed to today.
  const late = proposeReport(OPEN, { items: [{ which: 'piante', outcome: 'postponed', day: 'oggi' }] }, TODAY);
  assert.ok(!('error' in late) && late.op === 'report' && late.entries[0]?.toDay === TODAY);
});

test('commitment.report: what the code cannot compute or tell apart is an error the model reads, never a guess', () => {
  const error = (args: Record<string, unknown>): string => {
    const result = proposeReport(OPEN, args, TODAY);
    return 'error' in result ? result.error : '';
  };
  assert.match(error({}), /"items"/);
  assert.match(error({ items: [] }), /"items"/);
  assert.match(error({ items: [{ which: 'banca', outcome: 'maybe' }] }), /not one of done, not_done, postponed/);
  assert.match(error({ items: [{ which: 'treno', outcome: 'done' }] }), /no open commitment matches 'treno'[\s\S]*\[11111111\]/);
  assert.match(error({ items: [{ which: 'finto', outcome: 'done' }] }), /more than one open commitment matches/);
  assert.match(error({ items: [{ which: 'banca', outcome: 'done' }, { which: BANK, outcome: 'not_done' }] }), /already in this report/);
  assert.match(error({ items: [{ which: 'pane', outcome: 'postponed' }] }), /say the day/);
  assert.match(error({ items: [{ which: 'pane', outcome: 'postponed', day: 'boh' }] }), /not one the core can compute/);
  assert.match(error({ items: [{ which: 'pane', outcome: 'postponed', day: 'oggi' }] }), /a later day/);
  assert.match(error({ items: [{ which: 'pane', outcome: 'postponed', day: 'domani', time: 'presto' }] }), /not a clock/);
  assert.match(error({ items: [{ which: 'pane', outcome: 'not_done', reason: 'x'.repeat(301) }] }), /longer than 300/);
  assert.match(error({ items: Array.from({ length: 13 }, () => ({ which: 'pane', outcome: 'done' })) }), /at most 12/);
});

test('commitment.report: the approval detail read back, and the answer written by the code', () => {
  const report = proposeReport(
    OPEN,
    {
      items: [
        { which: 'banca', outcome: 'done' },
        { which: 'pane', outcome: 'postponed', day: 'domani', reason: 'forno chiuso' },
        { which: 'piante', outcome: 'not_done', reason: 'ero fuori' },
      ],
    },
    TODAY,
  );
  assert.ok(!('error' in report));
  const read = proposalOf({ kind: 'commitment', detail: JSON.parse(JSON.stringify({ ...report, step: 2 })) as Record<string, never> });
  assert.deepEqual(read, report);
  // A malformed entry is dropped; none left, no proposal.
  assert.equal(proposalOf({ kind: 'commitment', detail: { op: 'report', entries: [{ commitmentId: BANK, text: 'x', day: TODAY, outcome: 'postponed' }] } }), undefined);
  assert.equal(
    decisionText(report, 'approved', TODAY),
    'Annotato:\n- fatto: Andare in banca per il mutuo finto\n- rinviato a domani, sabato 10 ottobre 2026: Comprare il pane finto — forno chiuso\n- non fatto: Innaffiare le piante finte — ero fuori',
  );
  const partly = decisionText(report, 'approved', TODAY, new Set([BREAD]));
  assert.match(partly, /^Annotato:\n- rinviato a domani/);
  assert.match(partly, /Non annotati, perché nel frattempo chiusi o spostati altrove:\n- Andare in banca per il mutuo finto\n- Innaffiare le piante finte$/);
  assert.equal(decisionText(report, 'rejected', TODAY), 'Va bene, non ho annotato nulla. Dimmi cosa cambiare.');
});

test('the list shows the reason of a commitment closed with one', () => {
  const closed = { ...commitment(BREAD, 'Comprare il pane finto', TODAY, null, 'postponed'), reason: 'forno chiuso' };
  assert.match(listText([closed], { from: TODAY, to: TODAY, text: 'oggi' }, TODAY), /- Comprare il pane finto \(rinviato\) — forno chiuso/);
  assert.doesNotMatch(listText([{ ...closed, status: 'open' }], { from: TODAY, to: TODAY, text: 'oggi' }, TODAY), /forno/);
});

test('commitment.report: a day or a time only with a postponement, and never two different clocks', () => {
  const error = (item: Record<string, unknown>): string => {
    const result = proposeReport(OPEN, { items: [item] }, TODAY);
    return 'error' in result ? result.error : '';
  };
  assert.match(error({ which: 'banca', outcome: 'done', day: 'domani' }), /only with outcome postponed/);
  assert.match(error({ which: 'piante', outcome: 'not_done', time: '10:00' }), /only with outcome postponed/);
  assert.match(error({ which: 'banca', outcome: 'postponed', day: 'lunedì alle 10', time: '11:00' }), /two clocks/);
  assert.equal(error({ which: 'banca', outcome: 'postponed', day: 'lunedì alle 10', time: '10:00' }), '', 'the same clock twice is fine');
  // A placeholder for no clock, as local models write it, is no clock: the old one stays.
  const placeholder = proposeReport(OPEN, { items: [{ which: 'banca', outcome: 'postponed', day: 'domani', time: 'non specificato' }, { which: 'pane', outcome: 'done', time: 'nessuno', reason: '' }] }, TODAY);
  assert.ok(!('error' in placeholder) && placeholder.op === 'report');
  assert.equal(placeholder.entries[0]?.toTime, '15:00');
  assert.equal(placeholder.entries[1]?.reason, null, 'an empty reason is none');
  assert.match(error({ which: 'banca', outcome: 'postponed', day: 'domani', time: 'presto' }), /not a clock/, 'a word that is not a placeholder is still asked');
  assert.equal(error({ which: 'banca', outcome: 'done', day: 'non specificato', reason: '' }), '', 'a placeholder day with done is no day');
});

test('commitment.move with a reason, or of a day gone, is a postponement (D-151)', () => {
  const late = commitment(PLANTS, 'Innaffiare le piante finte', '2026-10-07');
  const today = commitment(BANK, 'Andare in banca per il mutuo finto', TODAY, '15:00');
  assert.equal(isPostponement(late, { day: 'oggi' }, TODAY), true, 'a day already gone');
  assert.equal(isPostponement(today, { day: 'venerdì', reason: 'banca chiusa' }, TODAY), true, 'a reason');
  assert.equal(isPostponement(today, { day: 'venerdì', reason: '  ' }, TODAY), false, 'a blank reason is none');
  assert.equal(isPostponement(today, { day: 'venerdì' }, TODAY), false, 'a change of plan stays a move');
});
