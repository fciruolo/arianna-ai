// The cardwall, tappa C3 (I-13, D-159): Arianna's plans, the way a card of an
// agent runs and the Designer. Pure parts; the database ones are in
// test-db/card-plans.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readAnswer, responseSchema, systemPrompt, type ToolId } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { parseAddressed } from '../src/addressed.ts';
import { assigneeText, checkPlan, checkStarts, defaultStarts, planAnswerText, planOf, PlanError } from '../src/card-plans.ts';
import { planCardTitle, planRequestAnswer, quotaNote } from '../src/orchestrator/plan-job.ts';
import {
  cardBrief,
  cardEnd,
  cardLabel,
  choiceOf,
  choosesWay,
  defaultWay,
  executorOptions,
  isAgentCard,
  LOCAL_CARD_NO_FILES,
  localCardRequest,
  noWayReason,
  outOfQuotaOf,
  preferredWay,
  waysFor,
} from '../src/orchestrator/card-run.ts';
import { claudeToolsOf, codexAccessOf, delegationRoute, type DelegateEnv } from '../src/orchestrator/delegate.ts';
import { orchestratorTools } from '../src/orchestrator/orchestrator.ts';
import { committedAgents } from './support/committed-agents.ts';

const HOME = resolveHome({});
const official = committedAgents(HOME);
const arianna = official.get('arianna');
const designer = official.get('designer');
const coder = official.get('coder');

const ASSIGNEES = ['user', 'coder', 'designer'];
const plan = (cards: unknown[], title: unknown = 'Sito della pasticceria') => ({ title, cards });
const card = (title: string, assignee: string, blocked_by: unknown = [], goal = 'Fare la parte.', criteria: unknown = 'La parte è fatta.', complexity: unknown = 'M') => ({
  title,
  goal,
  assignee,
  blocked_by,
  criteria,
  complexity,
});

test('a plan: a title, 2 to 12 cards by the user or an agent that can work, each waiting only for earlier ones, with criteria and complexity (D-159, D-235)', () => {
  const checked = checkPlan(plan([card('Grafica della landing', 'designer'), card('Codice della landing', 'coder', [1]), card('Testi', 'user', [1, 1])]), ASSIGNEES);
  assert.ok(!('error' in checked));
  assert.deepEqual(
    checked.cards.map((item) => [item.title, item.assignee, item.blockedBy, item.criteria, item.complexity]),
    [
      ['Grafica della landing', 'designer', [], 'La parte è fatta.', 'M'],
      ['Codice della landing', 'coder', [1], 'La parte è fatta.', 'M'],
      // Named twice: once.
      ['Testi', 'user', [1], 'La parte è fatta.', 'M'],
    ],
  );
  // Twelve cards are a plan (D-235).
  assert.ok(!('error' in checkPlan(plan(Array.from({ length: 12 }, (_, index) => card(`Card ${String(index)}`, 'user'))), ASSIGNEES)));
  // Whitespace folded, as a card's title on the wall.
  const spaced = checkPlan(plan([card('  Uno \n due ', 'user'), card('Tre', 'user')], ' Piano  '), ASSIGNEES);
  assert.ok(!('error' in spaced));
  assert.deepEqual([spaced.title, spaced.cards[0]?.title], ['Piano', 'Uno due']);
});

