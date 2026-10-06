import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { parseYamlText } from '@arianna/agents';

import { DelegationFileError, MAX_PREVIEW_BYTES, readProjectBytes, shownText } from './delegation-view.ts';

/**
 * The tab Servizi of the page "Progetti" (D-134, tappa 2; rules in D-134 g).
 * Only the commands written in the project's own files are run, chosen by
 * name from the list the core reads here, never free text; each start and
 * stop is confirmed by the user in the page. A command that ends by itself
 * stops after SHORT_LIMIT_MS; one that stays on (a script with a port, a
 * service of compose) does not; a stop is gentle, then forced after
 * KILL_GRACE_MS; the processes started here stop with the core (services of
 * compose stay with Docker, as after `up -d`). The log of each run stays in
 * memory, last MAX_LINES lines, and goes nowhere else.
 */

export type ServiceSource = 'package.json' | 'compose' | 'Makefile';

export interface ProjectService {
  /** `<source>:<name>`, the key the page sends back. */
  id: string;
  source: ServiceSource;
  /** The file it was read from, as the page shows it. */
  file: string;
  name: string;
  /** What runs, as argv: never through a shell. */
  command: string[];
  /** What the script or the recipe says, shown in the confirmation (package.json and Makefile). */
  script?: string;
  /** Ports on 127.0.0.1 that say the service is on. */
  ports: number[];
  /** Stays on until stopped (a server), or ends by itself (a test, a build). */
  stays: boolean;
}

/** How long a command that ends by itself may run. */
export const SHORT_LIMIT_MS = 10 * 60_000;
/** Between the gentle stop and the forced one. */
export const KILL_GRACE_MS = 10_000;
/** Lines of log kept per run. */
export const MAX_LINES = 2000;
/** Characters kept of one line. */
const MAX_LINE_CHARS = 2000;

const NAME = /^[A-Za-z0-9][\w:.-]{0,63}$/;
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const STAYING_SCRIPTS = new Set(['dev', 'start', 'serve', 'preview', 'watch']);

/** A file of the project as text, or undefined when it is missing or cannot be shown (too large, a vault value). */
async function projectText(root: string, path: string): Promise<string | undefined> {
  try {
    return shownText(await readProjectBytes(root, path, MAX_PREVIEW_BYTES, true));
  } catch (error) {
    if (error instanceof DelegationFileError) return undefined;
    throw error;
  }
}

const port = (value: string): number | undefined => {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : undefined;
};

/** Ports a script names: `--port 5180`, `--port=5180`, `-p 3000`, `PORT=8080`. */
export function scriptPorts(script: string): number[] {
  const found = new Set<number>();
  for (const match of script.matchAll(/(?:--port[= ]|-p |\bPORT=)(\d{2,5})\b/g)) {
    const value = port(match[1] ?? '');
    if (value !== undefined) found.add(value);
  }
  return [...found];
}

/** The host port of a compose port entry: "8025:8025", "127.0.0.1:55432:5432", { published: 80 }; a lone container port (1025) publishes a random one. */
export function composePort(entry: unknown): number | undefined {
  if (typeof entry === 'number') return undefined;
  if (typeof entry === 'object' && entry !== null) {
    const published = (entry as { published?: unknown }).published;
    return typeof published === 'number' || typeof published === 'string' ? port(String(published)) : undefined;
  }
  if (typeof entry !== 'string') return undefined;
  const parts = entry.split('/')[0]?.split(':') ?? [];
  // "host:container" or "ip:host:container"; a lone "container" publishes a random port.
  if (parts.length < 2) return undefined;
  return port(parts[parts.length - 2] ?? '');
}

