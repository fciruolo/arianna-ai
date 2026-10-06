import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkArt, renderSheet } from '../characters/compose.ts';
import { USER } from '../characters/art/user.ts';
import {
  agentPose,
  assignIslands,
  bubbleOf,
  officeSnapshot,
  placeKey,
  placeOfRepo,
  WANDER_MS,
  type OfficeAgent,
  type OfficeInput,
  type OfficeSnapshot,
} from '../src/lib/office/snapshot.ts';
import { emptySignals, noteActivity, notePause, type OfficeSignals } from '../src/lib/office/signals.ts';
import { runningWork, talkTarget } from '../src/lib/office/talk.ts';
import type { Conversation, RecentDelegation } from '../src/lib/types.ts';

const NOW = Date.parse('2026-10-05T03:00:00Z');
const PROJECTS = [
  { name: 'demo', path: '/repos/demo', label: 'L1' },
  { name: 'arianna-ai', path: '/repos/arianna-ai', label: 'L1' },
];

function agentOf(snapshot: OfficeSnapshot, id: string): OfficeAgent {
  const found = snapshot.agents.find((agent) => agent.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function input(change: Partial<OfficeInput> = {}): OfficeInput {
  return {
    agents: [
      { id: 'coder', state: 'idle', run: null },
      { id: 'arianna', state: 'idle', run: null },
    ],
    projects: PROJECTS,
    slots: 5,
    activity: [],
    coderConversations: [],
    pending: { total: 0, hidden: 0, coder: 0 },
    quota: {},
    now: NOW,
    ...change,
  };
}

test('islands: the approved projects in their order, the others behind the archive', () => {
  const many = Array.from({ length: 7 }, (_, index) => ({ name: `p${String(index)}`, path: `/r/p${String(index)}`, label: 'L1' }));
  const { islands, archived } = assignIslands(many, 5);
  assert.deepEqual(islands.map((item) => item.project), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(islands.map((item) => item.slot), [0, 1, 2, 3, 4]);
  assert.deepEqual(archived, ['p5', 'p6']);
  // Same projects, same order: the same islands every time.
  assert.deepEqual(assignIslands(many, 5), { islands, archived, unnamed: 0 });
});

test('islands: a name that is not a project name never reaches the office; a duplicate counts once', () => {
  const { islands, archived, unnamed } = assignIslands(
    [
      { name: 'Contratti Rossi', path: '/r/x', label: 'L1' },
      { name: 'demo', path: '/r/demo', label: 'L9' },
      { name: 'demo', path: '/r/demo2', label: 'L1' },
    ],
    5,
  );
  assert.deepEqual(islands, [{ slot: 0, project: 'demo', label: 'L2' }]);
  assert.deepEqual(archived, []);
  assert.equal(unnamed, 1);
});

test('islands: a real project named "progetto" keeps its name and its button, apart from the projects only counted', () => {
  const projects = [
    { name: 'Contratti Rossi', path: '/r/x', label: 'L1' },
    ...Array.from({ length: 5 }, (_, index) => ({ name: `p${String(index)}`, path: `/r/p${String(index)}`, label: 'L1' })),
    { name: 'progetto', path: '/r/progetto', label: 'L1' },
  ];
  const { archived, unnamed } = assignIslands(projects, 5);
  assert.deepEqual(archived, ['progetto']);
  assert.equal(unnamed, 1);
  const snapshot = officeSnapshot(input({ projects }));
  assert.deepEqual(snapshot.archived, ['progetto']);
  assert.equal(snapshot.unnamed, 1);
});

test('a repository the core names goes to its island by name, path or folder; otherwise the archive', () => {
  const { islands } = assignIslands(PROJECTS, 5);
  assert.deepEqual(placeOfRepo('demo', PROJECTS, islands), { kind: 'island', slot: 0 });
  assert.deepEqual(placeOfRepo('/repos/arianna-ai', PROJECTS, islands), { kind: 'island', slot: 1 });
  assert.deepEqual(placeOfRepo('elsewhere', PROJECTS, islands), { kind: 'archive' });
  assert.deepEqual(placeOfRepo(null, PROJECTS, islands), { kind: 'archive' });
});

test('poses from the events: activity kinds while running, then waiting, pause, free', () => {
  const line = (kind: 'read' | 'search' | 'write' | 'card' | 'tool' | 'delegate' | 'plan') => ({ conversationId: 'c', kind, at: NOW });
  assert.equal(agentPose('thinking', undefined, false, undefined, NOW), 'thinking');
  assert.equal(agentPose('working', undefined, false, undefined, NOW), 'working');
  assert.equal(agentPose('thinking', line('read'), false, undefined, NOW), 'reading');
  assert.equal(agentPose('thinking', line('search'), false, undefined, NOW), 'reading');
  for (const kind of ['write', 'card', 'tool', 'delegate'] as const) assert.equal(agentPose('working', line(kind), false, undefined, NOW), 'working', kind);
  assert.equal(agentPose('working', line('plan'), false, undefined, NOW), 'thinking');
  // Running wins over waiting and pause.
  assert.equal(agentPose('working', undefined, true, NOW + 1000, NOW), 'working');
  assert.equal(agentPose('idle', undefined, true, undefined, NOW), 'waiting');
  assert.equal(agentPose('waiting', undefined, false, undefined, NOW), 'waiting');
  assert.equal(agentPose('idle', undefined, false, NOW + 1000, NOW), 'paused');
  // A pause that has run out is over.
  assert.equal(agentPose('idle', undefined, false, NOW - 1, NOW), 'idle');
  assert.equal(agentPose('idle', undefined, false, undefined, NOW), 'idle');
});

test('the snapshot: Arianna at Privata, the Coder at the island of his repository or at the pause', () => {
  const idle = officeSnapshot(input());
  assert.deepEqual(idle.agents.map((agent) => agent.id), ['arianna', 'coder']);
  assert.deepEqual(idle.agents.find((agent) => agent.id === 'arianna')?.place, { kind: 'private' });
  assert.deepEqual(idle.agents.find((agent) => agent.id === 'coder')?.place, { kind: 'pause', seat: 0 });
  assert.equal(idle.agents.find((agent) => agent.id === 'coder')?.name, 'Coder');
  const working = officeSnapshot(
    input({
      agents: [
        { id: 'arianna', state: 'thinking', run: { executor: 'local', model: null, startedAt: '', repo: null } },
        { id: 'coder', state: 'working', run: { executor: 'claude', model: null, startedAt: '', repo: 'arianna-ai' } },
      ],
      coderConversations: ['c-coder'],
      activity: [
        { conversationId: 'c-coder', kind: 'read', at: NOW - 1000 },
        { conversationId: 'c-private', kind: 'write', at: NOW - 2000 },
        // Too old: no longer says anything.
        { conversationId: 'c-coder', kind: 'write', at: NOW - 60_000 },
      ],
    }),
  );
  const arianna = agentOf(working, 'arianna');
  const coder = agentOf(working, 'coder');
  assert.deepEqual(coder.place, { kind: 'island', slot: 1 });
  assert.equal(coder.pose, 'reading');
  assert.equal(coder.locality, 'cloud');
  assert.equal(arianna.pose, 'working');
  assert.equal(arianna.locality, 'local');
});

type Run = NonNullable<OfficeInput['agents'][number]['run']>;
const run = (repo: string | null, mode: Run['mode'] | undefined, executor = 'local'): Run => ({ executor, model: null, startedAt: '', repo, ...(mode === undefined ? {} : { mode }) });

test('Arianna works at the island of the project of her work conversation (D-124)', () => {
  const snapshot = officeSnapshot(input({ agents: [{ id: 'arianna', state: 'thinking', run: run('demo', 'work') }] }));
  assert.deepEqual(agentOf(snapshot, 'arianna').place, { kind: 'island', slot: 0 });
  // A conversation born before D-058 names a path: the same island.
  const byPath = officeSnapshot(input({ agents: [{ id: 'arianna', state: 'thinking', run: run('/repos/arianna-ai', 'work') }] }));
  assert.deepEqual(agentOf(byPath, 'arianna').place, { kind: 'island', slot: 1 });
});

test('Arianna running in a private conversation, or outside any, stays at Privata; a repository there does not move her', () => {
  for (const mode of ['private', null, undefined] as const) {
    const snapshot = officeSnapshot(input({ agents: [{ id: 'arianna', state: 'thinking', run: run('demo', mode) }] }));
    assert.deepEqual(agentOf(snapshot, 'arianna').place, { kind: 'private' }, String(mode));
  }
});

test('Arianna on a project without an island, or on work without a project, goes to the archive like the Coder', () => {
  const projects = Array.from({ length: 6 }, (_, index) => ({ name: `p${String(index)}`, path: `/r/p${String(index)}`, label: 'L1' }));
  const full = officeSnapshot(input({ projects, agents: [{ id: 'arianna', state: 'thinking', run: run('p5', 'work') }] }));
  assert.deepEqual(agentOf(full, 'arianna').place, { kind: 'archive' });
  const none = officeSnapshot(input({ agents: [{ id: 'arianna', state: 'thinking', run: run(null, 'work') }] }));
  assert.deepEqual(agentOf(none, 'arianna').place, { kind: 'archive' });
});

test('Arianna and the Coder on the same island or at the archive: the Coder keeps his chair, Arianna sits beside', () => {
  const together = officeSnapshot(
    input({
      agents: [
        { id: 'arianna', state: 'thinking', run: run('demo', 'work') },
        { id: 'coder', state: 'working', run: run('demo', 'work', 'claude') },
      ],
    }),
  );
  assert.deepEqual(agentOf(together, 'coder').place, { kind: 'island', slot: 0 });
  assert.deepEqual(agentOf(together, 'arianna').place, { kind: 'island', slot: 0, seat: 1 });
  assert.notEqual(placeKey(agentOf(together, 'coder').place), placeKey(agentOf(together, 'arianna').place));
  const archived = officeSnapshot(
    input({
      agents: [
        { id: 'arianna', state: 'thinking', run: run('elsewhere', 'work') },
        { id: 'coder', state: 'working', run: run('elsewhere', 'work', 'claude') },
      ],
    }),
  );
  assert.deepEqual(agentOf(archived, 'coder').place, { kind: 'archive' });
  assert.deepEqual(agentOf(archived, 'arianna').place, { kind: 'archive', seat: 1 });
  assert.equal(placeKey({ kind: 'island', slot: 0, seat: 1 }), 'island-0-1');
  assert.equal(placeKey({ kind: 'archive', seat: 1 }), 'archive-1');
});

test('Arianna free or waiting wanders between Privata and the pause by the clock; still with reduced motion', () => {
  const at = (now: number, state: 'idle' | 'waiting' = 'idle', still = false) =>
    agentOf(officeSnapshot(input({ now, still, agents: [{ id: 'arianna', state, run: null }, { id: 'coder', state: 'idle', run: null }] })), 'arianna').place;
  const even = Math.floor(NOW / WANDER_MS) * WANDER_MS;
  assert.equal(Math.floor(even / WANDER_MS) % 2, 0);
  assert.deepEqual(at(even), { kind: 'private' });
  assert.deepEqual(at(even + WANDER_MS - 1), { kind: 'private' });
  // The idle Coder has the first pause seat: Arianna takes the next one.
  assert.deepEqual(at(even + WANDER_MS), { kind: 'pause', seat: 1 });
  assert.deepEqual(at(even + 2 * WANDER_MS), { kind: 'private' });
  assert.deepEqual(at(even + WANDER_MS, 'waiting'), { kind: 'pause', seat: 1 });
  assert.deepEqual(at(even, 'waiting'), { kind: 'private' });
  // Same clock, same place: deterministic.
  assert.deepEqual(at(even + 3 * WANDER_MS + 5), at(even + 3 * WANDER_MS + 5));
  assert.deepEqual(at(even + WANDER_MS, 'idle', true), { kind: 'private' });
  // The Coder never moves for her.
  const coder = agentOf(officeSnapshot(input({ now: even + WANDER_MS })), 'coder');
  assert.deepEqual(coder.place, { kind: 'pause', seat: 0 });
});

test('waiting: the folder requests are the Coder\'s, the rest Arianna\'s; the total is the panel\'s', () => {
  const coderOnly = officeSnapshot(input({ pending: { total: 1, hidden: 0, coder: 1 } }));
  assert.equal(coderOnly.agents.find((agent) => agent.id === 'coder')?.pose, 'waiting');
  assert.equal(coderOnly.agents.find((agent) => agent.id === 'arianna')?.pose, 'idle');
  const both = officeSnapshot(input({ pending: { total: 3, hidden: 1, coder: 1 } }));
  assert.equal(both.agents.find((agent) => agent.id === 'arianna')?.pose, 'waiting');
  assert.deepEqual(both.decisions, { total: 3, hidden: 1 });
  const paused = officeSnapshot(input({ quota: { coder: NOW + 60_000 } }));
  assert.equal(paused.agents.find((agent) => agent.id === 'coder')?.pose, 'paused');
});

test('bubbles: "…" thinks, "!" waits, "zZ" paused, none while walking', () => {
  assert.equal(bubbleOf('thinking', false), 'dots');
  assert.equal(bubbleOf('waiting', false), 'bang');
  assert.equal(bubbleOf('paused', false), 'zz');
  assert.equal(bubbleOf('working', false), null);
  assert.equal(bubbleOf('waiting', true), null);
  assert.equal(placeKey({ kind: 'island', slot: 2 }), 'island-2');
  assert.equal(placeKey({ kind: 'pause', seat: 0 }), 'pause-0');
});

/** The closed list of the photograph (D-106): a new field fails here, and must be argued for. */
const ALLOWED: Record<string, readonly string[]> = {
  snapshot: ['agents', 'islands', 'archived', 'unnamed', 'decisions'],
  agent: ['id', 'name', 'pose', 'place', 'locality'],
  place: ['kind', 'slot', 'seat'],
  island: ['slot', 'project', 'label'],
  decisions: ['total', 'hidden'],
};
const SHORT_STRING = /^[A-Za-z0-9-]{0,40}$/;

test('privacy: the photograph has only the closed list of fields, and no free text', () => {
  const secrets = ['Fattura Rossi marzo', 'leggi kb/contratto-rossi.pdf', 'rm -rf data', 'Titolo segreto della conversazione'];
  const snapshot = officeSnapshot(
    input({
      agents: [
        { id: 'arianna', state: 'thinking', run: { executor: 'local', model: secrets[0] ?? '', startedAt: secrets[1] ?? '', repo: secrets[1] ?? '', mode: 'work' } },
        { id: 'coder', state: 'working', run: { executor: secrets[2] ?? '', model: null, startedAt: '', repo: secrets[3] ?? '' } },
      ],
      projects: [...PROJECTS, { name: secrets[0] ?? '', path: secrets[1] ?? '', label: 'L1' }],
      activity: [{ conversationId: secrets[3] ?? '', kind: 'read', at: NOW }],
      coderConversations: [secrets[3] ?? ''],
      pending: { total: 2, hidden: 1, coder: 0 },
    }),
  );
  const text = JSON.stringify(snapshot);
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);

  const check = (value: unknown, kind: string): void => {
    assert.ok(typeof value === 'object' && value !== null);
    for (const [key, field] of Object.entries(value)) {
      assert.ok(ALLOWED[kind]?.includes(key), `${kind}.${key} is not in the closed list`);
      if (typeof field === 'string') assert.match(field, SHORT_STRING, `${kind}.${key}`);
    }
  };
  check(snapshot, 'snapshot');
  check(snapshot.decisions, 'decisions');
  for (const agent of snapshot.agents) {
    check(agent, 'agent');
    check(agent.place, 'place');
  }
  for (const island of snapshot.islands) check(island, 'island');
  for (const name of snapshot.archived) assert.match(name, SHORT_STRING);
});

const conversation = (id: string, mode: 'work' | 'private', at: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  mode,
  clearance: mode === 'work' ? 'L1' : 'L2',
  effectiveLabel: mode === 'work' ? 'L1' : 'L2',
  workspace: null,
  model: null,
  agent: null,
  contextTokens: null,
  title: 'non usato',
  archivedAt: null,
  telegram: false,
  origin: 'user',
  systemReason: null,
  sourceTaskId: null,
  sourceConversationId: null,
  questionAttached: false,
  sourceTaskStatus: null,
  createdAt: at,
  lastMessageAt: at,
  pinnedAt: null,
  ...extra,
});

test('talk: the conversation the agent works on; else Arianna\'s latest private one; the free Coder a new work draft', () => {
  const list = [
    conversation('p-old', 'private', '2026-10-01T10:00:00Z'),
    conversation('p-new', 'private', '2026-10-04T10:00:00Z'),
    conversation('w-1', 'work', '2026-10-03T10:00:00Z'),
    conversation('w-run', 'work', '2026-10-02T10:00:00Z'),
    conversation('p-archived', 'private', '2026-10-05T10:00:00Z', { archivedAt: '2026-10-05T11:00:00Z' }),
    conversation('p-l3', 'private', '2026-10-05T10:00:00Z', { effectiveLabel: 'L3' }),
  ];
  const work = [{ agent: 'coder', conversationId: 'w-run', repo: 'demo' }];
  assert.deepEqual(talkTarget('coder', work, list), { kind: 'conversation', id: 'w-run' });
  // The free Coder: a new work draft (the user's choice, 2026-10-05), never the latest work conversation.
  assert.deepEqual(talkTarget('coder', [], list), { kind: 'draft', mode: 'work' });
  assert.deepEqual(talkTarget('coder', [], list, 'demo'), { kind: 'draft', mode: 'work', project: 'demo' });
  assert.deepEqual(talkTarget('arianna', work, list), { kind: 'conversation', id: 'p-new' });
  assert.deepEqual(talkTarget('arianna', [], []), { kind: 'draft', mode: 'private' });
  assert.deepEqual(talkTarget('coder', [], [], 'demo'), { kind: 'draft', mode: 'work', project: 'demo' });
  // A delegation in a conversation above L2 is never named: a new draft instead.
  assert.deepEqual(talkTarget('coder', [{ agent: 'coder', conversationId: 'p-l3', repo: null }], list), { kind: 'draft', mode: 'work' });
  // A delegation of another agent does not count for the Coder.
  assert.deepEqual(talkTarget('coder', [{ agent: 'arianna', conversationId: 'w-run', repo: null }], list), { kind: 'draft', mode: 'work' });
});

test('running work keeps who, where and which conversation, never the title', () => {
  const row: RecentDelegation = {
    id: 'd1', conversationId: 'c1', conversationTitle: 'Titolo segreto', agent: 'coder', repo: 'demo', status: 'running',
    executor: 'claude', alias: null, model: null, createdAt: '', durationMs: null, cost: null, files: null,
  };
  const done: RecentDelegation = { ...row, id: 'd2', status: 'ok' };
  const rows = runningWork([row, done]);
  assert.deepEqual(rows, [{ agent: 'coder', conversationId: 'c1', repo: 'demo' }]);
  assert.ok(!JSON.stringify(rows).includes('Titolo'));
});

test('the avatar "Tu" is a valid original sheet with every frame drawn', () => {
  assert.doesNotThrow(() => { checkArt(USER); });
  const { width, height, rgba } = renderSheet(USER);
  assert.equal(width, 112);
  assert.equal(height, 128);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 7; column++) {
      let opaque = 0;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) if ((rgba[((row * 32 + y) * width + column * 16 + x) * 4 + 3] ?? 0) > 0) opaque++;
      assert.ok(opaque > 100, `row ${String(row)} column ${String(column)}`);
    }
  }
});