test('a plan is refused with an error the model reads: one card, thirteen, a stranger, a later or own card waited for, no blocked_by, no criteria, a size that is not S, M or L', () => {
  const error = (value: Record<string, unknown>): string => {
    const checked = checkPlan(value, ASSIGNEES);
    assert.ok('error' in checked);
    return checked.error;
  };
  assert.match(error(plan([card('Sola', 'user')])), /2 to 12 cards; for one card call task.create/);
  assert.match(error(plan(Array.from({ length: 13 }, (_, index) => card(`Card ${String(index)}`, 'user')))), /2 to 12 cards/);
  assert.match(error(plan([card('Uno', 'user'), card('Due', 'user', [], 'x', '')])), /card 2 needs "criteria"/);
  assert.match(error(plan([card('Uno', 'user'), card('Due', 'user', [], 'x', null)])), /card 2 needs "criteria"/);
  assert.match(error(plan([card('Uno', 'user', [], 'x', 'Fatto.', 'XL'), card('Due', 'user')])), /card 1: "complexity" must be S, M or L/);
  assert.match(error(plan([card('Uno', 'user', [], 'x', 'Fatto.', 'm'), card('Due', 'user')])), /"complexity" must be S, M or L/);
  assert.match(error(plan([card('Uno', 'user'), card('Due', 'reviewer')])), /"assignee" must be one of user, coder, designer/);
  assert.match(error(plan([card('Uno', 'user', [2]), card('Due', 'user')])), /only earlier cards/);
  assert.match(error(plan([card('Uno', 'user'), card('Due', 'user', [2])])), /only earlier cards of the plan, by their number \(1 to 1\)/);
  assert.match(error(plan([card('Uno', 'user'), card('Due', 'user', [0])])), /only earlier cards/);
  assert.match(error(plan([card('Uno', 'user'), { title: 'Due', goal: 'x', assignee: 'user', criteria: 'y', complexity: 'S' }])), /needs "blocked_by"/);
  assert.match(error(plan([card('Uno', 'user'), card('Due', 'user')], '')), /needs a title/);
  assert.match(error(plan([card('Uno', 'user'), card('', 'user')])), /card 2 needs a title/);
});

test('the answer of a decided plan, written by the code', () => {
  const checked = checkPlan(plan([card('Grafica', 'designer', [], 'x', 'Mockup approvato.', 'S'), card('Codice', 'coder', [1]), card('Testi', 'user', [1, 2], 'x', 'Testi scritti.', 'L')]), ASSIGNEES);
  assert.ok(!('error' in checked));
  const head = 'Ho creato 3 card per «Sito della pasticceria», tutte in Inbox sul cardwall:\n\n1. Grafica — Designer · S\n2. Codice — Coder · M, aspetta la 1\n3. Testi — tu · L, aspetta le 1 e 2';
  // A plan read before D-235, without the rows that start: nothing about them.
  assert.equal(planAnswerText(checked, 'approved'), head);
  assert.equal(planAnswerText({ ...checked, starts: [1] }, 'approved'), `${head}\n\nPartono subito: la 1; una che aspetta un’altra card parte quando quella è in Fatto.`);
  assert.equal(planAnswerText({ ...checked, starts: [1, 2] }, 'approved'), `${head}\n\nPartono subito: le 1, 2; una che aspetta un’altra card parte quando quella è in Fatto.`);
  assert.equal(planAnswerText({ ...checked, starts: [] }, 'approved'), `${head}\n\nNessuna parte da sola: avviale dal cardwall quando vuoi.`);
  assert.equal(planAnswerText(checked, 'rejected'), 'Va bene, non ho creato nessuna card.');
  assert.equal(assigneeText('user'), 'tu');
  // Read back from an approval: a detail that is not a plan is none.
  assert.deepEqual(planOf({ kind: 'plan', detail: { ...checked, step: 1 } }), checked);
  assert.deepEqual(planOf({ kind: 'plan', detail: { ...checked, starts: [2, 9, 'x'] } }), { ...checked, starts: [2] });
  // A plan written before D-235: no criteria, no size.
  const old = { title: 'Vecchio', cards: [{ title: 'Uno', goal: 'g', assignee: 'user', blockedBy: [] }] };
  assert.deepEqual(planOf({ kind: 'plan', detail: old })?.cards[0], { title: 'Uno', goal: 'g', assignee: 'user', blockedBy: [], criteria: '', complexity: null });
  assert.equal(planOf({ kind: 'plan', detail: {} }), undefined);
  assert.equal(planOf({ kind: 'commitment', detail: { ...checked } }), undefined);
});

test('«Avvia subito» (D-235): by default the agents’ cards that wait for none; the chat may tick any agent’s card, never the user’s', () => {
  const checked = checkPlan(plan([card('Grafica', 'designer'), card('Codice', 'coder', [1]), card('Testi', 'user'), card('Controlli', 'coder')]), ASSIGNEES);
  assert.ok(!('error' in checked));
  assert.deepEqual(defaultStarts(checked), [1, 4]);
  assert.deepEqual(checkStarts([4, 2, 2], checked), [2, 4]);
  assert.deepEqual(checkStarts([], checked), []);
  for (const bad of [[3], [0], [5], [1.5], ['1'], 'tutte', null]) assert.throws(() => checkStarts(bad, checked), PlanError, JSON.stringify(bad));
});