/** The scripts of package.json, run with the project's package manager. */
export function packageServices(text: string, runner: string): ProjectService[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = typeof value === 'object' && value !== null ? (value as { scripts?: unknown }).scripts : undefined;
  if (typeof scripts !== 'object' || scripts === null) return [];
  return Object.entries(scripts)
    .filter((pair): pair is [string, string] => NAME.test(pair[0]) && typeof pair[1] === 'string')
    .slice(0, 100)
    .map(([name, script]) => {
      const ports = scriptPorts(script);
      return {
        id: `package.json:${name}`,
        source: 'package.json' as const,
        file: 'package.json',
        name,
        command: [runner, 'run', name],
        script,
        ports,
        stays: ports.length > 0 || STAYING_SCRIPTS.has(name) || name.startsWith('dev:'),
      };
    });
}

/** The services of a compose file: `docker compose up -d <name>`, stopped with `stop <name>`. */
export function composeServices(text: string, file: string): ProjectService[] {
  let value: unknown;
  try {
    value = parseYamlText(text, file);
  } catch {
    return [];
  }
  const services = typeof value === 'object' && value !== null ? (value as { services?: unknown }).services : undefined;
  if (typeof services !== 'object' || services === null) return [];
  return Object.entries(services)
    .filter(([name]) => NAME.test(name) && !name.includes(':'))
    .slice(0, 100)
    .map(([name, service]) => {
      const entries = typeof service === 'object' && service !== null ? (service as { ports?: unknown }).ports : undefined;
      const ports = Array.isArray(entries) ? [...new Set(entries.map(composePort).filter((item): item is number => item !== undefined))] : [];
      return { id: `compose:${name}`, source: 'compose' as const, file, name, command: ['docker', 'compose', '-f', file, 'up', '-d', name], ports, stays: true };
    });
}

/** The targets of a Makefile with their recipe; special ones (`.PHONY`), variables, `define` blocks and file rules (`foo.o:`) left out. */
export function makeServices(text: string): ProjectService[] {
  const recipes = new Map<string, string[]>();
  let current: string[] | undefined;
  let inDefine = false;
  for (const line of text.split('\n')) {
    if (/^\s*define\b/.test(line)) inDefine = true;
    if (inDefine) {
      if (/^\s*endef\b/.test(line)) inDefine = false;
      current = undefined;
      continue;
    }
    if (line.startsWith('\t') && current !== undefined) {
      if (current.length < 20) current.push(line.slice(1));
      continue;
    }
    const match = /^([A-Za-z0-9][\w.-]{0,63})\s*:(?![:=])/.exec(line);
    const name = match?.[1];
    if (name === undefined || /\.[A-Za-z]{1,4}$/.test(name)) {
      current = undefined;
      continue;
    }
    // A target written twice keeps the first recipe; its later lines are not shown as another's.
    current = recipes.has(name) ? undefined : [];
    if (current !== undefined) recipes.set(name, current);
  }
  return [...recipes.entries()].slice(0, 100).map(([name, recipe]) => ({
    id: `Makefile:${name}`,
    source: 'Makefile' as const,
    file: 'Makefile',
    name,
    command: ['make', name],
    script: recipe.join('\n'),
    ports: [],
    stays: false,
  }));
}

/** A service as listed to the page: with the fingerprint of what it runs, sent back with a start. */
export type ListedService = ProjectService & { fingerprint: string };

/** What the confirmation showed, in 16 hex characters: the command and the script or recipe. */
export function serviceFingerprint(service: ProjectService): string {
  return createHash('sha256')
    .update(JSON.stringify([service.command, service.script ?? '']))
    .digest('hex')
    .slice(0, 16);
}

/** Every service the project declares, read now from its files. */
export async function listServices(root: string): Promise<ListedService[]> {
  const services: ProjectService[] = [];
  const pkg = await projectText(root, 'package.json');
  if (pkg !== undefined) {
    const runner = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : 'npm';
    services.push(...packageServices(pkg, runner));
  }
  for (const file of COMPOSE_FILES) {
    const text = await projectText(root, file);
    if (text === undefined) continue;
    services.push(...composeServices(text, file));
    break;
  }
  const make = await projectText(root, 'Makefile');
  if (make !== undefined) services.push(...makeServices(make));
  return services.map((service) => ({ ...service, fingerprint: serviceFingerprint(service) }));
}

