// Usage: node apps/core/src/main.ts
// Starts the core: migrations, task worker, live feed, API, WebSocket and web chat.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { AGENTS_DIR, loadAgents } from '@arianna/agents';
import {
  catalogModelName,
  CLOUD_MODELS,
  cloudModelName,
  DEFAULT_VOICE,
  enabledCloudModels,
  loadCatalog,
  loadCloudCatalog,
  loadConfig,
  loadLabelRules,
  userHomeOf,
  VOICE_ALIAS,
  voicePaths,
  watchConfig,
  workParts,
  type TelegramConfig,
} from '@arianna/config';
import { createClaudeExecutor, createCodexExecutor, createLocalModel, type ClaudeExecutor, type CodexExecutor } from '@arianna/executors';
import { createContext } from '@arianna/policy';
import { createVault } from '@arianna/vault';

import { directPolicies } from './direct-chat.ts';
import { connect } from './db/client.ts';
import { prepareDatabase, resolveLogin } from './db/logins.ts';
import { loadMigrations, migrationStatus } from './db/migrate.ts';
import { createWorker } from './engine.ts';
import { eraseConversation } from './erase.ts';
import { closeIncognito, closeIncognitoAtStart, createIncognitoWatch, isIncognitoConversation, localCacheOn, openIncognito, type IncognitoCause } from './incognito.ts';
import { appendEvent } from './events.ts';
import { createServiceManager } from './project-services.ts';
import { createUserAgents } from './user-agents.ts';
import { createSpriteGenerator, spriteUnavailable } from './sprites/generate.ts';
import { passGateway } from './gateway.ts';
import { nameLabelOf } from './participants.ts';
import { startLiveFeed } from './live.ts';
import { createLocalServers, loggedEvent, logTail } from './local-servers.ts';
import { createHubClient } from './hub-http.ts';
import { createHuggingFace } from './huggingface.ts';
import { createModelActions } from './model-actions.ts';
import { createModelEvals, trialOpen } from './model-evals.ts';
import { trialEndpoints } from '@arianna/evals/library';
import { conversationOfTask, createNoticeBoard, createNotifier } from './notifications.ts';
import { createSecretaryTicker } from './reminders.ts';
import { createModelMemory, unloadModel } from './model-memory.ts';
import { createFetcher } from './model-http.ts';
import { loadModelsOverview } from './models-overview.ts';
import { delegationRoute } from './orchestrator/delegate.ts';
import { createKb } from './orchestrator/kb.ts';
import { createProjectPages } from './project-knowledge.ts';
import { createAriannaDocs } from './arianna-docs.ts';
import { createOrchestrator } from './orchestrator/orchestrator.ts';
import { createNoteOrganizer, organizeModelReady } from './organize.ts';
import { agentDefaultModel, agentModels, selectableModels, WORK_AGENT } from './orchestrator/routing.ts';
import { installationInfo } from './installation.ts';
import { startApiServer } from './server/http.ts';
import { createSettingsPage } from './settings-page.ts';
import { createBotApi } from './telegram/api.ts';
import { startTelegram } from './telegram/channel.ts';
import { createTelegramSwitch } from './telegram/switch.ts';
import { createCalls, liveCall } from './voice/calls.ts';
import { createPusher, vapidKey } from './voice/push.ts';
import { createRinger } from './voice/ringer.ts';
import { createVoiceService } from './voice/service.ts';
import { createVoiceSwitch } from './voice/switch.ts';
import { listClones } from './voice/clones.ts';
import { fileSize, trialModels } from './voice/trial.ts';
import { trialRefusal } from './orchestrator/trial-chat.ts';

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
// The user's agents (D-119): the active ones join the map, under the L1/A1 ceiling.
const userAgents = createUserAgents({ home: config.home, dataDir: config.paths.data, agents, official: new Set(agents.keys()) });
// Only the name: the reason may quote a line of a card edited by hand; the Agents page shows it.
for (const { name } of userAgents.load()) console.error(`user agent ${name} not loaded (see Impostazioni → Agenti)`);
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

// D-136: an incognito conversation does not outlive the core. Those left open
// by the previous run (a crash, a restart) close now, before the worker takes
// back and resumes their interrupted runs.
const closedIncognito = await closeIncognitoAtStart(sql, report);
if (closedIncognito > 0) console.log(`Incognito: closed ${String(closedIncognito)} left open by the previous run`);

// Set once the core starts stopping: nothing new is opened after it.
let stopping = false;

