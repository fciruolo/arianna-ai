import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';

import { BrowserError, CDP_PORT, channelArgs } from './container.ts';

/**
 * A channel to a port inside the container of the browser (D-264): `docker
 * exec -i <container> socat STDIO TCP:127.0.0.1:<port>`, spawned without a
 * shell. The container has no network: this pipe through Docker is the only
 * way in, and no port opens on the Mac.
 *
 * The stdin of socat stays open for the whole life of the channel: when it
 * is half-closed socat stops and the answer still on its way is lost. So the
 * end of either side destroys the channel, it never only ends the writing.
 */

export interface Channel {
  stream: Duplex;
  close(): void;
}

export type OpenChannel = (container: string, port: number) => Channel;

/** Starts `docker` with an argv and pipes on stdin and stdout; injectable for tests. */
export type SpawnDocker = (args: string[]) => ChildProcess;

const spawnDocker: SpawnDocker = (args) => spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });

export function dockerChannelOpener(spawnFn: SpawnDocker = spawnDocker): OpenChannel {
  return (container, port) => {
    const args = channelArgs(container, port);
    const child = spawnFn(args);
    const { stdin, stdout } = child;
    if (!stdin || !stdout) {
      child.kill('SIGKILL');
      throw new BrowserError('docker', 'docker exec started without pipes');
    }
    let closed = false;
    // Kills docker exec once; the stream is destroyed with it.
    const close = (): void => {
      if (closed) return;
      closed = true;
      child.kill('SIGKILL');
      stream.destroy();
    };
    const stream = new Duplex({
      read() {
        stdout.resume();
      },
      write(chunk: Buffer, _encoding, callback) {
        if (stdin.destroyed) {
          callback(new BrowserError('closed', 'the browser channel is closed'));
          return;
        }
        stdin.write(chunk, callback);
      },
      final(callback) {
        // Never half-close socat's stdin (see above): the end of writing closes the whole channel.
        callback();
        close();
      },
      destroy(error, callback) {
        if (!closed) {
          closed = true;
          child.kill('SIGKILL');
        }
        callback(error);
      },
    });
    stdout.on('data', (chunk: Buffer) => {
      if (!stream.push(chunk)) stdout.pause();
    });
    stdout.on('end', () => stream.push(null));
    stdin.on('error', () => { close(); });
    child.on('error', (error) => stream.destroy(new BrowserError('docker', `docker exec: ${error.message}`)));
    child.on('close', () => {
      if (!stream.destroyed) stream.push(null);
      close();
    });
    return { stream, close };
  };
}

export const openDockerChannel: OpenChannel = dockerChannelOpener();

const MAX_HEAD = 16 * 1024;
const MAX_BODY = 64 * 1024;
const DEVTOOLS_URL = /^ws:\/\/127\.0\.0\.1:9222(\/devtools\/browser\/[0-9a-f-]{36})$/;

/**
 * The path of the browser's CDP endpoint, from GET /json/version through a
 * channel: "/devtools/browser/<uuid>". Anything else is refused.
 */
export function readDevtoolsPath(open: OpenChannel, container: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel = open(container, CDP_PORT);
    let buffer = Buffer.alloc(0);
    let done = false;
    const finish = (error: Error | null, path?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.close();
      if (error) reject(error);
      else resolve(path ?? '');
    };
    const timer = setTimeout(() => { finish(new BrowserError('cdp-timeout', 'CDP did not answer')); }, timeoutMs);
    channel.stream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > MAX_HEAD) finish(new BrowserError('docker', 'CDP answer too long'));
        return;
      }
      const head = buffer.subarray(0, end).toString('latin1');
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1];
      const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1] ?? NaN);
      if (status !== '200' || !Number.isInteger(length) || length > MAX_BODY) {
        finish(new BrowserError('docker', 'unexpected CDP answer'));
        return;
      }
      const body = buffer.subarray(end + 4);
      if (body.length < length) return;
      try {
        const parsed = JSON.parse(body.subarray(0, length).toString('utf8')) as { webSocketDebuggerUrl?: unknown };
        const url = typeof parsed.webSocketDebuggerUrl === 'string' ? parsed.webSocketDebuggerUrl : '';
        const path = DEVTOOLS_URL.exec(url)?.[1];
        if (path) finish(null, path);
        else finish(new BrowserError('docker', 'unexpected CDP endpoint'));
      } catch {
        finish(new BrowserError('docker', 'unexpected CDP answer'));
      }
    });
    channel.stream.on('error', (error: Error) => { finish(error); });
    channel.stream.on('close', () => { finish(new BrowserError('closed', 'CDP closed the channel')); });
    // Chromium refuses a Host that is not an IP or localhost: the one of the container's loopback.
    channel.stream.write(`GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:${String(CDP_PORT)}\r\n\r\n`);
  });
}

export interface WaitOptions {
  timeoutMs: number;
  attemptMs?: number;
  pauseMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Waits until CDP answers, within a ceiling of time. */
export async function waitForCdp(open: OpenChannel, container: string, options: WaitOptions): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const left = deadline - now();
    if (left <= 0) throw new BrowserError('cdp-timeout', `CDP of the browser did not answer within ${String(Math.round(options.timeoutMs / 1000))} s`);
    try {
      return await readDevtoolsPath(open, container, Math.min(options.attemptMs ?? 2_000, left));
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'bad-port') throw error;
    }
    await sleep(options.pauseMs ?? 200);
  }
}