/** Whether something listens on 127.0.0.1:`port`, within a short wait. */
export function listening(port: number, waitMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (on: boolean): void => {
      socket.destroy();
      resolve(on);
    };
    socket.setTimeout(waitMs, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

export type ServiceErrorCode = 'unknown' | 'running' | 'not-running' | 'changed';

export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The service the page asked for, from the list read now: unknown when the
 * file no longer has it; `changed` when what it runs is not what the
 * confirmation showed (a script edited in between, by hand or by a run).
 */
export function pickService(list: readonly ListedService[], id: string, fingerprint: string | undefined): ListedService {
  const service = list.find((item) => item.id === id);
  if (service === undefined) throw new ServiceError('unknown', 'no such service in the project');
  if (fingerprint !== undefined && fingerprint !== service.fingerprint) throw new ServiceError('changed', 'the command changed since it was shown: confirm it again');
  return service;
}

/** One run of a service: its log and how it ended. */
export interface ServiceRun {
  startedAt: string;
  running: boolean;
  ended: { at: string; code: number | null; signal: string | null; reason: 'exit' | 'stopped' | 'time-limit' | 'error' } | null;
  lines: string[];
}

export interface ServiceManagerOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => Date;
  shortLimitMs?: number;
  killGraceMs?: number;
  /** Each start and stop, for the chain of events: project and service only. */
  onEvent?: (kind: 'service.started' | 'service.stopped', payload: { project: string; service: string; reason?: string; code?: number | null }) => void;
}

export interface ServiceManager {
  start(project: string, root: string, service: ProjectService): void;
  /** A run started here: stopped. A compose service: `docker compose stop` as a short run of its own. */
  stop(project: string, root: string, service: ProjectService): void;
  run(project: string, serviceId: string): ServiceRun | undefined;
  /** At the end of the core: every group started here gets SIGTERM, then SIGKILL after the grace; resolves when all are gone. */
  stopAll(): Promise<void>;
}

/** The variables a command of the project gets: no secret of the core, no colours. */
function serviceEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, LANG, SHELL, USER, TMPDIR } = process.env;
  return {
    ...(PATH === undefined ? {} : { PATH }),
    ...(HOME === undefined ? {} : { HOME }),
    ...(SHELL === undefined ? {} : { SHELL }),
    ...(USER === undefined ? {} : { USER }),
    ...(TMPDIR === undefined ? {} : { TMPDIR }),
    LANG: LANG ?? 'en_US.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Whether any process of the group `pid` is still alive. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

interface LiveRun extends ServiceRun {
  pid?: number;
  timers: ReturnType<typeof setTimeout>[];
  stopping?: 'stopped' | 'time-limit';
  /** The piece of a line not yet ended, per stream. */
  partial: { out: string; err: string };
}

export function createServiceManager(options: ServiceManagerOptions = {}): ServiceManager {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => new Date());
  const shortLimit = options.shortLimitMs ?? SHORT_LIMIT_MS;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const runs = new Map<string, LiveRun>();
  const key = (project: string, id: string): string => `${project}\u0000${id}`;

  function push(run: LiveRun, line: string): void {
    run.lines.push(line.replace(ANSI, '').slice(0, MAX_LINE_CHARS));
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
  }

  /** A chunk of a stream: whole lines go to the log, the rest waits for the next chunk. */
  function feed(run: LiveRun, stream: 'out' | 'err', text: string): void {
    const parts = (run.partial[stream] + text).split(/\r?\n/);
    run.partial[stream] = (parts.pop() ?? '').slice(0, MAX_LINE_CHARS);
    for (const line of parts) if (line !== '') push(run, line);
  }

  /** SIGTERM to the group, then SIGKILL after the grace if anything of it is still alive (a child may outlive the leader). */
  function kill(run: LiveRun): void {
    const pid = run.pid;
    if (pid === undefined) return;
    signalGroup(pid, 'SIGTERM');
    const timer = setTimeout(() => {
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    }, grace);
    timer.unref();
  }

  function launch(project: string, root: string, id: string, command: string[], limit: number | null, event: string): void {
    const [file, ...args] = command;
    if (file === undefined) throw new ServiceError('unknown', 'empty command');
    const run: LiveRun = { startedAt: now().toISOString(), running: true, ended: null, lines: [], timers: [], partial: { out: '', err: '' } };
    runs.set(key(project, id), run);
    push(run, `$ ${command.join(' ')}`);
    let started = false;
    const finish = (code: number | null, signal: string | null, reason: NonNullable<ServiceRun['ended']>['reason']): void => {
      if (!run.running) return;
      run.running = false;
      for (const timer of run.timers) clearTimeout(timer);
      for (const stream of ['out', 'err'] as const) if (run.partial[stream] !== '') push(run, run.partial[stream]);
      run.ended = { at: now().toISOString(), code, signal, reason };
      push(run, reason === 'time-limit' ? 'fermato: oltre il limite di tempo' : reason === 'stopped' ? 'fermato su tua richiesta' : reason === 'error' ? 'non avviato' : `finito (codice ${String(code ?? signal ?? '?')})`);
      // A command that never started has no stop in the chain: there was no start either.
      if (started) options.onEvent?.('service.stopped', { project, service: event, reason, code });
    };
    let child: ChildProcess;
    try {
      // Its own process group, so that a stop reaches what the script started (vite, node…).
      child = spawn(file, args, { cwd: root, env: serviceEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    } catch (error) {
      push(run, `non avviato: ${error instanceof Error ? error.message : String(error)}`);
      finish(null, null, 'error');
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      feed(run, 'out', text);
    });
    child.stderr?.on('data', (text: string) => {
      feed(run, 'err', text);
    });
    child.once('spawn', () => {
      started = true;
      if (child.pid !== undefined) run.pid = child.pid;
      options.onEvent?.('service.started', { project, service: event });
    });
    child.once('error', (error) => {
      push(run, `non avviato: ${error.message}`);
      finish(null, null, 'error');
    });
    // `close`, not `exit`: the last lines of the streams are in by then.
    child.once('close', (code, signal) => {
      finish(code, signal, run.stopping ?? 'exit');
    });
    if (limit !== null) {
      const timer = setTimeout(() => {
        run.stopping = 'time-limit';
        kill(run);
      }, limit);
      timer.unref();
      run.timers.push(timer);
    }
  }

  return {
    start(project, root, service) {
      if (runs.get(key(project, service.id))?.running === true) throw new ServiceError('running', `${service.name} is already running`);
      // `up -d` of compose ends at once: it is short (a slow pull is cut at the limit too), the service stays with Docker.
      launch(project, root, service.id, service.command, service.stays && service.source !== 'compose' ? null : shortLimit, service.id);
    },
    stop(project, root, service) {
      const run = runs.get(key(project, service.id));
      if (run?.running === true) {
        run.stopping = 'stopped';
        kill(run);
        return;
      }
      if (service.source === 'compose') {
        const file = service.command[3] ?? 'docker-compose.yml';
        launch(project, root, service.id, ['docker', 'compose', '-f', file, 'stop', service.name], shortLimit, `${service.id}:stop`);
        return;
      }
      throw new ServiceError('not-running', `${service.name} was not started from here`);
    },
    run(project, serviceId) {
      const run = runs.get(key(project, serviceId));
      if (run === undefined) return undefined;
      return { startedAt: run.startedAt, running: run.running, ended: run.ended, lines: [...run.lines] };
    },
    async stopAll() {
      const groups = [...runs.values()].flatMap((run) => {
        if (run.pid === undefined || !groupAlive(run.pid)) return [];
        if (run.running) run.stopping = 'stopped';
        return [run.pid];
      });
      for (const pid of groups) signalGroup(pid, 'SIGTERM');
      const until = Date.now() + grace;
      while (groups.some(groupAlive) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
      for (const pid of groups) if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    },
  };
}
