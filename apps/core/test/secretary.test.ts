// The secretary (I-12, D-144): what the code computes and writes without the model.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { responseSchema, systemPrompt } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { decisionText, findCommitment, listText, ofRange, proposalOf, proposeAdd, proposeMove, type Commitment } from '../src/commitments.ts';
import { orchestratorTools } from '../src/orchestrator/orchestrator.ts';
import { isSecretaryTool, SECRETARY_TOOLS } from '../src/orchestrator/secretary.ts';
import { committedAgents } from './support/committed-agents.ts';

const arianna = committedAgents(resolveHome({})).get('arianna');
const TODAY = '2026-10-09';

function commitment(id: string, body: string, day = TODAY, time: string | null = null, status: Commitment['status'] = 'open'): Commitment {
  return { id, body, day, time, status, reason: null, label: 'L2', conversationId: null, createdAt: new Date(), doneAt: null };
}

test('the commitment tools only in the secretary’s conversation, which delegates nothing', () => {
  assert.ok(arianna !== undefined);
  const ordinary = orchestratorTools(arianna, true, true);
  assert.ok(SECRETARY_TOOLS.every((tool) => !ordinary.includes(tool)));
  assert.ok(ordinary.includes('task.delegate'));
  const secretary = orchestratorTools(arianna, true, true, false, true);
  assert.deepEqual(
    secretary.filter((tool) => isSecretaryTool(tool)),
    ['commitment.add', 'commitment.list', 'commitment.done', 'commitment.move'],
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
