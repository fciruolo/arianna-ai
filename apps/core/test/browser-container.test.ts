import assert from 'node:assert/strict';
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

test('channel: only ports 5900 and 9222, only browser containers', () => {
  assert.deepEqual(channelArgs('arianna-browser-a', 9222), ['exec', '-i', 'arianna-browser-a', 'socat', 'STDIO', 'TCP:127.0.0.1:9222']);
  assert.deepEqual(channelArgs('arianna-browser-a', 5900).at(-1), 'TCP:127.0.0.1:5900');
  for (const port of [22, 5432, 9223, 0, 59000, Number.NaN]) {
    assert.throws(() => channelArgs('arianna-browser-a', port), code('bad-port'), String(port));
  }
  assert.throws(() => channelArgs('arianna-postgres', 9222), code('bad-id'));
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
