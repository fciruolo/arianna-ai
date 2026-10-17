// The card of a plan in the chat (D-159, D-235): rows read from the
// approval, edited before the decision, and the rows «Avvia subito».
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planErrorText } from '../src/lib/italian.ts';
import {
  addRow,
  cloneDraft,
  draftProblem,
  keepTicks,
  MAX_PLAN_ROWS,
  planBody,
  planCommandProblem,
  planDraft,
  planStarts,
  planWrittenBy,
  removeRow,
  toggleBlockedBy,
  withAssignee,
  type PlanDraft,
  type PlanDraftRow,
} from '../src/lib/plan-approval.ts';

const DETAIL = {
  title: 'Landing del sito',
  step: 1,
  cards: [
    { title: 'Grafica', goal: 'Due varianti.', assignee: 'designer', blockedBy: [], criteria: 'Due mockup.', complexity: 'M' },
    { title: 'Codice', goal: 'La pagina.', assignee: 'coder', blockedBy: [1], criteria: 'Test verdi.', complexity: 'L' },
    { title: 'Testi', goal: 'Le sezioni.', assignee: 'user', blockedBy: [], criteria: 'Scritti.', complexity: 'S' },
    { title: 'Controlli', goal: 'Link e moduli.', assignee: 'coder', blockedBy: [], criteria: 'Nessun errore.', complexity: 'S' },
  ],
};

function draft(): PlanDraft {
  const read = planDraft(DETAIL);
  assert.ok(read !== undefined);
  return read;
}

/** Row `index` of a draft, which the test knows is there. */
function rowOf(plan: PlanDraft, index: number): PlanDraftRow {
  const row = plan.rows[index];
  assert.ok(row !== undefined);
  return row;
}

test('the rows of a plan: «Avvia subito» ticked on the agents’ rows that wait for none; a plan before D-235 reads as M without criteria', () => {
  const read = draft();
  assert.deepEqual(
    read.rows.map((row) => [row.title, row.assignee, row.blockedBy, row.complexity, row.start]),
    [
      ['Grafica', 'designer', [], 'M', true],
      ['Codice', 'coder', [1], 'L', false],
      ['Testi', 'user', [], 'S', false],
      ['Controlli', 'coder', [], 'S', true],
    ],
  );
  assert.deepEqual(planStarts(read), [1, 4]);
  const old = planDraft({ title: 'Vecchio', cards: [{ title: 'Uno', goal: 'g', assignee: 'user', blockedBy: [3] }] });
  assert.deepEqual(old?.rows[0], { title: 'Uno', goal: 'g', assignee: 'user', blockedBy: [], criteria: '', complexity: 'M', start: false });
  assert.equal(planDraft({ title: 'x', cards: [] }), undefined);
  assert.equal(planDraft({ cards: DETAIL.cards }), undefined);
});

test('editing: a row removed is no longer waited for and the later ones are numbered again; «bloccata da» only towards earlier rows', () => {
  const read = draft();
  const copy = cloneDraft(read);
  rowOf(copy, 0).title = 'Altro';
  assert.equal(read.rows[0]?.title, 'Grafica', 'the copy is edited, not the plan');
  const fewer = removeRow(read, 1);
  assert.deepEqual(
    fewer.rows.map((row) => [row.title, row.blockedBy]),
    [
      ['Codice', []],
      ['Testi', []],
      ['Controlli', []],
    ],
  );
  const waits = toggleBlockedBy(rowOf(read, 3), 4, 2);
  assert.deepEqual(waits.blockedBy, [2]);
  assert.deepEqual(toggleBlockedBy(waits, 4, 2).blockedBy, []);
  assert.deepEqual(toggleBlockedBy(rowOf(read, 1), 2, 2).blockedBy, [1], 'never itself');
  assert.deepEqual(toggleBlockedBy(rowOf(read, 1), 2, 3).blockedBy, [1], 'never a later row');
  // A row becomes the user's: it no longer starts; an agent's again, the default.
  const mine = withAssignee(rowOf(read, 0), 'user');
  assert.equal(mine.start, false);
  assert.equal(withAssignee(mine, 'designer').start, true);
  assert.equal(planStarts({ ...read, rows: [mine, ...read.rows.slice(1)] }).includes(1), false);
  // Rows added up to twelve, empty: the plan cannot be saved until they are written.
  let many = read;
  for (let count = 0; count < 20; count += 1) many = addRow(many);
  assert.equal(many.rows.length, MAX_PLAN_ROWS);
  assert.match(draftProblem(many) ?? '', /^Card 5: manca il titolo/);
});

