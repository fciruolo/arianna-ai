// Usage: node apps/core/src/main.ts
// Starts the core: migrations, task worker, live feed, API, WebSocket and web chat.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AGENTS_DIR, loadAgents } from '@arianna/agents';
import { loadCatalog, loadConfig, loadLabelRules, voicePaths, watchConfig } from '@arianna/config';
import { createClaudeExecutor, createLocalModel, type ClaudeExecutor } from '@arianna/executors';
import { createContext } from '@arianna/policy';
import { createVault } from '@arianna/vault';

import { connect } from './db/client.ts';
import { prepareDatabase, resolveLogin } from './db/logins.ts';
import { loadMigrations, migrationStatus } from './db/migrate.ts';
import { createWorker } from './engine.ts';
import { appendEvent } from './events.ts';
import { passGateway } from './gateway.ts';
import { startLiveFeed } from './live.ts';
import { createKb } from './orchestrator/kb.ts';
import { createOrchestrator } from './orchestrator/orchestrator.ts';
import { selectableModels } from './orchestrator/routing.ts';
import { startApiServer } from './server/http.ts';
import { createBotApi } from './telegram/api.ts';
import { startTelegram, type TelegramChannel } from './telegram/channel.ts';
import { createCalls, type Calls } from './voice/calls.ts';
import { createPusher, PUSH_TEXT, vapidKey, type Pusher } from './voice/push.ts';
import { createRinger, type Ringer } from './voice/ringer.ts';
import { createVoiceService, type VoiceService } from './voice/service.ts';
import { listClones } from './voice/clones.ts';
import { fileSize, trialModels } from './voice/trial.ts';

/** Logs only the error's class and code: messages may quote data. */
function report(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  console.error(`core error: ${name}${code === '' ? '' : ` (${code})`}`);
}

/** The port of a local endpoint URL, shown in the readable error of a failed task (D-064). */
function endpointPort(url: string | undefined): number | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  } catch {
    return undefined;
  }
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

// Task 1.18: a model changed for a role applies without a restart: the
// orchestrator reads settings.current() at each model call. Every other
// section waits for a restart.
const settings = watchConfig({
  initial: config,
  onChange: ({ applied, restart }) => {
    if (applied.length > 0) console.log(`arianna.toml: applied ${applied.join(', ')}`);
    // A change of the approved projects is a privacy setting: it goes in the event log (D-058).
    if (applied.includes('projects')) {
      const projects = settings.current().projects.map(({ name, path, label }) => ({ name, path, label }));
      appendEvent(sql, { kind: 'settings.projects', label: 'L1', payload: { projects } }).catch(report);
    }
    if (restart.length > 0) console.log(`arianna.toml: ${restart.join(', ')} changed, applied at the next restart`);
  },
  onError: (error) => {
    // A ConfigError names a key and a rule, never a value read elsewhere.
    if (error instanceof Error && error.name === 'ConfigError') console.error(error.message);
    else report(error);
    console.error('arianna.toml: not reloaded, the previous configuration stays; no project is open until the file is valid');
  },
});

// Task 1.10: the orchestrator on the local model, with the development
// knowledge base in kb/ (the real one, data/kb, comes after Phase 1A), and
// the Coder on claude -p for delegated steps when the user enabled it
// (`[cloud] executors`, a restart applies a change). The adapter refuses a
// Node installation whose folders would open the user's files (D-050): then
// the core runs without delegation and says so.
const rules = loadLabelRules();
let claude: ClaudeExecutor | undefined;
if (config.cloud.executors.includes('claude')) {
  try {
    claude = createClaudeExecutor({ enabled: config.cloud.executors, home: config.home });
  } catch (error) {
    report(error);
    console.error('claude off: the sandbox folders of this Node installation are refused (see the error above)');
  }
}
const orchestrator = createOrchestrator({
  sql,
  agents,
  kb: createKb({ home: config.home, rules }),
  model: () => createLocalModel({ endpoints: settings.current().local.endpoints }),
  settings: () => settings.current(),
  rules,
  ...(claude === undefined ? {} : { claude }),
});
console.log(`Cloud executors: ${config.cloud.executors.length === 0 ? 'none' : config.cloud.executors.join(', ')}${claude === undefined ? ' (delegation off)' : ' (delegation on)'}`);

const worker = createWorker({
  sql,
  executor: orchestrator,
  allowedActions: (task) => agents.get(task.assignee)?.card.approvals ?? [],
  // No card, no caps: the engine then runs no step and the task waits for the user.
  agentLimits: (task) => agents.get(task.assignee)?.card.limits ?? {},
  endpointPort: (id) => endpointPort(settings.current().local.endpoints.find((endpoint) => endpoint.id === id)?.url),
  onError: report,
});
const live = await startLiveFeed(sql, { onError: report });

