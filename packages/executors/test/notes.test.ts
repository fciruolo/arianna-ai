// The read-only copy of a project's notes for the Coder (I-11 P3, D-166), with
// the fake binaries: what the copy holds, and how each profile opens it and
// closes the container of the part.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  ClaudeError,
  CodexError,
  createClaudeExecutor,
  createCodexExecutor,
  MAX_CODER_NOTES,
  openRepository,
  prepareProjectNotes,
  preparedNotes,
  removeProjectNotes,
  removeWorkspace,
  workspaceContainer,
  WorkspaceError,
} from '@arianna/executors';
import { createContext, gatewayCheck, markLogged, secretMatcher, type Label, type Target } from '@arianna/policy';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `notes-${randomUUID()}`);
const DATA = join(HOME, 'data');
const CONTAINER = join(HOME, 'repos', 'progetto');
const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const CODEX: Target = { kind: 'executor', id: 'codex', locality: 'cloud' };
/** Fake, and unique: it must never reach a run. */
const CANARY = `CANARY-${randomUUID()}-FAKE`;
const PROJECT = { name: 'progetto', absolute: CONTAINER, label: 'L1' as const };

before(() => {
  const part = join(CONTAINER, 'progetto-admin');
  mkdirSync(part, { recursive: true });
  writeFileSync(join(part, 'a.ts'), 'export {};\n');
  mkdirSync(join(CONTAINER, 'Workplan'), { recursive: true });
  writeFileSync(join(CONTAINER, 'Workplan', 'piano.md'), '---\nlabel: L1\n---\n\nPiano finto.\n');
  mkdirSync(join(CONTAINER, 'documenti'), { recursive: true });
  writeFileSync(join(CONTAINER, 'documenti', 'fattura.md'), `---\nlabel: L2\n---\n\n${CANARY}\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', part, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(async () => {
  // The copies are read only: removed through removeProjectNotes, then the rest.
  for (const name of existsSync(join(DATA, 'worktrees')) ? readdirSync(join(DATA, 'worktrees')) : []) {
    if (name.endsWith('.notes')) await removeProjectNotes({ data: DATA, runId: name.slice(0, -'.notes'.length) });
  }
  rmSync(HOME, { recursive: true, force: true });
});

/** An allow as passGateway leaves it, for one text. */
function allow(text: string, target: Target = CLAUDE, label: Label = 'L1', logged = true) {
  const decision = gatewayCheck([{ value: text, label, source: 'test' }], createContext('L1', label), target, secretMatcher([]));
  assert.equal(decision.decision, 'allow');
  if (logged) markLogged(decision);
  return decision;
}

const runId = () => `run-${randomUUID()}`;

describe('prepareProjectNotes (D-166)', () => {
  it('writes exactly the texts the gateway let out, read only, and removes them', async () => {
    const id = runId();
    const notes = await prepareProjectNotes({
      data: DATA,
      runId: id,
      executor: 'claude',
      notes: [
        { path: 'Workplan/piano.md', decision: allow('Piano finto.') },
        { path: 'IM/2026/riunione.md', decision: allow('Riunione finta.', CLAUDE, 'L0') },
      ],
    });
    assert.deepEqual(notes.files, ['Workplan/piano.md', 'IM/2026/riunione.md']);
    assert.equal(notes.label, 'L1');
    assert.equal(notes.path, realpathSync(join(DATA, 'worktrees', `${id}.notes`)));
    assert.equal(readFileSync(join(notes.path, 'Workplan', 'piano.md'), 'utf8'), 'Piano finto.');
    assert.equal(statSync(join(notes.path, 'Workplan', 'piano.md')).mode & 0o777, 0o400);
    assert.equal(statSync(join(notes.path, 'IM', '2026')).mode & 0o777, 0o500);
    assert.equal(statSync(notes.path).mode & 0o777, 0o500);
    assert.deepEqual(preparedNotes(notes), { path: notes.path, executor: 'claude' });
    assert.equal(preparedNotes({ ...notes }), undefined, 'a copy of the object is not a prepared copy');
    await removeWorkspace({ data: DATA, runId: id });
    assert.equal(existsSync(notes.path), false);
  });

  it('refuses a note the gateway did not let out towards this executor, a note above L1, an unlogged decision', async () => {
    const cases: [string, unknown][] = [
      ['not a decision', { decision: 'allow', texts: ['x'] }],
      ['towards codex', allow('x', CODEX)],
      ['unlogged', allow('x', CLAUDE, 'L1', false)],
      ['two texts', (() => {
        const decision = gatewayCheck(
          [
            { value: 'a', label: 'L1', source: 'test' },
            { value: 'b', label: 'L1', source: 'test' },
          ],
          createContext('L1'),
          CLAUDE,
          secretMatcher([]),
        );
        markLogged(decision);
        return decision;
      })()],
    ];
    for (const [name, decision] of cases) {
      const id = runId();
      await assert.rejects(prepareProjectNotes({ data: DATA, runId: id, executor: 'claude', notes: [{ path: 'Workplan/x.md', decision }] }), WorkspaceError, name);
      assert.equal(existsSync(join(DATA, 'worktrees', `${id}.notes`)), false, name);
    }
    // An L2 text never gets an allow towards the cloud in the first place.
    const blocked = gatewayCheck([{ value: CANARY, label: 'L2', source: 'test' }], createContext('L2', 'L2'), CLAUDE, secretMatcher([]));
    assert.equal(blocked.decision, 'block');
    await assert.rejects(prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: [{ path: 'documenti/fattura.md', decision: blocked }] }), WorkspaceError);
  });

  it('refuses paths that are not plain notes, instruction files, duplicates and too many notes, before spending anything', async () => {
    for (const path of ['../x.md', '/abs/x.md', 'x.md', 'Workplan/CLAUDE.md', 'Workplan/AGENTS.md', '.claude/x.md', 'Workplan/x.txt']) {
      const decision = allow('x');
      await assert.rejects(prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: [{ path, decision }] }), WorkspaceError, path);
    }
    const twice = [allow('a'), allow('b')];
    await assert.rejects(prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: [{ path: 'Workplan/a.md', decision: twice[0] }, { path: 'workplan/A.md', decision: twice[1] }] }), /twice/);
    // Nothing was spent: the first decision still opens a copy.
    const ok = await prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: [{ path: 'Workplan/a.md', decision: twice[0] }] });
    assert.deepEqual(ok.files, ['Workplan/a.md']);
    const many = Array.from({ length: MAX_CODER_NOTES + 1 }, (_, index) => ({ path: `Workplan/n${String(index)}.md`, decision: allow('n') }));
    await assert.rejects(prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: many }), WorkspaceError);
    await assert.rejects(prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: [] }), WorkspaceError);
  });
});

describe('the profiles open the copy and close the container (D-166)', () => {
  const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.ts');
  const FAKE_CODEX = join(import.meta.dirname, 'fixtures', 'fake-codex.ts');

  it('openRepository remembers the container of a part, never of a whole project', async () => {
    const part = await openRepository({ home: HOME, project: PROJECT, part: 'progetto-admin' });
    assert.equal(workspaceContainer(part), realpathSync(CONTAINER));
    assert.equal(workspaceContainer({ ...part }), undefined);
  });

  it('claude: --add-dir and allowRead for the copy, denyRead for the container; the private note is nowhere', async () => {
    const part = await openRepository({ home: HOME, project: PROJECT, part: 'progetto-admin' });
    const id = runId();
    const notes = await prepareProjectNotes({ data: DATA, runId: id, executor: 'claude', notes: [{ path: 'Workplan/piano.md', decision: allow('Piano finto.') }] });
    const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE_CLAUDE] }, home: HOME, killGraceMs: 200 });
    await claude.start({ brief: allow('scenario: ok'), workspace: part, notes, model: 'sonnet', tools: ['Read', 'Bash'] }).result;
    const path = part.path ?? '';
    const received = JSON.parse(readFileSync(join(path, '.fake-claude.json'), 'utf8')) as { argv: string[]; prompt: string };
    rmSync(join(path, '.fake-claude.json'));
    assert.ok(received.argv.includes(`--add-dir=${notes.path}`));
    const settings = JSON.parse(received.argv[received.argv.indexOf('--settings') + 1] ?? '') as { sandbox: { filesystem: { denyRead: string[]; allowRead: string[] } } };
    assert.ok(settings.sandbox.filesystem.allowRead.includes(notes.path));
    assert.ok(settings.sandbox.filesystem.denyRead.includes(realpathSync(CONTAINER)));
    assert.equal(settings.sandbox.filesystem.allowRead[0], realpathSync(path), 'the part is opened again');
    assert.ok(!JSON.stringify(received).includes(CANARY));
    assert.ok(!received.argv.some((arg) => arg.includes('documenti')));
    await removeProjectNotes({ data: DATA, runId: id });
  });

  it('claude: a copy made for codex, a forged one or a removed one is refused before the brief is spent', async () => {
    const part = await openRepository({ home: HOME, project: PROJECT, part: 'progetto-admin' });
    const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [FAKE_CLAUDE] }, home: HOME, killGraceMs: 200 });
    const forCodex = await prepareProjectNotes({ data: DATA, runId: runId(), executor: 'codex', notes: [{ path: 'Workplan/piano.md', decision: allow('x', CODEX) }] });
    const id = runId();
    const removed = await prepareProjectNotes({ data: DATA, runId: id, executor: 'claude', notes: [{ path: 'Workplan/piano.md', decision: allow('x') }] });
    await removeProjectNotes({ data: DATA, runId: id });
    for (const notes of [forCodex, { ...forCodex }, removed]) {
      const brief = allow('scenario: ok');
      await assert.rejects(claude.start({ brief, workspace: part, notes, model: 'sonnet', tools: ['Read'] }).result, (error: unknown) => error instanceof ClaudeError && error.kind === 'workspace');
    }
  });

  it('codex: the copy read, the container denied, the part opened again', async () => {
    const part = await openRepository({ home: HOME, project: PROJECT, part: 'progetto-admin' });
    const id = runId();
    const notes = await prepareProjectNotes({ data: DATA, runId: id, executor: 'codex', notes: [{ path: 'Workplan/piano.md', decision: allow('Piano finto.', CODEX) }] });
    const userHome = join(HOME, 'user-home');
    mkdirSync(userHome, { recursive: true });
    const codex = createCodexExecutor({
      enabled: ['codex'],
      command: { file: process.execPath, args: [FAKE_CODEX] },
      home: HOME,
      readable: [],
      env: { ...process.env, HOME: userHome },
      killGraceMs: 200,
      modelName: () => 'gpt-6.1-sol',
    });
    await codex.start({ brief: allow('scenario: ok', CODEX), workspace: part, notes, model: 'sol', access: 'write' }).result;
    const path = part.path ?? '';
    const received = JSON.parse(readFileSync(join(path, '.fake-codex.json'), 'utf8')) as { argv: string[]; prompt: string };
    rmSync(join(path, '.fake-codex.json'));
    const filesystem = received.argv.find((arg) => arg.startsWith('permissions.arianna.filesystem=')) ?? '';
    assert.ok(filesystem.includes(`"${notes.path}"="read"`));
    assert.ok(filesystem.includes(`"${realpathSync(CONTAINER)}"="deny"`));
    assert.ok(filesystem.includes(`"${realpathSync(path)}"="write"`));
    assert.ok(!JSON.stringify(received).includes(CANARY));
    const forClaude = await prepareProjectNotes({ data: DATA, runId: runId(), executor: 'claude', notes: [{ path: 'Workplan/piano.md', decision: allow('x') }] });
    await assert.rejects(codex.start({ brief: allow('scenario: ok', CODEX), workspace: part, notes: forClaude, model: 'sol', access: 'read' }).result, (error: unknown) => error instanceof CodexError && error.kind === 'workspace');
    await removeProjectNotes({ data: DATA, runId: id });
    assert.equal(lstatSync(CONTAINER).isDirectory(), true);
  });
});