test('«/progetta» (D-235): parsed with its description; the title of the card «Piano» and Arianna’s line, written by the code', () => {
  assert.deepEqual(parseAddressed('/progetta  la landing della pasticceria\ncon il menu'), { kind: 'plan', brief: 'la landing della pasticceria\ncon il menu' });
  assert.deepEqual(parseAddressed('/progetta'), { kind: 'plan', brief: '' });
  assert.equal(parseAddressed('/progettare la landing'), undefined);
  assert.equal(parseAddressed('ti scrivo /progetta x'), undefined);
  assert.equal(planCardTitle('  la landing \n della pasticceria'), 'Piano: la landing');
  const long = planCardTitle('x'.repeat(80));
  assert.equal(Array.from(long).length, 'Piano: '.length + 60);
  assert.ok(long.endsWith('…'));
  assert.match(quotaNote(new Date(2026, 9, 16, 14, 5)), /^In attesa della quota di Claude: riprovo alle 14:05\.$/);
  assert.equal(planRequestAnswer('Piano: la landing'), 'Ho messo la pianificazione sul cardwall: card «Piano: la landing». Ti avviso quando è pronta.');
});

test('task.plan: offered to Arianna, never in the secretary’s conversation nor in incognito; its assignees are the user and the agents that can work', () => {
  assert.ok(arianna !== undefined);
  assert.ok(orchestratorTools(arianna).includes('task.plan'));
  assert.ok(!orchestratorTools(arianna, false, false, false, true).includes('task.plan'));
  assert.ok(!orchestratorTools(arianna, true, true, true).includes('task.plan'));
  const tools: ToolId[] = ['task.plan'];
  const delegates = [
    { name: 'coder', description: 'Code' },
    { name: 'designer', description: 'Mockups' },
  ];
  assert.match(JSON.stringify(responseSchema(tools, true, delegates)), /"enum":\["user","coder","designer"\]/);
  assert.match(systemPrompt('A.', tools, true, '', delegates), /task\.plan: Propose to the user a plan/);
  const call = (assignee: string) => ({
    thought: 'Piano.',
    action: 'call',
    tool: 'task.plan',
    arguments: { title: 'Sito', cards: [card('Grafica', 'designer'), card('Codice', assignee, [1])] },
  });
  assert.ok(readAnswer(call('coder'), tools, true, delegates));
  assert.equal(readAnswer(call('reviewer'), tools, true, delegates), undefined);
});

function env(cloud: ('claude' | 'codex')[], local = true, projects = ['sito']): DelegateEnv {
  return {
    sql: undefined as never,
    agents: official,
    settings: () =>
      ({
        cloud: { executors: cloud },
        projects: projects.map((name) => ({ name, path: `repos/${name}`, absolute: `/x/repos/${name}`, label: 'L1' })),
      }) as never,
    rules: undefined as never,
    claude: {} as never,
    codex: {} as never,
    ...(local ? { model: () => ({}) as never } : {}),
  };
}

const task = (label: 'L0' | 'L1' | 'L2' | 'L3', project: string | null = 'sito') => ({ label, effectiveLabel: 'L0' as const, project });

