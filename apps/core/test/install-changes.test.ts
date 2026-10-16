// «Cosa è cambiato» (D-233): the picture of the installation, the comparison,
// the label of the event, what the page reads and the route. No database: a
// stand-in records the SQL and the events written.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import type { Queryable, Sql } from '../src/db/client.ts';
import {
  BASELINE_EVENT,
  CHANGED_EVENT,
  changesLabel,
  cleanArea,
  cloudModelAreas,
  createChangeWatcher,
  diffStates,
  loadChanges,
  mergeState,
  modelsArea,
  parseChanges,
  parseState,
  readAreas,
  shortCommit,
  sourcesArea,
  type StateAreas,
  type StateSources,
} from '../src/install-changes.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const base = resolve('data/test-tmp');
mkdirSync(base, { recursive: true });

const NOW = new Date('2026-10-16T10:00:00.000Z');

test('only ids and values made of letters, digits and a few signs pass: never a text, a path or a space', () => {
  assert.deepEqual(
    cleanArea({
      orchestrator: 'qwen3.8-27b-4bit',
      'nexu-io/open-design': 'abc1234',
      sonnet: 'claude-sonnet-5-5',
      'with space': 'x',
      path: '/progetti/segreti',
      note: 'Fattura di Mario Rossi',
      empty: '',
      number: 3 as unknown as string,
    }),
    { 'nexu-io/open-design': 'abc1234', orchestrator: 'qwen3.8-27b-4bit', sonnet: 'claude-sonnet-5-5' },
  );
  assert.deepEqual(cleanArea(undefined), {});
});

test('the comparison names what appeared, what went away and what changed, area by area', () => {
  const before = mergeState(undefined, { role: { orchestrator: 'qwen-a', extractor: 'qwen-s' }, executor: { claude: 'on' }, model: { 'qwen-a': 'on-disk' } }, NOW);
  const after = mergeState(before, { role: { orchestrator: 'qwen-b', extractor: 'qwen-s' }, executor: { codex: 'on' }, model: { 'qwen-a': 'on-disk', 'qwen-b': 'in-catalog' } }, NOW);
  assert.deepEqual(diffStates(before, after), [
    { area: 'role', id: 'orchestrator', from: 'qwen-a', to: 'qwen-b' },
    { area: 'model', id: 'qwen-b', from: null, to: 'in-catalog' },
    { area: 'executor', id: 'claude', from: 'on', to: null },
    { area: 'executor', id: 'codex', from: null, to: 'on' },
  ]);
  assert.deepEqual(diffStates(after, after), []);
});

test('an area that could not be read keeps its last picture: nothing looks removed', () => {
  const before = mergeState(undefined, { project: { demo: 'L1' }, theme: { theme: 'base' } }, NOW);
  const after = mergeState(before, { theme: { theme: 'halloween' } }, NOW);
  assert.deepEqual(after.areas.project, { demo: 'L1' });
  assert.deepEqual(diffStates(before, after), [{ area: 'theme', id: 'theme', from: 'base', to: 'halloween' }]);
});

test('an area read for the first time fills the picture without looking added; from then on it is compared', () => {
  const first = mergeState(undefined, { theme: { theme: 'base' } }, NOW);
  assert.ok(first.unread.includes('skills'));
  const second = mergeState(first, { theme: { theme: 'base' }, skills: { 'anthropics/skills': 'aaaaaaa' } }, NOW);
  assert.deepEqual(diffStates(first, second), []);
  assert.equal(second.unread.includes('skills'), false);
  const third = mergeState(second, { skills: { 'anthropics/skills': 'bbbbbbb' } }, NOW);
  assert.deepEqual(diffStates(second, third), [{ area: 'skills', id: 'anthropics/skills', from: 'aaaaaaa', to: 'bbbbbbb' }]);
});

test('names the user chose make the event L1; models, versions and catalogs alone are L0', () => {
  assert.equal(changesLabel([{ area: 'model', id: 'm', from: null, to: 'on-disk' }]), 'L0');
  assert.equal(changesLabel([{ area: 'binary', id: 'claude', from: '2.1.1', to: '2.1.2' }, { area: 'project', id: 'demo', from: null, to: 'L1' }]), 'L1');
  assert.equal(changesLabel([{ area: 'agent', id: 'revisore', from: 'disabled', to: 'active' }]), 'L1');
  assert.equal(changesLabel([{ area: 'character', id: 'coder', from: null, to: 'serie/x' }]), 'L1');
});

