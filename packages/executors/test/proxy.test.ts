// With NODE_USE_ENV_PROXY and HTTP_PROXY set, fetch sends even loopback
// requests to the proxy. The adapter and the watchdog must not: the proxy
// would receive L2 prompts.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

import { startFakeServer, type FakeServer } from './fixtures/fake-server.ts';

const CHECK_MAIN = join(import.meta.dirname, 'fixtures', 'proxy-check-main.ts');
const run = promisify(execFile);

describe('environment proxy', { timeout: 30_000 }, () => {
  let server: FakeServer;
  let proxyUrl: string;
  let proxyHits = 0;
  // Counts and drops: a request that reaches it never gets anywhere.
  const proxy = createServer((req) => {
    proxyHits += 1;
    req.socket.destroy();
  });
  proxy.on('connect', (_req, socket) => {
    proxyHits += 1;
    socket.destroy();
  });

  before(async () => {
    server = await startFakeServer();
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`;
  });
  after(async () => {
    await server.close();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  });

  async function check(mode: 'adapter' | 'fetch'): Promise<{ ok: boolean; text?: string; state?: string }> {
    // Without NODE_TEST_CONTEXT: the child would take itself for a test file of this runner.
    const env = { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '' };
    const { stdout } = await run(process.execPath, [CHECK_MAIN, mode, server.url], { env, timeout: 20_000 });
    return JSON.parse(stdout) as { ok: boolean; text?: string; state?: string };
  }

  it('is really turned on by the environment (control: plain fetch goes to the proxy)', async () => {
    const before = proxyHits;
    await check('fetch');
    assert.ok(proxyHits > before, 'the proxy saw nothing: the test would prove nothing');
  });

  it('is never used by the adapter or the watchdog', async () => {
    const before = proxyHits;
    assert.deepEqual(await check('adapter'), { ok: true, text: 'hello', state: 'up' });
    assert.equal(proxyHits, before);
  });
});
