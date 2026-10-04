// Workspaces from real git repositories, in a scratch ARIANNA_HOME under data/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import {
  gitConfigFingerprint,
  openRepository,
  prepareEmptyWorkspace,
  preparedPath,
  prepareWorkspace,
  removeWorkspace,
  reopenWorkspace,
  repositoryStatus,
  scanWorkspace,
  WorkspaceError,
} from '@arianna/executors';
import { createLabelRules } from '@arianna/policy';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `workspace-${randomUUID()}`);
const DATA = join(HOME, 'data');
const RULES = createLabelRules({
  folders: [
    { path: 'repos', label: 'L1' },
    { path: 'repos/leaky/private', label: 'L2' },
  ],
  sources: [],
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A repository under repos/<name> with the given files committed. */
function makeRepo(name: string, files: Record<string, string>, links: Record<string, string> = {}): string {
  const dir = join(HOME, 'repos', name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '--initial-branch=main');
  write(dir, files);
  for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '--allow-empty', '--message', 'fixture');
  return `repos/${name}`;
}

/** An approved project for a folder of the scratch ARIANNA_HOME (`repos/<name>`), at L1. */
const project = (repo: string) => ({ name: repo.split('/').at(-1) ?? repo, absolute: join(HOME, repo), label: 'L1' as const });

const options = (repo: string, allowlist: string[] = [repo]) => ({
  home: HOME,
  data: DATA,
  repo,
  runId: randomUUID(),
  allowlist,
  rules: RULES,
});

const findings = (prepared: Awaited<ReturnType<typeof prepareWorkspace>>): string[] | false =>
  prepared.decision.decision === 'block' && prepared.decision.findings.map((finding) => `${finding.kind}:${finding.path}`);

describe('prepareWorkspace', () => {
  it('writes an allowlisted, clean commit into data/worktrees/<run> as a new one-commit repository', async () => {
    const repo = makeRepo('clean', { 'src/index.ts': 'export {};\n' }, { latest: 'src/index.ts' });
    const opts = options(repo);
    const prepared = await prepareWorkspace(opts);
    assert.equal(prepared.decision.decision, 'allow');
    assert.equal(prepared.path, join(DATA, 'worktrees', opts.runId));
    assert.equal(readFileSync(join(prepared.path, 'src', 'index.ts'), 'utf8'), 'export {};\n');
    assert.equal(readlinkSync(join(prepared.path, 'latest')), 'src/index.ts');
    assert.equal(git(prepared.path, 'rev-list', '--count', 'HEAD').trim(), '1');
    assert.equal(git(prepared.path, 'status', '--porcelain'), '');
    // The executor's repository knows nothing of the source repository.
    assert.ok(lstatSync(join(prepared.path, '.git')).isDirectory());
    assert.doesNotMatch(readFileSync(join(prepared.path, '.git', 'config'), 'utf8'), /repos\/|worktree|remote/);
    assert.equal(existsSync(join(prepared.path, '.git', 'objects', 'info', 'alternates')), false);
    // Only this object opens the folder to an executor; a copy of it does not.
    assert.equal(preparedPath(prepared), prepared.path);
    assert.equal(preparedPath({ ...prepared }), undefined);
    assert.ok(Object.isFrozen(prepared));
    await removeWorkspace(opts);
    assert.equal(existsSync(prepared.path), false);
  });

  it('keeps the executable bit', async () => {
    const repo = makeRepo('exec', { 'run.sh': '#!/bin/sh\n' });
    chmodSync(join(HOME, repo, 'run.sh'), 0o755);
    git(join(HOME, repo), 'add', '--all');
    git(join(HOME, repo), 'commit', '--quiet', '--message', 'exec');
    const prepared = await prepareWorkspace(options(repo));
    assert.ok(prepared.path !== undefined);
    assert.equal(lstatSync(join(prepared.path, 'run.sh')).mode & 0o111, 0o111);
  });

  it('a secret deleted from the history is not reachable from the workspace', async () => {
    const repo = makeRepo('history', { '.env': 'TOKEN=fake-history-secret\n', 'a.ts': '' });
    git(join(HOME, repo), 'rm', '--quiet', '.env');
    git(join(HOME, repo), 'commit', '--quiet', '--message', 'remove secret');
    const prepared = await prepareWorkspace(options(repo));
    assert.ok(prepared.path !== undefined);
    assert.equal(git(prepared.path, 'log', '--all', '-p').includes('fake-history-secret'), false);
  });

  it('runs no filter, hook or fsmonitor configured in the source repository', async () => {
    const repo = makeRepo('hostile', { 'a.ts': 'x\n', '.gitattributes': '*.ts filter=evil\n' });
    const dir = join(HOME, repo);
    const marker = join(HOME, `ran-${randomUUID()}`);
    git(dir, 'config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`);
    git(dir, 'config', 'filter.evil.required', 'true');
    git(dir, 'config', 'core.fsmonitor', `sh -c 'touch ${marker}'`);
    write(dir, { '.git/hooks/post-checkout': `#!/bin/sh\ntouch ${marker}\n` });
    chmodSync(join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
    const prepared = await prepareWorkspace(options(repo));
    assert.equal(prepared.decision.decision, 'allow');
    assert.equal(existsSync(marker), false);
    assert.ok(prepared.path !== undefined);
    assert.equal(readFileSync(join(prepared.path, 'a.ts'), 'utf8'), 'x\n');
  });

  it('refuses a repository outside the allowlist without creating anything', async () => {
    const repo = makeRepo('unlisted', { 'a.ts': '' });
    const opts = options(repo, ['repos/clean']);
    const prepared = await prepareWorkspace(opts);
    assert.equal(prepared.decision.decision === 'block' && prepared.decision.rule, 'not-allowlisted');
    assert.equal(preparedPath(prepared), undefined);
    assert.equal(existsSync(join(DATA, 'worktrees', opts.runId)), false);
  });

  it('a committed secret or private file blocks the launch and the workspace is removed', async () => {
    const repo = makeRepo('leaky', { 'src/a.ts': '', '.env': 'TOKEN=fake\n', 'private/contract.md': 'fake\n' });
    const opts = options(repo);
    const prepared = await prepareWorkspace(opts);
    assert.deepEqual(findings(prepared), ['secret-file:.env', 'label:private', 'label:private/contract.md']);
    assert.equal(prepared.path, undefined);
    assert.equal(existsSync(join(DATA, 'worktrees', opts.runId)), false);
  });

  it('a committed link that leaves the workspace blocks the launch', async () => {
    const repo = makeRepo('linked', { 'a.ts': '' }, { outside: '/etc/hosts', inside: 'a.ts' });
    assert.deepEqual(findings(await prepareWorkspace(options(repo))), ['symlink-outside:outside']);
  });

  it('refuses an allowlisted folder that is a symbolic link', async () => {
    makeRepo('real', { 'a.ts': '' });
    symlinkSync('real', join(HOME, 'repos', 'alias'));
    await assert.rejects(prepareWorkspace(options('repos/alias')), /symbolic link/);
  });

  it('refuses a folder that is not the top of a git repository', async () => {
    makeRepo('outer', { 'sub/a.ts': '' });
    await assert.rejects(prepareWorkspace(options('repos/outer/sub')), WorkspaceError);
  });

  it('never touches an existing workspace folder', async () => {
    const repo = makeRepo('busy', { 'a.ts': '' });
    const opts = options(repo);
    write(join(DATA, 'worktrees', opts.runId), { 'other-run.txt': 'keep' });
    await assert.rejects(prepareWorkspace(opts), /already exists/);
    assert.equal(readFileSync(join(DATA, 'worktrees', opts.runId, 'other-run.txt'), 'utf8'), 'keep');
  });

  it('refuses run ids and refs that could escape or be read as options', async () => {
    const repo = makeRepo('ids', { 'a.ts': '' });
    await assert.rejects(prepareWorkspace({ ...options(repo), runId: 'x/../../y' }), /invalid run id/);
    await assert.rejects(prepareWorkspace({ ...options(repo), ref: '--orphan' }), /invalid ref/);
    await assert.rejects(prepareWorkspace({ ...options(repo), ref: 'no-such-branch' }));
  });
});

describe('scanWorkspace', () => {
  it('lists files, folders, links and special files without following links', async () => {
    const root = join(HOME, 'scan');
    mkdirSync(join(root, 'dir'), { recursive: true });
    writeFileSync(join(root, 'dir', 'f.txt'), '');
    symlinkSync('dir/f.txt', join(root, 'in'));
    symlinkSync('missing', join(root, 'broken'));
    execFileSync('mkfifo', [join(root, 'pipe')]);
    assert.deepEqual(await scanWorkspace(root), [
      { path: 'broken', kind: 'symlink', target: null },
      { path: 'dir', kind: 'directory' },
      { path: 'dir/f.txt', kind: 'file' },
      { path: 'in', kind: 'symlink', target: 'dir/f.txt' },
      { path: 'pipe', kind: 'other' },
    ]);
  });

  it('a link that passes outside, even if it comes back, has no target', async () => {
    const root = join(HOME, 'scan-chain');
    const outside = join(HOME, 'scan-outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'x.ts'), '');
    symlinkSync(join(root, 'x.ts'), join(outside, 'b'));
    symlinkSync(join(outside, 'b'), join(root, 'absolute'));
    symlinkSync(join('..', 'scan-outside', 'b'), join(root, 'relative'));
    assert.deepEqual(await scanWorkspace(root), [
      { path: 'absolute', kind: 'symlink', target: null },
      { path: 'relative', kind: 'symlink', target: null },
      { path: 'x.ts', kind: 'file' },
    ]);
  });
});

describe('reopenWorkspace', () => {
  it('opens again the folder of an earlier process, files changed by the executor included', async () => {
    const repo = makeRepo('reopen', { 'a.ts': 'x\n' });
    const opts = options(repo);
    const prepared = await prepareWorkspace(opts);
    assert.ok(prepared.path !== undefined);
    writeFileSync(join(prepared.path, 'b.ts'), 'y\n');
    const reopened = await reopenWorkspace(opts);
    assert.equal(reopened.decision.decision, 'allow');
    assert.equal(reopened.path, prepared.path);
    assert.equal(preparedPath(reopened), prepared.path);
    assert.equal(preparedPath({ ...reopened }), undefined);
  });

  it('refuses a folder that is gone, replaced by a link, not the prepared repository, or no longer allowlisted', async () => {
    const repo = makeRepo('reopen-bad', { 'a.ts': 'x\n' });
    const gone = options(repo);
    await assert.rejects(reopenWorkspace(gone), /is gone/);
    const prepared = await prepareWorkspace(gone);
    assert.ok(prepared.path !== undefined);
    const linked = options(repo);
    symlinkSync(prepared.path, join(DATA, 'worktrees', linked.runId));
    await assert.rejects(reopenWorkspace(linked), /symbolic link/);
    const plain = options(repo);
    mkdirSync(join(DATA, 'worktrees', plain.runId));
    await assert.rejects(reopenWorkspace(plain), /not the repository prepareWorkspace made/);
    const blocked = await reopenWorkspace({ ...gone, allowlist: [] });
    assert.equal(blocked.decision.decision, 'block');
    assert.equal(blocked.path, undefined);
  });

  it('scans the files again: a secret the executor wrote blocks the folder', async () => {
    const repo = makeRepo('reopen-leak', { 'a.ts': 'x\n' });
    const opts = options(repo);
    const prepared = await prepareWorkspace(opts);
    assert.ok(prepared.path !== undefined);
    writeFileSync(join(prepared.path, '.env'), 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEKEY0123456789\n');
    const reopened = await reopenWorkspace(opts);
    assert.equal(reopened.decision.decision, 'block');
    assert.ok(existsSync(prepared.path));
  });
});

describe('openRepository (D-056)', () => {
  it('opens the allowlisted folder itself, scanning tracked and untracked files but not ignored ones', async () => {
    const repo = makeRepo('inplace', { 'src/a.ts': 'x\n', '.gitignore': '.env\nbuild/\n' });
    const dir = join(HOME, repo);
    write(dir, { '.env': 'TOKEN=fake-ignored-0123456789abcdef\n', 'build/out.js': '1\n', 'notes.txt': 'untracked\n' });
    const opened = await openRepository({ home: HOME, project: project(repo) });
    assert.equal(opened.decision.decision, 'allow');
    assert.equal(opened.path, dir);
    assert.equal(preparedPath(opened), dir);
    assert.equal(opened.branch, 'main');
    assert.deepEqual(opened.dirty, ['notes.txt']);
    assert.match(opened.decision.reason, /^3 entries/);
  });

  it('a tracked or untracked secret file blocks; a link that leaves the folder blocks', async () => {
    const repo = makeRepo('inplace-secret', { 'a.ts': 'x\n' });
    const dir = join(HOME, repo);
    write(dir, { 'keys.pem': 'fake\n' });
    const blocked = await openRepository({ home: HOME, project: project(repo) });
    assert.equal(blocked.decision.decision, 'block');
    assert.equal(preparedPath(blocked), undefined);
    rmSync(join(dir, 'keys.pem'));
    symlinkSync(DATA, join(dir, 'escape'));
    const linked = await openRepository({ home: HOME, project: project(repo) });
    assert.equal(linked.decision.decision === 'block' && linked.decision.findings.some((f) => f.kind === 'symlink-outside'), true);
  });

  it('refuses a folder through a link, missing, or that is not a git repository', async () => {
    const repo = makeRepo('inplace-plain', { 'a.ts': 'x\n' });
    mkdirSync(join(HOME, 'repos', 'nogit'));
    await assert.rejects(openRepository({ home: HOME, project: project('repos/nogit') }), /not the top folder of a git repository/);
    symlinkSync(join(HOME, repo), join(HOME, 'repos', 'inplace-alias'));
    await assert.rejects(openRepository({ home: HOME, project: project('repos/inplace-alias') }), /symbolic link/);
    await assert.rejects(openRepository({ home: HOME, project: project('repos/missing') }), /does not exist/);
  });

  it('a project above L1 is blocked', async () => {
    const repo = makeRepo('inplace-l2', { 'a.ts': 'x\n' });
    const blocked = await openRepository({ home: HOME, project: { ...project(repo), label: 'L2' } });
    assert.equal(blocked.decision.decision, 'block');
    assert.equal(preparedPath(blocked), undefined);
  });

  // Outside ARIANNA_HOME (D-058): a sibling of the scratch ARIANNA_HOME stands for a folder under the user's home.
  const USER = `${HOME}-user`;
  after(() => {
    rmSync(USER, { recursive: true, force: true });
  });

  function outsideRepo(name: string, files: Record<string, string>): string {
    const dir = join(USER, 'Projects', name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--quiet', '--initial-branch=main');
    write(dir, files);
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', 'fixture');
    return dir;
  }

  it('opens the approved folder where it is, and the link in repos/ does not matter', async () => {
    const dir = outsideRepo('site', { 'index.html': '<h1>fake</h1>\n' });
    mkdirSync(join(HOME, 'repos'), { recursive: true });
    symlinkSync(dir, join(HOME, 'repos', 'site'));
    const opened = await openRepository({ home: HOME, project: { name: 'site', absolute: dir, label: 'L1' } });
    assert.equal(opened.decision.decision, 'allow');
    assert.equal(opened.path, dir);
    assert.equal(preparedPath(opened), dir);
  });

  it('refuses an approved path that became a link, even to another approved-looking folder', async () => {
    const real = outsideRepo('real', { 'a.txt': 'x\n' });
    const alias = join(USER, 'Projects', 'alias');
    symlinkSync(real, alias);
    await assert.rejects(openRepository({ home: HOME, project: { name: 'alias', absolute: alias, label: 'L1' } }), /symbolic link/);
    // A link higher up on the way: the approved path would follow wherever it is turned.
    symlinkSync(join(USER, 'Projects'), join(USER, 'Linked'));
    await assert.rejects(openRepository({ home: HOME, project: { name: 'real', absolute: join(USER, 'Linked', 'real'), label: 'L1' } }), /symbolic link/);
  });

  it('refuses a folder that contains ARIANNA_HOME, and one inside it other than repos/<name>', async () => {
    await assert.rejects(openRepository({ home: HOME, project: { name: 'up', absolute: dirname(HOME), label: 'L1' } }), /contains ARIANNA_HOME/);
    const repo = makeRepo('elsewhere', { 'a.ts': 'x\n' });
    await assert.rejects(openRepository({ home: HOME, project: { name: 'other', absolute: join(HOME, repo), label: 'L1' } }), /only as repos\/other/);
    mkdirSync(DATA, { recursive: true });
    await assert.rejects(openRepository({ home: HOME, project: { name: 'data', absolute: DATA, label: 'L1' } }), /only as repos\/data/);
  });

  it('refuses a relative or unnormalized path', async () => {
    await assert.rejects(openRepository({ home: HOME, project: { name: 'rel', absolute: 'Projects/site', label: 'L1' } }), /must be absolute/);
    await assert.rejects(openRepository({ home: HOME, project: { name: 'dots', absolute: `${USER}/Projects/./site`, label: 'L1' } }), /must be absolute/);
  });

  it('repositoryStatus lists uncommitted paths, staged and unstaged, ignored files left out', async () => {
    const repo = makeRepo('inplace-status', { 'a.ts': 'x\n', 'b.ts': 'y\n', 'e.ts': 'z\n', '.gitignore': 'tmp/\n' });
    const dir = join(HOME, repo);
    assert.deepEqual(await repositoryStatus(dir), []);
    write(dir, { 'a.ts': 'changed\n', 'c.ts': 'new\n', 'tmp/x': '1\n' });
    git(dir, 'mv', 'b.ts', 'd.ts');
    rmSync(join(dir, 'e.ts'));
    assert.deepEqual(await repositoryStatus(dir), ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });

  it('runs no filter of the repository\'s own configuration, and no hook', async () => {
    const repo = makeRepo('inplace-filter', { 'a.txt': 'x\n', '.gitattributes': '*.txt filter=evil\n' });
    const dir = join(HOME, repo);
    writeFileSync(join(dir, '.git', 'config'), `${readFileSync(join(dir, '.git', 'config'), 'utf8')}[filter "evil"]\n\tclean = touch ${join(dir, 'evil-ran')}\n`);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch ${join(dir, 'hook-ran')}\n`, { mode: 0o755 });
    write(dir, { 'a.txt': 'changed\n', 'b.txt': 'new\n' });
    assert.deepEqual(await repositoryStatus(dir), ['a.txt', 'b.txt']);
    const opened = await openRepository({ home: HOME, project: project(repo) });
    assert.equal(opened.decision.decision, 'allow');
    assert.equal(existsSync(join(dir, 'evil-ran')), false);
    assert.equal(existsSync(join(dir, 'hook-ran')), false);
  });

  it('a nested repository or a submodule is a special entry that blocks', async () => {
    const repo = makeRepo('inplace-nested', { 'a.ts': 'x\n' });
    const dir = join(HOME, repo);
    mkdirSync(join(dir, 'nested'));
    git(join(dir, 'nested'), 'init', '--quiet');
    write(dir, { 'nested/.env': 'TOKEN=fake-nested-0123456789abcdef\n' });
    const blocked = await openRepository({ home: HOME, project: project(repo) });
    assert.equal(blocked.decision.decision === 'block' && blocked.decision.findings.some((f) => f.kind === 'special-file' && f.path === 'nested'), true);
  });

  it('gitConfigFingerprint changes with .git/config, hooks or any .gitattributes, not with other files', async () => {
    const repo = makeRepo('inplace-fingerprint', { 'src/a.ts': 'x\n' });
    const dir = join(HOME, repo);
    const base = await gitConfigFingerprint(dir);
    write(dir, { 'src/a.ts': 'changed\n', 'src/b.ts': 'new\n' });
    assert.equal(await gitConfigFingerprint(dir), base);
    write(dir, { 'src/.gitattributes': '*.ts filter=x\n' });
    const withAttributes = await gitConfigFingerprint(dir);
    assert.notEqual(withAttributes, base);
    writeFileSync(join(dir, '.git', 'config'), `${readFileSync(join(dir, '.git', 'config'), 'utf8')}[filter "x"]\n\tclean = cat\n`);
    const withConfig = await gitConfigFingerprint(dir);
    assert.notEqual(withConfig, withAttributes);
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\n');
    assert.notEqual(await gitConfigFingerprint(dir), withConfig);
  });
});

describe('prepareEmptyWorkspace', () => {
  it('makes an empty folder the adapter accepts, once per run, removed with removeWorkspace', async () => {
    const runId = randomUUID();
    const workspace = await prepareEmptyWorkspace({ data: DATA, runId });
    assert.equal(workspace.decision.decision, 'allow');
    assert.equal(workspace.path, join(DATA, 'worktrees', runId));
    assert.ok(preparedPath(workspace) !== undefined);
    assert.deepEqual(readdirSync(workspace.path), []);
    await assert.rejects(prepareEmptyWorkspace({ data: DATA, runId }), WorkspaceError);
    await removeWorkspace({ data: DATA, runId });
    assert.equal(existsSync(workspace.path), false);
  });

  it('refuses a run id that is not a plain folder name', async () => {
    await assert.rejects(prepareEmptyWorkspace({ data: DATA, runId: 'Not A Run' }), WorkspaceError);
  });
});
