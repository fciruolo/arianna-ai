import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DEFAULT_SERVER, remotePaths, resolveHome, type RemoteServerConfig } from '@arianna/config';

import { findOpenssl, generateCertificate } from '../src/remote-cert.ts';
import { analyzeServeStatus, remoteChecks, serveCommand, TAILSCALE_APP } from '../src/remote-checks.ts';

// D-292: made-up outputs of `tailscale serve status --json`, in its format.
const HOST = 'mac-prova.tail0000.ts.net';
const OWN: RemoteServerConfig = { host: HOST, port: 7443, tls: 'own' };
const TAILSCALE: RemoteServerConfig = { ...OWN, tls: 'tailscale' };
const root = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const tcpForward = { TCP: { '443': { TCPForward: '127.0.0.1:7443' } } };
const https = { TCP: { '443': { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7443' } } } } };

test('the commands of the two modes', () => {
  assert.equal(serveCommand(OWN), 'tailscale serve --bg --tcp=443 tcp://127.0.0.1:7443');
  assert.equal(serveCommand(TAILSCALE), 'tailscale serve --bg --https=443 http://127.0.0.1:7443');
});

test('tls = "own": only TCP 443 forwarded to the remote port, without TLS ended by Tailscale', () => {
  assert.deepEqual(analyzeServeStatus(tcpForward, OWN).ok, true);
  const refused: [string, unknown, RegExp][] = [
    ['nothing published', {}, /non pubblica niente.*--tcp=443/],
    ['another port', { TCP: { '443': { TCPForward: '127.0.0.1:7420' } } }, /non inoltra/],
    ['another address', { TCP: { '443': { TCPForward: '192.168.1.5:7443' } } }, /non inoltra/],
    ['TLS ended by Tailscale', { TCP: { '443': { TCPForward: '127.0.0.1:7443', TerminateTLS: HOST } } }, /apre il traffico/],
    ['another port too', { TCP: { '443': { TCPForward: '127.0.0.1:7443' }, '8080': { TCPForward: '127.0.0.1:7420' } } }, /anche altro/],
    ['a web handler too', { ...tcpForward, Web: { [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } } } } }, /anche altro/],
    ['the setup of the other mode', https, /tls = "tailscale".*tls = "own"/],
    ['funnel', { ...tcpForward, AllowFunnel: { [`${HOST}:443`]: true } }, /Funnel è attivo/],
    ['a foreground session with funnel', { ...tcpForward, Foreground: { abc: { AllowFunnel: { [`${HOST}:443`]: true } } } }, /Funnel/],
    ['a foreground session publishing more', { ...tcpForward, Foreground: { abc: { TCP: { '22': { TCPForward: '127.0.0.1:22' } } } } }, /anche altro/],
    ['services of the tailnet', { ...tcpForward, Services: { 'svc:x': {} } }, /Services/],
    ['not an object', [], /non ha dato/],
  ];
  for (const [name, json, detail] of refused) {
    const check = analyzeServeStatus(json, OWN);
    assert.equal(check.ok, false, name);
    assert.match(check.detail, detail, name);
  }
  // Funnel set to false is not on.
  assert.equal(analyzeServeStatus({ ...tcpForward, AllowFunnel: { [`${HOST}:443`]: false } }, OWN).ok, true);
});

test('tls = "tailscale": only https://<name> to http://127.0.0.1:<port>', () => {
  assert.equal(analyzeServeStatus(https, TAILSCALE).ok, true);
  const refused: [string, unknown, RegExp][] = [
    ['nothing published', {}, /--https=443/],
    ['another name', { ...https, Web: { [`altro.tail0000.ts.net:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7443' } } } } }, /non manda/],
    ['the port of this Mac', { ...https, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } } } } }, /non manda/],
    ['another path too', { ...https, Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7443' }, '/files': { Path: '/Users' } } } } }, /anche altro/],
    ['another name too', { ...https, Web: { ...https.Web, [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } } } } }, /anche altro/],
    ['a TCP forward too', { ...https, TCP: { '443': { HTTPS: true }, '22': { TCPForward: '127.0.0.1:22' } } }, /anche altro/],
    ['the setup of the other mode', tcpForward, /tls = "own".*tls = "tailscale"/],
    ['funnel', { ...https, AllowFunnel: { [`${HOST}:443`]: true } }, /Funnel/],
    ['a foreground session publishing more', { ...https, Foreground: { abc: { Web: { [`${HOST}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:7420' } } } } } } }, /anche altro/],
    ['a foreground session with funnel', { ...https, Foreground: { abc: { AllowFunnel: { [`${HOST}:443`]: true } } } }, /Funnel/],
  ];
  for (const [name, json, detail] of refused) {
    const check = analyzeServeStatus(json, TAILSCALE);
    assert.equal(check.ok, false, name);
    assert.match(check.detail, detail, name);
  }
});

test('remoteChecks: without [server.remote] nothing to do; Tailscale missing says so; the app binary first', async () => {
  const paths = { data: join(root, 'data') };
  assert.deepEqual(await remoteChecks({ server: { ...DEFAULT_SERVER }, paths }), [
    { id: 'remote.tailscale', ok: true, detail: 'nessun accesso dal telefono: [server.remote] non è in arianna.toml (D-292)' },
  ]);
  const ran: string[] = [];
  const missing = await remoteChecks(
    { server: { ...DEFAULT_SERVER, remote: TAILSCALE }, paths },
    { exists: () => false, run: (binary) => (ran.push(binary), Promise.reject(new Error('ENOENT'))) },
  );
  assert.deepEqual(ran, ['tailscale']);
  assert.equal(missing.length, 1);
  assert.match(missing[0]?.detail ?? '', /Tailscale non risponde/);

  const args: string[][] = [];
  const found = await remoteChecks(
    { server: { ...DEFAULT_SERVER, remote: TAILSCALE }, paths },
    { exists: (path) => path === TAILSCALE_APP, run: (binary, list) => (ran.push(binary), args.push(list), Promise.resolve(JSON.stringify(https))) },
  );
  assert.equal(ran.at(-1), TAILSCALE_APP);
  assert.deepEqual(args, [['serve', 'status', '--json']]);
  assert.deepEqual(found.map((check) => check.ok), [true]);
});

test('remoteChecks in mode own: the certificate must be there, for the name and not about to expire', async () => {
  const data = join(root, 'own');
  const config = { server: { ...DEFAULT_SERVER, remote: OWN }, paths: { data } };
  const run = () => Promise.resolve(JSON.stringify(tcpForward));
  const without = await remoteChecks(config, { run, exists: () => false });
  assert.deepEqual(without.map((check) => [check.id, check.ok]), [['remote.tailscale', true], ['remote.cert', false]]);
  assert.match(without[1]?.detail ?? '', /pnpm remote:cert/);
  try {
    generateCertificate({ openssl: findOpenssl(), paths: remotePaths(data), host: HOST, now: new Date() });
  } catch {
    return; // No openssl here: the rest is covered by remote-cert.test.ts.
  }
  const fresh = await remoteChecks(config, { run, exists: () => false });
  assert.equal(fresh[1]?.ok, true);
  chmodSync(remotePaths(data).key, 0o644);
  assert.match((await remoteChecks(config, { run, exists: () => false }))[1]?.detail ?? '', /server\.key è leggibile da altri/);
  chmodSync(remotePaths(data).key, 0o600);
  chmodSync(remotePaths(data).dir, 0o755);
  assert.match((await remoteChecks(config, { run, exists: () => false }))[1]?.detail ?? '', /chmod 700 data\/remote/);
  chmodSync(remotePaths(data).dir, 0o700);
  chmodSync(remotePaths(data).key, 0o600);
  mkdirSync(remotePaths(data).tmp);
  assert.match((await remoteChecks(config, { run, exists: () => false }))[1]?.detail ?? '', /data\/remote\/tmp/);
  rmSync(remotePaths(data).tmp, { recursive: true });
  const late = await remoteChecks(config, { run, exists: () => false, now: new Date(Date.now() + 780 * 86_400_000) });
  assert.equal(late[1]?.ok, false);
  assert.match(late[1].detail, /scade fra \d+ giorni: lancia pnpm remote:cert/);
  const other = await remoteChecks({ ...config, server: { ...DEFAULT_SERVER, remote: { ...OWN, host: 'altro.tail0000.ts.net' } } }, { run, exists: () => false });
  assert.match(other[1]?.detail ?? '', /non è per altro\.tail0000\.ts\.net/);
});
