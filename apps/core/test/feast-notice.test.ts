import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import { answerNotice, feastNotice, feastNoticeStore, type FeastNoticeState } from '../src/feast-notice.ts';
import { isoDay, windowOf } from '../src/feasts.ts';
import type { LiveFeed } from '../src/live.ts';
import { characterChoiceOf } from '../src/prompt-tail.ts';
import { startApiServer } from '../src/server/http.ts';
import { currentTheme, currentThemeSync, listThemes, periodOf, type FeastsNow } from '../src/themes.ts';

const HOME = resolveHome({});
const REPO_THEMES = join(HOME, 'apps', 'hud', 'themes');
const ORIGINAL = join(HOME, 'apps', 'hud', 'characters', 'originali');
const SERIES = join(HOME, 'apps', 'hud', 'characters', 'serie');
// The answers of the made-up user, in data/test-tmp (never in git).
const root = join(HOME, 'data', 'test-tmp', randomUUID());

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const day = (text: string) => {
  const [year = 0, month = 0, date = 0] = text.split('-').map(Number);
  return { year, month, day: date };
};

test('the window of a feast that holds a day, across the new year and from Easter (D-315)', () => {
  const span = (dates: Parameters<typeof windowOf>[0], text: string) => {
    const window = windowOf(dates, day(text));
    return window === undefined ? undefined : [isoDay(window.from), isoDay(window.to)];
  };
  assert.deepEqual(span({ from: '10-25', to: '11-01' }, '2026-10-25'), ['2026-10-25', '2026-11-01']);
  assert.deepEqual(span({ from: '10-25', to: '11-01' }, '2026-11-01'), ['2026-10-25', '2026-11-01']);
  assert.equal(span({ from: '10-25', to: '11-01' }, '2026-10-24'), undefined);
  // Christmas: from December, and in January the window began the year before.
  assert.deepEqual(span({ from: '12-08', to: '01-06' }, '2026-12-08'), ['2026-12-08', '2027-01-06']);
  assert.deepEqual(span({ from: '12-08', to: '01-06' }, '2027-01-03'), ['2026-12-08', '2027-01-06']);
  // Easter 2026 on 5 April: Palm Sunday to Easter Monday.
  assert.deepEqual(span({ feast: 'pasqua' }, '2026-04-01'), ['2026-03-29', '2026-04-06']);
  assert.equal(span({ feast: 'pasqua' }, '2026-04-07'), undefined);
});

test('the notice of an automatic change of theme: once, until answered (D-315)', async () => {
  const { themes } = await listThemes(REPO_THEMES);
  const halloween = { on: true, today: day('2026-10-25') };
  const past = { on: true, today: day('2026-11-02') };
  const start = { kind: 'start', key: 'halloween@2026-10-25', theme: 'halloween', until: '2026-11-01' };

  // Halloween begins on Base with the feasts on: the start, with its last day.
  assert.deepEqual(feastNotice('base', themes, halloween, {}), start);
  assert.deepEqual(feastNotice('base', themes, { on: true, today: day('2026-10-31') }, {}), start);
  // «Va bene»: not again in the same period.
  const ok = answerNotice(start as never, 'ok', {});
  assert.deepEqual(ok, { seen: 'halloween@2026-10-25' });
  assert.equal(feastNotice('base', themes, halloween, ok), null);
  assert.equal(currentTheme('base', themes, { ...halloween, ...ok }), 'halloween');
  // At its end, once: back to Base; then nothing.
  assert.deepEqual(feastNotice('base', themes, past, ok), { kind: 'end', key: 'base', theme: 'halloween' });
  const ended = answerNotice({ kind: 'end', key: 'base', theme: 'halloween' }, 'ok', ok);
  assert.equal(feastNotice('base', themes, past, ended), null);

  // No feast, no notice; feasts off or a theme chosen by hand: never.
  assert.equal(feastNotice('base', themes, { on: true, today: day('2026-10-16') }, {}), null);
  assert.equal(feastNotice('base', themes, { ...halloween, on: false }, {}), null);
  assert.equal(feastNotice('corsia', themes, halloween, {}), null);
  assert.equal(feastNotice('halloween', themes, halloween, {}), null);
  assert.equal(feastNotice('corsia', themes, past, ok), null);
});

