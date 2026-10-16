import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { characterChoiceOf } from '../src/prompt-tail.ts';
import { currentTheme, currentThemeSync, feastOf, listThemes, MAX_THEME_BYTES, parseTheme, THEME_TOKENS, ThemeError } from '../src/themes.ts';
import { THEME_TOKENS as PAGE_TOKENS } from '../../hud/src/lib/themes.ts';

const HOME = resolveHome({});
const REPO_THEMES = join(HOME, 'apps', 'hud', 'themes');
const ORIGINAL = join(HOME, 'apps', 'hud', 'characters', 'originali');
const SERIES = join(HOME, 'apps', 'hud', 'characters', 'serie');
// Made-up themes, in data/ (never in git).
const root = join(HOME, 'data', 'test-tmp', randomUUID());

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const VALID = {
  id: 'prova',
  name: 'Prova',
  kind: 'serie',
  background: { pattern: 'griglia', decor: 'corrimano' },
  hud: { corners: true, glow: 'medio', radius: 'hud' },
  characters: { arianna: 'originali/arianna-corsia' },
  tokens: { dark: { bg: '#0b1517', glow: '#5fd0b533' }, light: {} },
};
const json = (value: unknown) => JSON.stringify(value);
const variant = (change: Record<string, unknown>) => json({ ...VALID, ...change });

test('the core and the page apply the same list of tokens (D-103)', () => {
  assert.deepEqual([...THEME_TOKENS], [...PAGE_TOKENS]);
});

test('the themes of the repository pass the schema (D-103)', async () => {
  const listing = await listThemes(REPO_THEMES);
  assert.deepEqual(listing.refused, []);
  assert.deepEqual(listing.themes.map((theme) => theme.id), ['base', 'carnevale', 'corsia', 'estate', 'fox-river', 'halloween', 'langley', 'natale', 'pasadena', 'pasqua', 'planet-express', 'quahog', 'san-patrizio', 'springfield', 'ufficio']);
  // Base (D-246) and the six feasts, the others of the series.
  const kind = (id: string) => listing.themes.find((theme) => theme.id === id)?.kind;
  assert.equal(kind('base'), 'base');
  for (const id of ['natale', 'san-patrizio', 'halloween', 'carnevale', 'estate', 'pasqua']) assert.equal(kind(id), 'stagionale', id);
  assert.equal(listing.themes.filter((theme) => theme.kind === 'serie').length, 8);
});

test('a valid theme is read with every field, and optional ones left out', () => {
  const theme = parseTheme(json(VALID), 'prova');
  assert.deepEqual(theme, { ...VALID, kind: 'serie' });
  const seasonal = parseTheme(variant({ kind: 'stagionale', dates: { from: '12-08', to: '01-06' }, characters: undefined, description: 'Neve' }), 'prova');
  assert.deepEqual(seasonal.dates, { from: '12-08', to: '01-06' });
  assert.deepEqual(seasonal.characters, {});
  assert.equal(seasonal.description, 'Neve');
  assert.deepEqual(parseTheme(variant({ kind: 'stagionale', dates: { feast: 'pasqua' } }), 'prova').dates, { feast: 'pasqua' });
  // A colour with alpha, as the glow of VALID, passes.
  assert.equal(theme.tokens.dark.glow, '#5fd0b533');
  assert.equal(Object.keys(parseTheme(variant({ characters: Object.fromEntries([...Array(16).keys()].map((index) => [`agente-${String(index)}`, 'originali/coder'])) }), 'prova').characters).length, 16);
});