test('the Designer: its own card, on Claude unless Claude cannot take the card, writing in the project but never running commands (D-159, D-298)', () => {
  assert.ok(designer !== undefined);
  const { card: d } = designer;
  assert.deepEqual([d.maxLabel, d.cloudMaxLabel, d.executors, d.executorChoice, d.autonomy], ['L2', 'L1', ['claude', 'codex', 'local'], 'prefer-first', 'A1']);
  assert.deepEqual(d.tools, ['repo.read', 'repo.write', 'task.update']);
  assert.equal(d.trifecta.external_comms, false);
  assert.ok(!d.tools.some((tool) => tool.startsWith('kb.') || tool.startsWith('web.')), 'no knowledge base, no network');
  assert.deepEqual(claudeToolsOf(d.tools), ['Read', 'Glob', 'Grep', 'Edit', 'Write'], 'no Bash: it runs no command');
  assert.equal(codexAccessOf(d.tools), 'write');
  assert.equal(delegationRoute(d), 'claude');
  assert.match(designer.prompt, /docs\/mockups\//);
  assert.match(designer.prompt, /DESIGN\.md/);
  assert.match(designer.prompt, /No remote resource/);
  // The other cards keep the router's choice.
  assert.equal(coder?.card.executorChoice, undefined);
});

test('the ways a card may run: the cloud only within the cloud ceiling, with an approved project and the executor on; the local model within max_label', () => {
  assert.ok(designer !== undefined);
  const d = designer.card;
  assert.deepEqual(executorOptions(env(['claude', 'codex']), d, task('L1')), { options: ['claude', 'codex', 'local'], excluded: [] });
  // A private card (any card written by hand on the wall is L2): the cloud never reads it.
  assert.deepEqual(executorOptions(env(['claude', 'codex']), d, task('L2')), {
    options: ['local'],
    excluded: [
      { executor: 'claude', reason: 'label' },
      { executor: 'codex', reason: 'label' },
    ],
  });
  // No approved project for the card: no folder to work in.
  assert.deepEqual(executorOptions(env(['claude']), d, task('L1', 'altro')).excluded, [
    { executor: 'claude', reason: 'project' },
    { executor: 'codex', reason: 'project' },
  ]);
  // Codex off: Claude and the local model.
  assert.deepEqual(executorOptions(env(['claude']), d, task('L0')), { options: ['claude', 'local'], excluded: [{ executor: 'codex', reason: 'off' }] });
  // No local model: nothing there either.
  assert.deepEqual(executorOptions(env([], false), d, task('L2')).options, []);
  // Above what the agent may read (its max_label, L2): not even the local model.
  assert.deepEqual(executorOptions(env(['claude', 'codex']), d, task('L3')), {
    options: [],
    excluded: [
      { executor: 'claude', reason: 'label' },
      { executor: 'codex', reason: 'label' },
      { executor: 'local', reason: 'label' },
    ],
  });
  assert.equal(
    noWayReason('designer', d, executorOptions(env([]), d, task('L3')).excluded),
    'no way for designer to work on this card now (claude: the card is above what designer may read there (cloud_max_label); codex: the card is above what designer may read there (cloud_max_label); local: the card is above what designer may read there (L2))',
  );
  // A delegation of the chat (D-159): the same rules, from its label and project; its reason speaks of the work.
  assert.deepEqual(waysFor(env(['claude']), d, 'L1', 'sito'), executorOptions(env(['claude']), d, task('L1')));
  assert.deepEqual(waysFor(env(['claude']), d, 'L1', undefined).options, ['local']);
  assert.equal(noWayReason('designer', d, [{ executor: 'local', reason: 'off' }], 'work'), 'no way for designer to work on this work now (local: off)');
});

test('prefer-first (D-298): the Designer takes Claude without asking when it can, else the user chooses among the rest', () => {
  assert.ok(designer !== undefined && coder !== undefined);
  const d = designer.card;
  assert.ok(choosesWay(d));
  assert.ok(!choosesWay(coder.card));
  // Claude on, the card within L1 in an approved project: Claude, no question.
  assert.equal(preferredWay(d, executorOptions(env(['claude', 'codex']), d, task('L1'))), 'claude');
  // Claude off: no way taken alone; the user chooses between ChatGPT and the local model.
  const off = executorOptions(env(['codex']), d, task('L1'));
  assert.equal(preferredWay(d, off), undefined);
  assert.deepEqual(off, { options: ['codex', 'local'], excluded: [{ executor: 'claude', reason: 'off' }] });
  // Claude out of quota: the same, with why.
  const quota = executorOptions(env(['claude', 'codex']), d, task('L1'), outOfQuotaOf({ blocked: [{ executor: 'claude', cause: 'quota', until: '2026-10-23T20:00:00Z' }] }));
  assert.equal(preferredWay(d, quota), undefined);
  assert.deepEqual(quota, { options: ['codex', 'local'], excluded: [{ executor: 'claude', reason: 'quota' }] });
  // A private card: Claude never reads it, the user chooses (here only the local model).
  assert.equal(preferredWay(d, executorOptions(env(['claude', 'codex']), d, task('L2'))), undefined);
  // An agent that asks never takes a way alone, even its first one.
  assert.equal(preferredWay({ ...d, executorChoice: 'ask' }, executorOptions(env(['claude', 'codex']), d, task('L1'))), undefined);
  // Only whole-executor blocks count: one model out of its cap leaves the executor available.
  assert.deepEqual(outOfQuotaOf({ blocked: [{ executor: 'claude', model: 'opus', cause: 'cap' }, { executor: 'codex', cause: 'quota' }] }), ['codex']);
  // With no way left, why reads the quota as such, not as "off".
  assert.equal(
    noWayReason('designer', d, [{ executor: 'claude', reason: 'quota' }, { executor: 'local', reason: 'off' }]),
    'no way for designer to work on this card now (claude: out of quota; local: off)',
  );
});

test('an agent that does not ask: the cloud way when it can run, else the local model, else none', () => {
  assert.ok(coder !== undefined);
  assert.equal(defaultWay(env(['claude']), coder.card, task('L2')), 'cloud');
  assert.equal(defaultWay(env([]), coder.card, task('L1')), 'local');
  // A general card: the only approved project, as a delegation of a conversation without one; with two, none.
  assert.equal(defaultWay(env(['claude']), coder.card, task('L1', null)), 'cloud');
  assert.equal(defaultWay(env(['claude'], true, ['sito', 'blog']), coder.card, task('L1', null)), 'local');
  const reviewer = official.get('reviewer');
  assert.ok(reviewer !== undefined);
  assert.equal(defaultWay(env([]), reviewer.card, task('L1')), undefined);
  // The local model only within the agent's max_label (L2 for the Coder).
  assert.equal(defaultWay(env([]), coder.card, task('L2')), 'local');
  assert.equal(defaultWay(env([]), coder.card, task('L3')), undefined);
});

test('a card on the local model: the Designer reads that it writes no file there; an agent that writes none does not', () => {
  assert.ok(designer !== undefined && coder !== undefined);
  assert.equal(localCardRequest({ title: 'Grafica', goal: 'La landing.' }, designer.card), `Grafica\n\nLa landing.\n\n${LOCAL_CARD_NO_FILES}`);
  assert.match(LOCAL_CARD_NO_FILES, /cannot write or read files/);
  const reviewer = official.get('reviewer');
  assert.ok(reviewer !== undefined && !reviewer.card.tools.includes('repo.write'));
  assert.equal(localCardRequest({ title: 'Rivedi', goal: null }, reviewer.card), 'Rivedi');
});

test('a card of an agent, its brief, its label and how it ends', () => {
  assert.ok(isAgentCard({ conversationId: null, assignee: 'designer' }));
  assert.ok(!isAgentCard({ conversationId: null, assignee: 'user' }));
  assert.ok(!isAgentCard({ conversationId: null, assignee: 'arianna' }));
  assert.ok(!isAgentCard({ conversationId: 'c', assignee: 'designer' }));
  assert.equal(cardLabel({ label: 'L1', effectiveLabel: 'L2' }), 'L2');
  assert.equal(
    cardBrief({ title: 'Grafica', goal: ' La landing. ', doneCriteria: 'Due varianti', project: 'sito' }),
    'Card: Grafica\n\nProject: sito\n\nWhat to do:\nLa landing.\n\nDone when:\nDue varianti',
  );
  assert.equal(cardBrief({ title: 'Grafica', goal: null, doneCriteria: '', project: null }), 'Card: Grafica');
  const delegation = { id: '7', status: 'ok', result: 'Scritti mockups/landing-1.html' } as never;
  assert.deepEqual(cardEnd({ assignee: 'designer' }, delegation, { kind: 'continue', usage: { steps: 3 } }), {
    kind: 'done',
    evidence: [{ kind: 'delegation', ref: '7' }],
    usage: { steps: 3 },
  });
  assert.deepEqual(cardEnd({ assignee: 'designer' }, { id: '8', status: 'failed', result: 'error: task.delegate: no folder' } as never, { kind: 'continue' }), {
    kind: 'wait-user',
    reason: 'designer could not finish the card: no folder',
  });
  // Anything else (a quota retry, a decision to wait for) stays as it is.
  const retry = { kind: 'retry' as const, at: new Date(0), reason: 'quota' };
  assert.equal(cardEnd({ assignee: 'designer' }, delegation, retry), retry);
  assert.equal(choiceOf({ kind: 'executor', state: 'approved', choice: 'codex' }), 'codex');
  assert.equal(choiceOf({ kind: 'executor', state: 'rejected', choice: null }), undefined);
  assert.equal(choiceOf({ kind: 'plan', state: 'approved', choice: 'codex' }), undefined);
});
