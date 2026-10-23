// Usage: node apps/core/src/main.ts
// Starts the core: migrations, task worker, live feed, API, WebSocket and web chat.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { AGENTS_DIR, isFinanceCard, loadAgents } from '@arianna/agents';
import {
  catalogModelName,
  CLOUD_MODELS,
  cloudModelName,
  configErrorText,
  DEFAULT_VOICE,
  enabledCloudModels,
  guardPaths,
  loadCatalog,
  loadCloudCatalog,
  loadConfigOrExit,
  loadLabelRules,
  modelPath,
  remotePaths,
  userHomeOf,
  VOICE_ALIAS,
  voicePaths,
  watchConfig,
  workParts,
  type TelegramConfig,
} from '@arianna/config';
import { claudeManagedSettingsPresent, createClaudeExecutor, createCodexExecutor, createLocalModel, localKeys, MCP_DIR, removeConversationWorkspace, removeStaleMcp, type ClaudeExecutor, type CodexExecutor } from '@arianna/executors';
import { createContext, spendAllowed } from '@arianna/policy';
import { createVault, MASTER_PASSWORD_REF, VaultError, verifyMasterPassword } from '@arianna/vault';

import { enqueueArchive, notesToPropose, proposeArchive, recordRelocated, relocateArchived } from './archivist.ts';
import { assigneeLimits, directPolicies, offInterlocutors, type DirectPolicy } from './direct-chat.ts';
import { CLAUDE_CHAT_AGENT, CODEX_CHAT_AGENT } from './conversations.ts';
import { createGodApi } from './god/api.ts';
import { godGit } from './god/clone.ts';
import { createGodLanding } from './god/land.ts';
import { prepareGodClone } from './god/prepare.ts';
import { createGodWork } from './god/work.ts';
import { GOD_AGENT } from './god/clone.ts';
import { connect } from './db/client.ts';
import { configurePiiGuard, createPiiGuard, guardStarter, stopPiiGuard } from './pii-guard.ts';
import { chatCharacters } from './character-chat.ts';
import { servedRowsSync } from './characters.ts';
import { characterDirsOf, configureSeriesLines, configureTailAgents, wornSeriesNames } from './prompt-tail.ts';
import { createSeriesLines } from './series-lines.ts';
import { createWikiquoteClient } from './wikiquote.ts';
import { prepareDatabase, resolveLogin } from './db/logins.ts';
import { loadMigrations, migrationStatus } from './db/migrate.ts';
import { CARD_WORKERS, createWorker, type StopCause } from './engine.ts';
import type { Task } from './tasks.ts';
import { stopCard } from './cardwall.ts';
import { eraseConversation } from './erase.ts';
import { attachmentsDir, pruneAttachments } from './attachments.ts';
import { closeIncognito, closeIncognitoAtStart, createIncognitoWatch, isIncognitoConversation, localCacheOn, openIncognito, type IncognitoCause } from './incognito.ts';
import { appendEvent } from './events.ts';
import { AgentBrowser, gatewayTyped } from './browser/agent-browser.ts';
import { readBrowserImageLock } from './browser/image.ts';
import { BrowserManager } from './browser/manager.ts';
import { BrowserScreens, conversationKindOf } from './browser/screen.ts';
import { writeClosedByUserLine, writeTakenLine } from './orchestrator/browser-tool.ts';
import { afterControl } from './browser/handoff.ts';
import { createMcpServer } from './mcp/server.ts';
import { readPage } from './web-page.ts';
import { createServiceManager } from './project-services.ts';
import { createUserAgents } from './user-agents.ts';
import { createSpriteGenerator, spriteUnavailable } from './sprites/generate.ts';
import { configureWornNames, passGateway } from './gateway.ts';
import { pruneGatewayTexts } from './gateway-log.ts';
import { savedAskValues } from './orchestrator/saved-ask.ts';
import { savedInAddress, startSavedPrivate } from './saved-private.ts';
import { nameLabelOf, type LeaveRule } from './participants.ts';
import { stopConversation } from './chat-stop.ts';
import { createQueueDispatcher } from './message-queue.ts';
import { startLiveFeed } from './live.ts';
import { createLocalReload, servedByLocalServer } from './local-reload.ts';
import { createLocalServers, localServerEnv, loggedEvent, logTail } from './local-servers.ts';
import { createOmlxReleases, createVersionRunner, OMLX_PROMPT } from './omlx-release.ts';
import { createHubClient } from './hub-http.ts';
import { createHuggingFace } from './huggingface.ts';
import { createDesignCatalog } from './design-catalog.ts';
import { createLocalSummarizer } from './design-news.ts';
import { themeDay } from './feasts.ts';
import { createFollowedProjects, PROJECT_PROMPT } from './followed-projects.ts';
import { createGithubClient } from './github-api.ts';
import { downloadPixelAgents } from './pixel-agents-pack.ts';
import { CloudTextError, createCloudText } from './cloud-text.ts';
import { createAdvisor } from './orchestrator/advisor.ts';
import { createStyleExamples } from './style-examples.ts';
import { createSkillTranslations } from './skill-translations.ts';
import { createSafetyReports, roleSafetyText, skillSafetyText } from './safety-reports.ts';
import { assignedSkills, createSkillsCatalog, eventSkillId, isPublicSkill, OPEN_DESIGN_SOURCE, ownSkillRefusal, skillRefusalOf, skillRefusals } from './skills-catalog.ts';
import { cloudModelAreas, createChangeWatcher, lastBinaryVersion, modelsArea, packageVersion, readAreas, shortCommit, sourcesArea, stateFile } from './install-changes.ts';
import { modelStatus } from './model-files.ts';
import { createAgentsCatalog } from './agents-catalog.ts';
import { createModelActions } from './model-actions.ts';
import { createModelEvals, machineBusy, trialOpen, trialRunning } from './model-evals.ts';
import { trialEndpoints } from '@arianna/evals/library';
import { conversationOfTask, createNoticeBoard, createNotifier } from './notifications.ts';
import { createImWatcher } from './im-watch.ts';
import { createImReporter, reportClaudeModel, reportUnavailable } from './im-report.ts';
import { createSecretaryTicker } from './reminders.ts';
import { createRoutineService, createRoutineSummarizer, createRoutineTicker, routineCallScript } from './routines.ts';
import { createModelMemory, unloadModel } from './model-memory.ts';
import { createFetcher } from './model-http.ts';
import { loadModelsOverview } from './models-overview.ts';
import { briefCeiling, delegationRoute, localAgentModel, mentionableAgents, mentionBlocks } from './orchestrator/delegate.ts';
import { createKb, KB_DIR } from './orchestrator/kb.ts';
import { createProjectPages } from './project-knowledge.ts';
import { createAriannaDocs } from './arianna-docs.ts';
import { createOrchestrator } from './orchestrator/orchestrator.ts';
import { createNoteReleaser } from './note-release.ts';
import { createNoteOrganizer, MAX_RESUMED, organizeModelReady } from './organize.ts';
import { agentDefaultModel, agentModels, selectableModels, WORK_AGENT } from './orchestrator/routing.ts';
import { installationInfo } from './installation.ts';
import { createReadiness } from './readiness.ts';
import { draftProjectRules } from './rules-draft.ts';
import { isRefreshConversation, settleDashboard, suggestQuestion } from './dashboard.ts';
import { chartOf } from './dashboard-chart.ts';
import { NO_RULES, planRulesExport, writeRulesExport } from './rules-export.ts';
import { startApiServer } from './server/http.ts';
import { createSettingsPage } from './settings-page.ts';
import { createBotApi } from './telegram/api.ts';
import { startTelegram } from './telegram/channel.ts';
import { createTelegramSwitch } from './telegram/switch.ts';
import { createCalls, liveCall } from './voice/calls.ts';
import { createPusher, vapidKey } from './voice/push.ts';
import { createPushSwitch } from './push-switch.ts';
import { loadRemoteTls, WARN_DAYS } from './remote-cert.ts';
import { createRemoteDevices } from './remote/devices.ts';
import { createDeviceStore } from './remote/store.ts';
import { createRinger } from './voice/ringer.ts';
import { createVoiceService } from './voice/service.ts';
import { createVoiceSwitch } from './voice/switch.ts';
import { listClones } from './voice/clones.ts';
import { fileSize, filesPresent, trialModels } from './voice/trial.ts';
import { systemVoices } from './voice/system-voices.ts';
import { createVideoWorker, findTool, voiceRunner } from './video-job.ts';
import { enqueueWikiIndex, enqueueWikiNote, runWikiJob } from './wiki.ts';
import { trialRefusal } from './orchestrator/trial-chat.ts';
import { CLOUD_WORKER_NAMES } from './work-diary.ts';
import { closeRefusedDirectWaits } from './orchestrator/gateway-refusal.ts';

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

