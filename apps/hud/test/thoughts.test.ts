import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_NOTE_BYTES } from '../src/lib/capture.ts';
import { THOUGHT_EMPTY_TEXT, THOUGHT_TOO_LARGE_TEXT } from '../src/lib/italian.ts';
import {
  displayTitle,
  filterThoughts,
  graphId,
  groupThoughts,
  kindText,
  noteDate,
  noteName,
  POLL_LIMIT_MS,
  shouldPoll,
  sizeCounter,
  STUCK_AFTER_MS,
  thoughtCapture,
  thoughtState,
  wikilinkTarget,
  type NoteSummary,
} from '../src/lib/thoughts.ts';

function note(name: string, fields: Partial<NoteSummary> = {}): NoteSummary {
  return {
    path: `kb/inbox/${name}`,
    name,
    title: null,
    capturedAt: null,
    status: 'new',
    kind: 'thought',
    capturedKind: null,
    label: 'L2',
    tags: [],
    ...fields,
  };
}

const NOW = new Date(2026, 9, 5, 10, 0).getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

test('state: organized, organizing while recent, stuck after a while or when the queue refused it', () => {
  assert.equal(thoughtState(note('a.md', { status: 'organized' }), NOW), 'organized');
  assert.equal(thoughtState(note('a.md', { capturedAt: minutesAgo(1) }), NOW), 'organizing');
  assert.equal(thoughtState(note('a.md', { capturedAt: minutesAgo(STUCK_AFTER_MS / 60_000 + 1) }), NOW), 'stuck');
  assert.equal(thoughtState(note('a.md', { capturedAt: minutesAgo(1) }), NOW, { failed: true }), 'stuck');
  // Queued again just now: organizing again.
  assert.equal(thoughtState(note('a.md', { capturedAt: minutesAgo(60) }), NOW, { queuedAt: NOW - 1000 }), 'organizing');
});

test('the date of a note: its header, or the start of its name', () => {
  assert.equal(noteDate(note('x.md', { capturedAt: '2026-10-05T08:12:44+02:00' })), '2026-10-05T08:12:44+02:00');
  assert.equal(noteDate(note('2026-10-05-081244-pane.md')), new Date(2026, 9, 5, 8, 12, 44).toISOString());
  assert.equal(noteDate(note('pane.md')), null);
});

test('grouped by day, newest first, as the conversations', () => {
  const groups = groupThoughts(
    [note('a.md', { capturedAt: minutesAgo(5) }), note('b.md', { capturedAt: minutesAgo(60 * 24) }), note('c.md', { capturedAt: minutesAgo(60 * 24 * 30) }), note('d.md')],
    new Date(NOW),
  );
  assert.deepEqual(
    groups.map((group) => [group.title, group.items.map((item) => item.name)]),
    [
      ['Oggi', ['a.md']],
      ['Ieri', ['b.md']],
      ['Prima', ['c.md', 'd.md']],
    ],
  );
});

test('filter by text, tag and status', () => {
  const notes = [
    note('1.md', { title: 'Comprare il caffè', status: 'organized', kind: 'promemoria', tags: ['spesa'] }),
    note('2.md', { title: 'Idea per il giardino', kind: 'thought' }),
  ];
  assert.deepEqual(filterThoughts(notes, 'caffe', 'all').map((item) => item.name), ['1.md']);
  assert.deepEqual(filterThoughts(notes, '#spesa', 'all').map((item) => item.name), ['1.md']);
  assert.deepEqual(filterThoughts(notes, 'promemoria', 'all').map((item) => item.name), ['1.md']);
  assert.deepEqual(filterThoughts(notes, '', 'new').map((item) => item.name), ['2.md']);
  assert.deepEqual(filterThoughts(notes, '', 'organized').map((item) => item.name), ['1.md']);
  assert.deepEqual(filterThoughts(notes, 'giardino', 'organized'), []);
});

test('title and kind to show', () => {
  assert.equal(displayTitle(note('2026-10-05-081244-comprare-il-pane.md', { title: '  ' })), 'comprare il pane');
  assert.equal(displayTitle(note('x.md', { title: 'Pane' })), 'Pane');
  assert.equal(kindText(note('x.md', { kind: 'promemoria' })), 'Promemoria');
  assert.equal(kindText(note('x.md', { kind: null })), 'Nota');
  assert.equal(kindText(note('x.md', { kind: 'altro' })), 'altro');
});

test('reload while a thought is organizing, never past the time cap', () => {
  const organizing = [note('a.md', { capturedAt: minutesAgo(1) })];
  const done = [note('a.md', { status: 'organized' })];
  assert.equal(shouldPoll(organizing, NOW - 1000, NOW), true);
  assert.equal(shouldPoll(done, NOW - 1000, NOW), false);
  assert.equal(shouldPoll(organizing, null, NOW), false);
  assert.equal(shouldPoll(organizing, NOW - POLL_LIMIT_MS, NOW), false);
  assert.equal(shouldPoll([note('a.md', { capturedAt: minutesAgo(1) })], NOW - 1000, NOW, { 'a.md': { failed: true } }), false);
});

test('the capture of a thought: kind thought, a title from the first line; empty or too large refused in Italian', () => {
  assert.deepEqual(thoughtCapture('Comprare il pane\ne il latte'), { capture: { text: 'Comprare il pane\ne il latte', kind: 'thought', title: 'Comprare il pane' } });
  assert.deepEqual(thoughtCapture('  \n '), { error: THOUGHT_EMPTY_TEXT });
  assert.deepEqual(thoughtCapture('a'.repeat(MAX_NOTE_BYTES + 1)), { error: THOUGHT_TOO_LARGE_TEXT });
  assert.ok('capture' in thoughtCapture('a'.repeat(MAX_NOTE_BYTES)));
});

test('the size counter shows only past a quarter of the limit', () => {
  assert.equal(sizeCounter('breve'), undefined);
  assert.equal(sizeCounter('a'.repeat(32 * 1024)), '32,0 / 64 KiB');
});

test('wikilinks: a thought of the inbox opens here, any other page in the graph', () => {
  assert.deepEqual(wikilinkTarget('inbox/2026-10-05-081244-pane'), { note: '2026-10-05-081244-pane.md' });
  assert.deepEqual(wikilinkTarget('kb/inbox/x.md|alias'), { note: 'x.md' });
  assert.deepEqual(wikilinkTarget('public/ricette'), { graph: 'public/ricette.md' });
  assert.equal(wikilinkTarget('../segreto'), undefined);
  assert.equal(wikilinkTarget('  '), undefined);
});

test('names and graph ids of a note path', () => {
  assert.equal(noteName('kb/inbox/x.md'), 'x.md');
  assert.equal(graphId('kb/inbox/x.md'), 'inbox/x.md');
});
