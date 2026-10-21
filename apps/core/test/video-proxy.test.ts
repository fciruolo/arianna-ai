import assert from 'node:assert/strict';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { after, before, test } from 'node:test';

import { connectTarget, startVideoProxy, videoHostAllowed, type VideoProxy } from '../src/video-proxy.ts';

// No test reaches the internet: an echo server on 127.0.0.1 stands for YouTube,
// reached through a fake resolver; 127.0.0.1 counts as public only through the test option.
let echo: Server;
let echoPort = 0;

before(async () => {
  echo = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoPort = (echo.address() as AddressInfo).port;
});

after(() => {
  echo.close();
});

const NAMES: Record<string, string> = {
  'www.youtube.com': '127.0.0.1',
  'rr1---sn-abc.googlevideo.com': '127.0.0.1',
  'youtubei.googleapis.com': '192.168.1.5',
};
const resolve = (host: string) => {
  const address = NAMES[host];
  return address === undefined ? Promise.reject(new Error('dns')) : Promise.resolve([{ address, family: 4 }]);
};

function proxy(extra: { maxBytes?: number; maxMs?: number } = {}): Promise<VideoProxy> {
  return startVideoProxy({ resolve, unsafeTest: { port: echoPort, addresses: ['127.0.0.1'] }, ...extra });
}

/** Opens a CONNECT through the proxy; resolves with the status line and the socket. */
function tunnel(through: VideoProxy, target: string, auth = true): Promise<{ status: string; socket: Socket }> {
  const url = new URL(through.url);
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) });
    const header = auth ? `Proxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString('base64')}\r\n` : '';
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`));
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      resolvePromise({ status: buffer.slice(0, buffer.indexOf('\r\n')), socket });
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
}

function roundTrip(socket: Socket, text: string): Promise<string> {
  return new Promise((resolvePromise) => {
    socket.once('data', (chunk: Buffer) => { resolvePromise(chunk.toString()); });
    socket.write(text);
  });
}

test('the hosts of the list: YouTube and its media servers by name, nothing else (D-273)', () => {
  for (const host of ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'consent.youtube.com', 'youtubei.googleapis.com', 'music.youtube.com', 'rr3---sn-hpa7zns7.googlevideo.com', 'WWW.YOUTUBE.COM']) {
    assert.equal(videoHostAllowed(host), true, host);
  }
  for (const host of ['googlevideo.com', '.googlevideo.com', 'evil.com', 'youtube.com.evil.com', 'www.google.com', 'accounts.google.com', 'i.ytimg.com', '142.250.0.1', 'www.youtube.com.', 'localhost', 'a..googlevideo.com', 'x_y.googlevideo.com']) {
    assert.equal(videoHostAllowed(host), false, host);
  }
  assert.deepEqual(connectTarget('www.youtube.com:443'), { host: 'www.youtube.com', port: 443 });
  for (const target of [undefined, 'www.youtube.com', '/path', 'www.youtube.com:0', 'www.youtube.com:99999', '[::1]:443', 'a b:443']) assert.equal(connectTarget(target), undefined, String(target));
});

test('a tunnel to an allowed host carries the bytes and counts them', async () => {
  const through = await proxy();
  try {
    assert.match(through.url, /^http:\/\/arianna:[A-Za-z0-9_-]{20,}@127\.0\.0\.1:\d+$/);
    const { status, socket } = await tunnel(through, `rr1---sn-abc.googlevideo.com:${String(echoPort)}`);
    assert.match(status, / 200 /);
    assert.equal(await roundTrip(socket, 'ciao'), 'ciao');
    socket.destroy();
    assert.equal(through.bytes, 8);
    assert.equal(through.stopped, undefined);
  } finally {
    await through.stop();
  }
});

test('refused: another host, another port, an address, no token, a private address behind a name, a plain request', async () => {
  const through = await proxy();
  try {
    assert.match((await tunnel(through, `example.org:${String(echoPort)}`)).status, / 403 /);
    assert.match((await tunnel(through, 'www.youtube.com:80')).status, / 403 /);
    assert.match((await tunnel(through, `127.0.0.1:${String(echoPort)}`)).status, / 403 /);
    assert.match((await tunnel(through, `www.youtube.com:${String(echoPort)}`, false)).status, / 407 /);
    // Allowed by name, but the name resolves to the local network: never connected.
    assert.match((await tunnel(through, `youtubei.googleapis.com:${String(echoPort)}`)).status, / 502 /);
    const url = new URL(through.url);
    const plain = await fetch(`http://127.0.0.1:${url.port}/watch?v=x`).then((response) => response.status);
    assert.equal(plain, 405);
    assert.equal(through.refused, 5);
    assert.equal(through.bytes, 0);
  } finally {
    await through.stop();
  }
});

test('past the bytes limit every tunnel closes and the proxy says why; nothing more is opened', async () => {
  const through = await proxy({ maxBytes: 10 });
  try {
    const { socket } = await tunnel(through, `www.youtube.com:${String(echoPort)}`);
    const closed = new Promise<void>((resolvePromise) => socket.once('close', () => { resolvePromise(); }));
    socket.write('0123456789abcdef');
    await closed;
    assert.equal(through.stopped, 'too-large');
    assert.match((await tunnel(through, `www.youtube.com:${String(echoPort)}`)).status, / 503 /);
  } finally {
    await through.stop();
  }
});

test('past the time limit every tunnel closes; after stop nothing listens', async () => {
  const through = await proxy({ maxMs: 50 });
  const { socket } = await tunnel(through, `www.youtube.com:${String(echoPort)}`);
  await new Promise<void>((resolvePromise) => socket.once('close', () => { resolvePromise(); }));
  assert.equal(through.stopped, 'timeout');
  await through.stop();
  const port = Number(new URL(through.url).port);
  await assert.rejects(
    new Promise((resolvePromise, reject) => {
      const late = connect({ host: '127.0.0.1', port });
      late.once('connect', () => { resolvePromise(undefined); });
      late.once('error', reject);
    }),
  );
});
