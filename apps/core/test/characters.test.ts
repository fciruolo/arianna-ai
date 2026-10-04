import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { assignCharacters, listPacks, MAX_SHEET_BYTES, readSheet, sheetRows } from '../src/characters.ts';

const HOME = resolveHome({});
const ORIGINAL = join(HOME, 'apps', 'hud', 'characters', 'originali');
// Made-up packs, in data/ (never in git).
const root = join(HOME, 'data', 'test-tmp', randomUUID());
const DATA = join(root, 'characters');
const dirs = { original: ORIGINAL, data: DATA };
const SHEET = readFileSync(join(ORIGINAL, 'coder.png'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A PNG header of the given size: enough for the checks, which read only the header. */
function header(width: number, height: number): Buffer {
  const png = Buffer.from(SHEET);
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function pack(name: string, manifest: unknown, files: Record<string, Buffer | string> = {}): string {
  const dir = join(DATA, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

const ONE = { name: 'Robots', source: 'made up', characters: [{ id: 'robot', name: 'Robot', file: 'robot.png' }] };

test('sheetRows accepts 112×96 and 112×128 PNGs only', () => {
  assert.equal(sheetRows(header(112, 96)), 3);
  assert.equal(sheetRows(header(112, 128)), 4);
  assert.throws(() => sheetRows(header(112, 64)), /112×96 or 112×128/);
  assert.throws(() => sheetRows(header(128, 96)), /112×96 or 112×128/);
  assert.throws(() => sheetRows(Buffer.from('GIF89a, not a png at all, padded to length')), /not a PNG/);
});

test('without data/characters only the originals are listed', async () => {
  const listing = await listPacks({ original: ORIGINAL, data: join(root, 'missing') });
  assert.deepEqual(
    listing.packs.map((entry) => [entry.id, entry.original, entry.characters.map(({ id, rows }) => [id, rows])]),
    [['originali', true, [['arianna', 4], ['coder', 4]]]],
  );
  assert.deepEqual(listing.refused, []);
});

test('a valid pack is listed and its sheets are served; a bad one is refused with the reason', async () => {
  pack('robots', ONE, { 'robot.png': header(112, 96) });
  pack('originali', ONE, { 'robot.png': header(112, 96) });
  pack('Bad Name', ONE, { 'robot.png': header(112, 96) });
  pack('wrong-size', ONE, { 'robot.png': header(112, 64) });
  pack('no-sheet', ONE);
  pack('not-json', '{ nope');
  pack('escape', { ...ONE, characters: [{ id: 'robot', name: 'Robot', file: '../robots/robot.png' }] });
  pack('twice', { ...ONE, characters: [ONE.characters[0], ONE.characters[0]] });
  pack('too-big', ONE, { 'robot.png': Buffer.concat([header(112, 96), Buffer.alloc(MAX_SHEET_BYTES)]) });
  const linked = pack('linked', ONE);
  symlinkSync(join(DATA, 'robots', 'robot.png'), join(linked, 'robot.png'));
  symlinkSync(join(DATA, 'robots'), join(DATA, 'folder-link'));

  const listing = await listPacks(dirs);
  assert.deepEqual(listing.packs.map((entry) => entry.id), ['originali', 'robots']);
  assert.deepEqual(Object.fromEntries(listing.refused.map(({ pack: name, reason }) => [name, reason])), {
    'Bad Name': 'folder name: lowercase letters, digits, - and _',
    escape: 'characters[0].file: a .png name in the pack folder',
    'folder-link': 'not a folder',
    linked: 'not a regular file',
    'no-sheet': 'pack.json or a sheet is missing',
    'not-json': 'pack.json is not valid JSON',
    originali: 'the name of the originals is taken',
    'too-big': 'file too large',
    twice: 'pack.json: an id is listed twice',
    'wrong-size': 'a sheet is 112×96 or 112×128',
  });

  assert.deepEqual(await readSheet(dirs, 'robots', 'robot'), header(112, 96));
  assert.deepEqual(await readSheet(dirs, 'originali', 'coder'), SHEET);
  for (const [name, character] of [['linked', 'robot'], ['wrong-size', 'robot'], ['robots', 'nobody'], ['..', 'robot'], ['originali', '../coder']]) {
    assert.equal(await readSheet(dirs, name ?? '', character ?? ''), undefined, `${String(name)}/${String(character)}`);
  }
});

test('unreadable originals are refused, and the packs of data/ are still listed', async () => {
  const listing = await listPacks({ original: join(root, 'no-originals'), data: DATA });
  assert.deepEqual(listing.packs.map((entry) => entry.id), ['robots']);
  assert.deepEqual(listing.refused.find((item) => item.pack === 'originali' && item.reason === 'pack.json or a sheet is missing') !== undefined, true);
});

test('assignCharacters: the choice when it is served, else the original of the agent, else the Coder', async () => {
  const { packs } = await listPacks(dirs);
  assert.deepEqual(
    assignCharacters(['arianna', 'coder', 'scout', 'writer'], { arianna: 'robots/robot', coder: 'robots/nobody', scout: 'gone/x' }, packs),
    {
      arianna: { pack: 'robots', character: 'robot', rows: 3 },
      coder: { pack: 'originali', character: 'coder', rows: 4 },
      scout: { pack: 'originali', character: 'coder', rows: 4 },
      writer: { pack: 'originali', character: 'coder', rows: 4 },
    },
  );
});