test('signals: one fresh activity kind per conversation; quota pauses the agent of its run until the reset, a new run ends it', () => {
  const signals: OfficeSignals = emptySignals();
  noteActivity(signals, 'c1', 'read', NOW - 60_000);
  noteActivity(signals, 'c2', 'write', NOW);
  noteActivity(signals, 'c2', 'card', NOW);
  assert.deepEqual(signals.activity, [{ conversationId: 'c2', kind: 'card', at: NOW }]);
  notePause(signals, { kind: 'executor.rate_limit', agent: 'coder', runId: null, payload: {} }, NOW);
  assert.deepEqual(signals.quota, {});
  // The quota event of the core names only task and run: an unknown run pauses nobody.
  notePause(signals, { kind: 'executor.quota', agent: null, runId: 'r9', payload: { resetsAt: '2026-10-05T04:00:00Z' } }, NOW);
  notePause(signals, { kind: 'executor.quota', agent: null, runId: null, payload: { resetsAt: '2026-10-05T04:00:00Z' } }, NOW);
  assert.deepEqual(signals.quota, {});
  // A run seen starting: its quota pauses its agent.
  notePause(signals, { kind: 'run.started', agent: 'coder', runId: 'r1', payload: {} }, NOW);
  notePause(signals, { kind: 'run.started', agent: 'arianna', runId: 'r2', payload: {} }, NOW);
  assert.deepEqual(signals.runs, { r1: 'coder', r2: 'arianna' });
  notePause(signals, { kind: 'executor.quota', agent: null, runId: 'r1', payload: { resetsAt: '2026-10-05T04:00:00Z' } }, NOW);
  assert.deepEqual(signals.quota, { coder: Date.parse('2026-10-05T04:00:00Z') });
  notePause(signals, { kind: 'executor.quota', agent: null, runId: 'r2', payload: { resetsAt: null } }, NOW);
  assert.deepEqual(signals.quota, { coder: Date.parse('2026-10-05T04:00:00Z'), arianna: NOW + 60 * 60 * 1000 });
  notePause(signals, { kind: 'run.started', agent: 'coder', runId: 'r3', payload: {} }, NOW);
  assert.deepEqual(Object.keys(signals.quota), ['arianna']);
  // The runs remembered stay few.
  for (let index = 0; index < 80; index++) notePause(signals, { kind: 'run.started', agent: 'coder', runId: `x${String(index)}`, payload: {} }, NOW);
  assert.equal(Object.keys(signals.runs).length, 50);
  assert.deepEqual(Object.entries(signals.runs).at(-1), ['x79', 'coder']);
});

