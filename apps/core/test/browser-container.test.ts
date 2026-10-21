import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BrowserError,
  browserRunArgs,
  channelArgs,
  checkImage,
  containerName,
  leftoverContainers,
  removeContainers,
  type DockerRun,
} from '../src/browser/container.ts';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const SECCOMP = '/opt/arianna/apps/core/browser/seccomp.json';

const code = (expected: BrowserError['code']) => (error: unknown): boolean => error instanceof BrowserError && error.code === expected;

test('docker run: the exact list of arguments, nothing more', () => {
  assert.deepEqual(browserRunArgs({ id: 'job-42', image: IMAGE, seccompPath: SECCOMP }), [
    'run', '--rm', '--init', '-d',
    '--name', 'arianna-browser-job-42',
    '--log-driver', 'none',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:size=256m,noexec',
    '--tmpfs', '/srv/browser:size=128m,uid=10001,gid=10001',
    '--user', '10001:10001',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--security-opt', `seccomp=${SECCOMP}`,
    '--memory', '1g', '--memory-swap', '1g', '--cpus', '1', '--pids-limit', '256', '--shm-size', '256m',
    IMAGE,
  ]);
});

test('docker run: no network but none, no volume, port, ipc, privilege or capability', () => {
  const args = browserRunArgs({ id: 'job-42', image: IMAGE, seccompPath: SECCOMP });
  const network = args.indexOf('--network');
  assert.equal(args[network + 1], 'none');
  assert.equal(args.filter((arg) => arg === '--network').length, 1);
  for (const forbidden of ['-v', '--volume', '--mount', '-p', '--publish', '-P', '--ipc', '--privileged', '--cap-add', '--pid', '--userns', '--device', '--add-host', '--env', '-e']) {
    assert.ok(!args.includes(forbidden), forbidden);
  }
  assert.ok(!args.some((arg) => arg.startsWith('--network=') || arg.startsWith('--volume=') || arg.startsWith('--mount=')));
  // The image is the last argument: nothing after it reaches the entrypoint.
  assert.equal(args.at(-1), IMAGE);
});

test('image: only an id sha256:<64 hex>, never a tag, a name or a digest reference', () => {
  assert.doesNotThrow(() => browserRunArgs({ id: 'a', image: IMAGE, seccompPath: SECCOMP }));
  for (const image of ['arianna-browser:local', 'arianna-browser', `arianna-browser@${IMAGE}`, 'sha256:abc', `sha256:${'A'.repeat(64)}`, `${IMAGE} --privileged`]) {
    assert.throws(() => browserRunArgs({ id: 'a', image, seccompPath: SECCOMP }), code('bad-image'), image);
  }
});

test('id of the browser: only [a-z0-9-]', () => {
  assert.equal(containerName('job-1'), 'arianna-browser-job-1');
  for (const id of ['', 'Job', 'a b', 'a;rm', '../x', '-x', 'a'.repeat(49), 'a_b']) {
    assert.throws(() => containerName(id), code('bad-id'), id);
  }
});

test('seccomp: an absolute path on one line, spaces and commas allowed', () => {
  for (const path of [SECCOMP, '/srv/Casa di Prova/arianna/seccomp.json', '/srv/a,b=c/seccomp.json']) {
    assert.ok(browserRunArgs({ id: 'a', image: IMAGE, seccompPath: path }).includes(`seccomp=${path}`), path);
  }
  for (const path of ['seccomp.json', './seccomp.json', '/a\nb/seccomp.json', '/a\rb/seccomp.json', '/a\0b/seccomp.json']) {
    assert.throws(() => browserRunArgs({ id: 'a', image: IMAGE, seccompPath: path }), BrowserError, path);
  }
});

