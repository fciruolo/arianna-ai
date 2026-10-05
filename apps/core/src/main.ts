// Usage: node apps/core/src/main.ts
// Starts the core: migrations, task worker, live feed, API, WebSocket and web chat.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { AGENTS_DIR, loadAgents } from '@arianna/agents';
import {
  CLOUD_MODELS,
  cloudModelName,
  DEFAULT_VOICE,
  enabledCloudModels,
  loadCatalog,
  loadConfig,
  loadLabelRules,
  userHomeOf,
  voicePaths,
  watchConfig,
} from '@arianna/config';
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
import { createLocalServers, loggedEvent, logTail } from './local-servers.ts';
import { createModelEvals } from './model-evals.ts';
import { createKb } from './orchestrator/kb.ts';
import { createOrchestrator } from './orchestrator/orchestrator.ts';
import { createNoteOrganizer } from './organize.ts';
import { defaultConversationModel, selectableModels } from './orchestrator/routing.ts';
import { installationInfo } from './installation.ts';
import { startApiServer } from './server/http.ts';
import { createSettingsPage } from './settings-page.ts';
import { createBotApi } from './telegram/api.ts';
import { startTelegram } from './telegram/channel.ts';
import { createTelegramSwitch } from './telegram/switch.ts';
import { createCalls, liveCall } from './voice/calls.ts';
import { createPusher, PUSH_TEXT, vapidKey } from './voice/push.ts';
import { createRinger } from './voice/ringer.ts';
import { createVoiceService } from './voice/service.ts';
import { createVoiceSwitch } from './voice/switch.ts';
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

// Set once the core starts stopping: nothing new is opened after it.
let stopping = false;

// Declared before the watcher, which may report a change of [telegram] while
// the core still starts: the switch ignores changes until `begin`.
const telegram = createTelegramSwitch({
  start: async (next) => {
    const token = await createVault({ data: config.paths.data }).resolve(next.token);
    return startTelegram({ sql, api: createBotApi({ token }), chats: next.chats, live, onError: report });
  },
  // An exit turned on or off: in the event log, without the chat ids.
  onChange: (next) => {
    appendEvent(sql, { kind: 'settings.telegram', label: 'L0', payload: { on: next !== undefined, chats: next?.chats.length ?? 0 } }).catch(report);
  },
  onState: (on, next) => {
    if (on) console.log(`Telegram on: ${String(next?.chats.length ?? 0)} chat(s)`);
    else console.error(next === undefined ? 'Telegram off' : 'Telegram off: see the error above; tried again at the next change of [telegram]');
  },
  onError: report,
});

// apps/voice (D-066): on only with [voice] in arianna.toml, started in the
// background so that the chat never waits for it. Turned on, off or moved to
// another port without a restart, once no call is in progress (D-071); the
// same for [voice.push]. Without the environment (pnpm voice:sync) the trial
// page says what is missing.
const voiceDirs = voicePaths(config.home, config.paths.data);
let voiceShown = { on: config.voice !== undefined, port: config.voice?.port ?? null, push: config.voice?.push !== undefined };
const voice = createVoiceSwitch({
  createService: (port) => {
    const service = createVoiceService({
      paths: voiceDirs,
      port,
      logFile: join(voiceDirs.tmp, 'voice.log'),
      onEvent: (event) => {
        if (event.type === 'state' || event.type === 'gave-up' || event.type === 'spawn-error') console.log(`voice: ${event.type === 'state' ? event.state : event.type}`);
      },
    });
    if (service.state === 'not-installed') console.error('voice off: data/voice/venv is missing (brew install uv, then pnpm voice:sync)');
    return service;
  },
  // Web Push (D-066, choice 7): a notification without content when no chat is open.
  createPusher: async (push) => {
    const privateKey = await createVault({ data: config.paths.data }).resolve(push.privateKey);
    return createPusher({
      sql,
      publicKey: push.publicKey,
      key: vapidKey(push.publicKey, privateKey.reveal()),
      subject: push.subject,
      // The fixed text, the only thing that leaves, goes through the gateway on channel push.
      gate: async () =>
        (await passGateway(sql, [{ value: PUSH_TEXT, label: 'L0', source: 'call:push' }], createContext('L0'), { kind: 'channel', id: 'push' })).decision === 'allow',
      onError: report,
    });
  },
  busy: async () => (await liveCall(sql)) !== undefined,
  // On or off, port and push on or off: L0, never the voice (it may name a copied voice).
  onChange: (next) => {
    const shown = { on: next !== undefined, port: next?.port ?? null, push: next?.push !== undefined };
    if (isDeepStrictEqual(shown, voiceShown)) return;
    voiceShown = shown;
    appendEvent(sql, { kind: 'settings.voice', label: 'L0', payload: shown }).catch(report);
  },
  onApplied: (next, push) => {
    console.log(next === undefined ? 'voice off: no [voice] in arianna.toml' : `voice on port ${String(next.port)}, Web Push ${push ? 'on' : 'off'}`);
    if (next?.push !== undefined && !push) console.error('Web Push off: see the error above; tried again at the next change of [voice.push]');
  },
  onError: report,
});

