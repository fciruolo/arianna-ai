// «Pronta per i dati veri» in the settings (D-192): the checks of
// `pnpm arianna:doctor` the core can run itself, grouped under closed ids,
// plus what the last doctor run in a terminal said about the checks only the
// owner of the database can make. The owner's password never enters the core
// (D-046), so those come from data/doctor/last.json, written by the doctor
// with ids and outcomes only. Nothing here leaves the details of a check:
// they hold paths, project names and program versions.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AriannaConfig } from '@arianna/config';

import type { Sql } from './db/client.ts';
import type { DbLogin } from './db/logins.ts';
import { appPasswordCheck, defaultPasswordsCheck, type DoctorCheck } from './doctor.ts';
import { verifyEventChain } from './events.ts';
import { installationChecks, type Runner } from './install-checks.ts';

/** The groups the page names, in the order it shows them; `other` holds an id this list does not know (it still counts). */
export const READINESS_IDS = ['passwords', 'default-passwords', 'events', 'folders', 'models', 'memory', 'model-log', 'programs', 'voice', 'projects', 'other'] as const;
export type ReadinessId = (typeof READINESS_IDS)[number];

export interface ReadinessCheck {
  id: ReadinessId;
  ok: boolean;
}

/** The last doctor run in a terminal: when, and whether the checks of the owner passed. */
export interface TerminalOutcome {
  at: string;
  ok: boolean;
}

export interface ReadinessReport {
  /** Every group passed and the last doctor in a terminal passed the owner's checks. */
  ready: boolean;
  checkedAt: string;
  checks: ReadinessCheck[];
  terminal: TerminalOutcome | null;
}

/** What only the doctor in a terminal can check: it needs the owner's password. */
export const TERMINAL_IDS = ['database.owner', 'database.migrations', 'database.app-role'] as const;

function groupOf(id: string): ReadinessId {
  if (id === 'database.passwords') return 'passwords';
  if (id === 'database.default-passwords') return 'default-passwords';
  if (id === 'events.chain') return 'events';
  if (id.startsWith('layout.')) return 'folders';
  if (id === 'models') return 'models';
  if (id === 'models.ram') return 'memory';
  if (/^local\..+\.log-level$/.test(id)) return 'model-log';
  if (id.startsWith('system.')) return 'programs';
  if (id === 'voice.env') return 'voice';
  if (id === 'projects' || id.startsWith('projects.')) return 'projects';
  return 'other';
}

/** The checks under their groups: a group passes when every check in it does. Groups without checks are left out. */
export function groupChecks(checks: readonly Pick<DoctorCheck, 'id' | 'ok'>[]): ReadinessCheck[] {
  const groups = new Map<ReadinessId, boolean>();
  for (const check of checks) {
    const id = groupOf(check.id);
    groups.set(id, (groups.get(id) ?? true) && check.ok);
  }
  return READINESS_IDS.filter((id) => groups.has(id)).map((id) => ({ id, ok: groups.get(id) === true }));
}

/** The record of the doctor: the checks it ran, by id, with their outcome only. */
export interface DoctorRecord {
  at: string;
  checks: { id: string; ok: boolean }[];
}

const DOCTOR_DIR = 'doctor';
const RECORD_FILE = 'last.json';
const MAX_RECORD = 64 * 1024;
const MAX_CHECKS = 1000;

/**
 * Writes data/doctor/last.json: the time and the id and outcome of each
 * check, never a detail. The folder is private (700) and the file 600; the
 * file is replaced whole (rename), and a link in place of the folder is refused.
 */
export function writeDoctorRecord(data: string, checks: readonly DoctorCheck[], now: Date = new Date()): void {
  const dir = join(data, DOCTOR_DIR);
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    stats = lstatSync(dir);
  }
  if (!stats.isDirectory()) throw new Error('data/doctor is not a folder: the record of the doctor was not written');
  if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  const record: DoctorRecord = { at: now.toISOString(), checks: checks.map((check) => ({ id: check.id, ok: check.ok })) };
  const temporary = join(dir, `${RECORD_FILE}.${String(process.pid)}.tmp`);
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, join(dir, RECORD_FILE));
}