test('«Torna a Base» keeps Base for that period only, in the chat and in the prompt (D-315)', async () => {
  const { themes } = await listThemes(REPO_THEMES);
  const halloween = { on: true, today: day('2026-10-26') };
  const start = feastNotice('base', themes, halloween, {});
  assert.ok(start !== null);
  const back: FeastNoticeState = answerNotice(start, 'back', {});
  assert.deepEqual(back, { seen: 'base', skip: 'halloween@2026-10-25' });
  // The rest of Halloween: Base, no notice, at every check.
  for (const text of ['2026-10-26', '2026-10-31', '2026-11-01']) {
    const now: FeastsNow = { on: true, today: day(text), skip: 'halloween@2026-10-25' };
    assert.equal(currentTheme('base', themes, now), 'base', text);
    assert.equal(currentThemeSync(REPO_THEMES, 'base', now), 'base', text);
    assert.equal(feastNotice('base', themes, now, back), null, text);
  }
  // Its end says nothing: it was never on screen.
  assert.equal(feastNotice('base', themes, { on: true, today: day('2026-11-02') }, back), null);
  // The next feast counts again, and Halloween next year too.
  assert.equal(feastNotice('base', themes, { on: true, today: day('2026-12-08') }, back)?.key, 'natale@2026-12-08');
  assert.equal(currentTheme('base', themes, { on: true, today: day('2027-10-25'), skip: 'halloween@2026-10-25' }), 'halloween');
  // A theme chosen by hand is never touched, Halloween chosen by hand included.
  assert.equal(currentTheme('halloween', themes, { ...halloween, skip: 'halloween@2026-10-25' }), 'halloween');
  // «Torna a» exists only at the start.
  assert.throws(() => answerNotice({ kind: 'end', key: 'base', theme: 'halloween' }, 'back', {}), /only the start/);
  // The prompt of a step dresses the agents as the chat does.
  const config = (skip: string | undefined) => ({ personas: {}, characters: {}, appearance: { theme: 'base', seasonal: true }, home: HOME, paths: { data: root }, today: () => day('2026-10-28'), feastSkip: () => skip });
  assert.equal(characterChoiceOf(config(undefined), 'arianna'), 'originali/arianna-halloween');
  assert.equal(characterChoiceOf(config('halloween@2026-10-25'), 'arianna'), 'originali/arianna');
  const base = themes.find((theme) => theme.id === 'base');
  assert.ok(base !== undefined);
  assert.equal(periodOf(base, day('2026-10-28')), undefined);
});

test('the store of the answers: a missing or broken file is no answer, a bad key is dropped (D-315)', () => {
  const data = join(root, 'store');
  const store = feastNoticeStore(data);
  assert.deepEqual(store.read(), {});
  store.write({ seen: 'base', skip: 'halloween@2026-10-25' });
  assert.deepEqual(store.read(), { seen: 'base', skip: 'halloween@2026-10-25' });
  writeFileSync(join(data, 'themes', 'notice.json'), '{not json');
  assert.deepEqual(store.read(), {});
  writeFileSync(join(data, 'themes', 'notice.json'), JSON.stringify({ seen: '../x', skip: 'base' }));
  assert.deepEqual(store.read(), {});
  writeFileSync(join(data, 'themes', 'notice.json'), 'x'.repeat(2000));
  assert.deepEqual(store.read(), {});
});

test('GET /api/themes carries the notice, POST /api/themes/notice answers it for every device (D-315)', async () => {
  const data = join(root, 'server');
  mkdirSync(data, { recursive: true });
  const notices = feastNoticeStore(data);
  let chosen = 'base';
  let feasts = { on: true, today: day('2026-10-25') };
  const server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    agents: () => ['arianna', 'coder'],
    characters: {
      dirs: { original: ORIGINAL, series: SERIES, data: join(root, 'no-characters') },
      choices: () => ({}),
      themes: { dir: REPO_THEMES, chosen: () => chosen, feasts: () => feasts, notice: notices },
    },
  });
  type Listing = { current: string; notice: { kind: string; key: string } | null };
  const origin = `http://127.0.0.1:${String(server.port)}`;
  // Two devices: each reads the same core.
  const read = async () => (await (await fetch(`${origin}/api/themes`)).json()) as Listing;
  const answer = (key: unknown, value: unknown, extra: Record<string, unknown> = {}) =>
    fetch(`${origin}/api/themes/notice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, answer: value, ...extra }) });
  try {
    const mac = await read();
    assert.deepEqual([mac.current, mac.notice?.key], ['halloween', 'halloween@2026-10-25']);
    // Shown on the first device until answered: the phone sees it too.
    assert.equal((await read()).notice?.key, 'halloween@2026-10-25');
    // Wrong answers change nothing.
    assert.equal((await answer('halloween@2026-10-25', 'maybe')).status, 400);
    assert.equal((await answer('natale@2026-12-08', 'ok')).status, 409);
    assert.equal((await answer('halloween@2026-10-25', 'ok', { theme: 'x' })).status, 400);
    assert.deepEqual(notices.read(), {});
    // «Torna a Base» on the Mac: Base, and the phone gets no notice.
    assert.equal((await answer('halloween@2026-10-25', 'back')).status, 200);
    const phone = await read();
    assert.deepEqual([phone.current, phone.notice], ['base', null]);
    const characters = (await (await fetch(`${origin}/api/characters`)).json()) as { agents: Record<string, { character: string }> };
    assert.equal(characters.agents.arianna?.character, 'arianna');
    // The same answer from the phone, late: 409, the page reloads.
    assert.equal((await answer('halloween@2026-10-25', 'ok')).status, 409);
    // Feasts off: no notice at Christmas.
    feasts = { on: false, today: day('2026-12-10') };
    assert.equal((await read()).notice, null);
    feasts = { on: true, today: day('2026-12-10') };
    assert.equal((await read()).notice?.key, 'natale@2026-12-08');
    chosen = 'corsia';
    assert.equal((await read()).notice, null);
  } finally {
    await server.close();
  }
});