// Task 1.18 and D-071: a change of arianna.toml applies without a restart:
// the core reads settings.current() at each use, restarts a local server whose
// `url` or `command` changed, opens or closes Telegram and apps/voice. Only
// paths, database and server wait for a restart.
const settings = watchConfig({
  initial: config,
  onChange: ({ applied, restart }) => {
    if (applied.length > 0) console.log(`arianna.toml: applied ${applied.join(', ')}`);
    if (applied.includes('local.endpoints')) localServers.sync(settings.current().local.endpoints).catch(report);
    if (applied.includes('telegram')) telegram.sync(settings.current().telegram);
    if (applied.includes('voice')) voice.sync(settings.current().voice);
    // Turning a cloud executor on or off is a privacy setting: it goes in the event log, like the projects.
    if (applied.includes('cloud.executors')) {
      const { executors } = settings.current().cloud;
      console.log(`Cloud executors: ${executors.length === 0 ? 'none' : executors.join(', ')}`);
      appendEvent(sql, { kind: 'settings.executors', label: 'L0', payload: { executors } }).catch(report);
    }
    // A change of the approved projects is a privacy setting: it goes in the event log (D-058).
    if (applied.includes('projects')) {
      const projects = settings.current().projects.map(({ name, path, label }) => ({ name, path, label }));
      appendEvent(sql, { kind: 'settings.projects', label: 'L1', payload: { projects } }).catch(report);
    }
    // The selector of the web chat reads the cloud models again (D-071): names only, nothing private.
    if (applied.includes('cloud.models')) {
      const { cloud } = settings.current();
      const payload = { enabled: enabledCloudModels(cloud), names: Object.fromEntries(CLOUD_MODELS.map((model) => [model, cloudModelName(cloud, model)])), default: cloud.defaultModel ?? null };
      appendEvent(sql, { kind: 'settings.cloud-models', label: 'L0', payload }).catch(report);
    }
    if (restart.length > 0) console.log(`arianna.toml: ${restart.join(', ')} changed, applied at the next restart`);
  },
  onError: (error) => {
    // A ConfigError names a key and a rule, never a value read elsewhere.
    if (error instanceof Error && error.name === 'ConfigError') console.error(error.message);
    else report(error);
    console.error('arianna.toml: not reloaded, the previous configuration stays; no project, cloud executor or Telegram bot is open until the file is valid');
  },
});