// A restart asked by GOD (D-179): the previous core must have let go of the port and the worker first.
const restartAfter = Number(process.env.ARIANNA_RESTART_AFTER ?? '');
delete process.env.ARIANNA_RESTART_AFTER;
if (Number.isInteger(restartAfter) && restartAfter > 0) {
  const gone = (): boolean => {
    try {
      process.kill(restartAfter, 0);
      return false;
    } catch {
      return true;
    }
  };
  for (let waited = 0; waited < 300_000 && !gone(); waited += 200) await new Promise((resolve) => setTimeout(resolve, 200));
}

const config = loadConfigOrExit();
const agents = loadAgents(join(config.home, AGENTS_DIR));
// The user's agents (D-119): the active ones join the map, under the L1/A1 ceiling.
// A card from a role of the catalog of agents (D-079) reads the role from the catalog, made further below.
const userAgents = createUserAgents({
  home: config.home,
  dataDir: config.paths.data,
  agents,
  // The plain chats of «Con chi parli» (D-111, tappa B) are named after their executor: no user agent takes those names.
  official: new Set([...agents.keys(), CLAUDE_CHAT_AGENT, CODEX_CHAT_AGENT]),
  catalog: { role: (id) => agentsCatalog.role(id), adoptedRole: (page, path) => agentsCatalog.adoptedRole(page, path) },
  // Deleting an agent drops its [agents.<id>] (model and skills) from arianna.toml (D-161), through the settings page made further below.
  forget: (name) => {
    settingsPage.forgetAgent(name);
  },
});
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

// The second scanner of personal data (D-113, stage 2): apps/guard with the model of
// the `pii` role, started at the first exit towards the cloud. Without the role, its
// weights or its environment every such exit stops, except with the development
// passwords (the doctor's criterion), where gateway_log says the check was skipped.
{
  const assigned = config.roles.pii;
  const entry = assigned === undefined ? undefined : loadCatalog(config.home).models.find((model) => model.id === assigned && model.roles.includes('pii'));
  const start = guardStarter(guardPaths(config.home, config.paths.data), entry === undefined ? undefined : modelPath(config.paths.data, entry));
  configurePiiGuard(
    createPiiGuard({
      start,
      development: app.development,
      names: () => [...agents.keys(), ...CLOUD_WORKER_NAMES],
      onEvent: (event) => {
        if (event !== 'ready' && event !== 'starting' && event !== 'idle-stop') console.error(`pii guard: ${event}`);
      },
    }),
  );
  if (start === undefined) {
    console.error(
      app.development
        ? 'Second check of personal data off (pii role, pnpm arianna:models pull, pnpm guard:sync): exits to the cloud go on, development installation'
        : 'Second check of personal data off (pii role, pnpm arianna:models pull, pnpm guard:sync): every exit to the cloud stops',
    );
  }
}
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
// «Cosa è cambiato» (D-233): set further below, once the catalogs exist; a change of arianna.toml asks for a new picture.
let changesSoon = (): void => undefined;

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
// another port without a restart, once no call is in progress (D-071). Web
// Push has its own switch below (D-292). Without the environment (pnpm
// voice:sync) the trial page says what is missing.
const voiceDirs = voicePaths(config.home, config.paths.data);
let voiceShown = { on: config.voice !== undefined, port: config.voice?.port ?? null };
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
  busy: async () => (await liveCall(sql)) !== undefined,
  // On or off and port: L0, never the voice (it may name a copied voice).
  onChange: (next) => {
    const shown = { on: next !== undefined, port: next?.port ?? null };
    if (isDeepStrictEqual(shown, voiceShown)) return;
    voiceShown = shown;
    appendEvent(sql, { kind: 'settings.voice', label: 'L0', payload: shown }).catch(report);
  },
  onApplied: (next) => {
    console.log(next === undefined ? 'voice off: no [voice] in arianna.toml' : `voice on port ${String(next.port)}`);
  },
  onError: report,
});

// Web Push (D-066, choice 7; on its own since D-292): a notification without
// content when no chat is open, for the chat notifications and the calls,
// with the voice off too. Keys of [push] or of [voice.push]; a change applies
// without a restart.
// Undefined until the first application: the start of the core is not a change.
let pushShown: boolean | undefined;
const push = createPushSwitch({
  createPusher: async (keys) => {
    const privateKey = await createVault({ data: config.paths.data }).resolve(keys.privateKey);
    return createPusher({
      sql,
      publicKey: keys.publicKey,
      key: vapidKey(keys.publicKey, privateKey.reveal()),
      subject: keys.subject,
      // The fixed sentence of the kind, all that leaves, goes through the gateway on channel push.
      gate: async (text, kind) =>
        (await passGateway(sql, [{ value: text, label: 'L0', source: `${kind}:push` }], createContext('L0'), { kind: 'channel', id: 'push' })).decision === 'allow',
      onError: report,
    });
  },
  onApplied: (next, on) => {
    console.log(`Web Push ${on ? 'on' : 'off'}`);
    if (next !== undefined && !on) console.error('Web Push off: see the error above; tried again at the next change of [push]');
    // On or off only: L0.
    if (pushShown !== undefined && pushShown !== on) appendEvent(sql, { kind: 'settings.push', label: 'L0', payload: { on } }).catch(report);
    pushShown = on;
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
    if (applied.length > 0) changesSoon();
    if (applied.includes('local.endpoints')) localServers.sync(settings.current().local.endpoints).catch(report);
    // D-107 E: a model no role serves any more leaves the memory of oMLX once idle.
    if (applied.includes('roles') || applied.includes('local.models') || applied.includes('local.endpoints')) {
      const next = settings.current().local.endpoints;
      memory.modelsChanged(servedEndpoints, next).catch(report);
      servedEndpoints = next;
    }
    if (applied.includes('telegram')) telegram.sync(telegramSection());
    if (applied.includes('voice')) voice.sync(settings.current().voice);
    if (applied.includes('push')) push.sync(settings.current().push);
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
    // A ConfigError names a key and a rule, never a value read elsewhere; a refused project in Italian (D-289).
    const text = configErrorText(error);
    if (text !== undefined) console.error(text);
    else report(error);
    console.error('arianna.toml: not reloaded, the previous configuration stays; no project, cloud executor or Telegram bot is open until the file is valid');
  },
});