test('the saved picture is checked again: another shape is refused, unsafe entries are left out', () => {
  assert.equal(parseState(null), undefined);
  assert.equal(parseState({ version: 2, observedAt: 'x', areas: {} }), undefined);
  const state = parseState({ version: 1, observedAt: NOW.toISOString(), areas: { role: { orchestrator: 'qwen', bad: 'a b' }, unknown: { a: 'b' } } });
  assert.ok(state !== undefined);
  assert.deepEqual(state.areas.role, { orchestrator: 'qwen' });
  assert.equal(Object.hasOwn(state.areas, 'unknown'), false);
});

test('the helpers: models on disk, catalog commits, cloud models, short commits', () => {
  assert.deepEqual(
    modelsArea(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        { model: 'a', state: 'present' },
        { model: 'a', state: 'ok' },
        { model: 'b', state: 'present' },
        { model: 'b', state: 'partial' },
      ],
    ),
    { a: 'on-disk', b: 'in-catalog', c: 'in-catalog' },
  );
  assert.deepEqual(sourcesArea([{ id: 'anthropics/skills', adopted: { commit: 'a'.repeat(40) } }, { id: 'x/y', adopted: null }]), { 'anthropics/skills': 'aaaaaaa', 'x/y': '-' });
  assert.deepEqual(cloudModelAreas({ opus: { enabled: true, name: 'claude-opus-5-5' }, sonnet: { enabled: false } }), { on: { opus: 'on', sonnet: 'off' }, names: { opus: 'claude-opus-5-5' } });
  assert.equal(shortCommit('not a commit'), '-');
  assert.equal(shortCommit(undefined), '-');
});

test('a source that throws leaves its area out, and says which', async () => {
  const errors: string[] = [];
  const sources = Object.fromEntries(
    ['arianna', 'role', 'model', 'executor', 'cloud-model', 'cloud-name', 'binary', 'skills', 'design', 'agents-catalog', 'agent', 'project', 'theme', 'character'].map((area) => [area, () => ({})]),
  ) as unknown as StateSources;
  sources.role = () => ({ orchestrator: 'qwen' });
  sources.model = () => Promise.reject(new Error('catalog unreadable'));
  const areas = await readAreas(sources, (area) => errors.push(area));
  assert.deepEqual(areas.role, { orchestrator: 'qwen' });
  assert.equal(Object.hasOwn(areas, 'model'), false);
  assert.deepEqual(errors, ['model']);
});

/** A stand-in of postgres.js: records every query, and the events written. */
function fakeSql(answers: Record<string, unknown[]> = {}): { sql: Queryable; queries: string[]; events: { kind: string; label: string; payload: unknown }[] } {
  const queries: string[] = [];
  const events: { kind: string; label: string; payload: unknown }[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$');
    queries.push(text);
    if (text.includes('INSERT INTO events')) {
      events.push({ kind: values[3] as string, label: values[4] as string, payload: values[5] });
      return Promise.resolve([{ id: String(events.length), ts: NOW, taskId: null, runId: null, agent: null, kind: values[3], label: values[4], payload: values[5], prevHash: null, hash: '' }]);
    }
    const key = Object.keys(answers).find((name) => text.includes(name));
    return Promise.resolve(key === undefined ? [] : answers[key]);
  };
  const sql = Object.assign(tag, { json: (value: unknown) => value, unsafe: (text: string) => tag(Object.assign([text], { raw: [text] })) });
  return { sql: sql as unknown as Queryable, queries, events };
}

test('the watcher: the first picture is only the start, then each difference is one event, and the picture moves on', async (t) => {
  const dir = mkdtempSync(join(base, 'changes-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'changes', 'state.json');
  const { sql, events } = fakeSql();
  let fresh: StateAreas = { role: { orchestrator: 'qwen-a' }, project: { demo: 'L1' } };
  const watcher = createChangeWatcher({ sql, file, read: () => Promise.resolve(fresh), onError: (error) => assert.fail(String(error)), now: () => NOW });

  assert.equal(await watcher.check(), 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    [BASELINE_EVENT],
  );
  assert.equal(await watcher.check(), 0);
  assert.equal(events.length, 1);

  fresh = { role: { orchestrator: 'qwen-b' }, project: { demo: 'L1' } };
  assert.equal(await watcher.check(), 1);
  assert.equal(events[1]?.kind, CHANGED_EVENT);
  assert.equal(events[1].label, 'L0');
  assert.deepEqual(events[1].payload, { changes: [{ area: 'role', id: 'orchestrator', from: 'qwen-a', to: 'qwen-b' }] });
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { areas: { role: unknown } }).areas.role, { orchestrator: 'qwen-b' });

  fresh = { project: { demo: 'L0', altro: 'L1' } };
  assert.equal(await watcher.check(), 2);
  assert.equal(events[2]?.label, 'L1');
});

