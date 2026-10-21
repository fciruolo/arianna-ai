import { spawn, type ChildProcess } from 'node:child_process';
import { Duplex } from 'node:stream';

import { BrowserError, channelArgs } from './container.ts';

/**
 * A channel to a Unix socket inside the container of the browser (D-264):
 * `docker exec -i <container> socat STDIO UNIX-CONNECT:<socket>`, spawned
 * without a shell. The container has no network and nothing in it listens on
 * TCP: this pipe through Docker is the only way in, and no port opens on the
 * Mac.
 *
 * The stdin of socat stays open for the whole life of the channel: when it
 * is half-closed socat stops and the answer still on its way is lost. So the
 * end of either side destroys the channel, it never only ends the writing.
 */

export interface Channel {
  stream: Duplex;
  close(): void;
}

export type OpenChannel = (container: string, socket: string) => Channel;

/** Starts `docker` with an argv and pipes on stdin and stdout; injectable for tests. */
export type SpawnDocker = (args: string[]) => ChildProcess;

const spawnDocker: SpawnDocker = (args) => spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });

export function dockerChannelOpener(spawnFn: SpawnDocker = spawnDocker): OpenChannel {
  return (container, socket) => {
    const args = channelArgs(container, socket);
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
