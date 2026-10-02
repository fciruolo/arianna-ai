// Exit criterion of task 1.14: a fake secret is used without appearing in a
// prompt, a log or an event. The vault runs a fake sops (packages/vault/test/fixtures).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createContext, type Target } from '@arianna/policy';
import { createVault } from '@arianna/vault';

import { createConversation, postUserMessage } from '../src/conversations.ts';
import { passGateway } from '../src/gateway.ts';
import { startLiveFeed, type LiveMessage } from '../src/live.ts';
import { openReply } from '../src/reply.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const HOME = resolveHome({});
const FAKE_SOPS = join(HOME, 'packages', 'vault', 'test', 'fixtures', 'fake-sops.ts');
const DATA = join(HOME, 'data', 'test-tmp', `core-vault-${randomUUID()}`);
const FAKE_TOKEN = 'fake-service-token-93d1aa';
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };

mkdirSync(join(DATA, 'vault'), { recursive: true });
writeFileSync(join(DATA, 'vault', 'secrets.yaml'), JSON.stringify({ 'service-token': FAKE_TOKEN }));
const vault = createVault({ data: DATA, command: [process.execPath, FAKE_SOPS], env: { PATH: process.env.PATH } });

after(() => {
  rmSync(DATA, { recursive: true, force: true });
});

/** A local service that wants the token, as a real integration would. */
async function startService(): Promise<Server> {
  const server = createServer((req, res) => {
    res.statusCode = req.headers.authorization === `Bearer ${FAKE_TOKEN}` ? 200 : 401;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function call(server: Server, authorization: string): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { authorization }, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Every row of every table of the test schema, as text. */
async function everyRow(schema: string): Promise<string[]> {
  const { sql } = db();
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'`;
  const rows: string[] = [];
  for (const { table_name: table } of tables) {
    const found = await sql.unsafe<{ row: string }[]>(`SELECT t::text AS row FROM "${schema}"."${table}" t`);
    rows.push(...found.map((item) => item.row));
  }
  return rows;
}

test('a vault secret is used by the code and never reaches a prompt, the chat, gateway_log or events', async () => {
  const { sql, schema } = db();
  const secret = await vault.resolve('vault://service-token');

  // Used: the code that needs it reveals it into a header.
  const service = await startService();
  try {
    assert.equal(await call(service, `Bearer ${secret.reveal()}`), 200);
    assert.equal(await call(service, `Bearer ${String(secret)}`), 401);
  } finally {
    await new Promise((resolve) => service.close(resolve));
  }

  const conversation = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, conversation.id, 'Controlla il servizio finto');
  const live = await startLiveFeed(sql);
  const received: LiveMessage[] = [];
  const stop = await live.subscribe({ send: (message) => received.push(message) });
  try {
    // A prompt to the local model with the value in it is blocked and logged.
    const brief = await passGateway(sql, [{ value: `Token: ${secret.reveal()}`, label: 'L2', source: 'test' }], createContext('L2'), LOCAL_MODEL, {
      taskId: task.id,
      summary: `token ${secret.reveal()}`,
    });
    assert.equal(brief.decision, 'block');
    assert.equal(brief.rule, 'secret');

    // So is a chat reply, as a fragment and as the final message.
    const reply = await openReply(sql, task.id);
    await assert.rejects(reply.delta(`ecco ${secret.reveal()}`), /vault:\/\/service-token/);
    const result = await reply.finish(`Il token è ${secret.reveal()}`, 'L2');
    assert.ok(!result.stored && result.reason === 'blocked');
    assert.equal(result.decision.rule, 'secret');

    // The reference is harmless anywhere.
    const harmless = await openReply(sql, task.id);
    assert.equal((await harmless.finish(`Uso ${String(secret)}`, 'L2')).stored, true);
  } finally {
    stop();
    await live.close();
  }

  const [log] = await sql<{ reason: string; payload_sha256: string | null; bytes_out: number | null; summary: string | null }[]>`
    SELECT reason, payload_sha256, bytes_out, summary FROM gateway_log WHERE target = 'omlx' AND task_id = ${task.id}`;
  assert.deepEqual(log, { reason: 'payload contains the value of vault://service-token', payload_sha256: null, bytes_out: null, summary: null });

  const rows = await everyRow(schema);
  assert.ok(rows.length > 0);
  assert.ok(rows.some((row) => row.includes('vault://service-token')));
  assert.ok(!rows.some((row) => row.includes(FAKE_TOKEN)), 'the value is in a table');
  assert.ok(!received.some((message) => JSON.stringify(message).includes(FAKE_TOKEN)), 'the value reached the live feed');
});
