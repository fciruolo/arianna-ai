// The page "Progetti" (D-134): an approved project read on this computer, nothing written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import type { Queryable } from '../src/db/client.ts';
import { createOpenLinks, DelegationFileError } from '../src/delegation-view.ts';
import { browsableProjects, listProjectDir, openBrowsedFile, readBrowsedFile, readCommitDiff, readProjectGit } from '../src/project-browser.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `browser-${randomUUID()}`);
const ROOT = join(HOME, 'repos', 'orto');
const OUTSIDE = join(HOME, 'outside');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Marta', '-c', 'user.email=marta@example.invalid', '-c', 'commit.gpgsign=false', '-C', ROOT, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}
function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), content);
  }
}

mkdirSync(ROOT, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, 'secret.txt'), 'fuori dal progetto\n');
git('init', '--quiet', '--initial-branch=main');
write({ 'src/seasons.ts': "export const SEASONS = ['pomodori'];\n", 'README.md': '# Orto\n', '.env': 'TOKEN=finto\n', 'public/index.html': '<h1>Orto</h1>\n' });
git('add', '--all');
git('commit', '--quiet', '--message', 'Primo');
write({ 'src/seasons.ts': "export const SEASONS = ['pomodori', 'zucchine'];\n", '.env': 'TOKEN=altro\n' });
git('add', '--all');
git('commit', '--quiet', '--message', 'Zucchine');
write({ 'README.md': '# Orto condiviso\n', 'node_modules/vue/index.js': 'x\n' });
symlinkSync(join(OUTSIDE, 'secret.txt'), join(ROOT, 'fuori.txt'));
symlinkSync('src', join(ROOT, 'codice'));

const PROJECTS: Project[] = [{ name: 'orto', path: 'repos/orto', absolute: ROOT, label: 'L1' }];
const idle: Queryable = { unsafe: () => Promise.resolve([]) } as unknown as Queryable;
const busy: Queryable = { unsafe: () => Promise.resolve([{ id: '1' }]) } as unknown as Queryable;
const code = (error: unknown): string => (error instanceof DelegationFileError ? error.code : String(error));

test('only approved projects, with their folder for "Apri in VS Code"', async () => {
  assert.deepEqual(browsableProjects(PROJECTS), [{ name: 'orto', absolute: ROOT }]);
  await assert.rejects(listProjectDir(PROJECTS, 'altro', ''), (error) => code(error) === 'not-approved');
  await assert.rejects(readBrowsedFile([], 'orto', 'README.md'), (error) => code(error) === 'not-approved');
});

test('a folder: folders first; hidden entries, node_modules and links leading out listed shut', async () => {
  const { entries, more } = await listProjectDir(PROJECTS, 'orto', '');
  assert.equal(more, 0);
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName['.git'], { name: '.git', kind: 'dir', size: null, shut: 'hidden' });
  assert.deepEqual(byName['.env'], { name: '.env', kind: 'file', size: null, shut: 'hidden' });
  assert.deepEqual(byName.node_modules, { name: 'node_modules', kind: 'dir', size: null, shut: 'excluded' });
  assert.deepEqual(byName['fuori.txt'], { name: 'fuori.txt', kind: 'file', size: null, shut: 'outside' });
  // A link to a folder inside the project is a folder like the others.
  assert.deepEqual(
    entries.find((entry) => entry.name === 'codice'),
    { name: 'codice', kind: 'dir', size: null },
  );
  assert.equal(byName['README.md']?.kind, 'file');
  assert.equal(entries.findIndex((entry) => entry.kind === 'file') > entries.findLastIndex((entry) => entry.kind === 'dir'), true);
  assert.deepEqual(
    (await listProjectDir(PROJECTS, 'orto', 'src')).entries.map(({ name }) => name),
    ['seasons.ts'],
  );
  for (const dir of ['.git', 'src/../..', '/etc', 'node_modules', 'src/', '..']) {
    await assert.rejects(listProjectDir(PROJECTS, 'orto', dir), (error) => code(error) === 'refused', dir);
  }
});

test('a file: its text and whether "Apri" serves it; hidden files, .git and links out refused', async () => {
  const file = await readBrowsedFile(PROJECTS, 'orto', 'src/seasons.ts');
  assert.equal(file.text, "export const SEASONS = ['pomodori', 'zucchine'];\n");
  assert.equal(file.openable, false);
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', 'public/index.html')).openable, true);
  for (const path of ['.env', '.git/config', 'fuori.txt', '../outside/secret.txt', 'src']) {
    await assert.rejects(readBrowsedFile(PROJECTS, 'orto', path), (error) => code(error) === 'refused' || code(error) === 'deleted', path);
  }
});

test('"Apri" gives a link for a page or an image only', async () => {
  const links = createOpenLinks();
  const { url } = await openBrowsedFile(PROJECTS, links, 'orto', 'public/index.html');
  assert.match(url, /^\/api\/open\/[A-Za-z0-9_-]{32}\/public\/index\.html$/);
  await assert.rejects(openBrowsedFile(PROJECTS, links, 'orto', 'src/seasons.ts'), (error) => code(error) === 'refused');
});

test('git: branches, changes not committed and the log; nothing while the Coder works there', async () => {
  const found = await readProjectGit(idle, PROJECTS, 'orto');
  assert.equal(found.repository, true);
  assert.deepEqual(found.branches.map(({ name, current }) => ({ name, current })), [{ name: 'main', current: true }]);
  assert.deepEqual(
    found.log.map(({ subject, author }) => ({ subject, author })),
    [
      { subject: 'Zucchine', author: 'Marta' },
      { subject: 'Primo', author: 'Marta' },
    ],
  );
  assert.ok(found.changes.some((change) => change.path === 'README.md' && change.change === 'modified'));
  await assert.rejects(readProjectGit(busy, PROJECTS, 'orto'), (error) => code(error) === 'busy');
});

test('a commit diff: the code shown, a hidden file listed but never shown, a bad id refused', async () => {
  const [last] = (await readProjectGit(idle, PROJECTS, 'orto')).log;
  assert.ok(last !== undefined);
  const { files, parent } = await readCommitDiff(idle, PROJECTS, 'orto', last.id);
  assert.notEqual(parent, null);
  const env = files.find((file) => file.path === '.env');
  assert.deepEqual(env, { path: '.env', change: 'modified', error: 'refused' });
  const seasons = files.find((file) => file.path === 'src/seasons.ts');
  assert.ok(seasons !== undefined && 'hunks' in seasons);
  const lines = seasons.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
  assert.ok(lines.some((line) => line.includes('zucchine')));
  assert.ok(!JSON.stringify(files).includes('TOKEN'));
  await assert.rejects(readCommitDiff(idle, PROJECTS, 'orto', 'HEAD'), (error) => code(error) === 'not-found');
  await assert.rejects(readCommitDiff(idle, PROJECTS, 'orto', 'f'.repeat(40)), (error) => code(error) === 'not-found');
});