// Telegram is off by the user's choice (D-110, question 12; the phone is task
// 1.19): [telegram] is read as absent. The code stays, ready to turn back on.
const TELEGRAM_ON: boolean = false;
function telegramSection(): TelegramConfig | undefined {
  return TELEGRAM_ON ? settings.current().telegram : undefined;
}

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
      // The fixed sentence of the kind, all that leaves, goes through the gateway on channel push.
      gate: async (text, kind) =>
        (await passGateway(sql, [{ value: text, label: 'L0', source: `${kind}:push` }], createContext('L0'), { kind: 'channel', id: 'push' })).decision === 'allow',
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
    // D-107 E: a model no role serves any more leaves the memory of oMLX once idle.
    if (applied.includes('roles') || applied.includes('local.models') || applied.includes('local.endpoints')) {
      const next = settings.current().local.endpoints;
      memory.modelsChanged(servedEndpoints, next).catch(report);
      servedEndpoints = next;
    }
    if (applied.includes('telegram')) telegram.sync(telegramSection());
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
      const payload = { enabled: enabledCloudModels(cloud), names: Object.fromEntries(CLOUD_MODELS.map((model) => [model, cloudModelName(cloud, model)])) };
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
    // A server that started or exited holds no model: the memory account starts again.
    if (event.type === 'spawn' || event.type === 'exit') memory.serverReset(event.endpoint);
    if (!loggedEvent(event)) return;
    // Codes only: `error` carries a system code or a class name, never data.
    const detail = event.type === 'state' ? event.state : event.type === 'error' ? `error ${event.message}` : event.type;
    console.log(`local ${event.endpoint}: ${detail}`);
    appendEvent(sql, { kind: 'local.server', label: 'L0', payload: { ...event } }).catch(report);
  },
});
// The memory policy of oMLX (D-107, stage E): the old model of a role is
// unloaded, a load that would pass the ceiling unloads the idle models first
// (or is refused with 507), swap and memory pressure are watched. Catalog ids
// and numbers only: L0.
let servedEndpoints = config.local.endpoints;
// Set once the calls exist: while one is in progress, the model behind
// `local-voice` is never evicted, not even idle between two turns.
let callActive: () => boolean = () => false;
const memory = createModelMemory({
  catalog: () => loadCatalog(config.home),
  endpoints: () => settings.current().local.endpoints,
  isAvailable: (id) => localServers.isAvailable(id),
  unload: (endpoint, name) => unloadModel(endpoint, name, (id) => localServers.isAvailable(id)),
  pinned: (endpoint, name) => callActive() && settings.current().local.endpoints.find(({ id }) => id === endpoint)?.models[VOICE_ALIAS] === name,
  onEvent: (event) => {
    if (event.type === 'swap') console.log(`memory: swap ${event.level} (${String(event.usedGib)} GiB used)`);
    else if (event.type === 'unloaded') console.log(`local ${event.endpoint}: unloaded ${event.model} (${event.reason})`);
    else console.error(`local ${event.endpoint}: ${event.model} refused, about ${String(event.needGib)} GiB over a ceiling of ${event.budgetGib.toFixed(1)} GiB`);
    appendEvent(sql, { kind: event.type === 'swap' ? 'memory.swap' : `local.memory.${event.type}`, label: 'L0', payload: { ...event } }).catch(report);
  },
  onError: report,
});
localServers.sync(config.local.endpoints).catch(report);
const localModel = () => {
  const endpoints = settings.current().local.endpoints;
  return memory.wrap(
    createLocalModel({
      endpoints,
      isAvailable: (id) => localServers.isAvailable(id),
      onFailure: (id) => { localServers.onFailure(id); },
    }),
    endpoints,
  );
};

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
// D-140 (D-111 tappa C): Codex next to Claude, with its own profile (D-138); the same rules apply.
let codex: CodexExecutor | undefined;
try {
  // The binary knows no alias (D-141): the exact name of [cloud.models], else the first of the cloud catalog.
  const catalog = loadCloudCatalog(config.home);
  codex = createCodexExecutor({
    enabled: () => settings.current().cloud.executors,
    home: config.home,
    modelName: (model) => settings.current().cloud.models[model].name ?? catalogModelName(catalog, model),
  });
} catch (error) {
  report(error);
  if (config.cloud.executors.includes('codex')) console.error('codex off: its sandbox folders are refused (see the error above)');
}
const adapters = { claude: claude !== undefined, codex: codex !== undefined };
// D-145: the knowledge of the approved projects is searched and read with kb/, on this computer only.
// D-155: Arianna's own documents (docs/, CHANGELOG.md) too, read-only and L2 at least.
const ariannaDocs = createAriannaDocs({ home: config.home, rules });
const kb = createKb({
  home: config.home,
  rules,
  projects: createProjectPages(() => settings.current().projects, { home: config.home, rules }),
  arianna: ariannaDocs,
});
const orchestrator = createOrchestrator({
  sql,
  agents,
  kb,
  model: localModel,
  settings: () => settings.current(),
  rules,
  ...(claude === undefined ? {} : { claude }),
  ...(codex === undefined ? {} : { codex }),
  // The trial chat of a catalog model (D-142): `local-large` of the endpoints pointing at it, as the trials of D-081.
  trialModel: (modelId) => {
    const endpoints = trialEndpoints(settings.current().local.endpoints, modelId);
    return memory.wrap(
      createLocalModel({ endpoints, isAvailable: (id) => localServers.isAvailable(id), onFailure: (id) => { localServers.onFailure(id); } }),
      endpoints,
    );
  },
});
const refused = [...(claude === undefined ? ['claude'] : []), ...(codex === undefined ? ['codex'] : [])];
console.log(`Cloud executors: ${config.cloud.executors.length === 0 ? 'none' : config.cloud.executors.join(', ')}${refused.length === 0 ? '' : ` (sandbox refused: ${refused.join(', ')})`}`);

