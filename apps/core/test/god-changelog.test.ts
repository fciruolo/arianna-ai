// "Parlane con GOD" (I-6, D-178): the context of a conversation with GOD
// about an entry of "Novità", written by the code from the installation's
// git. Every text here is invented.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { parseChangelog } from '../src/changelog.ts';
import { ChatError, type Conversation } from '../src/conversations.ts';
import type { Sql } from '../src/db/client.ts';
import type { GodApi } from '../src/god/api.ts';
import { CARRY_MAX_CHARS } from '../src/god/carry.ts';
import {
  changelogCarry,
  changelogCarryBody,
  changelogRefOf,
  changelogTitle,
  citedIds,
  findChangelogEntry,
  parseNumstat,
  versionGit,
  type ChangelogEntry,
  type ChangelogRef,
} from '../src/god/changelog-carry.ts';
import { godGit } from '../src/god/clone.ts';
import { gitEnv } from '../src/git-catalog.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'arianna-god-changelog-'));
  roots.push(root);
  return root;
}

const GIT_ENV = { ...gitEnv(process.env, 'file', temporary()), GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function commit(repo: string, message: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

const CHANGELOG = `# Registro delle versioni

## [Non rilasciato]

### Aggiunto

- Una funzione nuova ancora da rilasciare (I-6, D-178).

## [0.2.0] - 2026-10-02

### Aggiunto

- La **barra della quota** nella pagina finta, con \`quota.ts\` (D-127, I-5 G2, D-127).

### Corretto

- Un errore finto nella barra (D-150).

## [0.1.0] - 2026-10-01

### Aggiunto

- Il primo avvio finto (D-001).
`;

/** A fake ARIANNA_HOME on main: v0.1.0, then two commits and v0.2.0, a tag off main, and an uncommitted change. */
function fakeHome(): { home: string; data: string } {
  const home = temporary();
  git(home, 'init', '-q');
  commit(home, 'Primo avvio', { '.gitignore': 'data/\nrepos/\n', 'README.md': 'finto\n' });
  git(home, 'tag', '-a', 'v0.1.0', '-m', '0.1.0');
  commit(home, 'Calcolo della quota', { 'apps/core/src/quota.ts': 'export const QUOTA_SECRET_BODY = 1;\nexport const two = 2;\n' });
  commit(home, '0.2.0: barra della quota', { 'apps/hud/src/bar.vue': '<template />\n', 'logo.png': Buffer.from([0, 1, 2, 0, 3]).toString('binary'), 'CHANGELOG.md': CHANGELOG });
  git(home, 'tag', '-a', 'v0.2.0', '-m', '0.2.0');
  git(home, 'checkout', '-q', '-b', 'altro');
  commit(home, 'Un ramo non unito', { 'other.ts': 'export {};\n' });
  git(home, 'tag', 'v0.3.0');
  git(home, 'checkout', '-q', 'main');
  // The working tree has an entry not committed: never read.
  writeFileSync(join(home, 'CHANGELOG.md'), CHANGELOG.replace('### Corretto\n', '### Corretto\n\n- Una voce solo nella cartella (D-999).\n'));
  return { home, data: join(home, 'data') };
}

test('the body of the route is checked as it came over the wire', () => {
  assert.deepEqual(changelogRefOf({ version: '0.2.0', section: ' Aggiunto ', text: ' una voce ' }), { version: '0.2.0', section: 'Aggiunto', text: 'una voce' });
  assert.deepEqual(changelogRefOf({ version: null, section: 'Aggiunto', text: 'x' }).version, null);
  for (const body of [
    { version: 'v0.2.0', section: 'Aggiunto', text: 'x' },
    { version: '0.2', section: 'Aggiunto', text: 'x' },
    { version: undefined, section: 'Aggiunto', text: 'x' },
    { version: '0.2.0', section: '', text: 'x' },
    { version: '0.2.0', section: 'Aggiunto', text: 42 },
    { version: '0.2.0', section: 'Aggiunto', text: '   ' },
    { version: '0.2.0', section: 'x'.repeat(81), text: 'x' },
  ]) {
    assert.throws(() => changelogRefOf(body), (error: unknown) => error instanceof ChatError && error.code === 'invalid', JSON.stringify(body));
  }
});

test('an entry is found by version, section and exact text; anything else is not', () => {
  const changelog = parseChangelog(CHANGELOG);
  const text = 'Un errore finto nella barra (D-150).';
  assert.deepEqual(findChangelogEntry(changelog, { version: '0.2.0', section: 'corretto', text }), { version: '0.2.0', date: '2026-10-02', section: 'Corretto', text });
  assert.equal(findChangelogEntry(changelog, { version: null, section: 'Aggiunto', text: 'Una funzione nuova ancora da rilasciare (I-6, D-178).' })?.version, null);
  assert.equal(findChangelogEntry(changelog, { version: '0.1.0', section: 'Corretto', text }), undefined, 'another version');
  assert.equal(findChangelogEntry(changelog, { version: '0.2.0', section: 'Aggiunto', text }), undefined, 'another section');
  assert.equal(findChangelogEntry(changelog, { version: '0.2.0', section: 'Corretto', text: 'Un errore inventato dalla pagina.' }), undefined, 'a text the register does not have');
  assert.equal(findChangelogEntry(changelog, { version: '9.9.9', section: 'Corretto', text }), undefined);
});

test('the decisions and proposals an entry cites, once each', () => {
  assert.deepEqual(citedIds('La barra (D-127, I-5 G2, D-127, D-064b).'), ['D-127', 'I-5', 'D-064b']);
  assert.deepEqual(citedIds('Niente qui: IM-3, D-12, XD-123, AI-5.'), []);
});

test('numstat with -z: counts, binary files, odd names', () => {
  assert.deepEqual(parseNumstat('3\t1\ta.ts\0-\t-\tlogo.png\0' + '2\t0\tcon spazio.md\0\0'), [
    { path: 'a.ts', added: 3, removed: 1 },
    { path: 'logo.png', added: null, removed: null },
    { path: 'con spazio.md', added: 2, removed: 0 },
  ]);
  assert.deepEqual(parseNumstat('1\t1\tnome\nstrano.ts\0'), [{ path: 'nome strano.ts', added: 1, removed: 1 }], 'control characters do not reach GOD');
  assert.deepEqual(parseNumstat(''), []);
});

test('git of a version: the commits since the tag before and the files they touched, names and counts only', async () => {
  const { home, data } = fakeHome();
  const run = godGit(home, data);
  const facts = await versionGit(run, home, '0.2.0');
  assert.ok(typeof facts !== 'string', typeof facts === 'string' ? facts : '');
  assert.equal(facts.tag, 'v0.2.0');
  assert.equal(facts.previous, 'v0.1.0');
  assert.deepEqual(facts.commits.map((item) => item.subject), ['0.2.0: barra della quota', 'Calcolo della quota']);
  assert.equal(facts.moreCommits, 0);
  assert.deepEqual(facts.files.map((file) => file.path).sort(), ['CHANGELOG.md', 'apps/core/src/quota.ts', 'apps/hud/src/bar.vue', 'logo.png']);
  assert.equal(facts.files.find((file) => file.path === 'logo.png')?.added, null);
  assert.equal(facts.files.find((file) => file.path === 'apps/core/src/quota.ts')?.added, 2);
  // The first tag: only its own commit.
  const first = await versionGit(run, home, '0.1.0');
  assert.ok(typeof first !== 'string');
  assert.equal(first.previous, null);
  assert.deepEqual(first.commits.map((item) => item.subject), ['Primo avvio']);
  assert.deepEqual(first.files.map((file) => file.path).sort(), ['.gitignore', 'README.md']);
  // A tag off main, or no tag: a reason, nothing of the branch.
  assert.equal(await versionGit(run, home, '0.3.0'), 'the tag v0.3.0 is not on main');
  assert.equal(await versionGit(run, home, '0.4.0'), 'the installation\'s git has no tag v0.4.0');
});

test('the context of an entry comes from main in git: ids, commits, files, never contents nor the working tree', async () => {
  const { home, data } = fakeHome();
  const run = godGit(home, data);
  const carry = await changelogCarry(run, home, { version: '0.2.0', section: 'Aggiunto', text: 'La **barra della quota** nella pagina finta, con `quota.ts` (D-127, I-5 G2, D-127).' });
  assert.equal(carry.label, 'L1');
  assert.equal(carry.source, '0.2.0');
  assert.match(carry.title, /^Su 0\.2\.0: La barra della quota nella pagina finta/);
  assert.match(carry.body, /version 0\.2\.0 of 2026-10-02, section «Aggiunto»/);
  assert.match(carry.body, /It cites: D-127, I-5\./);
  assert.match(carry.body, /tag v0\.2\.0 on commit [0-9a-f]{12}, since v0\.1\.0/);
  assert.match(carry.body, /- [0-9a-f]+ Calcolo della quota/);
  assert.match(carry.body, /- apps\/core\/src\/quota\.ts \+2 -0/);
  assert.match(carry.body, /- logo\.png \(binary\)/);
  assert.doesNotMatch(carry.body, /QUOTA_SECRET_BODY/, 'the contents of a file never');
  assert.doesNotMatch(carry.body, /Un ramo non unito|other\.ts/, 'nothing off main');
  // Not released: no git, and the ids.
  const unreleased = await changelogCarry(run, home, { version: null, section: 'Aggiunto', text: 'Una funzione nuova ancora da rilasciare (I-6, D-178).' });
  assert.equal(unreleased.source, 'unreleased');
  assert.match(unreleased.title, /^Su non rilasciato: /);
  assert.match(unreleased.body, /no tag yet/);
  // An entry only in the working tree, or invented by the page: refused.
  await assert.rejects(changelogCarry(run, home, { version: '0.2.0', section: 'Corretto', text: 'Una voce solo nella cartella (D-999).' }), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
  await assert.rejects(changelogCarry(run, home, { version: '0.2.0', section: 'Corretto', text: 'Una voce inventata.' }), ChatError);
});

test('without CHANGELOG.md on main the context is refused', async () => {
  const home = temporary();
  git(home, 'init', '-q');
  commit(home, 'start', { 'README.md': 'finto\n' });
  writeFileSync(join(home, 'CHANGELOG.md'), CHANGELOG);
  await assert.rejects(changelogCarry(godGit(home, join(home, 'data')), home, { version: '0.1.0', section: 'Aggiunto', text: 'Il primo avvio finto (D-001).' }), (error: unknown) => error instanceof ChatError && error.code === 'not-found');
});

test('the body stays within the limit of a summary, and the title is short and plain', () => {
  const entry: ChangelogEntry = { version: '1.2.3', date: null, section: 'Aggiunto', text: `Una voce lunga ${'parola '.repeat(800)}(D-127).` };
  const files = Array.from({ length: 60 }, (_, index) => ({ path: `apps/core/src/${'cartella/'.repeat(10)}file-${String(index)}.ts`, added: index, removed: 1 }));
  const body = changelogCarryBody(entry, { tag: 'v1.2.3', commit: 'a'.repeat(40), previous: 'v1.2.2', commits: [{ sha: 'abc1234', subject: 'Un commit' }], moreCommits: 30, files, moreFiles: 10 });
  assert.ok(body.length <= CARRY_MAX_CHARS, String(body.length));
  assert.match(body, /\(the latest 1\)/);
  assert.ok(changelogTitle(entry).length <= 80);
  assert.equal(changelogTitle({ ...entry, text: 'Il [link](https://example.invalid) e `codice`' }), 'Su 1.2.3: Il link e codice');
  assert.match(changelogCarryBody(entry, 'the tag v1.2.3 is not on main'), /Git: the tag v1\.2\.3 is not on main\./);
});

function send(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the route checks the body before GOD, and answers 404 without the work of GOD', async (t) => {
  const asked: ChangelogRef[] = [];
  const work = {
    discuss: (ref: ChangelogRef) => {
      asked.push(ref);
      return Promise.resolve({ id: '7d9f1c2e-1111-4a5b-8c9d-0123456789ab' } as Conversation);
    },
  } as unknown as NonNullable<GodApi['work']>;
  const unused = (): Promise<never> => Promise.reject(new Error('unused'));
  const god: GodApi = { status: unused, syncClone: unused, work };
  const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, god });
  const bare = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, god: { status: unused, syncClone: unused } });
  t.after(async () => {
    await server.close();
    await bare.close();
  });
  const ok = await send(server.port, 'POST', '/api/god/changelog', { version: '0.2.0', section: 'Aggiunto', text: 'Una voce' });
  assert.equal(ok.status, 201);
  assert.equal((ok.body.conversation as { id: string }).id, '7d9f1c2e-1111-4a5b-8c9d-0123456789ab');
  assert.deepEqual(asked, [{ version: '0.2.0', section: 'Aggiunto', text: 'Una voce' }]);
  assert.equal((await send(server.port, 'POST', '/api/god/changelog', { version: '0.2.0', section: 'Aggiunto', text: 'x', body: 'altro' })).status, 400, 'an unknown field');
  assert.equal((await send(server.port, 'POST', '/api/god/changelog', { version: '../0.2.0', section: 'Aggiunto', text: 'x' })).status, 400);
  assert.equal((await send(server.port, 'POST', '/api/god/changelog', { version: null, section: 'Aggiunto' })).status, 400);
  assert.equal(asked.length, 1, 'GOD is never asked for a body that does not pass');
  assert.equal((await send(bare.port, 'POST', '/api/god/changelog', { version: null, section: 'Aggiunto', text: 'x' })).status, 404);
});
