// routine.propose (D-110, tappa A2; D-256): the closed fields checked by code,
// never trusted to the model; the answer written by code once decided.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext } from '@arianna/policy';

import { checkRoutineProposal, proposedRoutineId, routineAnswerText, routineTitle, WAITING_ROUTINE } from '../src/routine-proposals.ts';
import { runTool, type ToolEnv } from '../src/orchestrator/tools.ts';
import type { Kb } from '../src/orchestrator/kb.ts';
import type { Task } from '../src/tasks.ts';

const GOOD = { title: 'Resoconto del lunedì e giovedì', days: [4, 1], at: '09:00', sources: ['waiting', 'todo'] };

test('a proposal with closed fields is taken: days sorted, sources in their order, summary on, the zone of this Mac', () => {
  const checked = checkRoutineProposal(GOOD, 'Europe/Rome');
  assert.deepEqual(checked, { title: 'Resoconto del lunedì e giovedì', days: [1, 4], at: '09:00', timezone: 'Europe/Rome', sources: ['todo', 'waiting'], summary: true });
  assert.deepEqual(checkRoutineProposal({ ...GOOD, at: '9:30', summary: false, channel: 'chat' }, 'UTC'), {
    title: GOOD.title,
    days: [1, 4],
    at: '09:30',
    timezone: 'UTC',
    sources: ['todo', 'waiting'],
    summary: false,
  });
});

test('a field outside the closed list is refused: never a free prompt, never another channel', () => {
  const prompt = checkRoutineProposal({ ...GOOD, prompt: 'scrivimi una poesia ogni mattina' });
  assert.ok('error' in prompt && /unknown field\(s\) prompt/.test(prompt.error) && /never a prompt/.test(prompt.error));
  const timezone = checkRoutineProposal({ ...GOOD, timezone: 'Asia/Tokyo' });
  assert.ok('error' in timezone && /unknown field\(s\) timezone/.test(timezone.error));
  const call = checkRoutineProposal({ ...GOOD, channel: 'call' });
  assert.ok('error' in call && /only in its chat/.test(call.error));
});

test('wrong values are refused with an error the model reads', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...GOOD, days: [] }, /days must be/],
    [{ ...GOOD, days: [0, 8] }, /days must be/],
    [{ ...GOOD, days: ['lun'] }, /days must be/],
    [{ ...GOOD, at: '25:00' }, /HH:MM/],
    [{ ...GOOD, at: '9' }, /HH:MM/],
    [{ ...GOOD, sources: ['email.important'] }, /sources must be some of/],
    [{ ...GOOD, sources: [] }, /sources must be some of/],
    [{ ...GOOD, summary: 'sì' }, /true or false/],
    [{ ...GOOD, title: '   ' }, /empty/],
    [{ ...GOOD, title: 'x'.repeat(81) }, /longer than 80/],
    [{ ...GOOD, title: 'riga\u0000' }, /control characters/],
  ];
  for (const [args, error] of cases) {
    const checked = checkRoutineProposal(args);
    assert.ok('error' in checked, JSON.stringify(args));
    assert.match(checked.error, error);
  }
  // Spaces and new lines of a title become one line.
  assert.equal(routineTitle('  Resoconto\n  della sera '), 'Resoconto della sera');
});

function env(routines: boolean, context = createContext('L2', 'L2')): ToolEnv {
  return {
    sql: undefined as unknown as ToolEnv['sql'],
    kb: undefined as unknown as Kb,
    task: { id: 't' } as unknown as Task,
    context,
    autonomy: 'A1',
    routines,
  };
}

test('the tool proposes only where the step may, never from finance data', async () => {
  const proposed = await runTool('routine.propose', GOOD, env(true));
  assert.equal(proposed.text, WAITING_ROUTINE);
  assert.equal(proposed.routine?.title, GOOD.title);
  const elsewhere = await runTool('routine.propose', GOOD, env(false));
  assert.match(elsewhere.text, /^error: routine\.propose: a routine is proposed only in a private conversation/);
  assert.equal(elsewhere.routine, undefined);
  const finance = await runTool('routine.propose', GOOD, env(true, createContext('L2', 'L2', { finance: true })));
  assert.match(finance.text, /finance data/);
  assert.equal(finance.routine, undefined);
  const bad = await runTool('routine.propose', { ...GOOD, prompt: 'altro' }, env(true));
  assert.match(bad.text, /^error: routine\.propose: unknown field/);
  assert.equal(bad.routine, undefined);
});

test('the answer once decided is written by code', () => {
  const routine = { title: 'Resoconto', days: [1, 4] as (1 | 4)[], at: '09:00', timezone: 'UTC', status: 'active', nextRunAt: new Date('2026-10-19T09:00:00Z') };
  assert.equal(
    routineAnswerText(routine, 'approved'),
    'Fatto: la routine «Resoconto» è attiva, lun e gio alle 09:00. Il primo resoconto arriva lunedì 19 ottobre alle 09:00, nella sua chat «Routine · Resoconto». La cambi o la metti in pausa nella pagina Routine.',
  );
  assert.match(routineAnswerText(routine, 'rejected'), /^Va bene: la routine non parte/);
  assert.match(routineAnswerText(undefined, 'expired'), /^Va bene/);
  assert.match(routineAnswerText({ ...routine, status: 'retired', nextRunAt: null }, 'approved'), /^Non sono riuscita/);
});

test('the routine of an approval: only a kind routine with a uuid', () => {
  const id = '6f1c2a34-0b5d-4e6f-8a9b-0c1d2e3f4a5b';
  assert.equal(proposedRoutineId({ kind: 'routine', detail: { routineId: id } }), id);
  assert.equal(proposedRoutineId({ kind: 'fact', detail: { routineId: id } }), undefined);
  assert.equal(proposedRoutineId({ kind: 'routine', detail: { purged: true } }), undefined);
  assert.equal(proposedRoutineId({ kind: 'routine', detail: { routineId: 'x' } }), undefined);
});
