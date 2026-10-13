import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { gitEnv } from '../src/git-catalog.ts';
import { createSubtaskClone, godGit, godPartDir } from '../src/god/clone.ts';
import { changelogLine, commandRunner, landingEnv, createGodLanding, nextMinor, tailOf, trialBranch, versionOf, withRelease, withVersion, type CommandRunner, type GodLandingView } from '../src/god/land.ts';
import { GodError, type SubtaskRow, type SubtaskView } from '../src/god/work.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'arianna-land-'));
  roots.push(root);
  return root;
}

const GIT_ENV = { ...gitEnv(process.env, 'file', temporary()), GIT_AUTHOR_DATE: '2026-10-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T10:00:00Z' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'work');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

const CHANGELOG = '# Changelog\n\n## [Non rilasciato]\n\n## [0.68.0] - 2026-10-11\n\n### Aggiunto\n\n- Prima.\n';

test('versions and the register: the next minor, the package.json, the new section after «Non rilasciato»', () => {
  assert.equal(nextMinor('0.68.0'), '0.69.0');
  assert.equal(nextMinor('1.9.3'), '1.10.0');
  assert.throws(() => nextMinor('0.68'), GodError);
  assert.equal(versionOf('{\n  "name": "arianna",\n  "version": "0.68.0"\n}'), '0.68.0');
  assert.equal(withVersion('{ "version": "0.68.0", "x": "0.68.0" }', '0.69.0'), '{ "version": "0.69.0", "x": "0.68.0" }');
  const released = withRelease(CHANGELOG, '0.69.0', '2026-10-12', ['Uno (GOD g001, D-179).']);
  assert.equal(released, '# Changelog\n\n## [Non rilasciato]\n\n## [0.69.0] - 2026-10-12\n\n### Aggiunto\n\n- Uno (GOD g001, D-179).\n\n## [0.68.0] - 2026-10-11\n\n### Aggiunto\n\n- Prima.\n');
  // Without «Non rilasciato»: before the first version; without any version: at the end.
  assert.ok(withRelease('# C\n\n## [0.1.0] - x\n', '0.2.0', 'd', ['a']).startsWith('# C\n\n## [0.2.0] - d\n'));
  assert.equal(withRelease('# C\n', '0.1.0', 'd', ['a']), '# C\n\n## [0.1.0] - d\n\n### Aggiunto\n\n- a\n');
  assert.equal(changelogLine({ title: 'Pulsante verde.  ', part: 'g007-pulsante-verde' }), 'Pulsante verde (GOD g007, D-179).');
  assert.equal(trialBranch([{ part: 'g007-x' }, { part: 'g008-y' }]), 'prova/god-g007-x');
  assert.equal(tailOf('a\n\nb\nc\nd\ne\u001b[31m!\n'), 'b · c · d · e?[31m!', 'the last four lines, no control character');
});

interface Fixture {
  home: string;
  data: string;
  rows: Map<string, SubtaskRow>;
  calls: string[];
  restarts: number;
  reopened: { id: string; text: string }[];
  /** The exit code of the commit with the hooks (pnpm check), and of pnpm hud:build. */
  checkCode: number;
  buildCode: number;
  landing: ReturnType<typeof createGodLanding>;
}

function row(id: string, part: string, title: string): SubtaskRow {
  const at = new Date('2026-10-12T10:00:00Z');
  return { id, planId: 'p', position: 1, part, title, goal: 'g', files: [], blockedBy: [], state: 'reviewed', reason: null, review: 'ok', conversationId: 'c', reviewConversationId: 'r', commitSha: null, createdAt: at, updatedAt: at };
}