const worker = createWorker({
  sql,
  executor: orchestrator,
  allowedActions: (task) => agents.get(task.assignee)?.card.approvals ?? [],
  // No card, no caps: the engine then runs no step and the task waits for the user.
  agentLimits: (task) => agents.get(task.assignee)?.card.limits ?? {},
  endpointPort: (id) => endpointPort(settings.current().local.endpoints.find((endpoint) => endpoint.id === id)?.url),
  onError: report,
});
/** Closes an incognito conversation, stopping the step the worker runs for it (D-136). */
const endIncognito = (conversationId: string, cause: IncognitoCause) =>
  closeIncognito(sql, conversationId, cause, { stopTask: (taskId) => worker.stopTask(taskId, 'incognito'), onError: report });
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
callActive = () => calls.active();
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
  agentModels: () => Object.fromEntries([...agents].map(([id, agent]) => [id, agentModels(id, agent.card)])),
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
    memory.wrap(
      createLocalModel({
        endpoints,
        isAvailable: (id) => localServers.isAvailable(id),
        onFailure: (id) => { localServers.onFailure(id); },
      }),
      endpoints,
    ),
  onError: report,
});
// The actions of the "Modelli" page on a local model (I-3, stage M4):
// downloads from the catalog URLs only, verifications, removal into the bin
// data/models/eliminati, unloading from oMLX. Events: model id and outcome (L0).
const modelActions = createModelActions({
  catalog: () => loadCatalog(config.home),
  dataDir: config.paths.data,
  roles: () => settings.current().roles,
  fetch: createFetcher(),
  loaded: (modelId) => memory.snapshot().loaded.filter(({ model }) => model === modelId),
  unload: async (modelId) => {
    const endpoints = settings.current().local.endpoints;
    const places = memory.snapshot().loaded.filter(({ model }) => model === modelId);
    // Busy anywhere wins; then any server that did not confirm, or an endpoint gone from the configuration, is a failure.
    const results: ('unloaded' | 'busy' | 'failed')[] = [];
    for (const place of places) {
      const endpoint = endpoints.find(({ id }) => id === place.endpoint);
      results.push(endpoint === undefined ? 'failed' : await memory.unloadNow(endpoint, modelId));
    }
    if (results.includes('busy')) return 'busy';
    return results.length > 0 && results.every((result) => result === 'unloaded') ? 'unloaded' : 'failed';
  },
  trialOpen: (modelId) => trialOpen(sql, modelId),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
  onError: report,
});
// Hugging Face on the "Modelli" page (I-10, D-139): the typed search or the
// chosen repository id passes the gateway (L0, web target, logged) and is all
// that leaves; a model goes into config/models.user-catalog.yaml as
// experimental and without a role, its weights come later through Scarica.
const huggingface = createHuggingFace({
  home: config.home,
  dataDir: config.paths.data,
  client: createHubClient(),
  gateway: (payload, context, target, meta) => passGateway(sql, payload, context, target, meta),
  roles: () => settings.current().roles,
  busy: (modelId) => modelActions.list().some((action) => action.modelId === modelId && action.status === 'running'),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
});
// Captured notes organized by the local model in the background (D-086), one
// at a time, giving way to calls and task steps; the raw note is saved first.
// No note starts while oMLX is on its way up: at start it loads for minutes (D-100).
const organizer = createNoteOrganizer({
  sql,
  home: config.home,
  rules,
  kb,
  model: localModel,
  modelReady: () =>
    organizeModelReady(
      settings.current().local.endpoints,
      (id) => localServers.isAvailable(id),
      (id) => localServers.isSettling(id),
    ),
  // Links of these sites downloaded and summarized (D-154), read at each note.
  fetchSites: () => settings.current().capture.fetchSites,
  onError: report,
});
// "Genera personaggio" (D-123): the model of [sprites], read at each request; the brief passes the gateway.
const sprites = createSpriteGenerator({
  model: () => settings.current().sprites.model,
  unavailable: (model) => spriteUnavailable({ ...settings.current(), sprites: { model } }, claude !== undefined),
  claude,
  localModel,
  // Own keys only: the name comes from the page (`constructor` is no persona).
  persona: (name) => {
    const personas = settings.current().personas;
    return Object.hasOwn(personas, name) ? personas[name] : undefined;
  },
  gateway: (payload, context, target, meta) => passGateway(sql, payload, context, target, meta),
  dataDir: config.paths.data,
});
const dist = join(config.home, 'apps', 'hud', 'dist');
// The last notice pushed (I-1): the service worker asks for its kind and conversation.
const notices = createNoticeBoard();
// D-145: the parts of the approved projects, read from the disk at each request: what the Coder and the tabs File, Git and Servizi work on.
const approvedProjects = () => workParts(settings.current().projects);
const projectContainers = () => settings.current().projects;
// The tab Servizi of "Progetti" (D-134, tappa 2): each start and stop in the chain of events, project and service only.
const services = createServiceManager({
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L1', payload }).catch((error: unknown) => {
      console.error(`event ${kind}: ${error instanceof Error ? error.message : String(error)}`);
    });
  },
});
const server = await startApiServer({
  sql,
  live,
  host: config.server.host,
  port: config.server.port,
  // The approved projects: listed for a new conversation, and where the preview of a changed file is read (D-082).
  projects: approvedProjects,
  approvedProjects,
  projectContainers,
  // The tab "Conoscenza" (D-145): kb/progetti of this ARIANNA_HOME for the projects that are one git.
  knowledge: { home: config.home, rules },
  // The files attached to cards (D-152): private copies, outside git.
  cards: { dir: join(config.home, 'data', 'cards') },
  services,
  // Without the adapter no delegation runs: the selector offers nothing.
  models: () => selectableModels(settings.current(), adapters),
  defaultModel: () => agentDefaultModel(settings.current(), WORK_AGENT, agents.get(WORK_AGENT)?.card, adapters),
  agents: () => [...agents.keys()],
  // The participant bar (D-125): where an agent runs, and how its name is labelled in the chat.
  // I-8 (D-130): an agent idle for [participants] leave_after messages of the user leaves by itself.
  leaveRule: () => ({ after: settings.current().participants.leaveAfter, nameLabel: (name) => nameLabelOf(agents.get(name)) }),
  // D-142: "Prova in chat" opens only for a model of the catalog that writes text, with its files on the disk.
  trialRefusal: (modelId) => trialRefusal(loadCatalog(config.home), modelId, voiceDirs.models, fileSize),
  // D-111d: who the user may talk with directly, from the cards, with Claude on or off as now.
  directAgents: () =>
    directPolicies(agents, {
      claude: adapters.claude && settings.current().cloud.executors.includes('claude'),
      codex: adapters.codex && settings.current().cloud.executors.includes('codex'),
    }),
  participantAgent: (name) => {
    const agent = agents.get(name);
    return agent === undefined ? undefined : { executor: delegationRoute(agent.card) ?? agent.card.executors[0] ?? null, nameLabel: nameLabelOf(agent) };
  },
  characters: {
    dirs: { original: join(config.home, 'apps', 'hud', 'characters', 'originali'), data: join(config.paths.data, 'characters') },
    choices: () => settings.current().characters,
  },
  voice: { service: voice.service, voice: () => voiceSettings().voice, models: candidates, clones: voiceDirs.clones },
  calls,
  pusher: () => voice.pusher(),
  notices,
  settings: settingsPage,
  userAgents,
  sprites,
  local: {
    status: () => localServers.status(),
    restart: (id) => localServers.restart(id),
    log: (id) => logTail(config.paths.data, id),
    memory: () => memory.snapshot(),
  },
  capture: { home: config.home, rules, organize: (path) => organizer.enqueue(path), fetch: (path) => organizer.enqueueFetch(path), arianna: ariannaDocs },
  modelEvals,
  // The "Modelli" page (I-3): catalogs read at each request, with the adapters that run here (D-140).
  modelsOverview: () =>
    loadModelsOverview(sql, {
      home: config.home,
      dataDir: config.paths.data,
      config: () => settings.current(),
      memory: () => memory.snapshot(),
      adapters: () => adapters,
      actions: modelActions,
    }),
  modelActions,
  huggingface,
  // "Sviluppo di Arianna" (D-102): docs/ read, answers through the gateway into data/dev/RISPOSTE.md.
  devProgress: { home: config.home },
  // "Novità": CHANGELOG.md at the root of the home, read only.
  changelog: { home: config.home },
  // Development or production (D-089): the passwords the core logged in with, or [installation] mode.
  installation: () => installationInfo(config.home, app.development, settings.current().installation?.mode),
  ...(existsSync(dist) ? { staticDir: dist } : {}),
  // "Elimina" (D-157): the steps of the worker stop first, as for an incognito.
  erase: (conversationId) => eraseConversation(sql, conversationId, { stopTask: (taskId) => worker.stopTask(taskId, 'erase'), dataDir: config.paths.data, onError: report }),
  incognito: { close: endIncognito, localCache: () => localCacheOn(settings.current().local.endpoints) },
  onError: report,
});
await worker.start();
// D-136: 10 minutes without a page on an incognito conversation close it; the pages hear it a minute before.
const incognitoWatch = createIncognitoWatch({
  list: () => openIncognito(sql),
  pagesOn: (conversationId) => server.pagesOn(conversationId),
  close: (conversationId) => endIncognito(conversationId, 'idle'),
  warn: (conversationId, inSeconds) => {
    server.incognitoClosing(conversationId, inSeconds);
  },
  onError: report,
});
incognitoWatch.start();
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
    return pusher === undefined
      ? undefined
      : async () => {
          notices.record({ kind: 'call', conversationId: null });
          await pusher.notify('call');
        };
  },
  clientsOnline: () => server.clients(),
  onError: report,
});

