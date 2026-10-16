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
import { currentTheme, listThemes, MAX_THEME_BYTES, parseTheme, THEME_TOKENS, ThemeError } from '../src/themes.ts';
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
  assert.deepEqual(listing.themes.map((theme) => theme.id), ['corsia', 'langley', 'quahog', 'springfield', 'ufficio']);
  for (const theme of listing.themes) assert.equal(theme.kind, 'serie');
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
    ['base is reserved', variant({ id: 'base' }), /no file/],
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
  for (const [what, raw, reason] of bad) assert.throws(() => parseTheme(raw, what === 'base is reserved' ? 'base' : 'prova'), (error: unknown) => error instanceof ThemeError && reason.test(error.message), what);
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

test('GET /api/themes serves the checked themes and the characters of the chosen one go to /api/characters (D-103, D-211)', async () => {
  let chosen = 'corsia';
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
      themes: { dir: REPO_THEMES, chosen: () => chosen },
      names: () => ({ reviewer: 'Revisore' }),
    },
  });
  try {
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const themes = (await (await fetch(`${origin}/api/themes`)).json()) as { themes: { id: string }[]; chosen: string; current: string };
    assert.deepEqual(themes.themes.map(({ id }) => id), ['corsia', 'langley', 'quahog', 'springfield', 'ufficio']);
    assert.equal(themes.current, 'corsia');
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
    assert.deepEqual([fallback.chosen, fallback.current], ['sparito', 'base']);
    const plain = (await (await fetch(`${origin}/api/characters`)).json()) as { agents: Record<string, { character: string; from: string }> };
    assert.deepEqual([plain.agents.arianna?.character, plain.agents.arianna?.from], ['arianna', 'original']);
  } finally {
    await server.close();
  }
  assert.ok(readFileSync(join(REPO_THEMES, 'corsia', 'theme.json'), 'utf8').length < MAX_THEME_BYTES);
});