// The local servers (D-071, choice 4): an endpoint with `command` is started
// with the core, restarted when it fails and stopped with it; one already
// answering is adopted. Started in the background: loading a large model can
// take minutes, and the chat must not wait for it.
// The key of each server the core starts (D-221), read again at every request.
const localKey = localKeys(config.paths.data, (id) => settings.current().local.endpoints.some((endpoint) => endpoint.id === id && endpoint.command !== undefined));
const localServers = createLocalServers({
  home: config.home,
  dataDir: config.paths.data,
  onEvent: (event) => {
    // A server that started or exited holds no model: the memory account starts again.
    if (event.type === 'spawn' || event.type === 'exit') memory.serverReset(event.endpoint);
    if (!loggedEvent(event)) return;
    // Codes only: `error` carries a system code or a class name, never data.
    const detail =
      event.type === 'state' ? event.state
      : event.type === 'error' ? `error ${event.message}`
      : event.type === 'open' ? 'open: a server started without the key (D-221) answers on its port; stop it, then "Riavvia oMLX"'
      : event.type === 'refused' ? `not started: ${event.reason} (D-263); pnpm arianna:doctor says what`
      : event.type;
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
  unload: (endpoint, name) => unloadModel(endpoint, name, (id) => localServers.isAvailable(id), localKey),
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
      apiKey: localKey,
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
/**
 * The gateway of a catalog of text from GitHub (D-160, D-161): only the
 * address of the repository leaves, L0, towards the web, and the decision
 * is spent on that exact text.
 */
function catalogGateway(source: string, summary: string): (repository: string) => Promise<void> {
  return async (repository) => {
    const decision = await passGateway(sql, [{ value: repository, label: 'L0', source }], createContext('L0'), { kind: 'web' }, { summary });
    if (decision.decision !== 'allow') throw new Error(`gateway ${decision.rule}: ${decision.reason}`);
    const spent = spendAllowed(decision);
    if (spent?.target.kind !== 'web' || spent.texts[0] !== repository) throw new Error('the gateway decision cannot be spent');
  };
}
// The catalog of skills (D-161): SKILL.md files of the GitHub repositories the user follows, as
// text in data/catalogs/skills, downloaded only when the user presses the button. A skill reaches
// an agent only when assigned in [agents.<id>] skills, as L0 data in its delivery; never Arianna,
// never a card that closes untrusted_content.
const skillsCatalog = createSkillsCatalog({
  dir: join(config.paths.data, 'catalogs'),
  gateway: catalogGateway('settings:skills-catalog', 'github.com: catalogo di skill'),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
  assigned: (agent) => assignedSkills(settings.current(), agent),
  refusal: (agent) => skillRefusalOf(agent, agents.get(agent)?.card),
  // The user's own skills of Claude Code (D-255): copied only on the user's «Importa», private until marked shareable.
  claudeConfig: { env: process.env, home: userHomeOf() },
});
// Arianna's MCP server (D-261): a few read-only tools (her skills, the knowledge base) for an agent
// in the cloud while it runs, on its own listener on 127.0.0.1. A run reaches it only with a session
// opened for it (`mcpServer.open`, at most L1, `mcpClearance`) and revoked when it ends; each answer
// passes the gateway towards the run's executor. `mcpUrl` is what the run's MCP configuration names.
const mcpServer = createMcpServer({
  kb,
  skills: {
    list: () => skillsCatalog.list(),
    text: (id) => skillsCatalog.text(id),
    assigned: (agent) => assignedSkills(settings.current(), agent),
    refusal: (agent) => skillRefusalOf(agent, agents.get(agent)?.card),
  },
  gate: (payload, context, executor, meta) => passGateway(sql, payload, context, { kind: 'executor', id: executor, locality: 'cloud' }, meta),
  event: async ({ runId, taskId, agent, tool, decision, bytes }) => {
    await appendEvent(sql, { kind: 'mcp.call', label: 'L0', runId, taskId, agent, payload: { runId, tool, decision, bytes } }).catch(report);
  },
  // web_fetch for the Coder (D-262): every address through the gateway towards a page target, one event per page
  // with its site and outcome (never the address nor the text), labelled as the session.
  web: {
    sites: () => settings.current().web.coderSites,
    read: ({ address, consent, context, meta }) => readPage({ sql, address, context, consent, meta }),
    event: async ({ runId, taskId, agent, site, outcome, consent, label }) => {
      await appendEvent(sql, { kind: 'mcp.web_fetch', label, runId, taskId, agent, payload: { runId, site, outcome, consent } }).catch(report);
    },
  },
  version: packageVersion(config.home) ?? '0.0.0',
});
// The files of the runs' tokens (D-261), 0700 under data/: those a stopped core left go now, their tokens died with it.
const mcpDir = join(config.paths.data, MCP_DIR);
await removeStaleMcp(mcpDir).catch(report);
// The private values the user saved (D-283): compared in the browser and in web.fetch instead of the
// second scanner, built again after every change of a client. Until they load, those exits are refused.
await startSavedPrivate(sql, report).catch(report);
// A server that cannot start leaves the core up: runs get no MCP session (`open` refuses), undefined here.
let mcpUrl: string | undefined;
try {
  mcpUrl = (await mcpServer.start()).url;
  console.log(`MCP server for cloud runs on ${mcpUrl}`);
} catch (error) {
  console.error('MCP server not started: cloud runs go without Arianna’s tools');
  report(error);
}
// The catalog of agents (D-079): role files of the GitHub repositories the user follows, as text
// in data/catalogs/agents, downloaded one at a time only when the user presses the button. A role
// becomes an agent only through a disabled card the user confirms; its text stays L0 third-party data.
const agentsCatalog = createAgentsCatalog({
  dir: join(config.paths.data, 'catalogs'),
  gateway: catalogGateway('settings:agents-catalog', 'github.com: catalogo di agenti'),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
});
// The router's advisor (D-207): Sonnet without tools on a brief up to L1, only while the user keeps claude on.
const askAdvice = createCloudText({ sql, claude, data: config.paths.data });
const advise = createAdvisor({
  sql,
  data: config.paths.data,
  ask: (request) =>
    settings.current().cloud.executors.includes('claude') ? askAdvice(request) : Promise.reject(new CloudTextError('unavailable', 'claude is off')),
});
// Images and files attached in a private chat (D-247): data/attachments, private, outside git. The pasted
// ones never sent for a day go at start, with the files left without a row.
const attachmentFiles = attachmentsDir(config.paths.data);
pruneAttachments(sql, attachmentFiles).catch(report);
// «Cosa è uscito» (D-297): the texts of the exits older than 30 days go, at start and every hour.
const pruneTexts = (): void => void pruneGatewayTexts(sql).catch(report);
pruneTexts();
const gatewayTextsTicker = setInterval(pruneTexts, 60 * 60_000);
gatewayTextsTicker.unref();

// The screen of the browser in the chat (D-264, passo 4): view only, a token per conversation holding it.
// Declared first: it reads the browser below only when asked (lazy), and the browser tells it when it goes.
const conversationKind = conversationKindOf(sql);
const browserScreens = new BrowserScreens({
  holder: () => agentBrowser.holder,
  container: () => browserManager.active?.container ?? null,
  conversation: conversationKind,
  // «Chiudi» in the chat: after the action under way; the line tells the user and the model.
  closeBrowser: async (conversationId) => {
    const closed = await agentBrowser.closeByUser(conversationId);
    if (closed) await writeClosedByUserLine(sql, conversationId).catch(report);
    return closed;
  },
  site: (conversationId) => agentBrowser.siteOf(conversationId),
  // The bar of the screen (D-286): the address of the page, and its commands as the user's.
  url: (conversationId) => agentBrowser.urlOf(conversationId),
  acting: (conversationId) => agentBrowser.actingFor(conversationId),
  command: async (conversationId, command) => {
    const done = await agentBrowser.userCommand(conversationId, command);
    if (done.ok) return { ok: true, url: done.page.url, site: done.page.site };
    // A saved value: what it is and whose for the question of the bar, never the reference.
    if (done.reason === 'confirm-private') {
      return { ok: false, reason: done.reason, ...(done.site === undefined ? {} : { site: done.site }), ...(done.ask === undefined ? {} : { ask: done.ask }), values: savedAskValues(done.saved).map(({ kind, client }) => ({ kind, client })) };
    }
    return { ok: false, reason: done.reason };
  },
  // «Nuova chat Privata» (D-281): the work conversation shows where its browser went after an access.
  movedTo: (conversationId) => agentBrowser.movedFrom(conversationId),
  // «Prendi il controllo» (D-264, passo 5): the state is the browser's, the lines tell the user and the model.
  control: {
    take: (conversationId) => agentBrowser.takeControl(conversationId),
    give: (conversationId) => agentBrowser.returnControl(conversationId),
    input: (conversationId) => { agentBrowser.userInput(conversationId); },
    // D-286: a click or a key of the user chooses the next page of the agent's tab.
    gesture: (conversationId) => { agentBrowser.userGesture(conversationId); },
    driver: (conversationId) => agentBrowser.driverOf(conversationId),
    blocked: (conversationId) => agentBrowser.blockedOf(conversationId),
    access: (conversationId) => agentBrowser.accessOf(conversationId),
    loginForm: (conversationId) => agentBrowser.loginFormOf(conversationId),
  },
  // Given back after an access in a work conversation, the browser passes to a new Private chat (D-281).
  onControl: (conversationId, change) => { afterControl({ sql, browser: agentBrowser, kind: conversationKind }, conversationId, change).catch(report); },
  onEvent: (event) => { appendEvent(sql, event).catch(report); },
});
// The browser of Arianna (D-264, passo 3): one container at a time, the leftovers of a core that stopped removed at start.
const browserManager = new BrowserManager({
  home: config.home,
  onEvent: (event) => { appendEvent(sql, event).catch(report); },
  // Its screens close as soon as it starts closing, before docker removes it (D-264, passo 4).
  onStop: () => { browserScreens.revoke(); },
  onClose: () => { browserScreens.revoke(); },
});
if (readBrowserImageLock(config.home) !== null) browserManager.cleanup().catch(report);
const agentBrowser = new AgentBrowser({
  sql,
  manager: browserManager,
  session: { home: config.home, dataDir: config.paths.data },
  gateTyped: gatewayTyped(sql),
  // D-283: the card of a saved value at once, before the page is asked.
  savedIn: savedInAddress,
  onEvent: (event) => { appendEvent(sql, event).catch(report); },
  onTaken: (conversationId) => { writeTakenLine(sql, conversationId).catch(report); },
  onReleased: () => { browserScreens.revoke(); },
});

const orchestrator = createOrchestrator({
  // D-225, tappa A: a chat reply of a character switched on is written once more, livelier.
  livelyReplies: true,
  // D-251: a chat reply of the local model is written once more as free text in Markdown.
  freeReplies: true,
  attachmentsDir: attachmentFiles,
  sql,
  agents,
  advise,
  // D-261: the Coder's runs on claude get Arianna's tools; the files of their tokens in data/mcp, closed to the sandbox.
  // A machine whose Claude Code settings an administrator manages runs them without (only whether the files exist).
  mcp: { server: mcpServer, url: mcpUrl, dir: mcpDir, managed: () => claudeManagedSettingsPresent() },
  // The skills left out are written as `skills.skipped` events by the catalog (onEvent above).
  // A Designer card adds what the user chose on it (D-163): its style of Open Design first, then its skills.
  skills: (agent, maxBytes, card, ceiling) => {
    const delivery = skillsCatalog.skillTexts(agent, card?.skills ?? [], maxBytes, card?.style ?? undefined, ceiling);
    // The card's skills left out go in its history: the user's own by their source alone (D-255).
    const cardSkipped = (delivery.refused !== undefined ? [...(card?.skills ?? [])] : delivery.skipped.map((item) => item.id).filter((id) => card?.skills.includes(id) === true)).map(eventSkillId);
    return {
      block: delivery.block,
      ...(delivery.own === undefined ? {} : { own: delivery.own }),
      skipped: delivery.skipped.length,
      ...(delivery.styleSkipped === undefined ? {} : { styleSkipped: delivery.styleSkipped.slug }),
      ...(cardSkipped.length === 0 ? {} : { cardSkipped }),
    };
  },
  kb,
  // "Per il prossimo IM…" (D-167, P4b): the IM files of the approved projects, written by code on this computer.
  ims: { projects: () => settings.current().projects, knowledge: { home: config.home, rules } },
  model: localModel,
  settings: () => settings.current(),
  rules,
  ...(claude === undefined ? {} : { claude }),
  ...(codex === undefined ? {} : { codex }),
  // The trial chat of a catalog model (D-142): `local-large` of the endpoints pointing at it, as the trials of D-081.
  browser: { agent: agentBrowser, installed: () => readBrowserImageLock(config.home) !== null },
  trialModel: (modelId) => {
    const endpoints = trialEndpoints(settings.current().local.endpoints, modelId);
    return memory.wrap(
      createLocalModel({ endpoints, isAvailable: (id) => localServers.isAvailable(id), onFailure: (id) => { localServers.onFailure(id); }, apiKey: localKey }),
      endpoints,
    );
  },
});
// D-250: a direct chat left waiting only because the gateway refused its brief ends with Arianna's message.
closeRefusedDirectWaits(sql).catch(report);
const refused = [...(claude === undefined ? ['claude'] : []), ...(codex === undefined ? ['codex'] : [])];
console.log(`Cloud executors: ${config.cloud.executors.length === 0 ? 'none' : config.cloud.executors.join(', ')}${refused.length === 0 ? '' : ` (sandbox refused: ${refused.join(', ')})`}`);

// I-8 (D-130): an agent idle for [participants] leave_after messages of the user leaves by itself; also for a queued message (D-218).
const leaveRule = (): LeaveRule => ({ after: settings.current().participants.leaveAfter, nameLabel: (name) => nameLabelOf(agents.get(name)) });
const workerOptions = {
  sql,
  executor: orchestrator,
  allowedActions: (task: Task) => agents.get(task.assignee)?.card.approvals ?? [],
  // No card, no caps: the engine then runs no step and the task waits for the user.
  agentLimits: (task: Task) => assigneeLimits(agents, task.assignee),
  endpointPort: (id: string) => endpointPort(settings.current().local.endpoints.find((endpoint) => endpoint.id === id)?.url),
  onError: report,
};
// D-235: the chat has its own worker, the cards theirs, so a card at work never holds an answer;
// CARD_WORKERS cards of different projects at once, one per project (jobs.ts, claimStep).
const workers = [
  createWorker({ ...workerOptions, lane: 'chat' }),
  ...Array.from({ length: CARD_WORKERS }, () => createWorker({ ...workerOptions, lane: 'cards' })),
];
/** Stops the step of a task on the worker that runs it now; false when none does. */
const worker = {
  stopTask: (taskId: string, cause: StopCause): boolean => workers.some((one) => one.stopTask(taskId, cause)),
};
/** Closes an incognito conversation, stopping the step the worker runs for it (D-136). */
const endIncognito = async (conversationId: string, cause: IncognitoCause) => {
  // Never held by an incognito conversation (the tools are off there): released all the same.
  await agentBrowser.release(conversationId).catch(report);
  return closeIncognito(sql, conversationId, cause, { stopTask: (taskId) => worker.stopTask(taskId, 'incognito'), onError: report });
};
const live = await startLiveFeed(sql, { onError: report });

// The calls (D-066), on the voice in place: off, they are refused. Limits,
// voice and outgoing rules are read at each call (D-071).
const voiceSettings = () => settings.current().voice ?? DEFAULT_VOICE;
// The voices of macOS (D-290), read in the background now and again at most once a minute:
// the start does not wait on `say` (up to 10 s), a voice is "not installed" until the first list.
const macVoices = systemVoices();
void macVoices.refresh();
// Read at each request, like the roles: a new catalog entry needs no restart.
const candidates = () =>
  trialModels(
    loadCatalog(config.home),
    settings.current().roles,
    config.paths.data,
    fileSize,
    listClones(voiceDirs.clones).map(({ id }) => id),
    macVoices.names(),
  );
const host = config.server.host.includes(':') ? `[${config.server.host}]` : config.server.host;
const calls = createCalls({
  sql,
  voice: voice.service,
  config: () => ({
    roles: settings.current().roles,
    voice: voiceSettings(),
    local: settings.current().local,
    personas: settings.current().personas,
    // D-223: what the user rewrote of the people of the series.
    series: settings.current().series,
    // D-214: the person of the series an agent wears speaks in the calls too.
    characters: settings.current().characters,
    appearance: settings.current().appearance,
    home: config.home,
    paths: config.paths,
  }),
  candidates,
  model: localModel,
  coreUrl: `http://${host}:${String(config.server.port)}`,
  onError: report,
  // D-158: in a direct chat its agent answers the call, by the rules of its card.
  agents: () => agents,
  cloud: () => ({
    claude: adapters.claude && settings.current().cloud.executors.includes('claude'),
    codex: adapters.codex && settings.current().cloud.executors.includes('codex'),
  }),
  agentModel: (card, clearance, label) =>
    localAgentModel({ sql, settings: () => settings.current(), model: localModel, ...(claude === undefined ? {} : { claude }), ...(codex === undefined ? {} : { codex }) }, card, clearance, label),
  // D-259: the call of a routine says its counts, then its titles after a «sì», written by code.
  routineScript: (callId) => routineCallScript({ sql, home: config.home, rules }, callId),
});
callActive = () => calls.active();
const closed = await calls.closeLeftovers();
if (closed > 0) console.log(`Calls: closed ${String(closed)} left open by the previous run`);
// Before the API: with [voice] the routes never answer "voice off" at start.
await voice.begin(settings.current().voice);
await push.begin(settings.current().push);
// The settings page (D-071): it writes arianna.toml, which the watcher above
// applies as any other change. Each write goes in the event log with the
// names of the sections only, never their values.
// D-196: the safety reports are made further below; until then a change of the skills has nothing to make again.
let safetyRefresh = (): void => undefined;
const settingsPage = createSettingsPage({
  home: config.home,
  userHome: userHomeOf(),
  dataDir: config.paths.data,
  running: () => settings.current(),
  systemVoices: () => macVoices.names(),
  agentModels: () => Object.fromEntries([...agents].map(([id, agent]) => [id, agentModels(id, agent.card)])),
  // Who may read skills (D-161): never Arianna, never a card that closes untrusted_content.
  // Computed at each request, with the disabled cards too: skills are assigned before turning an agent on.
  agentSkills: () => skillRefusals(agents, userAgents.disabled()),
  // A private skill of the user's own goes only to an agent that reads it on this machine (D-255).
  skillRefusal: (agent, id) => {
    const card = agents.get(agent)?.card ?? userAgents.disabled().get(agent)?.card;
    return card === undefined ? null : ownSkillRefusal(skillsCatalog.labelOf(id), briefCeiling(card));
  },
  onChanged: (change) => {
    console.log(`arianna.toml: written from the settings page (${change.sections.join(', ')})`);
    // Applied at once: an export or a delegation right after "Salva" reads the new text, not the one of a second ago.
    settings.refresh();
    appendEvent(sql, { kind: 'settings.changed', label: 'L0', payload: { ...change } }).catch(report);
    // D-196: skills assigned or changed on an agent of the catalog: its safety report is made again.
    if (change.sections.includes('skills')) safetyRefresh();
  },
});
// Trials of a catalog model with the orchestrator evals (D-081): in the
// background, one at a time, giving way to calls and task steps. The model
// under trial is `local-large` on the endpoints of arianna.toml.
const modelEvals = createModelEvals({
  sql,
  catalog: () => loadCatalog(config.home),
  dataDir: config.paths.data,
  endpoints: () => settings.current().local.endpoints,
  assignedModels: () => Object.values(settings.current().roles),
  roleModel: (role) => settings.current().roles[role],
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
        apiKey: localKey,
      }),
      endpoints,
    ),
  onError: report,
});
// D-201: oMLX reads data/models when it starts, so a model downloaded from
// the "Modelli" page needs a restart of the servers the core started. It
// waits until no request uses a local model and no call, task step or trial
// is at work: a generation is never cut. Ids and outcomes only (L0).
const localReload = createLocalReload({
  servers: () => localServers.status(),
  restart: (id) => localServers.restart(id),
  // The queries first, the requests in flight last: the restart follows the last check at once.
  busy: async () => (await machineBusy(sql)) || (await trialRunning(sql)) || callActive() || memory.snapshot().loaded.some(({ busy }) => busy),
  onEvent: (payload) => {
    console.log(`local reload: ${payload.outcome} (${payload.models})`);
    appendEvent(sql, { kind: 'local.reload', label: 'L0', payload }).catch(report);
  },
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
  onDownloaded: (entry) => {
    if (servedByLocalServer(entry)) localReload.request(entry.id);
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
const archiveEnv = { sql, home: config.home, rules, kb, model: localModel };
const organizer = createNoteOrganizer({
  ...archiveEnv,
  // The Archivist with autonomy A1 (D-195): after a note is organized, the local model proposes where it goes; the user approves.
  archive: {
    propose: (path, signal, force) => proposeArchive(archiveEnv, path, signal, force),
    enqueue: (tx, path) => enqueueArchive(tx, path),
    waiting: () => notesToPropose(config.home, rules, MAX_RESUMED),
  },
  // The Wiki (D-280): proposals from a note and the «In breve» of the indexes, by the local model; the user approves.
  wiki: { run: (payload, signal) => runWikiJob(archiveEnv, payload, signal) },
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
// «Riassumi il video» (D-273, tappa A): one video at a time, approved by the user
// for that video, giving way to calls and task steps as the notes do. yt-dlp,
// Deno and ffmpeg are found when a job needs them; Parakeet is the model of the
// role stt, only when it is on disk.
const videoWorker = createVideoWorker({
  ...archiveEnv,
  scratch: join(voiceDirs.tmp, 'video'),
  tools: {
    runner: voiceRunner(voiceDirs),
    installed: () => existsSync(voiceDirs.python),
    deno: () => findTool('deno'),
    ffmpeg: () => findTool('ffmpeg'),
    stt: () => {
      const assigned = settings.current().roles.stt;
      const entry = assigned === undefined ? undefined : loadCatalog(config.home).models.find((model) => model.id === assigned && model.family === 'parakeet');
      return entry !== undefined && filesPresent(config.paths.data, entry) ? modelPath(config.paths.data, entry) : undefined;
    },
  },
  archive: (tx, path) => enqueueArchive(tx, path),
  wiki: (tx, path) => enqueueWikiNote(tx, path.slice(KB_DIR.length + 1)),
  modelReady: () =>
    organizeModelReady(
      settings.current().local.endpoints,
      (id) => localServers.isAvailable(id),
      (id) => localServers.isSettling(id),
    ),
  onError: report,
});
// The routines (D-110 tappa A, D-254): the report written by code in each routine's chat at its
// time, then three lines of the local model without tools, which wait for oMLX as the notes do (D-100).
// D-258: the source «Dashboard» starts «Aggiorna» of the tiles with the same agents as the page.
const routineEnv = {
  sql,
  home: config.home,
  rules,
  onError: report,
  dashboard: {
    agents: () => [...agents.keys()],
    financeAgents: () => [...agents].filter(([, agent]) => isFinanceCard(agent.card)).map(([name]) => name),
  },
};
const routines = createRoutineService(routineEnv);
const routineSummarizer = createRoutineSummarizer({
  sql,
  model: localModel,
  modelReady: () =>
    organizeModelReady(
      settings.current().local.endpoints,
      (id) => localServers.isAvailable(id),
      (id) => localServers.isSettling(id),
    ),
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
// The catalog of Open Design (D-160): styles and skills as text in data/catalogs, downloaded
// only when the user presses the button; the address of the repository passes the gateway
// (L0, web) and is all that leaves. Nothing of the clone runs.
const designCatalog = createDesignCatalog({
  dir: join(config.paths.data, 'catalogs'),
  gateway: catalogGateway('settings:design-catalog', 'github.com: catalogo di Open Design'),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
  // The news of Open Design (I-21, D-186): releases and comparison read from the public API of
  // GitHub (only the name of the repository leaves, L0 through the gateway), grouped by the local
  // model; the commits pass the gateway towards it as L0 data. Never fails the update.
  news: {
    get: createGithubClient(),
    gateway: catalogGateway('settings:design-news', 'api.github.com: novità di Open Design'),
    summarize: createLocalSummarizer({
      model: localModel,
      pass: async (data) => {
        const decision = await passGateway(sql, [{ value: data, label: 'L0', source: 'design-news:github' }], createContext('L0'), { kind: 'executor', id: 'local', locality: 'local' }, { summary: 'novità di Open Design' });
        const [text] = decision.decision === 'allow' ? decision.texts : [];
        if (text === undefined) throw new Error('the gateway did not let the news reach the local model');
        return text;
      },
    }),
  },
});
// The projects followed for ideas (D-202, after D-093): releases and comparisons read from the public
// API of GitHub only when the user presses «Controlla novità» (only the name of the repository leaves,
// L0 through the gateway); never a clone, never their code run. Grouped by the local model as D-186.
const followedProjects = createFollowedProjects({
  dir: join(config.paths.data, 'catalogs'),
  get: createGithubClient(),
  gateway: catalogGateway('settings:followed-projects', 'api.github.com: novità dei progetti seguiti'),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
  summarize: createLocalSummarizer({
    model: localModel,
    prompt: PROJECT_PROMPT,
    schemaName: 'followed_project_news',
    pass: async (data) => {
      const decision = await passGateway(sql, [{ value: data, label: 'L0', source: 'followed-projects:github' }], createContext('L0'), { kind: 'executor', id: 'local', locality: 'local' }, { summary: 'novità dei progetti seguiti' });
      const [text] = decision.decision === 'allow' ? decision.texts : [];
      if (text === undefined) throw new Error('the gateway did not let the news reach the local model');
      return text;
    },
  }),
});
// «Server dei modelli (oMLX)» (D-265): the version installed, read by running the command of the oMLX
// endpoint with --version (nothing else), and the newest release of jundot/omlx from the public API
// of GitHub once a day or on «Controlla ora» (only the name of the repository leaves, L0 through the
// gateway). Never an update: the user installs the DMG with the core stopped.
const omlxReleases = createOmlxReleases({
  dir: join(config.paths.data, 'catalogs'),
  get: createGithubClient(),
  gateway: catalogGateway('settings:omlx-release', 'api.github.com: release di oMLX'),
  endpoints: () => settings.current().local.endpoints,
  run: createVersionRunner({ cwd: config.home, env: localServerEnv(process.env) }),
  onEvent: (kind, payload) => {
    appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
  },
  summarize: createLocalSummarizer({
    model: localModel,
    prompt: OMLX_PROMPT,
    schemaName: 'omlx_release_news',
    pass: async (data) => {
      const decision = await passGateway(sql, [{ value: data, label: 'L0', source: 'omlx-release:github' }], createContext('L0'), { kind: 'executor', id: 'local', locality: 'local' }, { summary: 'novità di oMLX' });
      const [text] = decision.decision === 'allow' ? decision.texts : [];
      if (text === undefined) throw new Error('the gateway did not let the news reach the local model');
      return text;
    },
  }),
});
omlxReleases.start();
// The examples of the styles and the Italian descriptions of the skills (I-20, D-185): public text, written by Sonnet
// without tools through the gateway, only when the user asks; kept in data/catalogs and never made again for the same text.
const askCloudText = createCloudText({ sql, claude, data: config.paths.data });
const catalogEvent = (kind: string, payload: Record<string, string | number>): void => {
  appendEvent(sql, { kind, label: 'L0', payload }).catch(report);
};
const styleExamples = createStyleExamples({
  dir: join(config.paths.data, 'catalogs'),
  source: { list: () => designCatalog.list(), styleText: (slug) => designCatalog.styleText(slug) },
  ask: askCloudText,
  onEvent: catalogEvent,
});
// Public descriptions only (L0): the user's own skills of Claude Code are never sent to translate (D-255).
const skillTranslations = createSkillTranslations({ dir: join(config.paths.data, 'catalogs'), list: () => skillsCatalog.list().skills.filter(isPublicSkill), ask: askCloudText, onEvent: catalogEvent });
// The real lines of the people of the series (D-224): Sonnet, from the name of the character and of the series alone
// (L0), a hundred at a time on the user's click; the core draws a few for each answer of an agent that wears one.
const seriesLines = createSeriesLines({ dir: join(config.paths.data, 'characters'), ask: askCloudText, onEvent: catalogEvent, wikiquote: createWikiquoteClient() });
configureSeriesLines(seriesLines);
// The descriptions of the roles of the catalog of agents in Italian (request of the user of 2026-10-13), as the skills:
// Sonnet, public text (L0), a batch at a time, once per description; the name of a role stays as it is.
const roleTranslations = createSkillTranslations({
  dir: join(config.paths.data, 'catalogs'),
  list: () => agentsCatalog.list().roles,
  // As the safety reports: nothing leaves while Claude is off in the settings, even before a restart.
  ask: (request) => {
    if (!settings.current().cloud.executors.includes('claude')) return Promise.reject(new CloudTextError('unavailable', 'Claude non è abilitato in Impostazioni'));
    return askCloudText(request);
  },
  onEvent: catalogEvent,
  kind: 'roles',
});
// The safety reports of the catalog (D-196): Opus reads a role or a skill once per version (public text, L0,
// never a datum of the user) through the gateway, in the background, one at a time; an agent's report is made
// of the reports of its role and its skills (choice of the user, 2026-10-13).
const safetyReports = createSafetyReports({
  dir: join(config.paths.data, 'agents'),
  ask: (request) => {
    if (!settings.current().cloud.executors.includes('claude')) return Promise.reject(new CloudTextError('unavailable', 'Claude non è abilitato in Impostazioni'));
    return askCloudText(request);
  },
  subject: (name) => {
    const role = userAgents.catalogRole(name);
    if (role === undefined) return undefined;
    const all = settings.current().agents;
    const ids = Object.hasOwn(all, name) ? (all[name]?.skills ?? []) : [];
    const skills = ids.flatMap((id) => {
      try {
        const skill = skillsCatalog.text(id);
        // A report is for third-party text: the user's own skills are never sent to Opus for one (D-255).
        if (!isPublicSkill(skill)) return [];
        const text = skillSafetyText(skill);
        return [{ id, name: text.name, text: text.text }];
      } catch {
        // A skill no longer in the catalog reaches nobody: nothing to read.
        return [];
      }
    });
    return { role, skills };
  },
  names: () => userAgents.list().user.filter((agent) => agent.catalog !== undefined).map((agent) => agent.name),
  onEvent: catalogEvent,
  onError: report,
});
safetyRefresh = () => {
  safetyReports.refresh();
};
/**
 * After a version of a source is adopted (D-196): the roles that changed and from which an agent was made are
 * read again by Opus, only in the lines that changed; never the whole catalog.
 */
function safetyAfterAdopt(): void {
  // Never a failure of the adoption, which is done: a card that cannot be read only goes in the log.
  try {
    for (const agent of userAgents.list().user) {
      if (agent.catalog?.state !== 'update') continue;
      try {
        const before = userAgents.catalogRole(agent.name);
        if (before !== undefined) safetyReports.changed(roleSafetyText(agentsCatalog.role(agent.catalog.id)), { text: before.text });
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }
}
const agentsCatalogApi: typeof agentsCatalog = {
  ...agentsCatalog,
  adopt: (source, commit) => {
    const status = agentsCatalog.adopt(source, commit);
    safetyAfterAdopt();
    return status;
  },
};
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
// "Scrivi il report" of an IM (D-167, P4c): Arianna on the local model or Claude
// through the gateway, as the user picks each time; the input is built by code.
const imReports = createImReporter({
  projects: projectContainers,
  env: { home: config.home, rules },
  gateway: (payload, context, target, meta) => passGateway(sql, payload, context, target, meta),
  claude,
  localModel,
  unavailable: (agent) => reportUnavailable(settings.current(), agent, claude !== undefined),
  claudeModel: () => reportClaudeModel(settings.current()),
  dataDir: config.paths.data,
  onError: report,
});
// D-111d: who the user may talk with directly, from the cards, with Claude on or off as now.
const directAgents = (): DirectPolicy[] =>
  directPolicies(agents, {
    claude: adapters.claude && settings.current().cloud.executors.includes('claude'),
    codex: adapters.codex && settings.current().cloud.executors.includes('codex'),
  });
// GOD (D-127, G2-G3): the plans approved become subtasks, each in a clone of
// its own with the direct chats of the Coder and the Reviewer; a tick moves
// them on and starts the next ones within the quota.
const prepareGod = prepareGodClone({ home: config.home });
const godWork = createGodWork({
  sql,
  home: config.home,
  data: config.paths.data,
  parts: () => approvedProjects().map((project) => project.name),
  projects: () => settings.current().projects,
  policy: (agent) => directAgents().find((policy) => policy.agent === agent),
  models: () => selectableModels(settings.current(), adapters).map((entry) => entry.model),
  stopTask: (taskId) => worker.stopTask(taskId, 'god'),
  prepareClone: prepareGod,
  onError: report,
});
// «Prova», «Approva funzionalità», «Non funziona» (D-179): GOD's work in the installation, then a restart on it.
const godLanding = createGodLanding({
  home: config.home,
  data: config.paths.data,
  work: godWork,
  git: godGit(config.home, config.paths.data),
  development: () => app.development,
  restart: restartCore,
  onError: report,
});
/**
 * A new core on the code now in the installation: this one stops in order
 * (port, worker, services) and starts the new one, detached, as its last step
 * (its log in data/logs/core.log); the new one waits for this pid to be gone.
 */
let restartAsked = false;
function restartCore(): void {
  restartAsked = true;
  process.kill(process.pid, 'SIGTERM');
}
function spawnSuccessor(): void {
  const logs = join(config.paths.data, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = openSync(join(logs, 'core.log'), 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    cwd: process.cwd(),
    env: { ...process.env, ARIANNA_RESTART_AFTER: String(process.pid) },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
}
// A trial of GOD left half-made by a core stopped in the middle goes back to main.
await godLanding.recover().then(
  (recovered) => {
    if (recovered) console.error('GOD: a trial left half-made was undone, the installation is back on main');
  },
  (error: unknown) => {
    report(error);
  },
);
// The character packs (D-060, D-211): the two in the repository and the user's in data/.
const characterDirs = characterDirsOf(config.home, config.paths.data);
// D-217: the names of the people of the series worn now are no persons for the second scanner, whole.
configureWornNames(() => wornSeriesNames({ ...settings.current(), home: config.home, paths: config.paths }));
configureTailAgents(() => ({ official: [...agents.keys()], user: userAgents.list().user.map((agent) => agent.name) }));
// «Cosa è cambiato» (D-233): a picture of the installation, only ids, versions and states, compared
// with the last one in data/changes/state.json; what differs goes in the event log. Taken at start,
// after a change of arianna.toml, every 10 minutes and when the page is opened. An area that cannot
// be read keeps its last value. The Codex binary tells no version: only Claude's is observed.
const installChanges = createChangeWatcher({
  sql,
  file: stateFile(config.paths.data),
  onError: report,
  read: () =>
    readAreas(
      {
        arianna: () => {
          const version = packageVersion(config.home);
          if (version === undefined) throw new Error('package.json: no version');
          return { arianna: version };
        },
        role: () => Object.fromEntries(Object.entries(settings.current().roles)),
        model: async () => {
          const catalog = loadCatalog(config.home);
          return modelsArea(catalog.models, await modelStatus(catalog.models, config.paths.data));
        },
        executor: () => Object.fromEntries(settings.current().cloud.executors.map((executor) => [executor, 'on'])),
        'cloud-model': () => cloudModelAreas(settings.current().cloud.models).on,
        'cloud-name': () => cloudModelAreas(settings.current().cloud.models).names,
        binary: async () => {
          const version = await lastBinaryVersion(sql, 'claude');
          return version === undefined ? {} : { claude: version };
        },
        skills: () => sourcesArea(skillsCatalog.status().sources.filter((source) => !source.readOnly)),
        design: () => ({ [OPEN_DESIGN_SOURCE]: shortCommit(designCatalog.status().adopted?.commit) }),
        'agents-catalog': () => sourcesArea(agentsCatalog.status().sources),
        agent: () => Object.fromEntries(userAgents.list().user.map((agent) => [agent.name, agent.state])),
        project: () => Object.fromEntries(settings.current().projects.map((project) => [project.name, project.label])),
        theme: () => ({ theme: settings.current().appearance.theme, seasonal: settings.current().appearance.seasonal ? 'on' : 'off' }),
        character: () => settings.current().characters,
      },
      (area, error) => {
        console.error(`Cosa è cambiato: ${area} not read, its last picture stays`);
        report(error);
      },
    ),
});
let changesTimer: NodeJS.Timeout | undefined;
changesSoon = () => {
  if (changesTimer !== undefined || stopping) return;
  changesTimer = setTimeout(() => {
    changesTimer = undefined;
    if (!stopping) void installChanges.check();
  }, 3_000);
  changesTimer.unref();
};
void installChanges.check();
const changesTicker = setInterval(() => {
  if (!stopping) void installChanges.check();
}, 10 * 60_000);
changesTicker.unref();
// The remote port (D-292): with tls = "own" only with a valid certificate of
// pnpm remote:cert; without it the port stays closed and the core goes on.
const remoteListener = ((): { host: string; port: number; tls?: { cert: string; key: string } } | undefined => {
  const remote = config.server.remote;
  if (remote === undefined) return undefined;
  if (remote.tls === 'tailscale') return { host: remote.host, port: remote.port };
  const tls = loadRemoteTls(remotePaths(config.paths.data), remote.host, new Date());
  if (!tls.ok) {
    console.error(`Porta remota chiusa: ${tls.problem}.`);
    return undefined;
  }
  if (tls.daysLeft <= WARN_DAYS) console.error(`Il certificato della porta remota scade fra ${String(tls.daysLeft)} giorni: lancia pnpm remote:cert.`);
  return { host: remote.host, port: remote.port, tls: { cert: tls.cert, key: tls.key } };
})();
const server = await startApiServer({
  sql,
  live,
  changes: installChanges,
  host: config.server.host,
  port: config.server.port,
  // The phone (D-292): a second port on 127.0.0.1 behind tailscale serve; the API only with the session of a paired device (stage B).
  ...(remoteListener === undefined ? {} : { remote: remoteListener }),
  // Pairing, passkeys and sessions of the phone (D-292, stage B); Impostazioni → Dispositivi works with the remote port closed too.
  ...(config.server.remote === undefined ? {} : { remoteDevices: createRemoteDevices({ store: createDeviceStore(sql), host: config.server.remote.host }) }),
  onRemoteError: (error) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'errore';
    console.error(`Porta remota chiusa: non si apre su 127.0.0.1:${String(config.server.remote?.port)} (${code}); il core continua senza.`);
  },
  // The approved projects: listed for a new conversation, and where the preview of a changed file is read (D-082).
  projects: approvedProjects,
  approvedProjects,
  projectContainers,
  // The tab "Conoscenza" (D-145): kb/progetti of this ARIANNA_HOME for the projects that are one git.
  knowledge: { home: config.home, rules },
  // "Proponi bozza" (I-14 R2, D-175): the local model drafts the rules of a container; nothing is saved here.
  rulesDraft: async (name) => {
    const project = projectContainers().find((item) => item.name === name);
    return project === undefined ? undefined : draftProjectRules({ sql, model: localModel }, project, settings.current().projectRules);
  },
  // «Fissa alla Dashboard» (D-248): the local model rewrites the question of the tile; the user checks it.
  dashboardSuggest: (messageId) => suggestQuestion({ sql, model: localModel }, messageId),
  // A chart tile (D-248): the answer in checked data, from the local model.
  dashboardChart: (input) => chartOf({ sql, model: localModel }, input),
  // "Fai uscire una volta" of a Private note (I-11 P5, D-187): the hash of the master password is read from the vault at each try.
  noteRelease: createNoteReleaser({
    sql,
    model: localModel,
    projects: projectContainers,
    knowledge: { home: config.home, rules },
    checkPassword: async (password) => {
      let hash: string;
      try {
        hash = (await createVault({ data: config.paths.data }).resolve(MASTER_PASSWORD_REF)).reveal();
      } catch (error) {
        // No vault, no key in it, or a vault the age key cannot open: as if no password were set.
        if (error instanceof VaultError && ['no-vault', 'decrypt-failed', 'empty', 'sops-missing'].includes(error.code)) return 'unset';
        throw error;
      }
      try {
        return (await verifyMasterPassword(hash, password)) ? 'ok' : 'wrong';
      } catch (error) {
        // Something else than the line of pnpm vault:master under the key: set it again.
        if (error instanceof RangeError) return 'unset';
        throw error;
      }
    },
  }),
  // "Esporta in CLAUDE.md e AGENTS.md" (I-14 R3, D-176): the saved rules, in the parts of the container, on request.
  rulesExport: {
    plan: (name) => {
      const project = projectContainers().find((item) => item.name === name);
      return project === undefined ? null : (planRulesExport({ home: config.home }, project, settings.current().projectRules) ?? null);
    },
    write: (name, seen) => {
      const project = projectContainers().find((item) => item.name === name);
      return project === undefined ? NO_RULES : writeRulesExport({ home: config.home }, project, settings.current().projectRules, seen);
    },
  },
  // The files attached to cards (D-152): private copies, outside git.
  cards: { dir: join(config.home, 'data', 'cards') },
  // The logos of the clients (D-168): private copies, outside git, shown only in the web chat.
  clients: { dir: join(config.home, 'data', 'clients') },
  // Images and files of a private chat (D-247): an image only while a model has the vision role.
  attachments: { dir: attachmentFiles, vision: () => settings.current().roles.vision !== undefined },
  services,
  designCatalog,
  skillsCatalog,
  routines,
  agentsCatalog: agentsCatalogApi,
  styleExamples,
  skillTranslations,
  seriesLines,
  // Without the adapter no delegation runs: the selector offers nothing.
  models: () => selectableModels(settings.current(), adapters),
  // D-116: the model chosen for the agent the conversation is with; without one, the work agent's for Arianna.
  defaultModel: (agent) => agentDefaultModel(settings.current(), agent ?? WORK_AGENT, agents.get(agent ?? WORK_AGENT)?.card, adapters),
  agents: () => [...agents.keys()],
  financeAgents: () => [...agents].filter(([, agent]) => isFinanceCard(agent.card)).map(([name]) => name),
  // The participant bar (D-125): where an agent runs, and how its name is labelled in the chat.
  // I-8 (D-130): an agent idle for [participants] leave_after messages of the user leaves by itself.
  leaveRule,
  // «@name» and «/giro» (D-107, tappa B2): the agents Arianna may delegate to.
  mentionable: () => mentionableAgents(agents),
  // D-299: the agents «@name» cannot call, with the reason the refusal says (turned off, only in their chat, no executor).
  unmentionable: () => mentionBlocks(agents, userAgents.disabled()),
  // D-235: who may do a card of a plan the user edits, as the planner chooses them.
  planAssignees: () => orchestrator.planAssignees(),
  // D-142: "Prova in chat" opens only for a model of the catalog that writes text, with its files on the disk.
  trialRefusal: (modelId) => trialRefusal(loadCatalog(config.home), modelId, config.paths.data, fileSize),
  // D-111d: who the user may talk with directly, from the cards, with Claude on or off as now.
  directAgents,
  // D-111, tappa B: who of «Con chi parli» cannot answer now (ChatGPT without a project), and the folder of a plain chat with Claude.
  // D-225, tappa B: the people of the series Claude may play, those the pack `serie` serves now.
  chatCharacters: () => chatCharacters((pack, character) => servedRowsSync(characterDirs, pack, character)),
  offInterlocutors: () => offInterlocutors({ claude: adapters.claude && settings.current().cloud.executors.includes('claude'), codex: adapters.codex && settings.current().cloud.executors.includes('codex') }),
  chatFolderGone: (conversationId) => removeConversationWorkspace({ data: config.paths.data, conversationId }).catch(report),
  // GOD (D-127): the clone of Arianna's code and GOD's conversations.
  god: createGodApi({
    sql,
    home: config.home,
    data: config.paths.data,
    projects: () => settings.current().projects,
    available: () => directAgents().some((policy) => policy.agent === GOD_AGENT),
    prepare: prepareGod,
    work: godWork,
    landing: godLanding,
    boot: `${String(process.pid)}-${String(Date.now())}`,
  }),
  participantAgent: (name) => {
    const agent = agents.get(name);
    return agent === undefined ? undefined : { executor: delegationRoute(agent.card) ?? agent.card.executors[0] ?? null, nameLabel: nameLabelOf(agent) };
  },
  characters: {
    dirs: characterDirs,
    choices: () => settings.current().characters,
    // D-214: the name the user wrote for an agent wins over its character's in the chat too.
    names: () =>
      Object.fromEntries(
        Object.entries(settings.current().personas).flatMap(([agent, persona]) => (persona.displayName === undefined ? [] : [[agent, persona.displayName]])),
      ),
    themes: {
      dir: join(config.home, 'apps', 'hud', 'themes'),
      chosen: () => settings.current().appearance.theme,
      // D-246: the feasts in place of Base; ARIANNA_TODAY=YYYY-MM-DD shows one out of season in development.
      feasts: () => ({ on: settings.current().appearance.seasonal, today: themeDay(process.env, new Date()) }),
    },
    // D-223: what the user rewrote of the people of the series, for their card in the settings.
    series: () => settings.current().series,
    lines: seriesLines,
    downloadPixelAgents: () =>
      downloadPixelAgents({
        dirs: characterDirs,
        get: createGithubClient(),
        gateway: catalogGateway('settings:pixel-agents', 'api.github.com: personaggi di pixel-agents'),
      }),
  },
  voice: { service: voice.service, voice: () => voiceSettings().voice, models: candidates, clones: voiceDirs.clones },
  calls,
  pusher: () => push.pusher(),
  notices,
  settings: settingsPage,
  userAgents,
  safetyReports,
  roleTranslations,
  sprites,
  imReports,
  local: {
    status: () => localServers.status(),
    // "Riavvia oMLX" serves the downloads waiting for a restart (D-201): no second restart after it.
    restart: (id) => {
      localReload.restartedByUser();
      return localServers.restart(id);
    },
    log: (id) => logTail(config.paths.data, id),
    memory: () => memory.snapshot(),
  },
  capture: { home: config.home, rules, organize: (path) => organizer.enqueue(path), fetch: (path) => organizer.enqueueFetch(path), archive: (path) => enqueueArchive(sql, path, true), video: (path) => videoWorker.enqueue(path), videoState: (path) => videoWorker.state(path), wiki: { propose: (page, force) => enqueueWikiNote(sql, page, force), index: (folder) => enqueueWikiIndex(sql, folder) }, arianna: ariannaDocs },
  modelEvals,
  advisorData: config.paths.data,
  // The "Modelli" page (I-3): catalogs read at each request, with the adapters that run here (D-140).
  modelsOverview: () =>
    loadModelsOverview(sql, {
      home: config.home,
      dataDir: config.paths.data,
      config: () => settings.current(),
      memory: () => memory.snapshot(),
      adapters: () => adapters,
      actions: modelActions,
      reload: () => localReload.view(),
      systemVoices: () => macVoices.names(),
    }),
  modelActions,
  modelReload: localReload,
  huggingface,
  omlxReleases,
  // "Sviluppo di Arianna" (D-102): docs/ read, answers through the gateway into data/dev/RISPOSTE.md.
  devProgress: { home: config.home, news: () => designCatalog.news(), projects: followedProjects },
  // "Novità": CHANGELOG.md at the root of the home, read only.
  changelog: { home: config.home },
  // Development or production (D-089): the passwords the core logged in with, or [installation] mode.
  installation: () => installationInfo(config.home, app.development, settings.current().installation?.mode),
  // «Pronta per i dati veri» (D-192): the checks the core can run, on «Controlla» only; the owner's from data/doctor/last.json.
  readiness: createReadiness({ config: () => settings.current(), sql, app }),
  ...(existsSync(dist) ? { staticDir: dist } : {}),
  // "Elimina" (D-157): the steps of the worker stop first, as for an incognito.
  // "Ferma" in the chat (D-218): the steps of the worker stop as for GOD's, and the queue pauses.
  stopChat: (conversationId) => stopConversation(sql, conversationId, { stopTask: (taskId) => worker.stopTask(taskId, 'user') }),
  // D-235: "Ferma" of a card, as "Ferma" in the chat.
  stopCard: (cardId) => stopCard(sql, cardId, { stopTask: (taskId) => worker.stopTask(taskId, 'user') }),
  // Its browser goes first (D-264): the pages of an erased conversation do not stay open.
  erase: async (conversationId) => {
    await agentBrowser.release(conversationId).catch(report);
    try {
      return await eraseConversation(sql, conversationId, { stopTask: (taskId) => worker.stopTask(taskId, 'erase'), dataDir: config.paths.data, onError: report });
    } finally {
      // Again once its step is stopped: one that opened a browser in between does not keep it.
      await agentBrowser.release(conversationId).catch(report);
    }
  },
  incognito: { close: endIncognito, localCache: () => localCacheOn(settings.current().local.endpoints) },
  browserScreens,
  onError: report,
});
for (const one of workers) await one.start();
// D-218: the messages written while an answer was at work leave when it ends, one at a time.
const queueDispatcher = createQueueDispatcher({ sql, send: () => ({ leave: leaveRule(), mentionable: mentionableAgents(agents), unmentionable: () => mentionBlocks(agents, userAgents.disabled()) }), onError: report });
queueDispatcher.start();
// D-248: every 3 s the refreshes of the Dashboard that ended are copied in their tiles, and their conversations purged.
let settling = false;
const dashboardTicker = setInterval(() => {
  if (settling) return;
  settling = true;
  settleDashboard(sql, {
    stop: (conversationId) => stopConversation(sql, conversationId, { stopTask: (taskId) => worker.stopTask(taskId, 'user') }),
    chart: (input) => chartOf({ sql, model: localModel }, input),
    onError: report,
  })
    .catch(report)
    .finally(() => {
      settling = false;
    });
}, 3_000);
dashboardTicker.unref();
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
// Notes approved before D-198 in the folders of kb/ that git tracks: moved to kb/archivio, out of git.
try {
  const relocated = relocateArchived(config.home, rules);
  // Only when a note moved: one that cannot move would otherwise add an event at every start.
  if (relocated.moved > 0) {
    await recordRelocated(sql, relocated);
    console.log(`Notes: ${String(relocated.moved)} moved to kb/archivio`);
  }
} catch (error) {
  report(error);
}
// New notes left by pnpm kb:capture or by a previous run: queued again, at most MAX_RESUMED.
const { resumed } = await organizer.start();
if (resumed > 0) console.log(`Notes: ${String(resumed)} queued to be organized`);
await videoWorker.start();
await routineSummarizer.start();

// The calls Arianna makes (D-066): checked every 30 s under [voice.outgoing];
// with the voice off nothing rings.
const ringer = createRinger({
  sql,
  rules: () => voiceSettings().outgoing,
  voiceUp: () => voice.service.state === 'up',
  hold: (work) => voice.service.hold(work),
  // D-158: a call of a direct chat whose agent cannot answer now is skipped, not rung.
  check: (conversationId) => calls.check(conversationId, { answer: true }),
  // Read at each ring: [push] changes without a restart.
  notify: () => {
    const pusher = push.pusher();
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
  // A refresh of the Dashboard (D-248) says nothing either: its answer shows in the tile.
  incognito: async (conversationId) => (await isIncognitoConversation(sql, conversationId)) || (await isRefreshConversation(sql, conversationId)),
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
    const pusher = push.pusher();
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
// The morning of the day before an IM also names it (D-167, P4c).
const secretaryTicker = createSecretaryTicker({ sql, settings: () => settings.current().secretary, ims: { projects: projectContainers, env: { home: config.home, rules } }, onError: report });
secretaryTicker.start();

// The routines (D-110 tappa A, D-254): every 30 seconds the ones whose time has come; after the
// Mac slept or the core was off, within two hours the report says sorry for the delay, beyond it
// one line says the run was missed. Started after the notifier, as the secretary's.
const routineTicker = createRoutineTicker({ ...routineEnv, onError: report });
routineTicker.start();

// The IM between meetings (D-167, P4b): the closing asked in the secretary
// conversation once the meeting is over, and the items of a card in "Fatto".
// The subtasks of GOD move on every 15 seconds (D-127).
const godTicker = setInterval(() => {
  godWork.tick().catch(report);
}, 15_000);
godTicker.unref();

const imWatcher = createImWatcher({ sql, projects: projectContainers, env: { home: config.home, rules }, onError: report });
imWatcher.start();

// Telegram (task 1.15, D-044): on only with [telegram] in arianna.toml, opened
// or closed when the section changes (D-071). Without a token the core runs
// anyway: the web chat does not depend on it. Off by the user's choice (D-110,
// question 12): the section is ignored until TELEGRAM_ON comes back.
await telegram.begin(telegramSection());

console.log(`Arianna core on http://${host}:${String(server.port)}${existsSync(dist) ? '' : ' (API only: run pnpm hud:build for the web chat)'}`);
if (server.remotePort !== undefined && config.server.remote !== undefined) {
  const ends = config.server.remote.tls === 'own' ? 'TLS ended by the core' : 'TLS ended by Tailscale';
  console.log(`Remote port on 127.0.0.1:${String(server.remotePort)} for https://${config.server.remote.host}, ${ends} (D-292: API with the session of a paired device)`);
}
// D-246: a day forced for the feasts is said at the start, so a value left in the environment is not missed.
if (process.env.ARIANNA_TODAY !== undefined) {
  const forced = themeDay(process.env, new Date());
  console.log(`Themes see the day ${String(forced.year)}-${String(forced.month).padStart(2, '0')}-${String(forced.day).padStart(2, '0')} (ARIANNA_TODAY)`);
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // The processes started from "Progetti" stop with the core (D-134 g); compose services stay with Docker.
  await services.stopAll();
  settings.close();
  secretaryTicker.stop();
  routineTicker.stop();
  omlxReleases.stop();
  imWatcher.stop();
  clearInterval(godTicker);
  clearInterval(changesTicker);
  clearInterval(gatewayTextsTicker);
  if (changesTimer !== undefined) clearTimeout(changesTimer);
  incognitoWatch.stop();
  clearInterval(dashboardTicker);
  queueDispatcher.stop();
  stopNotices();
  await telegram.close();
  // Before the server: an upgraded socket of a screen is no connection the server still closes.
  browserScreens.close();
  await server.close();
  await mcpServer.close();
  ringer.stop();
  await calls.close();
  await voice.close();
  await push.close();
  await stopPiiGuard();
  await modelEvals.stop();
  await modelActions.stop();
  localReload.stop();
  await organizer.stop();
  await videoWorker.stop();
  await routineSummarizer.stop();
  await Promise.all(workers.map((one) => one.stop()));
  await agentBrowser.close();
  memory.stop();
  await localServers.stop();
  await live.close();
  await sql.end({ timeout: 5 });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown().then(
      () => {
        if (restartAsked) spawnSuccessor();
        process.exit(0);
      },
      (error: unknown) => {
        report(error);
        process.exit(1);
      },
    );
  });
}