// apps/voice (D-066): on only with [voice] in arianna.toml, started in the
// background so that the chat never waits for it. Without the environment
// (pnpm voice:sync) the trial page says what is missing.
let voice: VoiceService | undefined;
let calls: Calls | undefined;
let pusher: Pusher | undefined;
let voiceApi: { voice: string; models: () => ReturnType<typeof trialModels>; clones: string } | undefined;
const voiceConfig = config.voice;
if (voiceConfig !== undefined) {
  const voiceDirs = voicePaths(config.home, config.paths.data);
  // Read at each request, like the roles: a new catalog entry needs no restart.
  const candidates = () =>
    trialModels(
      loadCatalog(config.home),
      settings.current().roles,
      voiceDirs.models,
      fileSize,
      listClones(voiceDirs.clones).map(({ id }) => id),
    );
  voiceApi = { voice: voiceConfig.voice, models: candidates, clones: voiceDirs.clones };
  voice = createVoiceService({
    paths: voiceDirs,
    port: voiceConfig.port,
    logFile: join(voiceDirs.tmp, 'voice.log'),
    onEvent: (event) => {
      if (event.type === 'state' || event.type === 'gave-up' || event.type === 'spawn-error') console.log(`voice: ${event.type === 'state' ? event.state : event.type}`);
    },
  });
  if (voice.state === 'not-installed') console.error('voice off: data/voice/venv is missing (brew install uv, then pnpm voice:sync)');
  else voice.start().catch(report);
  const host = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
  calls = createCalls({
    sql,
    voice,
    config: () => ({ roles: settings.current().roles, voice: voiceConfig, local: settings.current().local }),
    candidates,
    model: () => createLocalModel({ endpoints: settings.current().local.endpoints }),
    coreUrl: `http://${host}:${String(config.server.port)}`,
    onError: report,
  });
  const closed = await calls.closeLeftovers();
  if (closed > 0) console.log(`Calls: closed ${String(closed)} left open by the previous run`);
  // Web Push (D-066, choice 7): a notification without content when no chat is open.
  const push = voiceConfig.push;
  if (push !== undefined) {
    try {
      const privateKey = await createVault({ data: config.paths.data }).resolve(push.privateKey);
      pusher = createPusher({
        sql,
        publicKey: push.publicKey,
        key: vapidKey(push.publicKey, privateKey.reveal()),
        subject: push.subject,
        // The fixed text, the only thing that leaves, goes through the gateway on channel push.
        gate: async () =>
          (await passGateway(sql, [{ value: PUSH_TEXT, label: 'L0', source: 'call:push' }], createContext('L0'), { kind: 'channel', id: 'push' })).decision === 'allow',
        onError: report,
      });
      console.log('Web Push on');
    } catch (error) {
      report(error);
      console.error('Web Push off: see the error above');
    }
  }
}
const dist = join(config.home, 'apps', 'hud', 'dist');
const server = await startApiServer({
  sql,
  live,
  host: config.server.host,
  port: config.server.port,
  projects: () => settings.current().projects,
  // Without the adapter no delegation runs: the selector offers nothing.
  models: () => (claude === undefined ? [] : selectableModels(settings.current())),
  agents: () => [...agents.keys()],
  characters: {
    dirs: { original: join(config.home, 'apps', 'hud', 'characters', 'originali'), data: join(config.paths.data, 'characters') },
    choices: () => settings.current().characters,
  },
  ...(voice === undefined || voiceApi === undefined ? {} : { voice: { service: voice, ...voiceApi } }),
  ...(calls === undefined ? {} : { calls }),
  ...(pusher === undefined ? {} : { pusher }),
  ...(existsSync(dist) ? { staticDir: dist } : {}),
  onError: report,
});
await worker.start();

// The calls Arianna makes (D-066): checked every 30 s under [voice.outgoing].
let ringer: Ringer | undefined;
if (calls !== undefined && voiceConfig !== undefined) {
  const push = pusher;
  ringer = createRinger({
    sql,
    rules: () => voiceConfig.outgoing,
    voiceUp: () => voice?.state === 'up',
    ...(push === undefined ? {} : { notify: async () => { await push.notify(); } }),
    clientsOnline: () => server.clients(),
    onError: report,
  });
}

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

const shown = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
console.log(`Arianna core on http://${shown}:${String(server.port)}${existsSync(dist) ? '' : ' (API only: run pnpm hud:build for the web chat)'}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  settings.close();
  await telegram?.close();
  await server.close();
  ringer?.stop();
  await calls?.close();
  await voice?.stop();
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
