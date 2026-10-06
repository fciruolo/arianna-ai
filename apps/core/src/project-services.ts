import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
  /** What the script says, for the page (package.json only). */
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

/** The targets of a Makefile, special ones (`.PHONY`) and variables left out. */
export function makeServices(text: string): ProjectService[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z0-9][\w.-]{0,63})\s*:(?![:=])/.exec(line);
    if (match?.[1] !== undefined) names.add(match[1]);
  }
  return [...names].slice(0, 100).map((name) => ({ id: `Makefile:${name}`, source: 'Makefile' as const, file: 'Makefile', name, command: ['make', name], ports: [], stays: false }));
}

/** Every service the project declares, read now from its files. */
export async function listServices(root: string): Promise<ProjectService[]> {
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
  return services;
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

export type ServiceErrorCode = 'unknown' | 'running' | 'not-running';

export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
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
  /** At the end of the core: every process started here stops. */
  stopAll(): void;
}

/** The variables a command of the project gets: no secret of the core, no colours. */
function serviceEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, LANG, SHELL, USER } = process.env;
  return {
    ...(PATH === undefined ? {} : { PATH }),
    ...(HOME === undefined ? {} : { HOME }),
    ...(SHELL === undefined ? {} : { SHELL }),
    ...(USER === undefined ? {} : { USER }),
    LANG: LANG ?? 'en_US.UTF-8',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function createServiceManager(options: ServiceManagerOptions = {}): ServiceManager {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => new Date());
  const shortLimit = options.shortLimitMs ?? SHORT_LIMIT_MS;
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const runs = new Map<string, ServiceRun & { child?: ChildProcess; timers: ReturnType<typeof setTimeout>[]; stopping?: 'stopped' | 'time-limit' }>();
  const key = (project: string, id: string): string => `${project}\u0000${id}`;

  function append(run: ServiceRun, text: string): void {
    for (const raw of text.replace(ANSI, '').split(/\r?\n/)) {
      if (raw === '') continue;
      run.lines.push(raw.slice(0, MAX_LINE_CHARS));
    }
    if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES);
  }

  /** The group of the child: SIGTERM, then SIGKILL after the grace. */
  function kill(run: ServiceRun & { child?: ChildProcess; timers: ReturnType<typeof setTimeout>[] }): void {
    const pid = run.child?.pid;
    if (pid === undefined) return;
    const signal = (name: NodeJS.Signals): void => {
      try {
        process.kill(-pid, name);
      } catch {
        // Already gone.
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => {
      if (run.running) signal('SIGKILL');
    }, grace);
    timer.unref();
    run.timers.push(timer);
  }

  function launch(project: string, root: string, id: string, command: string[], limit: number | null, event: string): void {
    const [file, ...args] = command;
    if (file === undefined) throw new ServiceError('unknown', 'empty command');
    const run: ServiceRun & { child?: ChildProcess; timers: ReturnType<typeof setTimeout>[]; stopping?: 'stopped' | 'time-limit' } = {
      startedAt: now().toISOString(),
      running: true,
      ended: null,
      lines: [],
      timers: [],
    };
    runs.set(key(project, id), run);
    append(run, `$ ${command.join(' ')}`);
    const finish = (code: number | null, signal: string | null, reason: NonNullable<ServiceRun['ended']>['reason']): void => {
      if (!run.running) return;
      run.running = false;
      for (const timer of run.timers) clearTimeout(timer);
      run.ended = { at: now().toISOString(), code, signal, reason };
      append(run, reason === 'time-limit' ? 'fermato: oltre il limite di tempo' : reason === 'stopped' ? 'fermato su tua richiesta' : `finito (codice ${String(code ?? signal ?? '?')})`);
      options.onEvent?.('service.stopped', { project, service: event, reason, code });
    };
    let child: ChildProcess;
    try {
      // Its own process group, so that a stop reaches what the script started (vite, node…).
      child = spawn(file, args, { cwd: root, env: serviceEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
    } catch (error) {
      append(run, `non avviato: ${error instanceof Error ? error.message : String(error)}`);
      finish(null, null, 'error');
      return;
    }
    run.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (text: string) => {
      append(run, text);
    });
    child.stderr?.on('data', (text: string) => {
      append(run, text);
    });
    child.once('error', (error) => {
      append(run, `non avviato: ${error.message}`);
      finish(null, null, 'error');
    });
    child.once('exit', (code, signal) => {
      finish(code, signal, run.stopping ?? 'exit');
    });
    options.onEvent?.('service.started', { project, service: event });
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
      // `up -d` of compose ends at once: it is short, the service stays with Docker.
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
    stopAll() {
      for (const run of runs.values()) {
        if (!run.running) continue;
        run.stopping = 'stopped';
        const pid = run.child?.pid;
        if (pid === undefined) continue;
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
    },
  };
}
