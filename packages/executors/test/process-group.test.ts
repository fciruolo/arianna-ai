// D-302: the process groups of the cloud runs a killed core left behind, and
// D-304: the guardian that stops them when the core dies, with real processes
// standing in for the core, `claude` and its children.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveHome } from '@arianna/config';
import { forgetRunPid, guardGroup, processStart, readPidRecord, reapRunOrphans, recordRunPid } from '@arianna/executors';

import { guardians, noGuardianLeft } from './support/guardians.ts';

const ROOT = join(resolveHome({}), 'data', 'test-tmp', `run-pids-${randomUUID()}`);
const started: ChildProcess[] = [];

after(() => {
  for (const child of started) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
});

const dir = (): string => join(ROOT, randomUUID());

/**
 * A group leader like `claude`: its own group, one child in the same group.
 * Prints the child's pid once both run (and, with `ignoreTerm`, once SIGTERM
 * is ignored by both).
 */
async function group(ignoreTerm = false): Promise<{ leader: number; child: number }> {
  const term = ignoreTerm ? "process.on('SIGTERM', () => undefined);" : '';
  const inner = `${term} setInterval(() => undefined, 1000);`;
  const script = `${term} const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'ignore' }); setTimeout(() => console.log(c.pid), 300); setInterval(() => undefined, 1000);`;
  const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(leader);
  const child = await new Promise<number>((resolve, reject) => {
    leader.stdout.once('data', (chunk: Buffer) => {
      resolve(Number(chunk.toString('utf8').trim()));
    });
    leader.once('error', reject);
  });
  assert.ok(leader.pid !== undefined && Number.isInteger(child));
  return { leader: leader.pid, child };
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (processStart(pid) === undefined) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe('run pid files (D-302)', () => {
  it('records the pid and start time of a run, and forgets it', async () => {
    const folder = dir();
    const { leader } = await group();
    const file = recordRunPid(folder, 'claude', leader);
    assert.ok(file !== undefined);
    assert.deepEqual(readdirSync(folder), [`claude-${String(leader)}.pid`]);
    assert.deepEqual(readPidRecord(file), { pid: leader, started: processStart(leader) });
    forgetRunPid(file);
    assert.deepEqual(readdirSync(folder), []);
    forgetRunPid(file);
    forgetRunPid(undefined);
  });

  it('writes nothing for a process already gone, an odd executor name or a folder that is not absolute', () => {
    const folder = dir();
    assert.equal(recordRunPid(folder, 'claude', 999_999_999), undefined);
    assert.equal(recordRunPid(folder, '../claude', process.pid), undefined);
    assert.equal(recordRunPid('data/run-pids', 'claude', process.pid), undefined);
    assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], []);
  });

  it('stops the group a killed core left running, the leader and its child', async () => {
    const folder = dir();
    const { leader, child } = await group();
    assert.ok(recordRunPid(folder, 'claude', leader) !== undefined);
    assert.deepEqual(await reapRunOrphans(folder, 2_000), [{ executor: 'claude', pid: leader }]);
    assert.ok(await gone(leader), 'leader stopped');
    assert.ok(await gone(child), 'child in the group stopped');
    assert.deepEqual(readdirSync(folder), []);
  });

  it('a group that ignores SIGTERM gets SIGKILL after the grace', async () => {
    const folder = dir();
    const { leader, child } = await group(true);
    assert.ok(recordRunPid(folder, 'codex', leader) !== undefined);
    assert.deepEqual(await reapRunOrphans(folder, 300), [{ executor: 'codex', pid: leader }]);
    assert.ok(await gone(leader));
    assert.ok(await gone(child));
  });

  it('never touches a process that only reused the pid: another start time', async () => {
    const folder = dir();
    const { leader, child } = await group();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `claude-${String(leader)}.pid`), JSON.stringify({ pid: leader, started: 'Thu Jan  1 00:00:00 1970' }));
    assert.deepEqual(await reapRunOrphans(folder, 300), []);
    assert.ok(processStart(leader) !== undefined, 'the leader still runs');
    assert.ok(processStart(child) !== undefined, 'its child still runs');
    assert.deepEqual(readdirSync(folder), [], 'the stale file goes');
  });

  it('leaves the runs of a core still alive; those of a core gone are orphans', async () => {
    const folder = dir();
    mkdirSync(folder, { recursive: true });
    const core = await group();
    const owner = { pid: core.leader, started: processStart(core.leader) };
    const live = await group();
    const liveFile = join(folder, `claude-${String(live.leader)}.pid`);
    writeFileSync(liveFile, JSON.stringify({ pid: live.leader, started: processStart(live.leader), owner }));
    const orphan = await group();
    writeFileSync(join(folder, `codex-${String(orphan.leader)}.pid`), JSON.stringify({ pid: orphan.leader, started: processStart(orphan.leader), owner: { pid: core.leader, started: 'Thu Jan  1 00:00:00 1970' } }));
    assert.deepEqual(await reapRunOrphans(folder, 1_000), [{ executor: 'codex', pid: orphan.leader }]);
    assert.ok(processStart(live.leader) !== undefined, 'the run of the live core still runs');
    assert.deepEqual(readdirSync(folder), [`claude-${String(live.leader)}.pid`], 'and keeps its file');
    assert.ok(await gone(orphan.leader));
  });

  it('ignores a missing folder and damaged files without errors, and leaves other files alone', async () => {
    assert.deepEqual(await reapRunOrphans(join(ROOT, 'missing')), []);
    const folder = dir();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'claude-123.pid'), 'not json');
    writeFileSync(join(folder, 'codex-456.pid'), 'null');
    writeFileSync(join(folder, 'claude-789.pid'), JSON.stringify({ pid: 1, started: 'x' }));
    writeFileSync(join(folder, 'claude-790.pid'), JSON.stringify({ pid: '790', started: 'x' }));
    writeFileSync(join(folder, 'notes.txt'), 'kept');
    assert.deepEqual(await reapRunOrphans(folder, 100), []);
    assert.deepEqual(readdirSync(folder), ['notes.txt']);
    await assert.rejects(reapRunOrphans('data/run-pids'), TypeError);
  });
});

