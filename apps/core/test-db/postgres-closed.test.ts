// D-317: a connection that closes cleanly in the middle of a transaction (a
// FIN without the FATAL of PostgreSQL, as the port forwarding of Docker does
// when its VM restarts) rejects `sql.begin` with CONNECTION_CLOSED and leaves
// the process alive. Without the patch of postgres.js the rollback of `begin`
// was written to the closed socket and threw a TypeError nobody catches.
import assert from 'node:assert/strict';
import { createServer, connect as tcpConnect, type Server, type Socket } from 'node:net';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadConfig } from '@arianna/config';

import { connect, type Sql } from '../src/db/client.ts';
import { resolveLogins } from '../src/db/logins.ts';

/** A TCP proxy to the database whose open connections can be closed with a clean FIN. */
interface Proxy {
  port: number;
  /** Ends both sides of every connection open now. */
  closeAll: () => void;
  server: Server;
}

async function startProxy(host: string, port: number): Promise<Proxy> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = tcpConnect(port, host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port');
  return {
    port: address.port,
    server,
    closeAll: () => {
      for (const socket of sockets) socket.end();
    },
  };
}

let proxy: Proxy;
let sql: Sql;

before(async () => {
  const config = loadConfig();
  const logins = await resolveLogins(config);
  proxy = await startProxy(config.database.host, config.database.port);
  sql = connect({ ...config, database: { ...config.database, host: '127.0.0.1', port: proxy.port } }, logins.owner);
});

after(async () => {
  await sql.end({ timeout: 5 });
  await new Promise<void>((resolve) => proxy.server.close(() => {
      resolve();
    }));
});

test('a transaction without a closed connection commits', async () => {
  const rows = await sql.begin((tx) => tx`SELECT 1 AS one`);
  assert.deepEqual([...rows], [{ one: 1 }]);
});

/** Connections of the pool of `connect` (its `max`): one more closure than these shows a connection the pool lost. */
const POOL_SIZE = 5;

test('a connection closed during a query of a transaction rejects it and leaves the process alive', { timeout: 30_000 }, async () => {
  for (let round = 0; round <= POOL_SIZE; round += 1) {
    const transaction = sql.begin(async (tx) => {
      const query = tx`SELECT pg_sleep(2)`;
      setTimeout(proxy.closeAll, 300);
      await query;
    });
    await assert.rejects(transaction, (error: Error & { code?: string }) => error.code === 'CONNECTION_CLOSED');
    // The rollback used to be written on the next turn of the event loop, and to throw there.
    await new Promise((resolve) => setImmediate(resolve));
    await sleep(100);
    // The pool connects again through the proxy, with a connection it has not lost.
    const rows = await sql`SELECT ${round}::int AS round`;
    assert.deepEqual([...rows], [{ round }]);
  }
});
