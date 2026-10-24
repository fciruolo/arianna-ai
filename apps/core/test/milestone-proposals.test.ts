// Milestones proposed in the chat (D-313, seguito 2): the checks of the code, the answer. Fake data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext } from '@arianna/policy';

import {
  checkMilestoneProposal,
  MAX_PROPOSED_CARDS,
  milestoneAnswerText,
  milestoneProposalLabelOk,
  milestoneProposalOf,
  proposalLabel,
  type MilestoneProposal,
} from '../src/milestone-proposals.ts';
import { runTool, type ToolEnv } from '../src/orchestrator/tools.ts';

const projects = [
  { name: 'panificio-rossi', label: 'L1' as const },
  { name: 'orto-verdi', label: 'L0' as const },
];
// A Saturday: "venerdì" is the next one.
const today = '2026-10-24';

function ok(result: MilestoneProposal | { error: string }): MilestoneProposal {
  if ('error' in result) throw new Error(result.error);
  return result;
}

function refused(result: MilestoneProposal | { error: string }): string {
  assert.ok('error' in result, 'refused');
  return result.error;
}

test('a milestone of a project the user named, with its cards and the due day computed by the code', () => {
  const proposal = ok(
    checkMilestoneProposal(
      { title: '  Accessi ', project: 'Panificio-Rossi', description: 'Si entra con email e password', due: 'venerdì', cards: ['Design', 'Database', 'Implementazione', 'design'] },
      { projects, today },
    ),
  );
  assert.deepEqual(proposal, {
    project: 'panificio-rossi',
    projectLabel: 'L1',
    title: 'Accessi',
    description: 'Si entra con email e password',
    due: '2026-10-30',
    cards: ['Design', 'Database', 'Implementazione'],
  });
  // No cards: a milestone alone, the cards moved in from the wall.
  assert.deepEqual(ok(checkMilestoneProposal({ title: 'Sezione dashboard', project: 'orto-verdi', cards: [] }, { projects, today })).cards, []);
});

test('the project of a work conversation is its own: another one is refused, none said is that one', () => {
  assert.equal(ok(checkMilestoneProposal({ title: 'Accessi', cards: ['Design'] }, { projects, workspace: 'panificio-rossi', today })).project, 'panificio-rossi');
  assert.equal(ok(checkMilestoneProposal({ title: 'Accessi', project: 'PANIFICIO-ROSSI', cards: [] }, { projects, workspace: 'panificio-rossi', today })).project, 'panificio-rossi');
  assert.match(refused(checkMilestoneProposal({ title: 'Accessi', project: 'orto-verdi', cards: [] }, { projects, workspace: 'panificio-rossi', today })), /panificio-rossi/);
});

test('refused: no project, an unknown one, fields that are not a milestone, a day the code cannot tell, bad cards', () => {
  assert.match(refused(checkMilestoneProposal({ title: 'Accessi', cards: [] }, { projects, today })), /panificio-rossi, orto-verdi/);
  assert.match(refused(checkMilestoneProposal({ title: 'Accessi', project: 'forno-bianchi', cards: [] }, { projects, today })), /no project 'forno-bianchi'/);
  assert.match(refused(checkMilestoneProposal({ title: 'Accessi', project: 'orto-verdi', cards: [], prompt: 'fai tutto' }, { projects, today })), /prompt/);
  assert.match(refused(checkMilestoneProposal({ title: 'Accessi', project: 'orto-verdi', due: 'quando capita', cards: [] }, { projects, today })), /cannot tell the day/);
  const many = Array.from({ length: MAX_PROPOSED_CARDS + 1 }, (_, index) => `Card ${String(index)}`);
  refused(checkMilestoneProposal({ title: 'Accessi', project: 'orto-verdi', cards: many }, { projects, today }));
  refused(checkMilestoneProposal({ title: 'Accessi', project: 'orto-verdi' }, { projects, today }));
  refused(checkMilestoneProposal({ title: ' ', project: 'orto-verdi', cards: [] }, { projects, today }));
  assert.match(refused(checkMilestoneProposal({ title: 'Accessi', project: 'orto-verdi', cards: ['Design', ''] }, { projects, today })), /card 2/);
});