// Notifications of the web chat (I-1): a reply, an approval waiting, a failed
// task, as [notifications] allows, to the open pages and, with none in view,
// by Web Push. Kind and conversation only, never text.
const notifier = createNotifier({
  settings: () => settings.current().notifications,
  conversationOf: (taskId) => conversationOfTask(sql, taskId),
  incognito: (conversationId) => isIncognitoConversation(sql, conversationId),
  visiblePages: () => server.visiblePages(),
  broadcast: (notice) => {
    server.broadcast(notice);
  },
  readingPages: (conversationId) => server.readingPages(conversationId),
  helpers: () => server.helpers(),
  toHelpers: (notice) => {
    server.notifyHelpers(notice);
  },
  push: () => {
    const pusher = voice.pusher();
    return pusher === undefined ? undefined : (kind, helper) => pusher.notify(kind, helper ? { skip: server.macEndpoints() } : {});
  },
  board: notices,
  onError: report,
});
const stopNotices = await live.subscribe(notifier.subscriber);

// The reminders of the secretary (I-12 S2, D-149): the three moments of
// [secretary], read at each tick (a change from the settings applies without
// a restart), once per day and moment; started after the notifier, so that
// a moment recovered at start-up notifies too.
const secretaryTicker = createSecretaryTicker({ sql, settings: () => settings.current().secretary, onError: report });
secretaryTicker.start();

// Telegram (task 1.15, D-044): on only with [telegram] in arianna.toml, opened
// or closed when the section changes (D-071). Without a token the core runs
// anyway: the web chat does not depend on it. Off by the user's choice (D-110,
// question 12): the section is ignored until TELEGRAM_ON comes back.
await telegram.begin(telegramSection());

console.log(`Arianna core on http://${host}:${String(server.port)}${existsSync(dist) ? '' : ' (API only: run pnpm hud:build for the web chat)'}`);

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // The processes started from "Progetti" stop with the core (D-134 g); compose services stay with Docker.
  await services.stopAll();
  settings.close();
  secretaryTicker.stop();
  incognitoWatch.stop();
  stopNotices();
  await telegram.close();
  await server.close();
  ringer.stop();
  await calls.close();
  await voice.close();
  await modelEvals.stop();
  await modelActions.stop();
  await organizer.stop();
  await worker.stop();
  memory.stop();
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