test('every rule of the schema refuses what breaks it (D-103)', () => {
  const bad: [string, string, RegExp][] = [
    ['not json', '{', /not valid JSON/],
    ['unknown key', variant({ css: 'body{}' }), /unknown key "css"/],
    ['id of another folder', variant({ id: 'altro' }), /name of the folder/],
    ['id with capitals', variant({ id: 'Prova' }), /lowercase/],
    ['base of another kind', variant({ id: 'base' }), /base alone/],
    ['another theme of kind base', variant({ kind: 'base' }), /base alone/],
    ['a seasonal theme with no days', variant({ kind: 'stagionale' }), /has its days/],
    ['kind outside the list', variant({ kind: 'parodia' }), /kind: one of/],
    ['dates on a series', variant({ dates: { from: '12-08', to: '01-06' } }), /only a seasonal/],
    ['no such day', variant({ kind: 'stagionale', dates: { from: '02-30', to: '03-01' } }), /no such day/],
    ['day in the wrong form', variant({ kind: 'stagionale', dates: { from: '12-8', to: '01-06' } }), /MM-DD/],
    ['feast outside the list', variant({ kind: 'stagionale', dates: { feast: 'ferragosto' } }), /feast: one of/],
    ['pattern outside the list', variant({ background: { pattern: 'url(x)' } }), /pattern: one of/],
    ['decor outside the list', variant({ background: { pattern: 'griglia', decor: 'fuochi' } }), /decor: one of/],
    ['glow outside the list', variant({ hud: { corners: true, glow: 'acceso', radius: 'hud' } }), /glow: one of/],
    ['corners not a boolean', variant({ hud: { corners: 'si', glow: 'medio', radius: 'hud' } }), /true or false/],
    ['radius outside the list', variant({ hud: { corners: true, glow: 'medio', radius: '3px' } }), /radius: one of/],
    ['a token outside the list', variant({ tokens: { dark: { 'office-floor': '#000000' }, light: {} } }), /unknown key "office-floor"/],
    ['a colour by name', variant({ tokens: { dark: { bg: 'black' }, light: {} } }), /#rrggbb/],
    ['a colour with CSS after it', variant({ tokens: { dark: { bg: '#000000; background:url(x)' }, light: {} } }), /#rrggbb/],
    ['a colour in capitals', variant({ tokens: { dark: { bg: '#ABCDEF' }, light: {} } }), /lowercase/],
    ['a mode outside dark and light', variant({ tokens: { dark: {}, light: {}, sepia: {} } }), /unknown key "sepia"/],
    ['a character by path', variant({ characters: { arianna: '../arianna' } }), /<pack>\/<character>/],
    ['a character with three parts', variant({ characters: { arianna: 'a/b/c' } }), /<pack>\/<character>/],
    ['an agent id with capitals', variant({ characters: { Arianna: 'originali/arianna' } }), /agent id/],
    ['an address in the name', variant({ name: 'https://example.com' }), /no addresses/],
    ['an import in the description', variant({ description: '@import x' }), /no addresses/],
    ['markup in the name', variant({ name: '<b>Prova</b>' }), /no addresses/],
    ['a name too long', variant({ name: 'x'.repeat(41) }), /1-40/],
    ['a description too long', variant({ description: 'x'.repeat(161) }), /1-160/],
    ['a css function in the description', variant({ description: 'sfondo url(x)' }), /no addresses/],
    ['a control character in the name', variant({ name: 'Pro\u0007va' }), /control characters/],
    ['an end day in the wrong form', variant({ kind: 'stagionale', dates: { from: '12-08', to: '13-01' } }), /dates\.to/],
    ['too many agents', variant({ characters: Object.fromEntries([...Array(17).keys()].map((index) => [`agente-${String(index)}`, 'originali/coder'])) }), /at most 16/],
    ['a long unknown key, cut in the reason', variant({ ['k'.repeat(500)]: 1 }), /unknown key "k{40}…"$/],
  ];
  for (const [what, raw, reason] of bad) assert.throws(() => parseTheme(raw, what === 'base of another kind' ? 'base' : 'prova'), (error: unknown) => error instanceof ThemeError && reason.test(error.message), what);
});

function folder(name: string, files: Record<string, string>): string {
  const dir = join(root, 'themes', name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

test('listThemes: a folder that holds anything but theme.json, a link, a file too large or a bad name is refused with the reason', async () => {
  folder('prova', { 'theme.json': json(VALID) });
  folder('extra', { 'theme.json': variant({ id: 'extra' }), 'style.css': 'body{}' });
  folder('vuoto', {});
  folder('grosso', { 'theme.json': variant({ id: 'grosso', description: 'x'.repeat(100) }).padEnd(MAX_THEME_BYTES + 1, ' ') });
  folder('Maiuscolo', { 'theme.json': variant({ id: 'Maiuscolo' }) });
  symlinkSync(join(root, 'themes', 'prova'), join(root, 'themes', 'collegato'));
  const listing = await listThemes(join(root, 'themes'));
  assert.deepEqual(listing.themes.map((theme) => theme.id), ['prova']);
  assert.deepEqual(
    Object.fromEntries(listing.refused.map(({ theme, reason }) => [theme, reason])),
    {
      Maiuscolo: 'the folder name is lowercase letters, digits and -',
      collegato: 'not a folder',
      extra: 'the folder holds theme.json alone',
      grosso: 'file too large',
      vuoto: 'the folder holds theme.json alone',
    },
  );
  assert.deepEqual(await listThemes(join(root, 'missing')), { themes: [], refused: [] });
});

test('listThemes: past 64 folders the others are refused, not dropped in silence', async () => {
  const dir = join(root, 'many');
  for (let index = 0; index < 65; index++) {
    const id = `tema-${String(index).padStart(2, '0')}`;
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, 'theme.json'), variant({ id }));
  }
  const listing = await listThemes(dir);
  assert.equal(listing.themes.length, 64);
  assert.deepEqual(listing.refused, [{ theme: 'tema-64', reason: 'more than 64 themes' }]);
});

test('the theme in use is the chosen one when it is served, Base otherwise', async () => {
  const { themes } = await listThemes(REPO_THEMES);
  assert.equal(currentTheme('corsia', themes), 'corsia');
  assert.equal(currentTheme('sparito', themes), 'base');
  assert.equal(currentTheme('base', themes), 'base');
});

const day = (text: string) => {
  const [year = 0, month = 0, date = 0] = text.split('-').map(Number);
  return { year, month, day: date };
};

test('the feasts take the place of Base in their days, never of a theme chosen by hand (D-246)', async () => {
  const { themes } = await listThemes(REPO_THEMES);
  const feast = (text: string) => feastOf(themes, day(text))?.id;
  // The windows of DECISIONS, ends included, Christmas across the new year.
  assert.deepEqual(['2026-12-07', '2026-12-08', '2026-12-25', '2027-01-06', '2027-01-07'].map(feast), [undefined, 'natale', 'natale', 'natale', undefined]);
  assert.deepEqual(['2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01', '2026-11-02'].map(feast), [undefined, 'halloween', 'halloween', 'halloween', undefined]);
  assert.deepEqual(['2027-03-14', '2027-03-15', '2027-03-17', '2027-03-18'].map(feast), [undefined, 'san-patrizio', 'san-patrizio', undefined]);
  assert.deepEqual(['2026-07-31', '2026-08-01', '2026-08-15', '2026-08-31', '2026-09-01'].map(feast), [undefined, 'estate', 'estate', 'estate', undefined]);
  // Movable feasts from Easter: 2026 on 5 April, 2027 on 28 March.
  assert.deepEqual(['2026-03-28', '2026-03-29', '2026-04-05', '2026-04-06', '2026-04-07'].map(feast), [undefined, 'pasqua', 'pasqua', 'pasqua', undefined]);
  assert.deepEqual(['2026-02-11', '2026-02-12', '2026-02-17', '2026-02-18'].map(feast), [undefined, 'carnevale', 'carnevale', undefined]);
  assert.deepEqual(['2027-02-03', '2027-02-04', '2027-02-09', '2027-02-10'].map(feast), [undefined, 'carnevale', 'carnevale', undefined]);
  // Two feasts on one day: the shorter wins (2008: Palm Sunday on 16 March, Saint Patrick on the 17th).
  assert.equal(feast('2008-03-17'), 'san-patrizio');
  assert.equal(feast('2008-03-18'), 'pasqua');
  assert.equal(feast('2026-10-16'), undefined);

  const on = { on: true, today: day('2026-12-24') };
  assert.equal(currentTheme('base', themes, on), 'natale');
  assert.equal(currentTheme('base', themes, { ...on, on: false }), 'base');
  assert.equal(currentTheme('base', themes, { ...on, today: day('2026-10-16') }), 'base');
  // A theme chosen by hand stays, a feast chosen by hand too, all year.
  assert.equal(currentTheme('corsia', themes, on), 'corsia');
  assert.equal(currentTheme('halloween', themes, on), 'halloween');
  assert.equal(currentTheme('halloween', themes, { on: false, today: day('2026-05-01') }), 'halloween');
  // A chosen theme that is gone falls back to Base, and Base dresses up.
  assert.equal(currentTheme('sparito', themes, on), 'natale');
});

test('the prompt of a step names the costume of the feast the chat shows (D-246)', async () => {
  const { themes } = await listThemes(REPO_THEMES);
  const today = day('2026-10-31');
  for (const chosen of ['base', 'corsia', 'sparito', 'natale']) {
    for (const on of [true, false]) assert.equal(currentThemeSync(REPO_THEMES, chosen, { on, today }), currentTheme(chosen, themes, { on, today }), `${chosen} ${String(on)}`);
  }
  const config = (seasonal: boolean) => ({ personas: {}, characters: {}, appearance: { theme: 'base', seasonal }, home: HOME, paths: { data: root }, today: () => today });
  assert.equal(characterChoiceOf(config(true), 'arianna'), 'originali/arianna-halloween');
  assert.equal(characterChoiceOf(config(false), 'arianna'), 'originali/arianna');
});

test('GET /api/themes serves the checked themes and the characters of the chosen one go to /api/characters (D-103, D-211)', async () => {
  let chosen = 'corsia';
  let feasts = { on: true, today: { year: 2026, month: 10, day: 31 } };
  const server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    agents: () => ['arianna', 'coder', 'god', 'designer'],
    characters: {
      dirs: { original: ORIGINAL, series: SERIES, data: join(root, 'no-characters') },
      choices: () => ({ coder: 'originali/coder' }),
      themes: { dir: REPO_THEMES, chosen: () => chosen, feasts: () => feasts },
      names: () => ({ reviewer: 'Revisore' }),
    },
  });
  try {
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const themes = (await (await fetch(`${origin}/api/themes`)).json()) as { themes: { id: string }[]; chosen: string; current: string; seasonal: boolean };
    assert.deepEqual(themes.themes.map(({ id }) => id), ['base', 'carnevale', 'corsia', 'estate', 'fox-river', 'halloween', 'langley', 'natale', 'pasadena', 'pasqua', 'planet-express', 'quahog', 'san-patrizio', 'springfield', 'ufficio']);
    // On Halloween a theme chosen by hand stays (D-246).
    assert.deepEqual([themes.current, themes.seasonal], ['corsia', true]);
    const characters = (await (await fetch(`${origin}/api/characters`)).json()) as { agents: Record<string, { pack: string; character: string; from: string }>; names: Record<string, string> };
    // The name the user wrote wins in the chat (D-214).
    assert.deepEqual(characters.names, { reviewer: 'Revisore' });
    // The prompt of a step chooses each agent's character as the chat does (D-214).
    for (const [agent, choice] of Object.entries(characters.agents)) {
      const config = { personas: {}, characters: { coder: 'originali/coder' }, appearance: { theme: 'corsia' }, home: HOME, paths: { data: root } };
      assert.equal(characterChoiceOf(config, agent), `${choice.pack}/${choice.character}`, agent);
    }
    // The people of the series (D-211, D-227), from the theme.
    assert.deepEqual(characters.agents.arianna, { pack: 'serie', character: 'carla', rows: 4, from: 'theme' });
    assert.deepEqual(characters.agents.god, { pack: 'serie', character: 'cox', rows: 4, from: 'theme' });
    assert.deepEqual(characters.agents.designer, { pack: 'serie', character: 'janitor', rows: 4, from: 'theme' });
    // The explicit choice of [characters] wins over the theme.
    assert.equal(characters.agents.coder?.from, 'choice');
    chosen = 'sparito';
    const fallback = (await (await fetch(`${origin}/api/themes`)).json()) as { chosen: string; current: string };
    assert.deepEqual([fallback.chosen, fallback.current], ['sparito', 'halloween']);
    // Base on Halloween (D-246): the feast, with its costumes; the explicit choice of the Coder still wins.
    chosen = 'base';
    const feast = (await (await fetch(`${origin}/api/themes`)).json()) as { chosen: string; current: string };
    assert.deepEqual([feast.chosen, feast.current], ['base', 'halloween']);
    const dressed = (await (await fetch(`${origin}/api/characters`)).json()) as { agents: Record<string, { character: string; from: string }> };
    assert.deepEqual([dressed.agents.arianna?.character, dressed.agents.arianna?.from], ['arianna-halloween', 'theme']);
    assert.deepEqual([dressed.agents.coder?.character, dressed.agents.coder?.from], ['coder', 'choice']);
    // The feasts off: Base as it is, the originals.
    feasts = { ...feasts, on: false };
    const plainThemes = (await (await fetch(`${origin}/api/themes`)).json()) as { current: string; seasonal: boolean };
    assert.deepEqual([plainThemes.current, plainThemes.seasonal], ['base', false]);
    const plain = (await (await fetch(`${origin}/api/characters`)).json()) as { agents: Record<string, { character: string; from: string }> };
    assert.deepEqual([plain.agents.arianna?.character, plain.agents.arianna?.from], ['arianna', 'original']);
  } finally {
    await server.close();
  }
  assert.ok(readFileSync(join(REPO_THEMES, 'corsia', 'theme.json'), 'utf8').length < MAX_THEME_BYTES);
});