test('channel: only /tmp/cdp.sock and /tmp/vnc.sock, only browser containers', () => {
  assert.deepEqual(channelArgs('arianna-browser-a', '/tmp/cdp.sock'), ['exec', '-i', 'arianna-browser-a', 'socat', 'STDIO', 'UNIX-CONNECT:/tmp/cdp.sock']);
  assert.equal(channelArgs('arianna-browser-a', '/tmp/vnc.sock').at(-1), 'UNIX-CONNECT:/tmp/vnc.sock');
  for (const socket of ['/tmp/.X11-unix/X1', '/tmp/cdp.sock,fork', 'TCP:127.0.0.1:9222', '/tmp/../tmp/cdp.sock', '', '/run/docker.sock']) {
    assert.throws(() => channelArgs('arianna-browser-a', socket), code('bad-socket'), socket);
  }
  assert.throws(() => channelArgs('arianna-postgres', '/tmp/cdp.sock'), code('bad-id'));
});

test('entrypoint: no TCP port for CDP or VNC, only the two Unix sockets', () => {
  const script = readFileSync(join(import.meta.dirname, '..', 'browser', 'entrypoint.sh'), 'utf8');
  const lines = script.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.match(lines, /--remote-debugging-pipe/);
  assert.doesNotMatch(lines, /--remote-debugging-port/);
  assert.doesNotMatch(lines, /--remote-debugging-address/);
  assert.doesNotMatch(lines, /--remote-allow-origins/);
  const rfbports = [...lines.matchAll(/-rfbport\s+(\S+)/g)].map((match) => match[1]);
  assert.deepEqual(rfbports, ['-1']);
  assert.match(lines, /-rfbunixpath \/tmp\/vnc\.sock/);
  assert.ok(lines.includes('UNIX-LISTEN:/tmp/cdp.sock,'));
  assert.match(lines, /fdin=3,fdout=4/);
  // socat accepts one connection: no fork, so one CDP session per container.
  assert.doesNotMatch(lines, /UNIX-LISTEN:[^ ]*fork/);
  assert.doesNotMatch(lines, /TCP(4|6)?(-LISTEN)?:/);
});

test('removal: a container already gone counts as removed, one being removed is asked again', async () => {
  const replies = [new BrowserError('docker', 'docker rm: Error response from daemon: removal of container arianna-browser-a is already in progress'), null];
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    const reply = replies.shift();
    return reply ? Promise.reject(reply) : Promise.resolve('');
  };
  await removeContainers(docker, ['arianna-browser-a'], () => Promise.resolve());
  assert.equal(calls.length, 2);
  const gone: DockerRun = () => Promise.reject(new BrowserError('docker', 'docker rm: Error response from daemon: No such container: arianna-browser-a'));
  await assert.doesNotReject(removeContainers(gone, ['arianna-browser-a']));
  const broken: DockerRun = () => Promise.reject(new BrowserError('docker', 'docker rm: Cannot connect to the Docker daemon'));
  await assert.rejects(removeContainers(broken, ['arianna-browser-a']), code('docker'));
});

test('image check: the local id must be the one of the lock', async () => {
  const same: DockerRun = (args) => Promise.resolve(args[0] === 'image' ? `${IMAGE}\n` : '');
  await checkImage(same, IMAGE);
  const other: DockerRun = () => Promise.resolve(`sha256:${'b'.repeat(64)}\n`);
  await assert.rejects(checkImage(other, IMAGE), code('image-mismatch'));
  const missing: DockerRun = () => Promise.reject(new Error('No such image'));
  await assert.rejects(checkImage(missing, IMAGE), code('image-mismatch'));
  await assert.rejects(checkImage(same, 'arianna-browser:local'), code('bad-image'));
});

test('leftovers: only well-formed browser containers are removed', async () => {
  const calls: string[][] = [];
  const docker: DockerRun = (args) => {
    calls.push(args);
    return Promise.resolve(args[0] === 'ps' ? 'arianna-browser-old\narianna-postgres\narianna-browser-Bad\n\narianna-browser-x;y\n' : '');
  };
  const names = await leftoverContainers(docker);
  assert.deepEqual(names, ['arianna-browser-old']);
  assert.deepEqual(calls[0], ['ps', '-a', '--filter', 'name=^arianna-browser-', '--format', '{{.Names}}']);
  await removeContainers(docker, [...names, 'arianna-postgres']);
  assert.deepEqual(calls[1], ['rm', '-f', 'arianna-browser-old']);
  await removeContainers(docker, ['arianna-postgres']);
  assert.equal(calls.length, 2);
});