const FAKE_CORE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-core.ts');

/** A core that guards the group `pgid`, with its guardian's pid. */
async function core(pgid: number): Promise<{ core: ChildProcess; guard: number; other: number; release: () => Promise<void> }> {
  const child = spawn(process.execPath, [FAKE_CORE, String(pgid)], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  started.push(child);
  const lines: string[] = [];
  let waiting: (() => void) | undefined;
  child.stdout.on('data', (chunk: Buffer) => {
    lines.push(...chunk.toString('utf8').split('\n').filter((line) => line !== ''));
    waiting?.();
  });
  const next = async (): Promise<string> => {
    while (lines.length === 0) await new Promise<void>((resolve) => (waiting = resolve));
    return lines.shift() ?? '';
  };
  const { guard, other } = JSON.parse(await next()) as { guard?: number; other?: number };
  assert.ok(typeof other === 'number');
  assert.ok(typeof guard === 'number' && processStart(guard) !== undefined, 'the guardian runs');
  return {
    core: child,
    guard,
    other,
    release: async () => {
      child.stdin.write('release\n');
      assert.equal(await next(), 'released');
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('run guardian (D-304)', () => {
  it('a core killed with SIGKILL takes the group down within a few seconds, without a restart', async () => {
    const { leader, child } = await group();
    const fake = await core(leader);
    const killed = Date.now();
    fake.core.kill('SIGKILL');
    assert.ok(await gone(leader), 'leader stopped');
    assert.ok(await gone(child), 'child in the group stopped');
    assert.ok(Date.now() - killed < 3_000);
    assert.ok(await gone(fake.guard), 'the guardian exits after the stop');
    assert.ok(processStart(fake.other) !== undefined, 'a child the core started later did not hold the pipe open, and lives on');
    process.kill(fake.other, 'SIGKILL');
  });

  it('a group that ignores SIGTERM gets SIGKILL about a second after the death of the core', async () => {
    const { leader, child } = await group(true);
    const fake = await core(leader);
    const killed = Date.now();
    fake.core.kill('SIGKILL');
    assert.ok(await gone(leader));
    assert.ok(await gone(child));
    assert.ok(Date.now() - killed < 2_500, 'about a second of grace, not more');
  });

  it('while the core lives the group lives too', async () => {
    const { leader, child } = await group();
    const fake = await core(leader);
    await sleep(1_500);
    assert.ok(processStart(leader) !== undefined && processStart(child) !== undefined, 'the group still runs');
    assert.ok(processStart(fake.guard) !== undefined, 'and its guardian waits');
    fake.core.kill('SIGKILL');
    assert.ok(await gone(leader));
  });

  it('a released guardian exits and leaves the group alone, even when the core dies later', async () => {
    const { leader, child } = await group();
    const fake = await core(leader);
    await fake.release();
    assert.ok(await gone(fake.guard), 'the guardian exits');
    fake.core.kill('SIGKILL');
    await sleep(1_500);
    assert.ok(processStart(leader) !== undefined && processStart(child) !== undefined, 'the group still runs');
  });

  it('a core that dies after its group is gone: the guardian just exits', async () => {
    const { leader, child } = await group();
    const fake = await core(leader);
    process.kill(-leader, 'SIGKILL');
    assert.ok(await gone(leader));
    assert.ok(await gone(child));
    fake.core.kill('SIGKILL');
    assert.ok(await gone(fake.guard), 'the guardian exits');
  });

  it('starts no guardian for a group that is no group, and release is harmless twice', async () => {
    for (const pgid of [0, 1, -5, 1.5, Number.NaN]) {
      const guard = guardGroup(pgid);
      assert.equal(guard.pid, undefined);
      guard.release();
    }
    const { leader } = await group();
    const guard = guardGroup(leader);
    assert.deepEqual(guardians().filter((one) => one.group === leader), [{ pid: guard.pid, group: leader }]);
    guard.release();
    guard.release();
    assert.ok(await noGuardianLeft());
    assert.ok(processStart(leader) !== undefined, 'released: the group still runs');
  });
});