function fixture(development = true): Fixture {
  const home = temporary();
  const data = join(home, 'data');
  git(home, 'init', '--quiet');
  commit(home, { '.gitignore': 'data/\nrepos/\nconfig/arianna.toml\n', 'package.json': '{\n  "name": "arianna",\n  "version": "0.68.0"\n}\n', 'CHANGELOG.md': CHANGELOG, 'src/a.ts': 'a\n' });
  const godRunner = godGit(home, data, { env: GIT_ENV });
  const real = commandRunner();
  const fx: Fixture = { home, data, rows: new Map(), calls: [], restarts: 0, reopened: [], checkCode: 0, buildCode: 0, landing: undefined as never };
  const run: CommandRunner = async (command, args, cwd, timeout) => {
    fx.calls.push(`${command} ${args.filter((arg) => !arg.startsWith('user.') && arg !== '-c' && !arg.startsWith('commit.')).join(' ')}`);
    if (command === 'pnpm') return { code: fx.buildCode, output: fx.buildCode === 0 ? 'built' : 'vite: error' };
    if (fx.checkCode !== 0) return { code: fx.checkCode, output: 'test failed: 3 errors\n' };
    return real(command, ['-c', 'core.hooksPath=/dev/null', ...args], cwd, timeout);
  };
  fx.landing = createGodLanding({
    home,
    data,
    git: godRunner,
    run,
    development: () => development,
    restart: () => {
      fx.restarts += 1;
    },
    now: () => new Date('2026-10-12T10:00:00'),
    work: {
      rows: (ids) => Promise.all(ids.map(async (id) => fx.rows.get(id) ?? Promise.reject(new GodError('not-found', 'not found')))),
      planRows: (planId) => Promise.resolve([...fx.rows.values()].filter((item) => item.planId === planId)),
      plan: (planId) => Promise.resolve({ id: planId, conversationId: null, messageId: null, title: 'Il piano', model: null, label: 'L1', createdAt: new Date() }),
      prepareBranch: (id) => {
        const found = fx.rows.get(id);
        if (found === undefined) throw new GodError('not-found', 'not found');
        const sha = git(godPartDir(home, found.part), 'rev-parse', 'HEAD').trim();
        const ready = { ...found, state: 'branch' as const, commitSha: sha };
        fx.rows.set(id, ready);
        return Promise.resolve(ready as unknown as SubtaskView);
      },
      reopen: (id, text) => {
        fx.reopened.push({ id, text });
        return Promise.resolve();
      },
    },
  });
  return fx;
}

async function subtaskWith(fx: Fixture, id: string, part: string, title: string, files: Record<string, string>): Promise<void> {
  const dir = await createSubtaskClone(fx.home, fx.data, part, godGit(fx.home, fx.data, { env: GIT_ENV }));
  commit(dir, files);
  fx.rows.set(id, row(id, part, title));
}

/** Waits for the operation in the background to end. */
async function settled(fx: Fixture): Promise<GodLandingView> {
  for (let i = 0; i < 400; i += 1) {
    const view = await fx.landing.view();
    if (view.landing === null) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the landing did not end');
}

const head = (fx: Fixture): string => git(fx.home, 'symbolic-ref', '--short', 'HEAD').trim();

test('«Prova» then «Approva funzionalità»: a trial branch with the version, then main moved forward with the tag', async (t) => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g001-uno', 'Uno', { 'src/b.ts': 'b\n' });
  await subtaskWith(fx, 's2', 'g002-due', 'Due', { 'src/c.ts': 'c\n' });
  const mainBefore = git(fx.home, 'rev-parse', 'main').trim();

  const started = await fx.landing.trial(['s1', 's2'], 'Il piano');
  assert.equal(started.landing?.action, 'trial');
  await assert.rejects(fx.landing.trial(['s1'], 'x'), /operazione in corso/, 'one operation at a time');
  let view = await settled(fx);
  assert.equal(view.outcome?.ok, true, view.outcome?.text);
  assert.equal(head(fx), 'prova/god-g001-uno');
  assert.equal(view.installation.trial, 'prova/god-g001-uno');
  assert.equal(git(fx.home, 'rev-parse', 'main').trim(), mainBefore, 'main does not move with a trial');
  assert.equal(readFileSync(join(fx.home, 'src', 'b.ts'), 'utf8'), 'b\n');
  assert.equal(readFileSync(join(fx.home, 'src', 'c.ts'), 'utf8'), 'c\n');
  assert.equal(versionOf(readFileSync(join(fx.home, 'package.json'), 'utf8')), '0.69.0');
  assert.match(readFileSync(join(fx.home, 'CHANGELOG.md'), 'utf8'), /## \[0\.69\.0\] - 2026-10-12\n\n### Aggiunto\n\n- Uno \(GOD g001, D-179\)\.\n- Due \(GOD g002, D-179\)\./);
  assert.equal(git(fx.home, 'log', '-1', '--format=%s %an').trim(), '0.69.0: Il piano (GOD, D-179) Arianna GOD');
  assert.ok(fx.calls.includes('pnpm hud:build'));
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(fx.restarts, 1, 'the core restarts on the trial');

  // Another trial is refused while this one runs; «Approva» on a subtask of the trial lands the whole trial.
  await assert.rejects(fx.landing.trial(['s1'], 'x'), /già in prova/);
  await fx.landing.approve(['s2'], 'Il piano');
  view = await settled(fx);
  assert.equal(view.outcome?.ok, true, view.outcome?.text);
  assert.equal(head(fx), 'main');
  assert.equal(view.installation.trial, null);
  assert.equal(versionOf(readFileSync(join(fx.home, 'package.json'), 'utf8')), '0.69.0');
  assert.equal(git(fx.home, 'tag', '--list').trim(), 'v0.69.0');
  assert.equal(git(fx.home, 'branch', '--list', 'prova/*').trim(), '', 'the trial branch is gone');
  t.diagnostic(view.outcome.text);
});

test('«Non funziona»: back to main as it was, the words to the Coder, a restart', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g003-tre', 'Tre', { 'src/d.ts': 'd\n' });
  const mainBefore = git(fx.home, 'rev-parse', 'main').trim();
  await fx.landing.trial(['s1'], 'Tre');
  await settled(fx);
  await assert.rejects(fx.landing.reject(['s1'], '   '), /scrivi cosa non va/);
  await fx.landing.reject(['s1'], 'Il pulsante non si vede');
  const view = await settled(fx);
  assert.equal(view.outcome?.ok, true, view.outcome?.text);
  assert.equal(head(fx), 'main');
  assert.equal(git(fx.home, 'rev-parse', 'HEAD').trim(), mainBefore);
  assert.equal(existsSync(join(fx.home, 'src', 'd.ts')), false);
  assert.deepEqual(fx.reopened, [{ id: 's1', text: 'Il pulsante non si vede' }]);
  await assert.rejects(fx.landing.reject(['s1'], 'x'), /non è in prova/);
});