// The local servers (D-071, choice 4): an endpoint with `command` is started
// with the core, restarted when it fails and stopped with it; one already
// answering is adopted. Started in the background: loading a large model can
// take minutes, and the chat must not wait for it.
const localServers = createLocalServers({
  home: config.home,
  dataDir: config.paths.data,
  onEvent: (event) => {
    if (!loggedEvent(event)) return;
    // Codes only: `error` carries a system code or a class name, never data.
    const detail = event.type === 'state' ? event.state : event.type === 'error' ? `error ${event.message}` : event.type;
    console.log(`local ${event.endpoint}: ${detail}`);
    appendEvent(sql, { kind: 'local.server', label: 'L0', payload: { ...event } }).catch(report);
  },
});
localServers.sync(config.local.endpoints).catch(report);
const localModel = () =>
  createLocalModel({
    endpoints: settings.current().local.endpoints,
    isAvailable: (id) => localServers.isAvailable(id),
    onFailure: (id) => { localServers.onFailure(id); },
  });

// Task 1.10: the orchestrator on the local model, with the development
// knowledge base in kb/ (the real one, data/kb, comes after Phase 1A), and
// the Coder on claude -p for delegated steps when the user enabled it in
// `[cloud] executors`, read at each launch: turning it on or off applies
// without a restart (D-071). The adapter refuses a Node installation whose
// folders would open the user's files (D-050): then the core runs without
// delegation and says so.
const rules = loadLabelRules();
let claude: ClaudeExecutor | undefined;
try {
  // The exact name for `--model` is read at each launch too (`[cloud.models]`).
  claude = createClaudeExecutor({
    enabled: () => settings.current().cloud.executors,
    home: config.home,
    modelName: (model) => settings.current().cloud.models[model].name,
  });
} catch (error) {
  report(error);
  if (config.cloud.executors.includes('claude')) console.error('claude off: the sandbox folders of this Node installation are refused (see the error above)');
}
const kb = createKb({ home: config.home, rules });
const orchestrator = createOrchestrator({
  sql,
  agents,
  kb,
  model: localModel,
  settings: () => settings.current(),
  rules,
  ...(claude === undefined ? {} : { claude }),
});
console.log(`Cloud executors: ${config.cloud.executors.length === 0 ? 'none' : config.cloud.executors.join(', ')}${claude === undefined ? ' (delegation off: sandbox refused)' : ''}`);

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

// The calls (D-066), on the voice in place: off, they are refused. Limits,
// voice and outgoing rules are read at each call (D-071).
const voiceSettings = () => settings.current().voice ?? DEFAULT_VOICE;
// Read at each request, like the roles: a new catalog entry needs no restart.
const candidates = () =>
  trialModels(
    loadCatalog(config.home),
    settings.current().roles,
    voiceDirs.models,
    fileSize,
    listClones(voiceDirs.clones).map(({ id }) => id),
  );
