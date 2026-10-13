// The page "Progetti" (D-134): an approved project read on this computer, nothing written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { Secret } from '@arianna/vault';

import type { Queryable } from '../src/db/client.ts';
import { createOpenLinks, DelegationFileError } from '../src/delegation-view.ts';
import { browsableProjects, isSecretPath, listProjectDir, openBrowsedFile, readBrowsedFile, readCommitDiff, readProjectGit } from '../src/project-browser.ts';

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
// A value of the vault in a committed file, and a hidden file renamed to a visible one.
const VAULT_VALUE = 'vault-browser-0f3c9a71d2';
new Secret('test/browser', VAULT_VALUE);
write({ 'config.ts': `export const KEY = '${VAULT_VALUE}';\n`, '.segreti.ts': 'export const NOTE = 1;\n' });
git('add', '--all');
git('commit', '--quiet', '--message', 'Chiave');
git('mv', '.segreti.ts', 'pubblico.ts');
git('commit', '--quiet', '--message', 'Rinomina');
write({ 'README.md': '# Orto condiviso\n', 'node_modules/vue/index.js': 'x\n' });
symlinkSync(join(OUTSIDE, 'secret.txt'), join(ROOT, 'fuori.txt'));
symlinkSync('src', join(ROOT, 'codice'));
symlinkSync('.git', join(ROOT, 'src2'));
symlinkSync('node_modules/vue', join(ROOT, 'vue'));
// D-135: entries the consent shows, secrets covered hidden or not, a link to a secret.
write({
  '.github/ci.yml': 'name: ci\n',
  '.env.example': 'TOKEN=\n',
  'certs/server.key': 'chiave finta\n',
  '.ombra.html': '<p>ombra</p>\n',
  '.vault-note': `nota ${VAULT_VALUE}\n`,
});
symlinkSync('.env', join(ROOT, 'note.txt'));
symlinkSync('certs/server.key', join(ROOT, 'chiave.txt'));
symlinkSync('certs/server.key', join(ROOT, 'logo.svg'));
const PLAIN = join(HOME, 'repos', 'senza-git');
mkdirSync(PLAIN, { recursive: true });
writeFileSync(join(PLAIN, 'note.md'), '# Note\n');

const PROJECTS: Project[] = [
  { name: 'orto', path: 'repos/orto', absolute: ROOT, label: 'L1' },
  { name: 'senza-git', path: 'repos/senza-git', absolute: PLAIN, label: 'L1' },
];
const idle: Queryable = { unsafe: () => Promise.resolve([]) } as unknown as Queryable;
const busy: Queryable = { unsafe: () => Promise.resolve([{ id: '1' }]) } as unknown as Queryable;
const code = (error: unknown): string => (error instanceof DelegationFileError ? error.code : String(error));

test('only approved projects, with their folder for "Apri in VS Code"', async () => {
  assert.deepEqual(browsableProjects(PROJECTS.slice(0, 1)), [{ name: 'orto', absolute: ROOT, hidden: false, project: 'orto', part: null }]);
  // D-135: the consent counts only for the folder it was given for.
  assert.deepEqual(browsableProjects(PROJECTS, new Map([['orto', ROOT], ['senza-git', '/srv/altrove']])).map(({ hidden }) => hidden), [true, false]);
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
  // Links into .git or node_modules: listed shut, never opened as folders.
  assert.equal(byName.src2?.shut, 'hidden');
  assert.equal(byName.vue?.shut, 'excluded');
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
  for (const dir of ['.git', 'src/../..', '/etc', 'node_modules', 'src/', '..', 'src2', 'src2/refs', 'vue']) {
    await assert.rejects(listProjectDir(PROJECTS, 'orto', dir), (error) => code(error) === 'refused', dir);
  }
});

test('a file: its text and whether "Apri" serves it; hidden files, .git and links out refused', async () => {
  const file = await readBrowsedFile(PROJECTS, 'orto', 'src/seasons.ts');
  assert.equal(file.text, "export const SEASONS = ['pomodori', 'zucchine'];\n");
  assert.equal(file.openable, false);
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', 'public/index.html')).openable, true);
  for (const path of ['.env', '.git/config', 'fuori.txt', '../outside/secret.txt', 'src', 'node_modules/vue/index.js', 'vue/index.js', 'src2/config', 'config.ts']) {
    await assert.rejects(readBrowsedFile(PROJECTS, 'orto', path), (error) => code(error) === 'refused' || code(error) === 'deleted', path);
  }
});