/** The record checked: anything unexpected (missing, a link, too big, another shape) is no record. */
export function readDoctorRecord(data: string): DoctorRecord | null {
  let fd: number;
  try {
    fd = openSync(join(data, DOCTOR_DIR, RECORD_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD) return null;
    parsed = JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { at, checks } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || !Array.isArray(checks) || checks.length > MAX_CHECKS) return null;
  const valid: DoctorRecord['checks'] = [];
  for (const check of checks as unknown[]) {
    if (typeof check !== 'object' || check === null) return null;
    const { id, ok } = check as Record<string, unknown>;
    if (typeof id !== 'string' || id.length > 200 || typeof ok !== 'boolean') return null;
    valid.push({ id, ok });
  }
  return { at: new Date(at).toISOString(), checks: valid };
}

/** What the record says about the owner's checks: all present and passed, or not. */
export function terminalOutcome(record: DoctorRecord | null): TerminalOutcome | null {
  if (record === null) return null;
  const ok = TERMINAL_IDS.every((id) => record.checks.some((check) => check.id === id && check.ok));
  return { at: record.at, ok };
}

export function readinessReport(checks: ReadinessCheck[], checkedAt: string, terminal: TerminalOutcome | null): ReadinessReport {
  return { ready: checks.every((check) => check.ok) && terminal?.ok === true, checkedAt, checks, terminal };
}

export interface ReadinessOptions {
  /** The configuration in use, read at each check. */
  config: () => AriannaConfig;
  /** The database as the application role. */
  sql: Sql;
  /** The login the core works with: only its development flag and length are looked at. */
  app: DbLogin;
  /** Runs the checks; the default is the real ones. Tests pass their own. */
  collect?: () => Promise<DoctorCheck[]>;
  run?: Runner;
  now?: () => number;
  /** A new check at most this often; meanwhile the last one is answered. */
  minIntervalMs?: number;
}

export interface Readiness {
  /** The last outcome, with the record of the doctor read again; null before the first check. */
  last(): ReadinessReport | null;
  /** Runs the checks: one at a time, and not again before the interval. */
  check(): Promise<ReadinessReport>;
}

/** A step that throws fails its own check, not the whole run. */
async function safely(id: string, step: () => Promise<DoctorCheck[]> | DoctorCheck[]): Promise<DoctorCheck[]> {
  try {
    return await step();
  } catch {
    return [{ id, ok: false, detail: 'not checked' }];
  }
}

/** The checks the core can run: those of the installation and those its own login sees. */
export async function coreChecks(config: AriannaConfig, sql: Sql, app: DbLogin, run?: Runner): Promise<DoctorCheck[]> {
  return [
    ...(await safely('other', () => installationChecks(config, run))),
    appPasswordCheck(app),
    ...(await safely('database.default-passwords', async () => [await defaultPasswordsCheck(config, config.database.user)])),
    ...(await safely('events.chain', async () => {
      const chain = await verifyEventChain(sql);
      return [{ id: 'events.chain', ok: chain.ok, detail: chain.ok ? 'intact' : 'broken' }];
    })),
  ];
}

export function createReadiness(options: ReadinessOptions): Readiness {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? 10_000;
  const collect = options.collect ?? (() => coreChecks(options.config(), options.sql, options.app, options.run));
  let last: { checks: ReadinessCheck[]; at: number } | null = null;
  let running: Promise<ReadinessReport> | undefined;
  const reportOf = (done: { checks: ReadinessCheck[]; at: number }): ReadinessReport =>
    readinessReport(done.checks, new Date(done.at).toISOString(), terminalOutcome(readDoctorRecord(options.config().paths.data)));
  return {
    last: () => (last === null ? null : reportOf(last)),
    check() {
      if (running !== undefined) return running;
      if (last !== null && now() - last.at < minInterval) return Promise.resolve(reportOf(last));
      running = (async () => {
        try {
          const done = { checks: groupChecks(await collect()), at: now() };
          last = done;
          return reportOf(done);
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
  };
}
