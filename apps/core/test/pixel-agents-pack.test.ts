import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { listPacks, readSheet } from '../src/characters.ts';
import type { GithubGet } from '../src/github-api.ts';
import { downloadPixelAgents, PIXEL_AGENTS_PACK, PIXEL_AGENTS_REPOSITORY } from '../src/pixel-agents-pack.ts';

const HOME = resolveHome({});
const ORIGINAL = join(HOME, 'apps', 'hud', 'characters', 'originali');
const SHEET = readFileSync(join(ORIGINAL, 'coder.png'));
const root = join(HOME, 'data', 'test-tmp', randomUUID());

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const BASE = `/repos/${PIXEL_AGENTS_REPOSITORY}`;
const FOLDER = `${BASE}/contents/webview-ui/public/assets/characters`;

function file(bytes: Buffer): unknown {
  // The contents API breaks the base64 in lines.
  return { encoding: 'base64', content: (bytes.toString('base64').match(/.{1,60}/g) ?? []).join('\n') };
}

/** A made-up GitHub: the paths asked are recorded. */
function fakeGithub(answers: Record<string, unknown>): { get: GithubGet; asked: string[] } {
  const asked: string[] = [];
  const get: GithubGet = (path) => {
    asked.push(path);
    if (!(path in answers)) return Promise.reject(new Error(`unexpected path ${path}`));
    return Promise.resolve(answers[path]);
  };
  return { get, asked };
}

const GOOD = {
  [FOLDER]: [
    { type: 'file', name: 'char_1.png' },
    { type: 'file', name: 'char_0.png' },
    { type: 'file', name: 'readme.md' },
    { type: 'dir', name: 'char_2.png' },
  ],
  [`${FOLDER}/char_0.png`]: file(SHEET),
  [`${FOLDER}/char_1.png`]: file(SHEET),
  [`${BASE}/license`]: file(Buffer.from('MIT License\n')),
};

test('downloads only the sheets and the licence into the pack pixel-agents', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'one') };
  const left: string[] = [];
  const { get, asked } = fakeGithub(GOOD);
  const result = await downloadPixelAgents({ dirs, get, gateway: (address) => (left.push(address), Promise.resolve()) });
  assert.deepEqual(result, { pack: PIXEL_AGENTS_PACK, characters: 2, replaced: false });
  assert.deepEqual(left, [`https://github.com/${PIXEL_AGENTS_REPOSITORY}`]);
  assert.deepEqual(asked, [FOLDER, `${FOLDER}/char_0.png`, `${FOLDER}/char_1.png`, `${BASE}/license`]);
  assert.deepEqual(readdirSync(join(dirs.data, PIXEL_AGENTS_PACK)).sort(), ['LICENSE', 'char-0.png', 'char-1.png', 'pack.json']);
  assert.deepEqual(readdirSync(dirs.data), [PIXEL_AGENTS_PACK]);
  const { packs } = await listPacks(dirs);
  const pack = packs.find((item) => item.id === PIXEL_AGENTS_PACK);
  assert.deepEqual(pack?.characters, [
    { id: 'char-0', name: 'Personaggio 1', rows: 4 },
    { id: 'char-1', name: 'Personaggio 2', rows: 4 },
  ]);
  assert.match(pack.source, /solo per uso personale/);
  assert.ok((await readSheet(dirs, PIXEL_AGENTS_PACK, 'char-1')) !== undefined);
});

test('a second download replaces the pack and leaves no hidden folder', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'two') };
  const gateway = () => Promise.resolve();
  await downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway });
  const result = await downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway });
  assert.equal(result.replaced, true);
  assert.deepEqual(readdirSync(dirs.data), [PIXEL_AGENTS_PACK]);
});

test('a sheet that is not a character fails the download and keeps the previous pack', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'three') };
  const gateway = () => Promise.resolve();
  await downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway });
  const bad = { ...GOOD, [`${FOLDER}/char_1.png`]: file(Buffer.from('not a png')) };
  await assert.rejects(downloadPixelAgents({ dirs, get: fakeGithub(bad).get, gateway }), /char_1\.png/);
  assert.deepEqual(readdirSync(dirs.data), [PIXEL_AGENTS_PACK]);
  assert.equal(readdirSync(join(dirs.data, PIXEL_AGENTS_PACK)).length, 4);
});

test('nothing is asked of GitHub when the gateway refuses', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'four') };
  const { get, asked } = fakeGithub(GOOD);
  await assert.rejects(downloadPixelAgents({ dirs, get, gateway: () => Promise.reject(new Error('gateway refused')) }), /gateway refused/);
  assert.deepEqual(asked, []);
});

test('a folder without characters is an error', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'five') };
  const { get } = fakeGithub({ ...GOOD, [FOLDER]: [{ type: 'file', name: 'readme.md' }] });
  await assert.rejects(downloadPixelAgents({ dirs, get, gateway: () => Promise.resolve() }), /no character found/);
});

test('two downloads at once run one after the other', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'six') };
  const gateway = () => Promise.resolve();
  const results = await Promise.all([downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway }), downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway })]);
  assert.deepEqual(results.map((result) => result.replaced), [false, true]);
  assert.deepEqual(readdirSync(dirs.data), [PIXEL_AGENTS_PACK]);
});

test('a licence missing or not in base64 fails the download', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'seven') };
  const gateway = () => Promise.resolve();
  for (const license of [{ encoding: 'none', content: '' }, { encoding: 'base64', content: '' }, []]) {
    await assert.rejects(downloadPixelAgents({ dirs, get: fakeGithub({ ...GOOD, [`${BASE}/license`]: license }).get, gateway }), /LICENSE/);
  }
  assert.throws(() => readdirSync(join(dirs.data, PIXEL_AGENTS_PACK)));
});

test('a name with a leading zero is not a character', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'eight') };
  const { get, asked } = fakeGithub({ ...GOOD, [FOLDER]: [{ type: 'file', name: 'char_0.png' }, { type: 'file', name: 'char_00.png' }] });
  await downloadPixelAgents({ dirs, get, gateway: () => Promise.resolve() });
  assert.ok(!asked.some((path) => path.endsWith('char_00.png')));
});

test('a swap cut in the middle is put back by the next download', async () => {
  const dirs = { original: ORIGINAL, data: join(root, 'nine') };
  const gateway = () => Promise.resolve();
  await downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway });
  // As if the core had stopped after moving the pack away.
  renameSync(join(dirs.data, PIXEL_AGENTS_PACK), join(dirs.data, `.${PIXEL_AGENTS_PACK}.cut.old`));
  mkdirSync(join(dirs.data, `.${PIXEL_AGENTS_PACK}.cut.tmp`));
  await downloadPixelAgents({ dirs, get: fakeGithub(GOOD).get, gateway });
  assert.deepEqual(readdirSync(dirs.data), [PIXEL_AGENTS_PACK]);
});
