// «Pronta per i dati veri» (D-192): groups, the record of the doctor, the
// report and the pace of the checks, without a database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type AriannaConfig } from '@arianna/config';

import type { DoctorCheck } from '../src/doctor.ts';
import {
  createReadiness,
  groupChecks,
  readDoctorRecord,
  readinessReport,
  terminalOutcome,
  writeDoctorRecord,
  type DoctorRecord,
} from '../src/readiness.ts';

const ROOT = join(resolveHome({}), 'data', 'test-tmp', `readiness-${randomUUID()}`);
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = join(ROOT, randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

const check = (id: string, ok: boolean, detail = 'a detail with /a/path and a project name'): DoctorCheck => ({ id, ok, detail });
const OWNER_OK = [check('database.owner', true), check('database.migrations', true), check('database.app-role', true)];

test('checks go under closed groups: a group passes only when all its checks do; empty groups are left out', () => {
  const groups = groupChecks([
    check('system.node', true),
    check('system.docker', false),
    check('layout.data', true),
    check('layout.links', true),
    check('models', true),
    check('models.ram', false),
    check('local.omlx.log-level', true),
    check('projects.sito', true),
    check('projects.sito.link', true),
    check('database.passwords', false),
    check('database.default-passwords', false),
    check('events.chain', true),
  ]);
  assert.deepEqual(groups, [
    { id: 'passwords', ok: false },
    { id: 'default-passwords', ok: false },
    { id: 'events', ok: true },
    { id: 'folders', ok: true },
    { id: 'models', ok: true },
    { id: 'memory', ok: false },
    { id: 'model-log', ok: true },
    { id: 'programs', ok: false },
    { id: 'projects', ok: true },
  ]);
  // No detail and no name survive the grouping.
  assert.doesNotMatch(JSON.stringify(groups), /sito|path|detail/);
});

test('an id the list does not know still counts, under «other»', () => {
  assert.deepEqual(groupChecks([check('something.new', false)]), [{ id: 'other', ok: false }]);
  assert.deepEqual(groupChecks([check('something.new', true), check('voice.env', true)]), [
    { id: 'voice', ok: true },
    { id: 'other', ok: true },
  ]);
});

test('the record of the doctor: ids and outcomes only, a private folder and a 600 file', () => {
  const data = dataDir();
  writeDoctorRecord(data, [check('system.node', true), ...OWNER_OK], new Date('2026-10-12T18:40:00Z'));
  const file = join(data, 'doctor', 'last.json');
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /detail|\/a\/path|project name/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(data, 'doctor')).mode & 0o777, 0o700);
  const record = readDoctorRecord(data);
  assert.equal(record?.at, '2026-10-12T18:40:00.000Z');
  assert.equal(record.checks.length, 4);
  // Written again: replaced whole.
  writeDoctorRecord(data, [check('system.node', false)], new Date('2026-10-13T08:00:00Z'));
  assert.deepEqual(readDoctorRecord(data), { at: '2026-10-13T08:00:00.000Z', checks: [{ id: 'system.node', ok: false }] });
});

test('the record is refused when the folder is a link, and read as none when missing, a link or another shape', () => {
  const data = dataDir();
  assert.equal(readDoctorRecord(data), null);
  mkdirSync(join(data, 'elsewhere'));
  symlinkSync(join(data, 'elsewhere'), join(data, 'doctor'));
  assert.throws(() => {
    writeDoctorRecord(data, OWNER_OK);
  }, /not a folder/);

  const other = dataDir();
  mkdirSync(join(other, 'doctor'));
  for (const body of ['not json', '{"at":"yesterday","checks":[]}', '{"at":"2026-10-12T18:40:00Z","checks":[{"id":"x","ok":"yes"}]}', '[]']) {
    writeFileSync(join(other, 'doctor', 'last.json'), body);
    assert.equal(readDoctorRecord(other), null, body);
  }
  rmSync(join(other, 'doctor', 'last.json'));
  writeFileSync(join(other, 'real.json'), JSON.stringify({ at: '2026-10-12T18:40:00Z', checks: [] }));
  symlinkSync(join(other, 'real.json'), join(other, 'doctor', 'last.json'));
  assert.equal(readDoctorRecord(other), null);
});

test('the terminal passes only with every check of the owner present and passed', () => {
  const at = '2026-10-12T18:40:00.000Z';
  const record = (checks: DoctorRecord['checks']): DoctorRecord => ({ at, checks });
  assert.equal(terminalOutcome(null), null);
  assert.deepEqual(terminalOutcome(record(OWNER_OK)), { at, ok: true });
  assert.deepEqual(terminalOutcome(record(OWNER_OK.slice(1))), { at, ok: false });
  assert.deepEqual(terminalOutcome(record([...OWNER_OK.slice(1), check('database.owner', false)])), { at, ok: false });
});

test('ready only with every group passed and the terminal passed', () => {
  const terminal = { at: '2026-10-12T18:40:00.000Z', ok: true };
  assert.equal(readinessReport([{ id: 'folders', ok: true }], 'now', terminal).ready, true);
  assert.equal(readinessReport([{ id: 'folders', ok: false }], 'now', terminal).ready, false);
  assert.equal(readinessReport([{ id: 'folders', ok: true }], 'now', { ...terminal, ok: false }).ready, false);
  assert.equal(readinessReport([{ id: 'folders', ok: true }], 'now', null).ready, false);
});

test('checks run one at a time and at most every 10 s; meanwhile the last outcome is answered', async () => {
  const data = dataDir();
  writeDoctorRecord(data, OWNER_OK, new Date('2026-10-12T18:40:00Z'));
  let clock = 1_000_000;
  let runs = 0;
  let release: () => void = () => undefined;
  const readiness = createReadiness({
    config: () => ({ paths: { data } }) as unknown as AriannaConfig,
    sql: undefined as never,
    app: { user: 'arianna_app', password: 'x', development: true },
    now: () => clock,
    collect: async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [check('layout.data', true)];
    },
  });
  assert.equal(readiness.last(), null);
  const first = readiness.check();
  const second = readiness.check();
  assert.equal(first, second);
  release();
  const report = await first;
  assert.equal(runs, 1);
  assert.deepEqual(report, { ready: true, checkedAt: new Date(1_000_000).toISOString(), checks: [{ id: 'folders', ok: true }], terminal: { at: '2026-10-12T18:40:00.000Z', ok: true } });
  clock += 5_000;
  assert.deepEqual(await readiness.check(), report);
  assert.equal(runs, 1);
  // The record of the doctor is read again at each answer.
  writeDoctorRecord(data, [check('database.owner', false)], new Date('2026-10-13T08:00:00Z'));
  assert.equal(readiness.last()?.ready, false);
  clock += 6_000;
  const again = readiness.check();
  release();
  await again;
  assert.equal(runs, 2);
});

test('a check that fails to run answers no outcome and lets the next one try', async () => {
  const data = dataDir();
  let fail = true;
  const readiness = createReadiness({
    config: () => ({ paths: { data } }) as unknown as AriannaConfig,
    sql: undefined as never,
    app: { user: 'arianna_app', password: 'x', development: true },
    collect: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve([check('models', false)])),
  });
  await assert.rejects(readiness.check());
  assert.equal(readiness.last(), null);
  fail = false;
  assert.deepEqual((await readiness.check()).checks, [{ id: 'models', ok: false }]);
});
