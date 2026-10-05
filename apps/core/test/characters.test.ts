import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import {
  assignCharacters,
  characterId,
  cleanSheet,
  listPacks,
  MAX_SHEET_BYTES,
  MAX_UPLOAD_BODY,
  parseUpload,
  readSheet,
  sheetRows,
  UploadError,
  uploadSheet,
} from '../src/characters.ts';
import type { Sql } from '../src/db/client.ts';
import { encodePng } from '../src/png.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

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

// D-118: uploads into data/characters/miei.
const ARIANNA = readFileSync(join(ORIGINAL, 'arianna.png'));
const UPLOAD = join(root, 'upload');
const uploadDirs = { original: ORIGINAL, data: join(UPLOAD, 'characters') };
const b64 = (buffer: Buffer): string => buffer.toString('base64');
/** A real, transparent PNG of the given size. */
const blank = (width: number, height: number): Buffer => encodePng({ width, height, rgba: new Uint8Array(width * height * 4) });

test('parseUpload: a name of one line, the PNG in base64 and an optional replace', () => {
  assert.deepEqual(parseUpload({ name: ' Robot blu ', png: b64(SHEET) }), { name: 'Robot blu', png: SHEET, replace: false });
  assert.equal(parseUpload({ name: 'R', png: b64(SHEET), replace: true }).replace, true);
  const bad: Record<string, unknown>[] = [
    { png: b64(SHEET) },
    { name: '', png: b64(SHEET) },
    { name: '!!!', png: b64(SHEET) },
    { name: 'a\nb', png: b64(SHEET) },
    { name: 'x'.repeat(41), png: b64(SHEET) },
    { name: 'R', png: 'not base64!' },
    { name: 'R', png: '' },
    { name: 'R', png: b64(Buffer.alloc(MAX_SHEET_BYTES + 1)) },
    { name: 'R', png: b64(SHEET), replace: 'yes' },
    { name: 'R', png: b64(SHEET), pack: 'originali' },
  ];
  for (const body of bad) assert.throws(() => parseUpload(body), { name: 'UploadError' }, JSON.stringify(body).slice(0, 60));
  assert.equal(characterId('Robòt  Blu!'), 'robot-blu');
});

test('cleanSheet: 112×96 or 112×128 only, written again from the pixels', () => {
  const clean = cleanSheet(SHEET);
  assert.equal(clean.rows, 4);
  assert.equal(cleanSheet(clean.png).png.equals(clean.png), true);
  assert.throws(() => cleanSheet(blank(112, 64)), { name: 'UploadError', message: /112×96 or 112×128/ });
  assert.throws(() => cleanSheet(blank(400, 96)), { name: 'UploadError', message: /112×96 or 112×128/ });
  assert.throws(() => cleanSheet(Buffer.from('GIF89a, not a png at all')), { name: 'UploadError', message: /not a PNG/ });
  // A sheet with text after IEND (a file glued to the image): refused.
  assert.throws(() => cleanSheet(Buffer.concat([SHEET, Buffer.from('PK hidden archive')])), { name: 'UploadError', message: /after the end/ });
});

test('uploadSheet: a new character in miei, a conflict on the same name, replaced only on request', async () => {
  const first = await uploadSheet(uploadDirs, { name: 'Robot blu', png: SHEET, replace: false });
  assert.deepEqual(first, { pack: 'miei', character: 'robot-blu', name: 'Robot blu', rows: 4, replaced: false });
  const listing = await listPacks(uploadDirs);
  assert.deepEqual(listing.packs.map((entry) => [entry.id, entry.characters.map(({ id }) => id)]), [['originali', ['arianna', 'coder']], ['miei', ['robot-blu']]]);
  assert.deepEqual(await readSheet(uploadDirs, 'miei', 'robot-blu'), cleanSheet(SHEET).png);

  await assert.rejects(uploadSheet(uploadDirs, { name: 'robot BLU', png: ARIANNA, replace: false }), (error: unknown) => {
    assert.ok(error instanceof UploadError);
    assert.equal(error.code, 'conflict');
    assert.deepEqual(error.existing, { id: 'robot-blu', name: 'Robot blu' });
    return true;
  });
  // Unchanged until replaced.
  assert.deepEqual(await readSheet(uploadDirs, 'miei', 'robot-blu'), cleanSheet(SHEET).png);
  const replaced = await uploadSheet(uploadDirs, { name: 'robot BLU', png: ARIANNA, replace: true });
  assert.equal(replaced.replaced, true);
  assert.deepEqual(await readSheet(uploadDirs, 'miei', 'robot-blu'), cleanSheet(ARIANNA).png);
  const manifest = JSON.parse(readFileSync(join(uploadDirs.data, 'miei', 'pack.json'), 'utf8')) as { characters: { name: string }[] };
  assert.deepEqual(manifest.characters.map(({ name }) => name), ['robot BLU']);
  // Two at once: both lines kept.
  await Promise.all([uploadSheet(uploadDirs, { name: 'Uno', png: SHEET, replace: false }), uploadSheet(uploadDirs, { name: 'Due', png: SHEET, replace: false })]);
  assert.deepEqual((await listPacks(uploadDirs)).packs[1]?.characters.map(({ id }) => id), ['robot-blu', 'uno', 'due']);
  // No temporary file left behind.
  assert.deepEqual(readdirSync(join(uploadDirs.data, 'miei')).filter((name) => name.startsWith('.')), []);
});