test('refusals: not on main, changes not saved, a migration in a trial; a failed check leaves main as it was', async () => {
  const fx = fixture(false);
  await subtaskWith(fx, 's1', 'g004-quattro', 'Quattro', { 'src/e.ts': 'e\n' });
  await subtaskWith(fx, 's2', 'g005-cinque', 'Cinque', { 'apps/core/migrations/0099_x.sql': 'SELECT 1;\n' });
  const mainBefore = git(fx.home, 'rev-parse', 'main').trim();

  writeFileSync(join(fx.home, 'src', 'a.ts'), 'changed\n');
  await assert.rejects(fx.landing.trial(['s1'], 'x'), /modifiche non salvate/);
  git(fx.home, 'checkout', '--quiet', '--', 'src/a.ts');
  git(fx.home, 'checkout', '--quiet', '-b', 'task/altro');
  await assert.rejects(fx.landing.approve(['s1'], 'x'), /non su main/);
  git(fx.home, 'checkout', '--quiet', 'main');
  fx.rows.set('s3', { ...row('s3', 'g006-sei', 'Sei'), state: 'working' });
  await assert.rejects(fx.landing.trial(['s3'], 'x'), /non è pronto/);

  await fx.landing.trial(['s2'], 'Cinque');
  let view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /migrazione/);
  await fx.landing.approve(['s2'], 'Cinque');
  view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /password vere/, 'a migration lands by itself only with the development passwords');

  fx.checkCode = 1;
  await fx.landing.approve(['s1'], 'Quattro');
  view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /pnpm check non passa: test failed: 3 errors/);
  assert.equal(head(fx), 'main');
  assert.equal(git(fx.home, 'rev-parse', 'HEAD').trim(), mainBefore);
  assert.equal(git(fx.home, 'status', '--porcelain').trim(), '');
  assert.equal(git(fx.home, 'branch', '--list', 'prova/*').trim(), '');
  assert.equal(fx.restarts, 0, 'no restart after a failure');
});

test('the Coder\'s own commits are checked too: a file the installation ignores, the lockfile', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g010-config', 'Config', { 'src/k.ts': 'k\n' });
  // As a Coder committing in its clone: the subtask is already a branch, «Prepara il ramo» never saw it.
  const dir = godPartDir(fx.home, 'g010-config');
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'arianna.toml'), 'x = 1\n');
  git(dir, 'add', '--force', 'config/arianna.toml');
  git(dir, 'commit', '--quiet', '-m', 'force');
  fx.rows.set('s1', { ...row('s1', 'g010-config', 'Config'), state: 'branch', commitSha: git(dir, 'rev-parse', 'HEAD').trim() });
  await fx.landing.approve(['s1'], 'Config');
  let view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /Config/);
  assert.equal(head(fx), 'main');
  assert.equal(git(fx.home, 'for-each-ref', 'refs/god').trim(), '', 'the fetched refs go');

  await subtaskWith(fx, 's2', 'g011-lock', 'Lock', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n' });
  await fx.landing.trial(['s2'], 'Lock');
  view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /dipendenze/);
});