test('"Apri" gives a link for a page or an image only', async () => {
  const links = createOpenLinks();
  const { url } = await openBrowsedFile(PROJECTS, links, 'orto', 'public/index.html');
  assert.match(url, /^\/api\/open\/[A-Za-z0-9_-]{32}\/public\/index\.html$/);
  await assert.rejects(openBrowsedFile(PROJECTS, links, 'orto', 'src/seasons.ts'), (error) => code(error) === 'refused');
  // D-135: a link named like an image never serves a secret.
  await assert.rejects(openBrowsedFile(PROJECTS, links, 'orto', 'logo.svg'), (error) => code(error) === 'refused');
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', 'logo.svg')).openable, false);
});

test('git: branches, changes not committed and the log; nothing while the Coder works there', async () => {
  const found = await readProjectGit(idle, PROJECTS, 'orto');
  assert.equal(found.repository, true);
  assert.deepEqual(found.branches.map(({ name, current }) => ({ name, current })), [{ name: 'main', current: true }]);
  assert.deepEqual(
    found.log.map(({ subject, author }) => ({ subject, author })),
    [
      { subject: 'Rinomina', author: 'Marta' },
      { subject: 'Chiave', author: 'Marta' },
      { subject: 'Zucchine', author: 'Marta' },
      { subject: 'Primo', author: 'Marta' },
    ],
  );
  assert.ok(found.changes.some((change) => change.path === 'README.md' && change.change === 'modified'));
  await assert.rejects(readProjectGit(busy, PROJECTS, 'orto'), (error) => code(error) === 'busy');
});

test('a project without git: said, not an error', async () => {
  assert.deepEqual(await readProjectGit(idle, PROJECTS, 'senza-git'), { repository: false, branches: [], changes: [], log: [] });
});

test('a commit diff: a value of the vault and a file renamed from a hidden one are listed, never shown', async () => {
  const [renamed, keyed] = (await readProjectGit(idle, PROJECTS, 'orto')).log;
  assert.ok(renamed !== undefined && keyed !== undefined);
  const rename = await readCommitDiff(idle, PROJECTS, 'orto', renamed.id);
  assert.deepEqual(rename.files, [{ path: 'pubblico.ts', change: 'renamed', from: '.segreti.ts', error: 'refused' }]);
  const key = await readCommitDiff(idle, PROJECTS, 'orto', keyed.id);
  assert.ok(key.files.some((file) => file.path === 'config.ts' && 'error' in file && file.error === 'refused'));
  assert.ok(!JSON.stringify(key.files).includes(VAULT_VALUE));
  assert.ok(!JSON.stringify(key.files).includes('NOTE'));
});

test('the root commit: everything added, against nothing', async () => {
  const log = (await readProjectGit(idle, PROJECTS, 'orto')).log;
  const root = log.at(-1);
  assert.ok(root !== undefined);
  const { parent, files } = await readCommitDiff(idle, PROJECTS, 'orto', root.id);
  assert.equal(parent, null);
  assert.ok(files.every((file) => file.change === 'added'));
  assert.ok(files.some((file) => file.path === 'README.md' && 'hunks' in file && file.added === 1));
});

test('a commit diff: the code shown, a hidden file listed but never shown, a bad id refused', async () => {
  const last = (await readProjectGit(idle, PROJECTS, 'orto')).log.find((item) => item.subject === 'Zucchine');
  assert.ok(last !== undefined);
  const { files, parent } = await readCommitDiff(idle, PROJECTS, 'orto', last.id);
  assert.notEqual(parent, null);
  const env = files.find((file) => file.path === '.env');
  assert.deepEqual(env, { path: '.env', change: 'modified', error: 'covered' });
  const seasons = files.find((file) => file.path === 'src/seasons.ts');
  assert.ok(seasons !== undefined && 'hunks' in seasons);
  const lines = seasons.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
  assert.ok(lines.some((line) => line.includes('zucchine')));
  assert.ok(!JSON.stringify(files).includes('TOKEN'));
  await assert.rejects(readCommitDiff(idle, PROJECTS, 'orto', 'HEAD'), (error) => code(error) === 'not-found');
  await assert.rejects(readCommitDiff(idle, PROJECTS, 'orto', 'f'.repeat(40)), (error) => code(error) === 'not-found');
});

test('isSecretPath (D-135): .env, keys, credentials and .git/config; examples and ordinary files are not', () => {
  for (const path of ['.env', '.env.local', 'app/.env.production', '.npmrc', '.netrc', '.git-credentials', 'id_rsa', 'home/id_ed25519', 'certs/server.key', 'a.PEM', 'store.p12', 'release.jks', '.git/config', '.git/modules/lib/config', '.GIT/config']) {
    assert.equal(isSecretPath(path), true, path);
  }
  for (const path of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'README.md', 'src/env.ts', 'config', 'src/config', 'id_rsa.pub', 'keys.ts', '.key', 'environment.md', '.github/ci.yml']) {
    assert.equal(isSecretPath(path), false, path);
  }
});

