// The routes of the settings page (D-071): status codes, refusals, and the
// local servers' restart and log. No database: these routes do not use it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CATALOG_FILE, CONFIG_FILE, DATA_DIR, DEFAULT_SETTINGS, loadCatalog, parseConfig, renderSettings, resolveHome, type Settings } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import type { LocalServerStatus } from '../src/local-servers.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createSettingsPage, type SettingsChange } from '../src/settings-page.ts';

const REPO = resolveHome({});
const root = join(REPO, DATA_DIR, 'test-tmp', randomUUID());
const home = join(root, 'home');
const userHome = join(root, 'user');
const file = join(home, CONFIG_FILE);

const START: Settings = {
  ...DEFAULT_SETTINGS,
  roles: { orchestrator: 'qwen3.8-27b-4bit' },
  endpoints: [
    { id: 'omlx', url: 'http://127.0.0.1:7001/v1', command: ['omlx', 'serve'] },
    { id: 'spare', url: 'http://127.0.0.1:7002/v1' },
  ],
  cloud: { executors: ['claude'] },
};

const LOCAL: LocalServerStatus[] = [
  { id: 'omlx', url: 'http://127.0.0.1:7001/v1', managed: true, adopted: false, state: 'up' },
  { id: 'spare', url: 'http://127.0.0.1:7002/v1', managed: false, adopted: false, state: 'down' },
  { id: 'outside', url: 'http://127.0.0.1:7004/v1', managed: true, adopted: true, state: 'up' },
];

let server: ApiServer;
let origin: string;
let changes: SettingsChange[] = [];
let clock = Date.now();
const restarted: string[] = [];

