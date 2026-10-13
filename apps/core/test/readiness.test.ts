// «Pronta per i dati veri» (D-192): groups, the record of the doctor, the
// report and the pace of the checks, without a database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type AriannaConfig } from '@arianna/config';

import type { DoctorCheck } from '../src/doctor.ts';
import { withPackageBins } from '../src/install-checks.ts';
import {
  createReadiness,
  groupChecks,
  latestMigration,
  readDoctorRecord,
  readinessReport,
  REQUIRED_GROUPS,
  requiredGroups,
  terminalOutcome,
  writeDoctorRecord,
  type DoctorRecord,
  type ReadinessCheck,
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

const MIGRATION = '0099_test';
const check = (id: string, ok: boolean, detail = 'a detail with /a/path and a project name'): DoctorCheck => ({ id, ok, detail });
const TERMINAL_OK = [check('database.owner', true), check('database.migrations', true), check('database.app-role', true), check('database.passwords', true), check('database.default-passwords', true)];
const ALL_REQUIRED: ReadinessCheck[] = REQUIRED_GROUPS.map((id) => ({ id, ok: true }));

test('checks go under closed groups: a group passes only when all its checks do; optional empty groups are left out', () => {
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

test('a required group without checks is a failure, never a silent pass; the voice is required only with [voice]', () => {
  const groups = groupChecks([check('layout.data', true)], requiredGroups({}));
  assert.deepEqual(
    groups.filter((group) => group.ok).map((group) => group.id),
    ['folders'],
  );
  assert.deepEqual(groups.map((group) => group.id).sort(), [...REQUIRED_GROUPS].sort());
  assert.equal(requiredGroups({ voice: {} as never }).includes('voice'), true);
  assert.equal(requiredGroups({}).includes('voice'), false);
  assert.equal(readinessReport(groups, 'now', { at: 'x', ok: true, stale: false }).ready, false);
});

test('an id the list does not know still counts, under «other»', () => {
  assert.deepEqual(groupChecks([check('something.new', false)]), [{ id: 'other', ok: false }]);
  assert.deepEqual(groupChecks([check('something.new', true), check('voice.env', true)]), [
    { id: 'voice', ok: true },
    { id: 'other', ok: true },
  ]);
});

test('the record of the doctor: time, last migration, ids and outcomes only; a private folder and a 600 file', () => {
  const data = dataDir();
  writeDoctorRecord(data, [check('system.node', true), ...TERMINAL_OK], { now: new Date('2026-10-12T18:40:00Z'), migration: MIGRATION });
  const file = join(data, 'doctor', 'last.json');
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /detail|\/a\/path|project name/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(data, 'doctor')).mode & 0o777, 0o700);
  const record = readDoctorRecord(data);
  assert.equal(record?.at, '2026-10-12T18:40:00.000Z');
  assert.equal(record.migration, MIGRATION);
  assert.equal(record.checks.length, 6);
  // Written again: replaced whole; by default with the last migration of this code.
  writeDoctorRecord(data, [check('system.node', false)], { now: new Date('2026-10-13T08:00:00Z') });
  assert.deepEqual(readDoctorRecord(data), { at: '2026-10-13T08:00:00.000Z', migration: latestMigration(), checks: [{ id: 'system.node', ok: false }] });
  assert.match(latestMigration() ?? '', /^\d{4}_/);
});

test('the record is refused when the folder is a link, and read as none when missing, a link or another shape', () => {
  const data = dataDir();
  assert.equal(readDoctorRecord(data), null);
  mkdirSync(join(data, 'elsewhere'));
  writeFileSync(join(data, 'elsewhere', 'last.json'), JSON.stringify({ at: '2026-10-12T18:40:00Z', migration: MIGRATION, checks: [] }));
  symlinkSync(join(data, 'elsewhere'), join(data, 'doctor'));
  assert.throws(() => {
    writeDoctorRecord(data, TERMINAL_OK);
  }, /not a folder/);
  // A folder that is a link is not read either, even with a valid record behind it.
  assert.equal(readDoctorRecord(data), null);

  const other = dataDir();
  mkdirSync(join(other, 'doctor'));
  for (const body of ['not json', '{"at":"yesterday","checks":[]}', '{"at":"2026-10-12T18:40:00Z","checks":[{"id":"x","ok":"yes"}]}', '{"at":"2026-10-12T18:40:00Z","migration":3,"checks":[]}', '[]']) {
    writeFileSync(join(other, 'doctor', 'last.json'), body);
    assert.equal(readDoctorRecord(other), null, body);
  }
  rmSync(join(other, 'doctor', 'last.json'));
  writeFileSync(join(other, 'real.json'), JSON.stringify({ at: '2026-10-12T18:40:00Z', checks: [] }));
  symlinkSync(join(other, 'real.json'), join(other, 'doctor', 'last.json'));
  assert.equal(readDoctorRecord(other), null);
});

test('the terminal passes only with every database check passed and the required ones present', () => {
  const at = '2026-10-12T18:40:00.000Z';
  const record = (checks: DoctorRecord['checks'], migration: string | null = MIGRATION): DoctorRecord => ({ at, migration, checks });
  assert.equal(terminalOutcome(null, MIGRATION), null);
  assert.deepEqual(terminalOutcome(record(TERMINAL_OK), MIGRATION), { at, ok: true, stale: false });
  // A required check missing.
  assert.equal(terminalOutcome(record(TERMINAL_OK.filter((item) => item.id !== 'database.owner')), MIGRATION)?.ok, false);
  assert.equal(terminalOutcome(record(TERMINAL_OK.filter((item) => item.id !== 'database.passwords')), MIGRATION)?.ok, false);
  // The owner's password short or equal to the app's: the doctor fails database.passwords, the page must say no.
  const shortOwner = record([...TERMINAL_OK.filter((item) => item.id !== 'database.passwords'), check('database.passwords', false)]);
  assert.equal(terminalOutcome(shortOwner, MIGRATION)?.ok, false);
  // Any other database check failed counts too, also one this code does not know yet.
  assert.equal(terminalOutcome(record([...TERMINAL_OK, check('database.something-new', false)]), MIGRATION)?.ok, false);
  // Checks outside the database do not decide the terminal: the core runs them itself.
  assert.equal(terminalOutcome(record([...TERMINAL_OK, check('system.docker', false)]), MIGRATION)?.ok, true);
});

test('the terminal is stale when written before the last migration, or without one', () => {
  const at = '2026-10-12T18:40:00.000Z';
  assert.equal(terminalOutcome({ at, migration: '0098_older', checks: TERMINAL_OK }, MIGRATION)?.stale, true);
  assert.equal(terminalOutcome({ at, migration: null, checks: TERMINAL_OK }, MIGRATION)?.stale, true);
  assert.equal(terminalOutcome({ at, migration: MIGRATION, checks: TERMINAL_OK }, MIGRATION)?.stale, false);
});

test('ready only with every group passed and the terminal passed and up to date', () => {
  const terminal = { at: '2026-10-12T18:40:00.000Z', ok: true, stale: false };
  assert.equal(readinessReport(ALL_REQUIRED, 'now', terminal).ready, true);
  assert.equal(readinessReport([...ALL_REQUIRED.slice(1), { id: 'passwords', ok: false }], 'now', terminal).ready, false);
  assert.equal(readinessReport(ALL_REQUIRED, 'now', { ...terminal, ok: false }).ready, false);
  assert.equal(readinessReport(ALL_REQUIRED, 'now', { ...terminal, stale: true }).ready, false);
  assert.equal(readinessReport(ALL_REQUIRED, 'now', null).ready, false);
});

test('the programs are also looked for where Homebrew and Docker Desktop put them, after PATH', () => {
  assert.equal(withPackageBins(['/usr/bin', '/bin'].join(delimiter)), ['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter));
  assert.equal(withPackageBins(['/opt/homebrew/bin', '/usr/bin'].join(delimiter)), ['/opt/homebrew/bin', '/usr/bin', '/usr/local/bin'].join(delimiter));
  assert.equal(withPackageBins(undefined), ['/opt/homebrew/bin', '/usr/local/bin'].join(delimiter));
});

function configOf(data: string): () => AriannaConfig {
  return () => ({ paths: { data }, voice: undefined }) as unknown as AriannaConfig;
}

const PASSING = [check('database.passwords', true), check('database.default-passwords', true), check('events.chain', true), check('layout.data', true), check('models', true), check('system.node', true), check('projects', true)];

test('checks run one at a time and at most every 10 s; meanwhile the last outcome is answered', async () => {
  const data = dataDir();
  writeDoctorRecord(data, TERMINAL_OK, { now: new Date('2026-10-12T18:40:00Z'), migration: MIGRATION });
  let clock = 1_000_000;
  let runs = 0;
  let release: () => void = () => undefined;
  const readiness = createReadiness({
    config: configOf(data),
    sql: undefined as never,
    app: { user: 'arianna_app', password: 'x', development: true },
    migration: MIGRATION,
    now: () => clock,
    collect: async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return PASSING;
    },
  });
  assert.equal(readiness.last(), null);
  const first = readiness.check();
  const second = readiness.check();
  assert.equal(first, second);
  release();
  const report = await first;
  assert.equal(runs, 1);
  assert.equal(report.ready, true);
  assert.equal(report.checkedAt, new Date(1_000_000).toISOString());
  assert.deepEqual(report.terminal, { at: '2026-10-12T18:40:00.000Z', ok: true, stale: false });
  clock += 5_000;
  assert.deepEqual(await readiness.check(), report);
  assert.equal(runs, 1);
  // The record of the doctor is read again at each answer: a short owner password turns it to no.
  writeDoctorRecord(data, [...TERMINAL_OK.filter((item) => item.id !== 'database.passwords'), check('database.passwords', false)], { migration: MIGRATION });
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
    config: configOf(data),
    sql: undefined as never,
    app: { user: 'arianna_app', password: 'x', development: true },
    migration: MIGRATION,
    collect: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve([check('models', false)])),
  });
  await assert.rejects(readiness.check());
  assert.equal(readiness.last(), null);
  fail = false;
  const report = await readiness.check();
  assert.deepEqual(
    report.checks.find((item) => item.id === 'models'),
    { id: 'models', ok: false },
  );
  // The required groups that did not run are failures.
  assert.equal(report.checks.find((item) => item.id === 'passwords')?.ok, false);
});
