// Usage: node apps/core/src/main.ts
// Starts the core: migrations, task worker, live feed, API, WebSocket and web chat.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AGENTS_DIR, loadAgents } from '@arianna/agents';
import { loadConfig, watchConfig } from '@arianna/config';
import { createVault } from '@arianna/vault';

import { CHAT_AGENT } from './conversations.ts';
import { connect } from './db/client.ts';
import { prepareDatabase, resolveLogin } from './db/logins.ts';
import { loadMigrations, migrationStatus } from './db/migrate.ts';
import { createWorker, type StepExecutor } from './engine.ts';
import { startLiveFeed } from './live.ts';
import { startApiServer } from './server/http.ts';
import { createBotApi } from './telegram/api.ts';
import { startTelegram, type TelegramChannel } from './telegram/channel.ts';

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
const app = await resolveLogin(config, 'app');

// The core works as the application role (D-046). With the development
// passwords it also migrates, as the owner; with real ones the owner's
// password, a superuser's, stays out of this process: pnpm db:migrate first.
if (app.development) {
  const owner = connect(config, await resolveLogin(config, 'owner'));
  try {
    const applied = await prepareDatabase(owner, app);
    if (applied.length > 0) console.log(`Applied migrations: ${applied.join(', ')}`);
  } finally {
    await owner.end();
  }
  console.log('Database: development passwords, fake data only (pnpm arianna:doctor)');
}
const sql = connect(config, app);
const status = await migrationStatus(sql, loadMigrations());
if (status.pending.length + status.edited.length + status.missing.length > 0) {
  console.error('The database is not at the migrations of this version: run pnpm db:migrate, then pnpm arianna:doctor');
  await sql.end();
  process.exit(1);
}

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
  allowlist: config.cloud.allowlist,
  ...(existsSync(dist) ? { staticDir: dist } : {}),
  onError: report,
});
await worker.start();

// Telegram (task 1.15, D-044): on only with [telegram] in arianna.toml. Without
// a token the core runs anyway: the web chat does not depend on it.
let telegram: TelegramChannel | undefined;
if (config.telegram !== undefined) {
  try {
    const token = await createVault({ data: config.paths.data }).resolve(config.telegram.token);
    telegram = await startTelegram({ sql, api: createBotApi({ token }), chats: config.telegram.chats, live, onError: report });
    console.log(`Telegram on: ${String(config.telegram.chats.length)} chat(s)`);
  } catch (error) {
    report(error);
    console.error('Telegram off: see the error above');
  }
}

// Task 1.18: a model changed for a role applies without a restart. Whoever
// calls a local model (the orchestrator, task 1.10) reads settings.current()
// at each call; every other section waits for a restart.
const settings = watchConfig({
  initial: config,
  onChange: ({ applied, restart }) => {
    if (applied.length > 0) console.log(`arianna.toml: applied ${applied.join(', ')}`);
    if (restart.length > 0) console.log(`arianna.toml: ${restart.join(', ')} changed, applied at the next restart`);
  },
  onError: (error) => {
    // A ConfigError names a key and a rule, never a value read elsewhere.
    if (error instanceof Error && error.name === 'ConfigError') console.error(error.message);
    else report(error);
    console.error('arianna.toml: not reloaded, the previous configuration stays');
  },
});

const shown = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
console.log(`Arianna core on http://${shown}:${String(server.port)}${existsSync(dist) ? '' : ' (API only: run pnpm hud:build for the web chat)'}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  settings.close();
  await telegram?.close();
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