const host = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
const calls = createCalls({
  sql,
  voice: voice.service,
  config: () => ({ roles: settings.current().roles, voice: voiceSettings(), local: settings.current().local }),
  candidates,
  model: localModel,
  coreUrl: `http://${host}:${String(config.server.port)}`,
  onError: report,
});
const closed = await calls.closeLeftovers();
if (closed > 0) console.log(`Calls: closed ${String(closed)} left open by the previous run`);
// Before the API: with [voice] the routes never answer "voice off" at start.
await voice.begin(settings.current().voice);
// The settings page (D-071): it writes arianna.toml, which the watcher above
// applies as any other change. Each write goes in the event log with the
// names of the sections only, never their values.
const settingsPage = createSettingsPage({
  home: config.home,
  userHome: userHomeOf(),
  dataDir: config.paths.data,
  running: () => settings.current(),
  onChanged: (change) => {
    console.log(`arianna.toml: written from the settings page (${change.sections.join(', ')})`);
    appendEvent(sql, { kind: 'settings.changed', label: 'L0', payload: { ...change } }).catch(report);
  },
});
// Trials of a catalog model with the orchestrator evals (D-081): in the
// background, one at a time, giving way to calls and task steps. The model
// under trial is `local-large` on the endpoints of arianna.toml.
const modelEvals = createModelEvals({
  sql,
  catalog: () => loadCatalog(config.home),
  modelsDir: voiceDirs.models,
  endpoints: () => settings.current().local.endpoints,
  assignedModels: () => Object.values(settings.current().roles),
  prompt: () => {
    const arianna = agents.get('arianna');
    if (arianna === undefined) throw new Error('agents/arianna.md is missing');
    return arianna.prompt;
  },
  casesDir: join(config.home, 'evals', 'orchestrator'),
  createModel: (endpoints) =>
    createLocalModel({
      endpoints,
      isAvailable: (id) => localServers.isAvailable(id),
      onFailure: (id) => { localServers.onFailure(id); },
    }),
  onError: report,
});
// Captured notes organized by the local model in the background (D-086), one
// at a time, giving way to calls and task steps; the raw note is saved first.
const organizer = createNoteOrganizer({ sql, home: config.home, rules, kb, model: localModel, onError: report });
const dist = join(config.home, 'apps', 'hud', 'dist');
const approvedProjects = () => settings.current().projects;
const server = await startApiServer({
  sql,
  live,
  host: config.server.host,
  port: config.server.port,
  // The approved projects: listed for a new conversation, and where the preview of a changed file is read (D-082).
  projects: approvedProjects,
  approvedProjects,
  // Without the adapter no delegation runs: the selector offers nothing.
  models: () => (claude === undefined ? [] : selectableModels(settings.current())),
  defaultModel: () => (claude === undefined ? undefined : defaultConversationModel(settings.current())),
  agents: () => [...agents.keys()],
  characters: {
    dirs: { original: join(config.home, 'apps', 'hud', 'characters', 'originali'), data: join(config.paths.data, 'characters') },
    choices: () => settings.current().characters,
  },
  voice: { service: voice.service, voice: () => voiceSettings().voice, models: candidates, clones: voiceDirs.clones },
  calls,
  pusher: () => voice.pusher(),
  settings: settingsPage,
  local: {
    status: () => localServers.status(),
    restart: (id) => localServers.restart(id),
    log: (id) => logTail(config.paths.data, id),
  },
  capture: { home: config.home, rules, organize: (path) => organizer.enqueue(path) },
  modelEvals,
  // Development or production (D-089): the passwords the core logged in with, or [installation] mode.
  installation: () => installationInfo(config.home, app.development, settings.current().installation?.mode),
  ...(existsSync(dist) ? { staticDir: dist } : {}),
  onError: report,
});
await worker.start();
// Trials left running by the previous run are closed as `interrupted`, never resumed.
await modelEvals.start();
// New notes left by pnpm kb:capture or by a previous run: queued again, at most MAX_RESUMED.
const { resumed } = await organizer.start();
if (resumed > 0) console.log(`Notes: ${String(resumed)} queued to be organized`);

// The calls Arianna makes (D-066): checked every 30 s under [voice.outgoing];
// with the voice off nothing rings.
const ringer = createRinger({
  sql,
  rules: () => voiceSettings().outgoing,
  voiceUp: () => voice.service.state === 'up',
  hold: (work) => voice.service.hold(work),
  // Read at each ring: [voice.push] changes without a restart.
  notify: () => {
    const pusher = voice.pusher();
    return pusher === undefined ? undefined : async () => { await pusher.notify(); };
  },
  clientsOnline: () => server.clients(),
  onError: report,
});

// Telegram (task 1.15, D-044): on only with [telegram] in arianna.toml, opened
// or closed when the section changes (D-071). Without a token the core runs
// anyway: the web chat does not depend on it.
await telegram.begin(settings.current().telegram);

console.log(`Arianna core on http://${host}:${String(server.port)}${existsSync(dist) ? '' : ' (API only: run pnpm hud:build for the web chat)'}`);

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  settings.close();
  await telegram.close();
  await server.close();
  ringer.stop();
  await calls.close();
  await voice.close();
  await modelEvals.stop();
  await organizer.stop();
  await worker.stop();
  await localServers.stop();
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
