// Usage: node apps/core/src/main.ts
// Starts the core: migrations, task worker, live feed, API, WebSocket and web chat.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AGENTS_DIR, loadAgents } from '@arianna/agents';
import { loadConfig } from '@arianna/config';

import { CHAT_AGENT } from './conversations.ts';
import { connect } from './db/client.ts';
import { loadMigrations, migrate } from './db/migrate.ts';
import { createWorker, type StepExecutor } from './engine.ts';
import { startLiveFeed } from './live.ts';
import { startApiServer } from './server/http.ts';

/**
 * Until the orchestrator exists (task 1.10), a chat task waits for the user
 * with the reason. The chat, the engine and the reply contract are final:
 * 1.10 replaces only this executor.
 */
const orchestratorPending: StepExecutor = {
  plan: () => ({ agent: CHAT_AGENT, executor: 'none', locality: 'local' }),
  run: () => Promise.resolve({ kind: 'wait-user', reason: 'the orchestrator is not available yet (task 1.10)' }),
};

/** Logs only the error's class and code: messages may quote data. */
function report(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  console.error(`core error: ${name}${code === '' ? '' : ` (${code})`}`);
}

const config = loadConfig();
const agents = loadAgents(join(config.home, AGENTS_DIR));
const sql = connect(config);

const applied = await migrate(sql, loadMigrations());
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);

const worker = createWorker({
  sql,
  executor: orchestratorPending,
  allowedActions: (task) => agents.get(task.assignee)?.card.approvals ?? [],
  // No card, no caps: the engine then runs no step and the task waits for the user.
  agentLimits: (task) => agents.get(task.assignee)?.card.limits ?? {},
  onError: report,
});
const live = await startLiveFeed(sql, { onError: report });
const dist = join(config.home, 'apps', 'hud', 'dist');
const server = await startApiServer({
  sql,
  live,
  host: config.server.host,
  port: config.server.port,
  ...(existsSync(dist) ? { staticDir: dist } : {}),
  onError: report,
});
await worker.start();

const shown = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
console.log(`Arianna core on http://${shown}:${String(server.port)}${existsSync(dist) ? '' : ' (API only: run pnpm hud:build for the web chat)'}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  await worker.stop();
  await live.close();
  await sql.end({ timeout: 5 });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        report(error);
        process.exit(1);
      },
    );
  });
}