before(async () => {
  mkdirSync(join(home, 'config'), { recursive: true });
  mkdirSync(userHome, { recursive: true });
  copyFileSync(join(REPO, CATALOG_FILE), join(home, CATALOG_FILE));
  const config = parseConfig(renderSettings(START), home, loadCatalog(home), userHome);
  const settings = createSettingsPage({ home, userHome, dataDir: join(home, DATA_DIR), running: () => config, onChanged: (change) => changes.push(change), now: () => clock });
  server = await startApiServer({
    // Unused by these routes.
    sql: undefined as unknown as Sql,
    live: undefined as unknown as LiveFeed,
    host: '127.0.0.1',
    port: 0,
    settings,
    local: {
      status: () => LOCAL,
      restart: (id) => {
        restarted.push(id);
        return Promise.resolve(true);
      },
      log: (id) => `log of ${id}\n`,
    },
  });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

beforeEach(() => {
  writeFileSync(file, renderSettings(START));
  changes = [];
  clock = Date.now();
  restarted.length = 0;
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** node:http, not fetch: with NODE_USE_ENV_PROXY fetch would send loopback requests to a proxy. */
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...(method === 'GET' ? {} : { origin }),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function fingerprint(): Promise<string> {
  const reply = await call('GET', '/api/settings');
  assert.equal(reply.status, 200);
  return reply.body.fingerprint as string;
}

describe('/api/settings', () => {
  it('GET: values, fingerprint, catalog, local servers', async () => {
    const reply = await call('GET', '/api/settings');
    assert.equal(reply.status, 200);
    assert.match(reply.body.fingerprint as string, /^[0-9a-f]{64}$/);
    assert.deepEqual((reply.body.values as { executors: string[] }).executors, ['claude']);
    assert.deepEqual(reply.body.local, LOCAL);
    assert.ok(Array.isArray(reply.body.catalog));
    assert.deepEqual(reply.body.privacy, ['executors', 'telegram', 'projects', 'endpoints']);
  });

  it('POST: an ordinary change is written; a stale fingerprint is 409', async () => {
    const read = await fingerprint();
    const saved = await call('POST', '/api/settings', { fingerprint: read, values: { roles: { orchestrator: 'qwen3.5-9b-mlx-4bit' } } });
    assert.equal(saved.status, 200);
    assert.equal((saved.body.values as { roles: Record<string, string> }).roles.orchestrator, 'qwen3.5-9b-mlx-4bit');
    assert.deepEqual(changes, [{ sections: ['roles'], privacy: false }]);
    const stale = await call('POST', '/api/settings', { fingerprint: read, values: { roles: {} } });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error as string, /changed/);
  });

  it('POST: a privacy section, a bad shape or a rule of the file is 400; nothing written', async () => {
    const read = await fingerprint();
    for (const values of [{ executors: ['claude', 'codex'] }, { roles: { orchestrator: 1 } }, { roles: { orchestrator: 'nope' } }]) {
      const reply = await call('POST', '/api/settings', { fingerprint: read, values });
      assert.equal(reply.status, 400, JSON.stringify(values));
    }
    assert.equal(readFileSync(file, 'utf8'), renderSettings(START));
    assert.deepEqual(changes, []);
  });

  it('POST without the Origin of the page is refused before anything is read', async () => {
    const reply = await call('POST', '/api/settings', { fingerprint: await fingerprint(), values: { roles: {} } }, { origin: 'http://evil.example' });
    assert.equal(reply.status, 403);
    assert.equal(readFileSync(file, 'utf8'), renderSettings(START));
  });

  it('an unreadable file is 409 for a change, and GET says why', async () => {
    writeFileSync(file, `${renderSettings(START)}\n[nonsense]\n`);
    const read = await call('GET', '/api/settings');
    assert.equal(read.body.values, null);
    assert.match(read.body.error as string, /nonsense/);
    const reply = await call('POST', '/api/settings', { fingerprint: read.body.fingerprint, values: { roles: {} } });
    assert.equal(reply.status, 409);
  });
});

describe('/api/settings/privacy', () => {
  it('prepare then confirm: written once; the second confirm is 404', async () => {
    const proposal = await call('POST', '/api/settings/privacy/prepare', { fingerprint: await fingerprint(), values: { executors: [] } });
    assert.equal(proposal.status, 200);
    assert.deepEqual(proposal.body.changes, { executors: { before: ['claude'], after: [] } });
    assert.equal(readFileSync(file, 'utf8'), renderSettings(START));
    const confirmed = await call('POST', '/api/settings/privacy/confirm', { id: proposal.body.id });
    assert.equal(confirmed.status, 200);
    assert.deepEqual((confirmed.body.values as { executors: string[] }).executors, []);
    assert.deepEqual(changes, [{ sections: ['executors'], privacy: true, confirmation: proposal.body.id }]);
    const again = await call('POST', '/api/settings/privacy/confirm', { id: proposal.body.id });
    assert.equal(again.status, 404);
  });

  it('prepare refuses an ordinary section and no change (400); confirm refuses extra fields (400)', async () => {
    const read = await fingerprint();
    assert.equal((await call('POST', '/api/settings/privacy/prepare', { fingerprint: read, values: { roles: {} } })).status, 400);
    assert.equal((await call('POST', '/api/settings/privacy/prepare', { fingerprint: read, values: { executors: ['claude'] } })).status, 400);
    assert.equal((await call('POST', '/api/settings/privacy/confirm', { id: randomUUID(), values: {} })).status, 400);
    assert.deepEqual(changes, []);
  });

  it('an expired confirmation is 410', async () => {
    const proposal = await call('POST', '/api/settings/privacy/prepare', { fingerprint: await fingerprint(), values: { executors: [] } });
    clock += 5 * 60_000;
    assert.equal((await call('POST', '/api/settings/privacy/confirm', { id: proposal.body.id })).status, 410);
    assert.equal(readFileSync(file, 'utf8'), renderSettings(START));
  });

  it('a proposal for Telegram never carries the vault reference of the token', async () => {
    const proposal = await call('POST', '/api/settings/privacy/prepare', { fingerprint: await fingerprint(), values: { telegram: { chats: [42] } } });
    assert.equal(proposal.status, 200);
    assert.deepEqual(proposal.body.changes, { telegram: { before: null, after: { chats: [42] } } });
    assert.ok(!JSON.stringify(proposal.body).includes('vault://'));
  });

  it('a file changed after prepare: confirm is 409', async () => {
    const proposal = await call('POST', '/api/settings/privacy/prepare', { fingerprint: await fingerprint(), values: { executors: [] } });
    writeFileSync(file, `${renderSettings(START)}# by hand\n`);
    assert.equal((await call('POST', '/api/settings/privacy/confirm', { id: proposal.body.id })).status, 409);
  });
});

describe('/api/local', () => {
  it('restart: 202 for a server the core starts, 409 for one it only watches, 404 for an unknown one', async () => {
    const reply = await call('POST', '/api/local/omlx/restart', {});
    assert.equal(reply.status, 202);
    assert.deepEqual(restarted, ['omlx']);
    assert.equal((await call('POST', '/api/local/spare/restart', {})).status, 409);
    assert.equal((await call('POST', '/api/local/outside/restart', {})).status, 409);
    assert.equal((await call('POST', '/api/local/other/restart', {})).status, 404);
    assert.equal((await call('POST', '/api/local/omlx/restart', { now: true })).status, 400);
    assert.deepEqual(restarted, ['omlx']);
  });

  it('log: the end of the log of a known server only', async () => {
    assert.deepEqual((await call('GET', '/api/local/omlx/log')).body, { log: 'log of omlx\n' });
    assert.equal((await call('GET', '/api/local/..%2Fsecrets/log')).status, 404);
  });
});
