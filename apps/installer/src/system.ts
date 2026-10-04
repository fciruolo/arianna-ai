// Prerequisites and layout of ARIANNA_HOME (task 1.17): what `install` needs
// before it starts and what `arianna:doctor` reports besides the database.
// Binaries are only asked for their version: nothing here changes the system.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { arch, platform, totalmem } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { DoctorCheck } from '@arianna/core/doctor';

/** Subfolders of data/ created by install (docs/INSTALLER-PORTABILITY.md); Docker creates its own volumes. */
export const DATA_LAYOUT = ['models', 'archive', 'kb', 'vault', 'worktrees', 'backups'] as const;

export const MIN_NODE = [22, 18] as const;

/** Runs `binary args` and returns stdout; rejects when the binary is missing or fails. */
export type Runner = (binary: string, args: string[]) => Promise<string>;

export const runCommand: Runner = (binary, args) =>
  new Promise((resolvePromise, reject) => {
    execFile(binary, args, { timeout: 15_000, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolvePromise(stdout.trim());
      else reject(new Error(`${binary} is missing or failed`));
    });
  });

function nodeAtLeast(version: string, [major, minor]: readonly [number, number]): boolean {
  const [have = 0, haveMinor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return have > major || (have === major && haveMinor >= minor);
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

export interface SystemOptions {
  run?: Runner;
  nodeVersion?: string;
  /** `[voice]` is configured: uv builds the Python environment of apps/voice (D-066). */
  voice?: boolean;
}

/** Node, pnpm, Docker with its daemon running, sops and age, machine. */
export async function systemChecks(options: SystemOptions = {}): Promise<DoctorCheck[]> {
  const run = options.run ?? runCommand;
  const node = options.nodeVersion ?? process.version;
  const checks: DoctorCheck[] = [
    {
      id: 'system.node',
      ok: nodeAtLeast(node, MIN_NODE),
      detail: `${node} (at least ${String(MIN_NODE[0])}.${String(MIN_NODE[1])})`,
    },
  ];
  const tool = async (id: string, binary: string, args: string[], missing: string): Promise<void> => {
    try {
      checks.push({ id, ok: true, detail: firstLine(await run(binary, args)) });
    } catch {
      checks.push({ id, ok: false, detail: missing });
    }
  };
  await tool('system.pnpm', 'pnpm', ['--version'], 'pnpm is not installed');
  await tool('system.docker', 'docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker is not installed or not running: start Docker Desktop');
  await tool('system.sops', 'sops', ['--version'], 'sops is not installed: brew install sops (needed by the vault)');
  await tool('system.age', 'age', ['--version'], 'age is not installed: brew install age (needed by the vault)');
  if (options.voice === true) await tool('system.uv', 'uv', ['--version'], 'uv is not installed: brew install uv (needed by the calls, D-066)');
  checks.push({
    id: 'system.machine',
    ok: true,
    detail: `${platform()} ${arch()}, ${String(Math.round(totalmem() / 2 ** 30))} GiB of RAM`,
  });
  return checks;
}

/** The Python environment of apps/voice, built by pnpm voice:sync (D-066). */
export function voiceCheck(python: string): DoctorCheck {
  const ok = existsSync(python);
  return { id: 'voice.env', ok, detail: ok ? 'data/voice/venv is in place' : 'data/voice/venv is missing: pnpm voice:sync' };
}

/**
 * Creates data/ and its subfolders. data/ and the vault are readable by this
 * user only: an existing one that is looser is tightened, and reported.
 */
export function ensureLayout(data: string): string[] {
  const changed: string[] = [];
  for (const dir of ['', ...DATA_LAYOUT]) {
    const path = join(data, dir);
    const name = dir === '' ? 'data' : `data/${dir}`;
    const private_ = dir === '' || dir === 'vault';
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true, mode: private_ ? 0o700 : 0o755 });
      changed.push(name);
    } else if (private_ && (statSync(path).mode & 0o077) !== 0) {
      chmodSync(path, 0o700);
      changed.push(`${name} (now private)`);
    }
  }
  return changed;
}

function outside(home: string, path: string): boolean {
  const fromHome = relative(home, path);
  return fromHome === '..' || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome);
}

/**
 * The layout of data/ and the symlinks in it that leave ARIANNA_HOME. Those
 * are allowed (weights on another disk) but reported: what they point to is
 * not synced, not backed up, and not covered by the rules of the folder.
 */
export function layoutCheck(home: string, data: string): DoctorCheck[] {
  const missing = DATA_LAYOUT.filter((dir) => !existsSync(join(data, dir)));
  const leaving: string[] = [];
  const unreadable: string[] = [];
  // Compared with real paths: ARIANNA_HOME itself may sit behind a link.
  const realHome = existsSync(home) ? realpathSync(home) : home;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(relative(home, dir));
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          target = resolve(dir, readlinkSync(path));
        }
        if (outside(realHome, target)) leaving.push(relative(home, path));
      } else if (entry.isDirectory() && entry.name !== 'postgres' && entry.name !== 'qdrant') {
        walk(path, depth + 1);
      }
    }
  };
  walk(data, 0);
  // statSync follows a link: what counts is the folder the data is in.
  const open = ['', 'vault'].filter((dir) => existsSync(join(data, dir)) && (statSync(join(data, dir)).mode & 0o077) !== 0);
  return [
    {
      id: 'layout.data',
      ok: missing.length === 0 && open.length === 0,
      detail: [
        missing.length === 0 ? 'every folder present' : `missing ${missing.map((dir) => `data/${dir}`).join(', ')}: run pnpm arianna:install`,
        open.length === 0 ? '' : `readable by other users: ${open.map((dir) => (dir === '' ? 'data' : `data/${dir}`)).join(', ')} (pnpm arianna:install makes them private)`,
      ]
        .filter((part) => part !== '')
        .join('; '),
    },
    {
      id: 'layout.links',
      ok: unreadable.length === 0,
      detail: [
        leaving.length === 0 ? 'no link leaves ARIANNA_HOME' : `outside ARIANNA_HOME, not synced nor backed up: ${leaving.join(', ')}`,
        unreadable.length === 0 ? '' : `cannot read ${unreadable.join(', ')}`,
      ]
        .filter((part) => part !== '')
        .join('; '),
    },
  ];
}

/** Bytes free on the disk of `path`. */
export function freeBytes(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}