test('the body of the edit is the arguments of task.plan; the problems said in Italian before the core checks', () => {
  const read = draft();
  rowOf(read, 0).title = '  Grafica nuova ';
  assert.deepEqual(planBody(read).cards[0], { title: 'Grafica nuova', goal: 'Due varianti.', assignee: 'designer', blocked_by: [], criteria: 'Due mockup.', complexity: 'M' });
  assert.equal(draftProblem(read), undefined);
  assert.match(draftProblem({ ...read, title: ' ' }) ?? '', /titolo/);
  assert.match(draftProblem({ ...read, rows: read.rows.slice(0, 1) }) ?? '', /da 2 a 12 card/);
  const noCriteria = cloneDraft(read);
  rowOf(noCriteria, 2).criteria = '';
  assert.match(draftProblem(noCriteria) ?? '', /^Card 3: manca il criterio/);
});

test('the refusals of the core in Italian: the scanner of a work conversation, a cycle, a stranger, a size, a row that is the user’s', () => {
  assert.equal(
    planErrorText('a work conversation cannot hold this plan (iban, tax-code): open a private conversation'),
    'Il piano di una conversazione di lavoro non può contenere IBAN, codice fiscale: scrivilo in una conversazione privata.',
  );
  assert.equal(planErrorText('card 2: "blocked_by" may name only earlier cards of the plan, by their number (1 to 1)'), 'Card 2: «bloccata da» può indicare solo card precedenti.');
  assert.match(planErrorText('card 3: "assignee" must be one of user, coder') ?? '', /^Card 3: chi la fa/);
  assert.match(planErrorText('card 1: "complexity" must be S, M or L') ?? '', /S, M o L/);
  assert.equal(planErrorText('a plan has 2 to 12 cards; for one card call task.create'), 'Un piano ha da 2 a 12 card.');
  assert.equal(planErrorText('starts: card 3 is yours, it does not start by itself'), 'La card 3 è tua: non parte da sola.');
  assert.equal(planErrorText('something else'), undefined);
});

test('«/progetta» only with Arianna, never in incognito, and in a work conversation only with its project (D-235)', () => {
  const here = { ariannaChat: true, incognito: false, mode: 'work', workspace: 'site' };
  assert.equal(planCommandProblem(here), undefined);
  assert.equal(planCommandProblem({ ...here, mode: 'private', workspace: null }), undefined);
  assert.match(planCommandProblem({ ...here, workspace: null }) ?? '', /vuole un progetto/);
  assert.match(planCommandProblem({ ...here, incognito: true }) ?? '', /incognito/);
  assert.match(planCommandProblem({ ...here, ariannaChat: false }) ?? '', /solo in una conversazione con Arianna/);
});

test('the ticks «Avvia subito» survive a refresh of the same version; an edit made elsewhere brings its rows with the defaults (D-235)', () => {
  const shown = draft();
  rowOf(shown, 0).start = false;
  rowOf(shown, 1).start = true;
  const again = keepTicks(draft(), shown);
  assert.deepEqual(again.rows.map((row) => row.start), [false, true, false, true]);
  const edited = planDraft({ ...DETAIL, revision: 1 });
  assert.ok(edited !== undefined);
  assert.equal(edited.revision, 1);
  assert.deepEqual(keepTicks(edited, shown).rows.map((row) => row.start), [true, false, false, true]);
  assert.equal(draft().revision, 0);
});

test('the note of a plan written by another model than the project asked for (D-235)', () => {
  assert.equal(planWrittenBy({ title: 'Sito', cards: [], writtenBy: 'Scritto da Sonnet: Opus è spento' }), 'Scritto da Sonnet: Opus è spento');
  assert.equal(planWrittenBy({ title: 'Sito', cards: [] }), undefined);
  assert.equal(planWrittenBy({ writtenBy: '  ' }), undefined);
  assert.equal(planWrittenBy({ writtenBy: 3 }), undefined);
});