test('two clicks at once: only one operation starts', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g012-uno', 'Uno', { 'src/u.ts': 'u\n' });
  const [first, second] = await Promise.allSettled([fx.landing.trial(['s1'], 'Uno'), fx.landing.trial(['s1'], 'Uno')]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(String(second.reason), /operazione in corso/);
  const view = await settled(fx);
  assert.equal(view.outcome?.ok, true, view.outcome?.text);
});

test('main moved after the trial: «Approva» is refused and the installation stays on the trial', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g013-uno', 'Uno', { 'src/m.ts': 'm\n' });
  await fx.landing.trial(['s1'], 'Uno');
  await settled(fx);
  git(fx.home, 'branch', '--quiet', '-f', 'main', git(fx.home, 'commit-tree', '-p', 'main', '-m', 'altro', 'main^{tree}').trim());
  await fx.landing.approve(['s1'], 'Uno');
  let view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /main è cambiato/);
  assert.equal(head(fx), 'prova/god-g013-uno');
  await fx.landing.reject(['s1'], 'rifai');
  view = await settled(fx);
  assert.equal(view.outcome?.ok, true, view.outcome?.text);
  assert.equal(head(fx), 'main');
});

test('a chat that does not build: the trial is undone, back on main, no restart', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g014-uno', 'Uno', { 'src/h.ts': 'h\n' });
  const mainBefore = git(fx.home, 'rev-parse', 'main').trim();
  fx.buildCode = 1;
  await fx.landing.trial(['s1'], 'Uno');
  const view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /Prova annullata, la chat non si è ricompilata/);
  assert.equal(head(fx), 'main');
  assert.equal(git(fx.home, 'rev-parse', 'HEAD').trim(), mainBefore);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(fx.restarts, 0);
});

test('a tag already there is refused before anything; a migration lands directly with the development passwords', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g015-mig', 'Migrazione', { 'apps/core/migrations/0099_x.sql': 'SELECT 1;\n' });
  git(fx.home, 'tag', 'v0.69.0');
  await fx.landing.approve(['s1'], 'Migrazione');
  let view = await settled(fx);
  assert.equal(view.outcome?.ok, false);
  assert.match(view.outcome.text, /il tag v0\.69\.0 c'è già/);
  assert.equal(head(fx), 'main');
  git(fx.home, 'tag', '-d', 'v0.69.0');
  await fx.landing.approve(['s1'], 'Migrazione');
  view = await settled(fx);
  assert.equal(view.outcome?.ok, true, view.outcome?.text);
  assert.equal(existsSync(join(fx.home, 'apps/core/migrations/0099_x.sql')), true);
  assert.equal(git(fx.home, 'tag', '--list').trim(), 'v0.69.0');
});

test('a trial lands or goes whole; a plan takes only what is not in main yet; a half-made trial is undone at start', async () => {
  const fx = fixture();
  await subtaskWith(fx, 's1', 'g016-uno', 'Uno', { 'src/w1.ts': '1\n' });
  await subtaskWith(fx, 's2', 'g017-due', 'Due', { 'src/w2.ts': '2\n' });
  await fx.landing.trial(['s1', 's2'], 'Il piano');
  await settled(fx);
  await fx.landing.reject(['s1'], 'non va');
  await settled(fx);
  assert.deepEqual(fx.reopened.map((item) => item.id).sort(), ['s1', 's2'], 'both Coders hear it');

  assert.deepEqual(await fx.landing.planTargets('p'), { ids: ['s1', 's2'], title: 'Il piano' });
  await fx.landing.approve(['s1'], 'Uno');
  await settled(fx);
  assert.deepEqual((await fx.landing.planTargets('p')).ids, ['s2'], 'the subtask in main is left out');

  // A core stopped during the check: a merge not committed on a trial branch.
  git(fx.home, 'checkout', '--quiet', '-b', 'prova/god-g017-due');
  git(fx.home, 'fetch', '--quiet', godPartDir(fx.home, 'g017-due'), 'god/g017-due');
  git(fx.home, 'merge', '--quiet', '--no-ff', '--no-commit', 'FETCH_HEAD');
  assert.equal(await fx.landing.recover(), true);
  assert.equal(head(fx), 'main');
  assert.equal(git(fx.home, 'status', '--porcelain').trim(), '');
  assert.equal(await fx.landing.recover(), false);
});

test('the environment of pnpm check: only the variables named, never a password or a proxy', () => {
  const env = landingEnv({ PATH: '/bin', HOME: '/h', PGPASSWORD: 'x', SOPS_AGE_KEY: 'k', HTTPS_PROXY: 'http://p', ARIANNA_DB_PASSWORD: 'y', LANG: '' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
});