test('the label of the approval: what the step read, never below the project, at most Privato', () => {
  assert.equal(proposalLabel('L0', { projectLabel: 'L1' }), 'L1');
  assert.equal(proposalLabel('L2', { projectLabel: 'L1' }), 'L2');
  assert.ok(milestoneProposalLabelOk('L2'));
  assert.ok(!milestoneProposalLabelOk('L3'));
});

test('the proposal of an approval, and none for another kind or a purged one', () => {
  const detail = { project: 'panificio-rossi', projectLabel: 'L1', title: 'Accessi', description: null, due: null, cards: ['Design', 3], step: 2 };
  assert.deepEqual(milestoneProposalOf({ kind: 'milestone_plan', detail }), { project: 'panificio-rossi', projectLabel: 'L1', title: 'Accessi', description: null, due: null, cards: ['Design'] });
  assert.equal(milestoneProposalOf({ kind: 'milestone_plan', detail: { purged: true } }), undefined);
  assert.equal(milestoneProposalOf({ kind: 'plan', detail }), undefined);
});

test('the answer, written by code: created with its cards, refused, a full project', () => {
  const proposal: MilestoneProposal = { project: 'panificio-rossi', projectLabel: 'L1', title: 'Accessi', description: null, due: '2026-10-30', cards: ['Design', 'Database'] };
  const created = milestoneAnswerText(proposal, 'approved', 'created');
  assert.match(created, /^Ho creato la milestone «Accessi» di panificio-rossi, scade venerdì 30 ottobre 2026, con 2 card in Inbox/);
  assert.match(created, /1\. Design\n2\. Database/);
  assert.match(milestoneAnswerText({ ...proposal, cards: ['Design'] }, 'approved', 'created'), /con una card in Inbox, assegnata a te e non avviata/);
  assert.match(milestoneAnswerText({ ...proposal, cards: [], due: null }, 'approved', 'created'), /^Ho creato la milestone «Accessi» di panificio-rossi, ancora senza card/);
  assert.match(milestoneAnswerText(proposal, 'rejected', 'failed'), /^Va bene: non ho creato la milestone/);
  assert.match(milestoneAnswerText(proposal, 'approved', 'full'), /già 50 milestone aperte/);
  assert.match(milestoneAnswerText(proposal, 'approved', 'duplicate'), /ne ha già una aperta con questo nome/);
  assert.match(milestoneAnswerText(proposal, 'approved', 'failed'), /^Non sono riuscita a creare la milestone «Accessi»: guarda il «Cardwall»/);
});

test('the tool refuses before reading anything: without the projects of a conversation of Arianna, after a finance read', async () => {
  // The refusals come first: the database and the knowledge base are never touched.
  const untouched = new Proxy({}, { get: () => { throw new Error('touched'); } });
  const env = (extra: Partial<ToolEnv>): ToolEnv =>
    ({ sql: untouched, kb: untouched, task: { id: 't', conversationId: 'c' }, context: createContext('L2', 'L1'), autonomy: 'A1', ...extra }) as unknown as ToolEnv;
  const args = { title: 'Accessi', project: 'panificio-rossi', cards: [] };
  assert.match((await runTool('milestone.propose', args, env({}))).text, /^error: milestone\.propose: a milestone is proposed only in a conversation with Arianna/);
  const finance = env({ milestones: { projects }, context: createContext('L2', 'L2', { finance: true }) });
  const refused = await runTool('milestone.propose', args, finance);
  assert.match(refused.text, /^error: milestone\.propose: this conversation has read finance data/);
  assert.equal(refused.milestone, undefined);
});
