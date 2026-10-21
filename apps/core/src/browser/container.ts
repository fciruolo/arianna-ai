import { execFile } from 'node:child_process';

import { isImageId } from './image.ts';

/**
 * The container of the agent's browser (D-264, D-095 tappa 2): every
 * argument of `docker run` is fixed here and checked by a test, so a change
 * that adds a network, a volume or a published port fails the suite. Docker
 * is called with execFile, never through a shell.
 */

export const CONTAINER_PREFIX = 'arianna-browser-';
/** The only ports the core may reach inside the container: VNC and CDP. */
export const VNC_PORT = 5900;
export const CDP_PORT = 9222;
export const CHANNEL_PORTS: readonly number[] = [VNC_PORT, CDP_PORT];

const BROWSER_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CONTAINER_NAME = /^arianna-browser-[a-z0-9][a-z0-9-]{0,47}$/;

export class BrowserError extends Error {
  readonly code: 'busy' | 'no-lock' | 'image-mismatch' | 'bad-id' | 'bad-image' | 'bad-port' | 'docker' | 'cdp-timeout' | 'closed';

  constructor(code: BrowserError['code'], message: string) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
  }
}

export function validBrowserId(id: string): boolean {
  return BROWSER_ID.test(id);
}

export function containerName(id: string): string {
  if (!validBrowserId(id)) throw new BrowserError('bad-id', 'browser id must be [a-z0-9-], at most 48 characters');
  return `${CONTAINER_PREFIX}${id}`;
}

export function isContainerName(name: string): boolean {
  return CONTAINER_NAME.test(name);
}

export interface RunArgsInput {
  id: string;
  /** The id of the built image, "sha256:<64 hex>", from config/browser-image.lock. */
  image: string;
  /** Absolute path of apps/core/browser/seccomp.json. */
  seccompPath: string;
}

/**
 * The argv of `docker run` (without "docker"). Nothing else may be added:
 * no -v/--mount, no -p, no --ipc, no --privileged, no --cap-add.
 * - /tmp is noexec: Xvnc and Chromium start (checked 2026-10-21), and the
 *   Debian wrapper passes --disable-dev-shm-usage, so Chromium keeps its
 *   shared memory in /tmp: hence 256 MB.
 * - /srv/browser holds the profile: 4 MB at start, 8 MB after the pages
 *   of the live trial.
 * - --log-driver none: what Chromium prints (it can name the pages) is not
 *   kept by Docker.
 * - seccomp=<path>: docker splits it at the first "=" and reads the whole
 *   rest as a path, spaces and commas included (checked 2026-10-21).
 */
export function browserRunArgs(input: RunArgsInput): string[] {
  const name = containerName(input.id);
  if (!isImageId(input.image)) throw new BrowserError('bad-image', 'the browser image must be an id "sha256:<64 hex>", never a tag or a name');
  if (!input.seccompPath.startsWith('/') || /[\n\r\0]/.test(input.seccompPath)) {
    throw new BrowserError('docker', 'the seccomp profile must be an absolute path on one line');
  }
  return [
    'run',
    '--rm',
    '--init',
    '-d',
    '--name', name,
    '--log-driver', 'none',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:size=256m,noexec',
    '--tmpfs', '/srv/browser:size=128m,uid=10001,gid=10001',
    '--user', '10001:10001',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--security-opt', `seccomp=${input.seccompPath}`,
    '--memory', '1g',
    '--memory-swap', '1g',
    '--cpus', '1',
    '--pids-limit', '256',
    '--shm-size', '256m',
    input.image,
  ];
}

/** The argv of the channel to a port inside the container (without "docker"). */
export function channelArgs(container: string, port: number): string[] {
  if (!isContainerName(container)) throw new BrowserError('bad-id', 'not a container of the browser');
  if (!CHANNEL_PORTS.includes(port)) throw new BrowserError('bad-port', `only ports ${CHANNEL_PORTS.join(' and ')} can be reached`);
  return ['exec', '-i', container, 'socat', 'STDIO', `TCP:127.0.0.1:${String(port)}`];
}

/** Runs docker with fixed arguments and returns stdout; injectable for tests. */
export type DockerRun = (args: string[], timeoutMs?: number) => Promise<string>;

export const execDocker: DockerRun = (args, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024, shell: false }, (error, stdout, stderr) => {
      if (error) {
        // The first line of stderr only: docker says what failed without dumping the environment.
        const reason = stderr.split('\n')[0]?.trim() || error.message;
        reject(new BrowserError('docker', `docker ${args[0] ?? ''}: ${reason}`));
        return;
      }
      resolve(stdout);
    });
  });

/** Refuses to start when the local image is not the one of the lock. */
export async function checkImage(docker: DockerRun, image: string): Promise<void> {
  if (!isImageId(image)) throw new BrowserError('bad-image', 'the browser image must be an id "sha256:<64 hex>"');
  let id: string;
  try {
    id = (await docker(['image', 'inspect', '--format', '{{.Id}}', image], 15_000)).trim();
  } catch {
    throw new BrowserError('image-mismatch', 'the browser image of config/browser-image.lock is not on this machine: run pnpm browser:build');
  }
  if (id !== image) throw new BrowserError('image-mismatch', 'the local browser image differs from config/browser-image.lock: run pnpm browser:build');
}

/** Names of the browser containers left by a core that stopped; only well-formed names. */
export async function leftoverContainers(docker: DockerRun): Promise<string[]> {
  const out = await docker(['ps', '-a', '--filter', `name=^${CONTAINER_PREFIX}`, '--format', '{{.Names}}'], 15_000);
  return out.split('\n').map((line) => line.trim()).filter(isContainerName);
}

export async function removeContainers(docker: DockerRun, names: string[]): Promise<void> {
  const valid = names.filter(isContainerName);
  if (valid.length === 0) return;
  await docker(['rm', '-f', ...valid], 30_000);
}