test('signals: names from the prototype of an object are not runs nor pauses', () => {
  const signals: OfficeSignals = emptySignals();
  // An unknown run named like a property of every object: nobody is paused.
  notePause(signals, { kind: 'executor.quota', agent: null, runId: 'constructor', payload: { resetsAt: null } }, NOW);
  notePause(signals, { kind: 'executor.quota', agent: null, runId: 'toString', payload: { resetsAt: null } }, NOW);
  assert.deepEqual(signals.quota, {});
  // A run of an agent named like one: the pause list is not touched.
  const before = signals.quota;
  notePause(signals, { kind: 'run.started', agent: 'constructor', runId: 'r1', payload: {} }, NOW);
  assert.equal(signals.quota, before);
  // Then its quota pauses that agent, and only it.
  notePause(signals, { kind: 'executor.quota', agent: null, runId: 'r1', payload: { resetsAt: null } }, NOW);
  assert.deepEqual(signals.quota, { constructor: NOW + 60 * 60 * 1000 });
});

test('an agent the chat does not know is named "Agente", never by its id', () => {
  const sentinel = 'fattura-rossi-segreta';
  const snapshot = officeSnapshot(input({ agents: [{ id: 'arianna', state: 'idle', run: null }, { id: sentinel, state: 'idle', run: null }] }));
  const unknown = agentOf(snapshot, sentinel);
  assert.equal(unknown.name, 'Agente');
  assert.ok(!unknown.name.includes(sentinel));
  assert.equal(agentOf(snapshot, 'arianna').name, 'Arianna');
  // Nor a name from the prototype of an object.
  const odd = officeSnapshot(input({ agents: [{ id: 'constructor', state: 'idle', run: null }] }));
  assert.equal(agentOf(odd, 'constructor').name, 'Agente');
});