test('the watcher: a failed event leaves the picture as it was, so the next check writes it again', async (t) => {
  const dir = mkdtempSync(join(base, 'changes-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(mergeState(undefined, { theme: { theme: 'base' } }, NOW)));
  const failing = Object.assign(() => Promise.reject(new Error('database down')), { json: (value: unknown) => value }) as unknown as Queryable;
  const errors: unknown[] = [];
  const watcher = createChangeWatcher({ sql: failing, file, read: () => Promise.resolve({ theme: { theme: 'natale' } }), onError: (error) => errors.push(error), now: () => NOW });
  assert.equal(await watcher.check(), 0);
  assert.equal(errors.length, 1);
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { areas: { theme: unknown } }).areas.theme, { theme: 'base' });
});

test('the watcher: an unreadable picture is said and starts the observation again', async (t) => {
  const dir = mkdtempSync(join(base, 'changes-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'state.json');
  writeFileSync(file, '{ not json');
  const { sql, events } = fakeSql();
  const errors: unknown[] = [];
  const watcher = createChangeWatcher({ sql, file, read: () => Promise.resolve({ theme: { theme: 'base' } }), onError: (error) => errors.push(error), now: () => NOW });
  assert.equal(await watcher.check(), 0);
  assert.equal(errors.length, 1);
  assert.deepEqual(events, [{ kind: BASELINE_EVENT, label: 'L0', payload: { reset: true } }]);
});

test('checks asked while one runs share the next one', async (t) => {
  const dir = mkdtempSync(join(base, 'changes-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const { sql } = fakeSql();
  let reads = 0;
  const watcher = createChangeWatcher({
    sql,
    file: join(dir, 'state.json'),
    read: async () => {
      reads += 1;
      await new Promise((done) => setTimeout(done, 10));
      return {};
    },
    onError: (error) => assert.fail(String(error)),
  });
  await Promise.all([watcher.check(), watcher.check(), watcher.check(), watcher.check()]);
  assert.equal(reads, 2);
});

test('the events read back are checked again; the page reads only the events of «Cosa è cambiato»', async () => {
  assert.deepEqual(
    parseChanges({
      changes: [
        { area: 'model', id: 'qwen', from: null, to: 'on-disk' },
        { area: 'nope', id: 'x', from: null, to: 'y' },
        { area: 'project', id: 'a b', from: null, to: 'L1' },
        { area: 'theme', id: 'theme', from: 'base', to: 'una frase lunga' },
      ],
      more: 3,
    }),
    { changes: [{ area: 'model', id: 'qwen', from: null, to: 'on-disk' }], more: 3 },
  );
  const { sql, queries } = fakeSql({
    'payload FROM events': [
      { id: '9', ts: NOW, payload: { changes: [{ area: 'arianna', id: 'arianna', from: '0.120.0', to: '0.121.0' }] } },
      { id: '7', ts: NOW, payload: { changes: [] } },
    ],
    'ORDER BY id DESC LIMIT 1': [{ ts: new Date('2026-10-01T08:00:00.000Z') }],
  });
  const report = await loadChanges(sql);
  assert.equal(report.since, '2026-10-01T08:00:00.000Z');
  assert.deepEqual(
    report.entries.map((entry) => entry.id),
    ['9'],
  );
  assert.equal(report.truncated, false);
  const all = queries.join('\n');
  assert.doesNotMatch(all, /FROM (messages|conversations|tasks|notes)\b/);
  for (const query of queries) assert.match(query, /FROM events WHERE kind = \$/);
});

function get(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((done, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        done({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('GET /api/changes: 404 without the watcher; with it a fresh picture first, then the log', async (t) => {
  const { sql } = fakeSql();
  const without = await startApiServer({ sql: sql as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await without.close();
  });
  assert.equal((await get(without.port, '/api/changes')).status, 404);

  let checks = 0;
  const server = await startApiServer({
    sql: sql as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    changes: {
      check: () => {
        checks += 1;
        return Promise.resolve(0);
      },
    },
  });
  t.after(async () => {
    await server.close();
  });
  const answer = await get(server.port, '/api/changes');
  assert.equal(answer.status, 200);
  assert.equal(checks, 1);
  assert.deepEqual(answer.body, { since: null, entries: [], truncated: false });
});