test('a folder with the consent (D-135): hidden entries, node_modules and .git open; links out stay shut; secrets marked', async () => {
  const byName = Object.fromEntries((await listProjectDir(PROJECTS, 'orto', '', true)).entries.map((entry) => [entry.name, entry]));
  assert.deepEqual(byName['.git'], { name: '.git', kind: 'dir', size: null });
  assert.equal(byName['.github']?.shut, undefined);
  assert.equal(byName.node_modules?.shut, undefined);
  assert.equal(byName['.env']?.secret, true);
  assert.equal(byName['.env.example']?.secret, undefined);
  assert.equal(byName['fuori.txt']?.shut, 'outside');
  assert.equal(byName.src2?.shut, undefined);
  assert.equal((await listProjectDir(PROJECTS, 'orto', 'certs')).entries[0]?.secret, true);
  // A link is marked by where it leads; an ordinary file is not marked.
  assert.equal(byName['note.txt']?.secret, true);
  assert.equal(byName['chiave.txt']?.secret, true);
  assert.equal(byName['README.md']?.secret, undefined);
  assert.equal((await listProjectDir(PROJECTS, 'orto', '')).entries.find((entry) => entry.name === 'chiave.txt')?.secret, true);
  for (const dir of ['.git', '.git/refs', 'node_modules/vue', 'src2', '.github']) {
    assert.ok((await listProjectDir(PROJECTS, 'orto', dir, true)).entries.length > 0, dir);
  }
  for (const dir of ['..', 'src/../..', '/etc', 'src/']) {
    await assert.rejects(listProjectDir(PROJECTS, 'orto', dir, true), (error) => code(error) === 'refused', dir);
  }
});

test('a file with the consent (D-135): hidden files and .git read, secrets covered until reveal, vault values never', async () => {
  const shown = { showHidden: true };
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', '.github/ci.yml', shown)).text, 'name: ci\n');
  assert.match((await readBrowsedFile(PROJECTS, 'orto', '.git/HEAD', shown)).text, /refs\/heads\/main/);
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', 'node_modules/vue/index.js', shown)).text, 'x\n');
  // "Apri" never serves a hidden file, consent or not.
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', '.ombra.html', shown)).openable, false);
  for (const path of ['.env', '.git/config', 'note.txt', 'src2/config']) {
    const covered = await readBrowsedFile(PROJECTS, 'orto', path, shown);
    assert.equal(covered.covered, true, path);
    assert.equal(covered.text, '', path);
  }
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', '.env', { showHidden: true, reveal: true })).text, 'TOKEN=altro\n');
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', '.env', { showHidden: true, reveal: true })).covered, undefined);
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', '.env.example', shown)).covered, undefined);
  // A secret that is not hidden is covered without the consent too.
  const key = await readBrowsedFile(PROJECTS, 'orto', 'certs/server.key');
  assert.deepEqual([key.covered, key.text], [true, '']);
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', 'certs/server.key', { reveal: true })).text, 'chiave finta\n');
  await assert.rejects(readBrowsedFile(PROJECTS, 'orto', '.vault-note', shown), (error) => code(error) === 'refused');
  // Without the consent a link to a hidden secret is refused, never covered.
  await assert.rejects(readBrowsedFile(PROJECTS, 'orto', 'note.txt'), (error) => code(error) === 'refused');
  await assert.rejects(readBrowsedFile(PROJECTS, 'orto', 'src2/config'), (error) => code(error) === 'refused');
  // A link with an ordinary name to a secret that is not hidden: covered without the consent too.
  const linked = await readBrowsedFile(PROJECTS, 'orto', 'chiave.txt');
  assert.deepEqual([linked.covered, linked.text], [true, '']);
  assert.equal((await readBrowsedFile(PROJECTS, 'orto', 'README.md', { reveal: true })).secret, undefined);
  await assert.rejects(readBrowsedFile(PROJECTS, 'orto', 'fuori.txt', shown), (error) => code(error) === 'refused');
});

test('a commit diff with the consent (D-135): a file renamed from a hidden one shown, a secret still covered', async () => {
  const log = (await readProjectGit(idle, PROJECTS, 'orto')).log;
  const renamed = log.find((item) => item.subject === 'Rinomina');
  const zucchine = log.find((item) => item.subject === 'Zucchine');
  assert.ok(renamed !== undefined && zucchine !== undefined);
  const [rename] = (await readCommitDiff(idle, PROJECTS, 'orto', renamed.id, true)).files;
  assert.ok(rename !== undefined && 'hunks' in rename);
  const { files } = await readCommitDiff(idle, PROJECTS, 'orto', zucchine.id, true);
  assert.deepEqual(files.find((file) => file.path === '.env'), { path: '.env', change: 'modified', error: 'covered' });
  assert.ok(!JSON.stringify(files).includes('TOKEN'));
});