test('uploadSheet refuses a pack miei that is a link or holds a broken pack.json', async () => {
  const linkedDirs = { original: ORIGINAL, data: join(UPLOAD, 'linked') };
  mkdirSync(join(UPLOAD, 'elsewhere'), { recursive: true });
  mkdirSync(linkedDirs.data, { recursive: true });
  symlinkSync(join(UPLOAD, 'elsewhere'), join(linkedDirs.data, 'miei'));
  await assert.rejects(uploadSheet(linkedDirs, { name: 'R', png: SHEET, replace: false }), { name: 'UploadError', message: /not a folder/ });
  assert.deepEqual(readdirSync(join(UPLOAD, 'elsewhere')), []);

  const brokenDirs = { original: ORIGINAL, data: join(UPLOAD, 'broken') };
  mkdirSync(join(brokenDirs.data, 'miei'), { recursive: true });
  writeFileSync(join(brokenDirs.data, 'miei', 'pack.json'), '{ nope');
  await assert.rejects(uploadSheet(brokenDirs, { name: 'R', png: SHEET, replace: false }), { name: 'UploadError', message: /not valid JSON/ });
  assert.equal(readFileSync(join(brokenDirs.data, 'miei', 'pack.json'), 'utf8'), '{ nope');
});

test('POST /api/characters/upload: 201, 409 with the existing character, 400 on a bad sheet', async () => {
  const routeDirs = { original: ORIGINAL, data: join(UPLOAD, 'route') };
  const server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    agents: () => ['arianna', 'coder'],
    characters: { dirs: routeDirs, choices: () => ({}) },
  });
  try {
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const post = (body: unknown, type = 'application/json') =>
      fetch(`${origin}/api/characters/upload`, { method: 'POST', headers: { 'content-type': type, origin }, body: JSON.stringify(body) });
    const created = await post({ name: 'Gatto', png: b64(SHEET) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { character: { pack: 'miei', character: 'gatto', name: 'Gatto', rows: 4, replaced: false } });
    const listed = (await (await fetch(`${origin}/api/characters`)).json()) as { packs: { id: string }[] };
    assert.deepEqual(listed.packs.map(({ id }) => id), ['originali', 'miei']);
    const sheet = await fetch(`${origin}/api/characters/miei/gatto`);
    assert.equal(sheet.status, 200);
    assert.deepEqual(Buffer.from(await sheet.arrayBuffer()), cleanSheet(SHEET).png);

    const conflict = await post({ name: 'gatto', png: b64(ARIANNA) });
    assert.equal(conflict.status, 409);
    assert.deepEqual(((await conflict.json()) as { existing: unknown }).existing, { id: 'gatto', name: 'Gatto' });
    assert.equal((await post({ name: 'gatto', png: b64(ARIANNA), replace: true })).status, 201);

    assert.equal((await post({ name: 'Piccolo', png: b64(blank(112, 64)) })).status, 400);
    assert.equal((await post({ name: 'Finto', png: b64(Buffer.from('not a png, just text')) })).status, 400);
    assert.equal((await post({ name: 'Grosso', png: 'A'.repeat(MAX_UPLOAD_BODY) })).status, 413);
    assert.equal((await post({ name: 'Form', png: b64(SHEET) }, 'text/plain')).status, 415);
    const cross = await fetch(`${origin}/api/characters/upload`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
  } finally {
    await server.close();
  }
});

test('uploadSheet: at most 32 characters in miei, a file of another character refused, a replacement writes over the file it names', async () => {
  const fullDirs = { original: ORIGINAL, data: join(UPLOAD, 'full') };
  const dir = join(fullDirs.data, 'miei');
  mkdirSync(dir, { recursive: true });
  const clean = cleanSheet(SHEET).png;
  const characters = Array.from({ length: 32 }, (_item, index) => ({ id: `c${String(index)}`, name: `C ${String(index)}`, file: `c${String(index)}.png` }));
  for (const { file } of characters) writeFileSync(join(dir, file), clean);
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name: 'Miei', characters }));
  await assert.rejects(uploadSheet(fullDirs, { name: 'Trentatré', png: SHEET, replace: false }), (error: unknown) => {
    assert.ok(error instanceof UploadError);
    assert.equal(error.code, 'full');
    assert.match(error.message, /holds at most 32 characters/);
    return true;
  });
  // Replacing one of the 32 is still allowed.
  assert.equal((await uploadSheet(fullDirs, { name: 'c0', png: ARIANNA, replace: true })).replaced, true);

  const takenDirs = { original: ORIGINAL, data: join(UPLOAD, 'taken') };
  const takenDir = join(takenDirs.data, 'miei');
  mkdirSync(takenDir, { recursive: true });
  writeFileSync(join(takenDir, 'other.png'), clean);
  writeFileSync(join(takenDir, 'old-file.png'), clean);
  writeFileSync(
    join(takenDir, 'pack.json'),
    JSON.stringify({ name: 'Miei', characters: [{ id: 'other', name: 'Other', file: 'robot.png' }, { id: 'hand', name: 'Hand', file: 'old-file.png' }] }),
  );
  writeFileSync(join(takenDir, 'robot.png'), clean);
  await assert.rejects(uploadSheet(takenDirs, { name: 'Robot', png: SHEET, replace: false }), { name: 'UploadError', message: /belongs to another character/ });
  await uploadSheet(takenDirs, { name: 'Hand', png: ARIANNA, replace: true });
  assert.deepEqual(readFileSync(join(takenDir, 'old-file.png')), cleanSheet(ARIANNA).png);
  assert.equal(readdirSync(takenDir).includes('hand.png'), false);
});

test('parseUpload refuses format characters in the name', () => {
  assert.throws(() => parseUpload({ name: 'Ro​bot', png: b64(SHEET) }), { name: 'UploadError' });
  assert.throws(() => parseUpload({ name: 'Ro‮bot', png: b64(SHEET) }), { name: 'UploadError' });
});
