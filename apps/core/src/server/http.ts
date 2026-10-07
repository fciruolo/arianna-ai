import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type { NewUserAgent } from '@arianna/agents';
import type { CharacterChoices, Project } from '@arianna/config';
import { createContext, isLabel, maxLabel, type Label, type LabelRules } from '@arianna/policy';

import { countConversationActivities, listTaskActivities } from '../activities.ts';
import { loadChangelog } from '../changelog.ts';
import { CaptureError, captureNote, isCaptureKind, MAX_CAPTURE_BYTES } from '../capture.ts';
import { findConversationNote, saveConversation, type SavedLine } from '../saved-conversations.ts';
import { listApprovals, loadApproval, type ApprovalState } from '../approvals.ts';
import { assignCharacters, listPacks, MAX_UPLOAD_BODY, parseUpload, readSheet, UploadError, uploadSheet, type CharacterDirs } from '../characters.ts';
import {
  archiveConversation,
  ChatError,
  createConversation,
  DIRECT_MODELS,
  isUuid,
  listConversations,
  listMessages,
  loadConversation,
  loadMessage,
  pinConversation,
  postUserMessage,
  purgeConversation,
  renameConversation,
  setConversationModel,
} from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import {
  createOpenLinks,
  DelegationFileError,
  listCredits,
  listRecentDelegations,
  openDelegationFile,
  openHeaders,
  readDelegationDiff,
  readDelegationFile,
  readOpenFile,
  type OpenLinks,
} from '../delegation-view.ts';
import { browsableProjects, hiddenConsents, hiddenShown, listProjectDir, notBusy, openBrowsedFile, readBrowsedFile, readCommitDiff, readProjectGit, revealBrowsedFile, serviceStates, setHiddenShown } from '../project-browser.ts';
import { pickService, ServiceError, type ServiceManager } from '../project-services.ts';
import { DevAnswerError, loadProgress, MAX_ANSWER_CHARS, pendingQuestions, recordAnswer, saveAnswer, type AnswerGate, type OpenQuestion } from '../dev-progress.ts';
import { passGateway } from '../gateway.ts';
import { recordDecision, retryTask } from '../engine.ts';
import { loadFailure } from '../failures.ts';
import { SpriteError, type SpriteGenerator } from '../sprites/generate.ts';
import { UserAgentError, type ConfirmedNewUserAgent, type UserAgents } from '../user-agents.ts';
import type { LiveFeed, LiveMessage } from '../live.ts';
import type { LocalServerStatus } from '../local-servers.ts';
import { ModelEvalError, type ModelEvals } from '../model-evals.ts';
import type { MemorySnapshot } from '../model-memory.ts';
import { buildKnowledgeGraph, readKnowledgePage, type GraphCache } from '../knowledge.ts';
import { isNoteStatus, listNotes, NoteError, readNote } from '../notes.ts';
import { SettingsError, type SettingsPage } from '../settings-page.ts';
import type { InstallationInfo } from '../installation.ts';
import { AlreadySavedError, captureMessage, savedMessageNotes } from '../saved-messages.ts';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchAll, SearchError } from '../search.ts';
import type { DirectPolicy } from '../direct-chat.ts';
import { activeParticipants, removeParticipant, type LeaveRule } from '../participants.ts';
import { closeIncognito, incognitoClosedCause, isIncognitoConversation, isIncognitoTask, type IncognitoCause, type IncognitoReceipt } from '../incognito.ts';
import { loadStatus } from '../status.ts';
import { attachQuestion, openFailureChat } from '../system-chats.ts';
import { loadTask, TaskError } from '../tasks.ts';
import { dismissWaitingTask, listWaitingTasks } from '../waiting.ts';
import { CallError, listCalls, liveCall, type CallEndReason, type Calls } from '../voice/calls.ts';
import type { Notice, NoticeBoard, NoticeKind } from '../notifications.ts';
import { isPushEndpoint, parseSubscription, PushError, type Pusher } from '../voice/push.ts';
import { callWhenDone, cancelCall, scheduleCall, ScheduleError } from '../voice/ringer.ts';
import { VoiceError, type VoiceService, type VoiceState } from '../voice/service.ts';
import { CloneError, deleteClone, listClones, MAX_CLONE_BODY, parseClone, saveClone } from '../voice/clones.ts';
import { MAX_TRANSCRIBE_BODY, speakCall, transcribeCall, TrialError, type TrialModel } from '../voice/trial.ts';
import { allowedHosts, checkRequest, securityHeaders } from './security.ts';

/**
 * API, WebSocket and web chat of the core (task 1.11, D-039). `node:http`
 * without a framework; loopback only (config), same-origin only (security.ts).
 * Every action goes through HTTP; the WebSocket only pushes events and reply
 * fragments.
 */
/** What the chat sees of an approved project: the path as written, never resolved. */
export interface ProjectInfo {
  name: string;
  path: string;
  label: string;
}

export interface ApiServerOptions {
  sql: Sql;
  live: LiveFeed;
  host: string;
  port: number;
  /**
   * The projects the user approved (`[[project]]` of arianna.toml, D-058), read
   * at each request: the only ones a work conversation may name.
   */
  projects?: () => readonly ProjectInfo[];
  /** The cloud models a work conversation may choose (task 1.10), from the current configuration. */
  models?: () => readonly { executor: string; model: string }[];
  /** The model a new work conversation starts with (`[cloud.models] default`, D-071); undefined lets the router choose. */
  defaultModel?: () => string | undefined;
  /** The ids of the agents (agents/*.yaml): the status panel and the characters list them. */
  agents?: () => readonly string[];
  /** The pixel characters (D-060): pack folders and the user's choices, read at each request. */
  characters?: { dirs: CharacterDirs; choices: () => CharacterChoices };
  /** apps/voice (D-066); its state is `off` while `[voice]` is not configured (D-071). */
  voice?: VoiceApi;
  /** Calls from the chat (D-066); refused while the voice is off. */
  calls?: Calls;
  /** Web Push for the calls of Arianna (D-066), read at each request: undefined without [voice.push]. */
  pusher?: () => Pusher | undefined;
  /** The last notice pushed (I-1), which the service worker asks for: kind and conversation only. */
  notices?: NoticeBoard;
  /** The settings page (D-071): arianna.toml read and written with its fingerprint. */
  settings?: SettingsPage;
  /** The local servers the core watches (D-071): state, restart, end of the log. */
  local?: LocalApi;
  /**
   * Capture into kb/inbox (D-080): the home whose kb/ receives the notes, and
   * the folder rules; the notes of kb/inbox are read with the same (D-086).
   * `organize` queues the organizing of a note by the local model; without it
   * notes are saved and read, not organized.
   */
  capture?: { home: string; rules: LabelRules; organize?: (path: string) => Promise<boolean> };
  /** Trials of catalog models with the orchestrator evals (D-081). */
  modelEvals?: Pick<ModelEvals, 'request' | 'list' | 'get' | 'cancel'>;
  /** What this installation is (D-089), read at each request: mode, folder name, commit. */
  installation?: () => InstallationInfo;
  /**
   * The approved projects with their folders (D-058), read at each request:
   * where the preview of a file changed by the Coder is read (D-082).
   */
  approvedProjects?: () => readonly Project[];
  /** The tab Servizi of "Progetti" (D-134, tappa 2); without it the routes answer 404. */
  services?: ServiceManager;
  /** "Sviluppo di Arianna" (D-102): the home whose docs/ are read, and the event of an answer saved. */
  devProgress?: DevProgressApi;
  /** "Novità": the home whose CHANGELOG.md is read, read only; without it the route answers 404. */
  changelog?: { home: string };
  /** The agents the user creates from the Agents page (D-119); without it the routes answer 404. */
  userAgents?: UserAgents;
  /**
   * What the participant bar shows of an active agent (D-125): where it runs and the
   * label of its name in the lines of the chat; undefined for an agent no
   * longer active. Without it every agent reads as gone (executor null, L1).
   */
  participantAgent?: (agent: string) => { executor: string | null; nameLabel: Label } | undefined;
  /** Who the user may talk with in place of Arianna (D-111d); undefined, nobody. */
  directAgents?: () => readonly DirectPolicy[];
  /** When an idle agent leaves a conversation (I-8, D-130), read at each message; undefined, none leaves. */
  leaveRule?: () => LeaveRule | undefined;
  /** "Genera personaggio" (D-123); without it the routes answer 404. */
  sprites?: SpriteGenerator;
  /**
   * Closes an incognito conversation (D-136) stopping its work in progress;
   * without it the route closes it without stopping a step of the worker.
   */
  incognito?: {
    close: (conversationId: string, cause: IncognitoCause) => Promise<IncognitoReceipt>;
    /** A local server keeps a cache of the prompts on the SSD (`--paged-ssd-cache-dir`, D-136): the opening card names it. Read at each request. */
    localCache?: () => boolean;
  };
  /** Built web chat (`apps/hud/dist`); without it only the API is served. */
  staticDir?: string;
  /** Errors are reported here, never sent to the client: they may hold data. */
  onError?: (error: unknown) => void;
}

/** What the routes need of the voice: the service and the trial candidates, read at each request. */
export interface VoiceApi {
  service: Pick<VoiceService, 'state' | 'request'>;
  models: () => TrialModel[];
  /** The voice of `[voice]`, read at each request. */
  voice: () => string;
  /** Where the voices copied from a sample live (D-069): data/voice/voices. */
  clones: string;
}

export interface LocalApi {
  status(): LocalServerStatus[];
  /** Resolves once the server has settled, which may take minutes: the route does not wait. */
  restart(id: string): Promise<boolean>;
  /** The end of data/<id>.log: may hold prompts (L2), shown only in the web chat. */
  log(id: string): string;
  /** The account of the local models and the swap level (D-107, stage E): catalog ids and numbers, L0. */
  memory?(): MemorySnapshot;
}

export interface ApiServer {
  /** The bound port, useful with port 0 in tests. */
  readonly port: number;
  /** Pages holding the live feed now: with none, a call of Arianna rings by Web Push (D-066). */
  clients(): number;
  /** Pages that said they are in view (I-1): with none, a notice goes by Web Push. */
  visiblePages(): number;
  /** Pages in view and in front with this conversation open (D-128): with none, the helper of the Mac shows the notice. */
  readingPages(conversationId: string): number;
  /** A notice (I-1) to every open page: a kind and a conversation id, never text; `helper` when the helper of the Mac shows it (D-128). */
  broadcast(notice: Notice & { kind: NoticeKind; helper?: boolean }): void;
  /** Native helpers connected (D-128, GET /api/notifications/stream). */
  helpers(): number;
  /** A notice to every helper: kind and conversation id only. */
  notifyHelpers(notice: Notice & { kind: NoticeKind }): number;
  /** The push addresses the pages of this Mac said are theirs: skipped for notices while a helper is connected. */
  macEndpoints(): ReadonlySet<string>;
  /** Pages that said this conversation is open in them, in view or not (D-136: an incognito with none closes). */
  pagesOn(conversationId: string): number;
  /** `conversation.incognito-closing` to every open page (D-136): an id and the seconds left, nothing else. */
  incognitoClosing(conversationId: string, inSeconds: number): void;
  close(): Promise<void>;
}

// A message of MAX_MESSAGE_LENGTH 4-byte characters, JSON-escaped, fits.
export const MAX_BODY_BYTES = 128 * 1024;
/** A client that reads this far behind is dropped; it catches up on reconnection. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Helpers of the Mac at once (D-128): one is enough, a few for a restart that overlaps. */
const MAX_HELPERS = 4;
const MAX_MAC_ENDPOINTS = 8;
const HELPER_BEAT_MS = 25_000;
const PING_MS = 30_000;
const PAGE_LIMIT = 200;

class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string>;
/** A JSON body, or `raw` bytes with their type (the character sheets). */
/** `raw` bytes are cached by the browser unless `noStore` (the voice trial's WAV, D-066). */
/** `lines` are sent as newline-delimited JSON while they come (a turn of a call, D-070). */
type Result =
  | { status?: number; body: unknown }
  | { raw: Buffer; type: string; headers?: Record<string, string>; noStore?: boolean }
  | { lines: AsyncIterableIterator<unknown> };
type Handler = (request: IncomingMessage, url: URL, params: Params) => Promise<Result>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

async function readJson(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? '0');
  if (declared > limit) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'body must be a JSON object');
  return value as Record<string, unknown>;
}

function onlyFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new HttpError(400, `unknown field(s): ${unknown.join(', ')}`);
}

function limitParam(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new HttpError(400, `limit must be 1-${String(PAGE_LIMIT)}`);
  return limit;
}

function idParam(params: Params, key: string): string {
  const id = params[key] ?? '';
  if (!isUuid(id)) throw new HttpError(404, 'not found');
  return id;
}

const APPROVAL_STATES: readonly ApprovalState[] = ['pending', 'approved', 'rejected', 'expired'];

interface RouteOptions {
  projects: () => readonly ProjectInfo[];
  models: () => readonly { executor: string; model: string }[];
  defaultModel: () => string | undefined;
  agents: () => readonly string[];
  characters: ApiServerOptions['characters'];
  voice: VoiceApi | undefined;
  calls: Calls | undefined;
  pusher: () => Pusher | undefined;
  settings: SettingsPage | undefined;
  local: LocalApi | undefined;
  capture: ApiServerOptions['capture'];
  modelEvals: ApiServerOptions['modelEvals'];
  approvedProjects: () => readonly Project[];
  installation: ApiServerOptions['installation'];
  directAgents?: (() => readonly DirectPolicy[]) | undefined;
  services?: ServiceManager | undefined;
  leaveRule?: (() => LeaveRule | undefined) | undefined;
  incognito?: ApiServerOptions['incognito'];
  onError: (error: unknown) => void;
}

/** The voice is configured: `[voice]` in arianna.toml (D-071: it turns on and off without a restart). */
function voiceOn(voice: VoiceApi | undefined): voice is VoiceApi {
  return voice !== undefined && voice.service.state !== 'off';
}

/** The token of the voice for one call: `Authorization: Bearer <token>`. */
function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

const END_REASONS_FROM_VOICE: readonly CallEndReason[] = ['hangup', 'time-limit', 'disconnected', 'voice-error'];

function callRoutes(sql: Sql, voice: VoiceApi | undefined, calls: Calls | undefined, pushers: () => Pusher | undefined): Route[] {
  const need = (): Calls => {
    if (calls === undefined || voice?.service.state === 'off') throw new HttpError(503, 'voice off: add [voice] to arianna.toml');
    return calls;
  };
  const needPush = (): Pusher => {
    const pusher = pushers();
    if (pusher === undefined) throw new HttpError(503, 'push off: add [voice.push] to arianna.toml');
    return pusher;
  };
  return [
    // The call in progress, if any: a reloaded page finds it again.
    route('GET', '/api/calls/live', async () => ({ body: { call: (await liveCall(sql)) ?? null } })),
    route('GET', '/api/conversations/:id/calls', async (_request, _url, params) => ({ body: { calls: await listCalls(sql, idParam(params, 'id')) } })),
    // The page calls: its WebRTC offer in, the answer of apps/voice out.
    route('POST', '/api/calls', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['conversationId', 'sdp', 'type']);
      const { conversationId, sdp, type } = body;
      if (typeof conversationId !== 'string' || typeof sdp !== 'string' || typeof type !== 'string') throw new HttpError(400, 'conversationId, sdp and type are required');
      const started = need();
      // An incognito conversation has no calls (D-136); with the voice off the 503 comes first, as for any call.
      if (await isIncognitoConversation(sql, conversationId)) return { status: 409, body: { error: 'incognito' } };
      return { status: 201, body: await started.start(conversationId, { sdp, type }) };
    }),
    route('POST', '/api/calls/:id/end', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { call: await need().end(idParam(params, 'id'), 'hangup') } };
    }),
    // A call of Arianna that is ringing: answered with the page's offer, or declined.
    route('POST', '/api/calls/:id/answer', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['sdp', 'type']);
      const { sdp, type } = body;
      if (typeof sdp !== 'string' || typeof type !== 'string') throw new HttpError(400, 'sdp and type are required');
      return { body: await need().answer(idParam(params, 'id'), { sdp, type }) };
    }),
    route('POST', '/api/calls/:id/decline', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { call: await need().decline(idParam(params, 'id')) } };
    }),
    // "Chiamami alle 18" and "chiamami quando finisci" (D-066, choice 8).
    route('POST', '/api/calls/schedule', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['conversationId', 'at']);
      need();
      if (typeof body.conversationId === 'string' && (await isIncognitoConversation(sql, body.conversationId))) return { status: 409, body: { error: 'incognito' } };
      const { conversationId, at } = body;
      if (typeof conversationId !== 'string' || !isUuid(conversationId) || typeof at !== 'string') throw new HttpError(400, 'conversationId and at (ISO time) are required');
      return { status: 201, body: { call: await scheduleCall(sql, conversationId, new Date(at)) } };
    }),
    route('POST', '/api/tasks/:id/call-when-done', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      need();
      if (await isIncognitoTask(sql, idParam(params, 'id'))) return { status: 409, body: { error: 'incognito' } };
      return { status: 201, body: { call: await callWhenDone(sql, idParam(params, 'id')) } };
    }),
    route('POST', '/api/calls/:id/cancel', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { call: await cancelCall(sql, idParam(params, 'id')) } };
    }),
    // Web Push: the public key for the page, and the browsers that asked for it.
    route('GET', '/api/push/key', () => Promise.resolve({ body: { publicKey: pushers()?.publicKey ?? null } })),
    route('POST', '/api/push/subscribe', async (request) => {
      const pusher = needPush();
      const body = await readJson(request);
      onlyFields(body, ['subscription']);
      await pusher.subscribe(parseSubscription(body.subscription));
      return { status: 201, body: { ok: true } };
    }),
    route('POST', '/api/push/unsubscribe', async (request) => {
      const pusher = needPush();
      const body = await readJson(request);
      onlyFields(body, ['endpoint']);
      if (typeof body.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
      await pusher.unsubscribe(body.endpoint);
      return { body: { ok: true } };
    }),
    // From apps/voice, with the token of the call.
    route('POST', '/api/calls/:id/turn', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['text']);
      return { lines: need().turnStream(idParam(params, 'id'), bearer(request), body.text) };
    }),
    route('POST', '/api/calls/:id/ended', async (request, _url, params) => {
      const body = await readJson(request);
      onlyFields(body, ['reason']);
      const reason = END_REASONS_FROM_VOICE.find((item) => item === body.reason);
      if (reason === undefined) throw new HttpError(400, `reason must be one of ${END_REASONS_FROM_VOICE.join(', ')}`);
      const token = bearer(request);
      if (token === undefined) throw new CallError('unauthorized', 'the token of the call is required');
      return { body: { call: await need().end(idParam(params, 'id'), reason, token) } };
    }),
  ];
}

/** A JSON answer of apps/voice, or the closed code of its error. */
function voiceJson(answer: { status: number; body: Buffer }): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body.toString('utf8'));
  } catch {
    throw new HttpError(502, 'voice: invalid answer');
  }
  if (answer.status !== 200) {
    const code = typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : 'error';
    throw new HttpError(502, `voice: ${code.slice(0, 200)}`);
  }
  return parsed;
}

function voiceRoutes(voice: VoiceApi | undefined): Route[] {
  const need = (): VoiceApi => {
    if (!voiceOn(voice)) throw new HttpError(503, 'voice off: add [voice] to arianna.toml');
    return voice;
  };
  return [
    // The trial page (D-066): service state, candidates on disk, voices.
    route('GET', '/api/voice/trial', () => {
      const state: VoiceState = voice === undefined ? 'off' : voice.service.state;
      return Promise.resolve({ body: { state, voice: voiceOn(voice) ? voice.voice() : null, models: voiceOn(voice) ? voice.models() : [] } });
    }),
    // Voices copied from a sample (D-069): L2 on disk, never in a log or an event.
    route('GET', '/api/voice/clones', () => Promise.resolve({ body: { clones: listClones(need().clones) } })),
    route('POST', '/api/voice/clones', async (request) => {
      const { clones } = need();
      return { status: 201, body: { clone: saveClone(clones, parseClone(await readJson(request, MAX_CLONE_BODY))) } };
    }),
    route('DELETE', '/api/voice/clones/:id', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      if (!deleteClone(need().clones, params.id ?? '')) throw new HttpError(404, 'not found');
      return { body: { ok: true } };
    }),
    route('POST', '/api/voice/trial/transcribe', async (request) => {
      const { service, models } = need();
      const call = transcribeCall(await readJson(request, MAX_TRANSCRIBE_BODY), models());
      // Loading two models the first time takes a while.
      return { body: voiceJson(await service.request('POST', '/trial/transcribe', { json: call, timeoutMs: 300_000 })) };
    }),
    route('POST', '/api/voice/trial/speak', async (request) => {
      const { service, models } = need();
      const call = speakCall(await readJson(request), models());
      const answer = await service.request('POST', '/trial/speak', { json: call, timeoutMs: 300_000, maxBytes: 32 * 1024 * 1024 });
      if (answer.status !== 200) voiceJson(answer);
      if (answer.body.subarray(0, 4).toString('latin1') !== 'RIFF') throw new HttpError(502, 'voice: invalid answer');
      // Seconds spent and to the first audio (D-068): numbers only, rewritten by the core.
      const headers: Record<string, string> = {};
      for (const name of ['x-seconds-spent', 'x-first-audio']) {
        const value = Number(answer.headers[name]);
        if (answer.headers[name] !== undefined && Number.isFinite(value)) headers[name] = value.toFixed(3);
      }
      return { raw: answer.body, type: 'audio/wav', noStore: true, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    }),
  ];
}

function settingsRoutes(settings: SettingsPage | undefined, local: LocalApi | undefined, onError: (error: unknown) => void): Route[] {
  const need = (): SettingsPage => {
    if (settings === undefined) throw new HttpError(404, 'not found');
    return settings;
  };
  const server = (params: Params): { local: LocalApi; found: LocalServerStatus } => {
    const found = local?.status().find((entry) => entry.id === params.id);
    if (local === undefined || found === undefined) throw new HttpError(404, 'not found');
    return { local, found };
  };
  return [
    // Values, catalog, fingerprint, what applies now and what waits for a restart, local servers.
    // With `memory`: the account of the local models and the swap level (D-107, stage E), L0.
    route('GET', '/api/settings', () => {
      const memory = local?.memory?.();
      return Promise.resolve({ body: { ...need().read(), local: local?.status() ?? [], ...(memory === undefined ? {} : { memory }) } });
    }),
    // Models, cloud models, characters, [voice]: written at once.
    route('POST', '/api/settings', async (request) => ({ body: need().update(await readJson(request)) })),
    // Cloud executors, Telegram, projects, local servers: shown first, written only on confirmation.
    route('POST', '/api/settings/privacy/prepare', async (request) => ({ body: need().prepare(await readJson(request)) })),
    route('POST', '/api/settings/privacy/confirm', async (request) => ({ body: need().confirm(await readJson(request)) })),
    // "Riavvia oMLX": only a server the core starts; answered before the model has loaded.
    route('POST', '/api/local/:id/restart', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      const { local: servers, found } = server(params);
      if (!found.managed) throw new HttpError(409, 'this server has no command in arianna.toml: the core only watches it');
      // Started outside the core: stopping it is not the core's to do.
      if (found.adopted) throw new HttpError(409, 'this server was already running when the core started: restart it where it was started');
      servers.restart(found.id).catch(onError);
      return { status: 202, body: { ok: true } };
    }),
    // The id is one the core watches, never a path.
    route('GET', '/api/local/:id/log', (_request, _url, params) => {
      const { local: servers, found } = server(params);
      return Promise.resolve({ body: { log: servers.log(found.id) } });
    }),
  ];
}

/**
 * "/nota" of the web chat (D-080): a new note in kb/inbox, L2, without a
 * model. The answer names the path and the label, never the text.
 */
const CAPTURE_BODY_BYTES = 2 * MAX_CAPTURE_BYTES + 4096;

function captureRoutes(sql: Sql, capture: ApiServerOptions['capture'], onError: (error: unknown) => void): Route[] {
  return [
    route('POST', '/api/capture', async (request) => {
      if (capture === undefined) throw new HttpError(404, 'not found');
      let body: Record<string, unknown>;
      try {
        // Room for a text at the limit, JSON-escaped, and the other fields.
        body = await readJson(request, CAPTURE_BODY_BYTES);
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) throw new HttpError(413, `text is longer than ${String(MAX_CAPTURE_BYTES / 1024)} KiB`);
        throw error;
      }
      onlyFields(body, ['text', 'kind', 'url', 'title', 'from', 'messageId', 'conversationId']);
      const { kind, url, title, from, messageId, conversationId } = body;
      // "/nota" from an incognito conversation (D-136): nothing it says is kept.
      if (conversationId !== undefined && (typeof conversationId !== 'string' || !isUuid(conversationId))) throw new HttpError(400, 'conversationId must be a conversation id');
      if (conversationId !== undefined && (await isIncognitoConversation(sql, conversationId))) return { status: 409, body: { error: 'incognito' } };
      // A message of the chat saved once (D-089): its label and, without `text`, its text come from the database.
      if (messageId !== undefined && (typeof messageId !== 'string' || !/^[1-9]\d{0,18}$/.test(messageId))) {
        throw new HttpError(400, 'messageId must be a message id');
      }
      const message = messageId === undefined ? undefined : await loadMessage(sql, messageId);
      if (messageId !== undefined && message === undefined) throw new HttpError(404, 'message not found');
      if (message !== undefined && (await isIncognitoConversation(sql, message.conversationId))) return { status: 409, body: { error: 'incognito' } };
      const text = body.text ?? message?.body;
      if (typeof text !== 'string') throw new HttpError(400, 'text is required');
      const chosen = kind ?? 'note';
      if (!isCaptureKind(chosen)) throw new HttpError(400, 'kind must be thought, link or note');
      if (url !== undefined && typeof url !== 'string') throw new HttpError(400, 'url must be a string');
      if (title !== undefined && typeof title !== 'string') throw new HttpError(400, 'title must be a string');
      // The label of the message saved (D-084): it can only raise the note, and above L2 nothing is written.
      if (from !== undefined && !isLabel(from)) throw new HttpError(400, 'from must be a label');
      const raised = message === undefined ? from : maxLabel(message.label, from ?? message.label);
      const input = {
        home: capture.home,
        rules: capture.rules,
        text,
        kind: chosen,
        ...(url === undefined ? {} : { url }),
        ...(title === undefined ? {} : { title }),
        ...(raised === undefined ? {} : { from: raised }),
      };
      let note;
      try {
        note = message === undefined ? captureNote({ ...input, source: { channel: 'hud', id: randomUUID() } }) : captureMessage({ ...input, messageId: message.id });
      } catch (error) {
        // `note`: the file name of the note already saved, or null when it is above L2.
        if (error instanceof AlreadySavedError) return { status: 409, body: { error: error.message, note: error.note } };
        throw error;
      }
      // Organized in the background (D-086): the note is already saved, a failed queue leaves it new.
      let organizing = false;
      if (capture.organize !== undefined) {
        try {
          await capture.organize(note.path);
          organizing = true;
        } catch (error) {
          onError(error);
        }
      }
      return { status: 201, body: { path: note.path, label: note.label, organizing } };
    }),
    // The messages of a conversation already saved in kb/inbox (D-089): the chat shows "Salvato" after a reload,
    // and "Apri nella Conoscenza" with the file names of the notes up to L2 (`notes`, id → name).
    route('GET', '/api/conversations/:id/saved', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if (capture === undefined) throw new HttpError(404, 'not found');
      const loaded = await loadConversation(sql, id);
      if (loaded === undefined) throw new HttpError(404, 'not found');
      // Nothing of an incognito conversation is ever saved (D-136): read as one without saves.
      if (loaded.incognito) return { body: { messageIds: [], notes: {}, conversation: false, conversationNote: null, conversationSavedAt: null } };
      const saved = savedMessageNotes(capture.home, capture.rules);
      // The whole conversation saved (I-7, D-131): "Salva in inbox" of the header becomes "Aggiorna"; its path and time only up to L2.
      const whole = findConversationNote(capture.home, capture.rules, id);
      const conversation = whole !== undefined;
      const conversationNote = whole?.visible === true ? whole.path : null;
      const conversationSavedAt = whole?.visible === true ? whole.savedAt : null;
      if (saved.size === 0) return { body: { messageIds: [], notes: {}, conversation, conversationNote, conversationSavedAt } };
      const rows = await sql<{ id: string }[]>`
        SELECT id::text FROM messages WHERE conversation_id = ${id} AND id = ANY (${[...saved.keys()]}::bigint[]) ORDER BY id`;
      const notes: Record<string, string> = {};
      for (const row of rows) {
        const name = saved.get(row.id);
        if (typeof name === 'string') notes[row.id] = name;
      }
      return { body: { messageIds: rows.map((row) => row.id), notes, conversation, conversationNote, conversationSavedAt } };
    }),
    // I-7 (D-131): the whole conversation in one note of kb/inbox, without the lines of the system; a second save replaces it.
    route('POST', '/api/conversations/:id/save', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if (capture === undefined) throw new HttpError(404, 'not found');
      const conversation = await loadConversation(sql, id);
      if (conversation === undefined) throw new HttpError(404, 'not found');
      if (conversation.incognito) return { status: 409, body: { error: 'incognito' } };
      const lines = await sql<SavedLine[]>`
        SELECT role, agent, label, body FROM messages WHERE conversation_id = ${id} AND role <> 'system' ORDER BY id`;
      const note = saveConversation({ home: capture.home, rules: capture.rules, conversationId: id, title: conversation.title, lines, floor: conversation.effectiveLabel });
      let organizing = false;
      if (capture.organize !== undefined) {
        try {
          await capture.organize(note.path);
          organizing = true;
        } catch (error) {
          onError(error);
        }
      }
      return { status: 201, body: { path: note.path, label: note.label, replaced: note.replaced, organizing } };
    }),
    ...noteRoutes(capture),
    ...knowledgeRoutes(capture),
  ];
}

/**
 * "Cerca" (D-089): conversation titles, message texts, notes and pages of
 * kb/, up to L2, grouped by kind. The query never goes to a log: errors name
 * fixed reasons only.
 */
function searchRoutes(sql: Sql, capture: ApiServerOptions['capture']): Route[] {
  return [
    route('GET', '/api/search', async (_request, url) => {
      const raw = url.searchParams.get('limit');
      const limit = raw === null ? DEFAULT_SEARCH_LIMIT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw new HttpError(400, `limit must be 1-${String(MAX_SEARCH_LIMIT)}`);
      const kb = capture === undefined ? {} : { kb: { home: capture.home, rules: capture.rules } };
      return { body: await searchAll(sql, url.searchParams.get('q') ?? '', { limit, ...kb }) };
    }),
  ];
}

/**
 * The graph of kb/ for the "Conoscenza" page (D-087): nodes and edges up to
 * L2, header fields only; the text of one page at a time, 404 for anything
 * outside kb/, hidden or above L2.
 */
function knowledgeRoutes(capture: ApiServerOptions['capture']): Route[] {
  const cache: GraphCache = new Map();
  const need = (): NonNullable<ApiServerOptions['capture']> => {
    if (capture === undefined) throw new HttpError(404, 'not found');
    return capture;
  };
  return [
    route('GET', '/api/knowledge/graph', () => {
      const { home, rules } = need();
      return Promise.resolve({ body: buildKnowledgeGraph(home, rules, cache) });
    }),
    route('GET', '/api/knowledge/page', (_request, url) => {
      const { home, rules } = need();
      return Promise.resolve({ body: { page: readKnowledgePage(home, rules, url.searchParams.get('path') ?? '') } });
    }),
  ];
}

/**
 * The notes of kb/inbox (D-086): listed by their header (never the body),
 * read one at a time up to L2, organized again on request.
 */
function noteRoutes(capture: ApiServerOptions['capture']): Route[] {
  const need = (): NonNullable<ApiServerOptions['capture']> => {
    if (capture === undefined) throw new HttpError(404, 'not found');
    return capture;
  };
  return [
    route('GET', '/api/notes', (_request, url) => {
      const { home, rules } = need();
      const status = url.searchParams.get('status');
      if (status !== null && !isNoteStatus(status)) throw new HttpError(400, 'status must be new or organized');
      const limit = limitParam(url);
      return Promise.resolve({ body: listNotes(home, rules, { limit, ...(status === null ? {} : { status }) }) });
    }),
    route('GET', '/api/notes/:name', (_request, _url, params) => {
      const { home, rules } = need();
      return Promise.resolve({ body: { note: readNote(home, rules, params.name ?? '') } });
    }),
    route('POST', '/api/notes/:name/organize', async (request, _url, params) => {
      const { home, rules, organize } = need();
      onlyFields(await readJson(request), []);
      const note = readNote(home, rules, params.name ?? '');
      if (note.status !== 'new') throw new HttpError(409, 'the note is already organized');
      if (organize === undefined) throw new HttpError(503, 'notes cannot be organized now');
      await organize(note.path);
      return { status: 202, body: { path: note.path, organizing: true } };
    }),
  ];
}

/**
 * Trials of a catalog model (D-081): queued here, run by the core in the
 * background. Rows hold ids, outcomes, times and codes only (L0).
 */
function modelEvalRoutes(evals: ApiServerOptions['modelEvals']): Route[] {
  const need = (): NonNullable<ApiServerOptions['modelEvals']> => {
    if (evals === undefined) throw new HttpError(404, 'not found');
    return evals;
  };
  const evalId = (params: Params): string => {
    const id = params.id ?? '';
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new HttpError(404, 'not found');
    return id;
  };
  return [
    route('GET', '/api/model-evals', async (_request, url) => {
      const modelId = url.searchParams.get('modelId');
      const limit = url.searchParams.get('limit') === null ? 20 : limitParam(url);
      return { body: { evals: await need().list({ ...(modelId === null ? {} : { modelId }), limit }) } };
    }),
    route('POST', '/api/model-evals', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['modelId', 'role']);
      const { modelId, role } = body;
      if (typeof modelId !== 'string' || typeof role !== 'string') throw new HttpError(400, 'modelId and role are required');
      return { status: 202, body: { id: await need().request(modelId, role) } };
    }),
    route('GET', '/api/model-evals/:id', async (_request, _url, params) => {
      const found = await need().get(evalId(params));
      if (found === undefined) throw new HttpError(404, 'not found');
      return { body: { eval: found } };
    }),
    route('POST', '/api/model-evals/:id/cancel', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      return { body: { eval: await need().cancel(evalId(params)) } };
    }),
  ];
}

/**
 * "Who did what" and "Files changed" (D-082): read only, metadata only. The
 * preview reads the file again from the approved project, as it is now; no
 * route opens Finder or runs `open` (the API has no authentication before 1.13).
 */
function delegationRoutes(sql: Sql, approvedProjects: () => readonly Project[], openLinks: OpenLinks): Route[] {
  const delegationId = (params: Params): string => {
    const id = params.id ?? '';
    if (!/^[1-9]\d{0,17}$/.test(id)) throw new HttpError(404, 'not found');
    return id;
  };
  return [
    route('GET', '/api/delegations', async (_request, url) => {
      const limit = url.searchParams.get('limit') === null ? 10 : limitParam(url);
      return { body: { delegations: await listRecentDelegations(sql, limit) } };
    }),
    route('GET', '/api/conversations/:id/credits', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { credits: await listCredits(sql, id) } };
    }),
    route('GET', '/api/delegations/:id/files/:index', async (_request, _url, params) => {
      const id = delegationId(params);
      const index = params.index ?? '';
      if (!/^\d{1,4}$/.test(index)) throw new HttpError(404, 'not found');
      return { body: { file: await readDelegationFile(sql, approvedProjects(), id, Number(index)) } };
    }),
    // D-117: what the run changed in each file, from the commit its files were listed against.
    route('GET', '/api/delegations/:id/diff', async (_request, _url, params) => {
      const id = delegationId(params);
      return { body: { diff: await readDelegationDiff(sql, approvedProjects(), id) } };
    }),
    // D-117, tappa 3: "Apri" on a page or an image the run changed: a link with a random token, same origin only.
    route('POST', '/api/delegations/:id/open', async (request, _url, params) => {
      const id = delegationId(params);
      const body = await readJson(request);
      const index = body.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 9999) throw new HttpError(400, 'index must be a file of the delegation');
      return { body: await openDelegationFile(sql, approvedProjects(), openLinks, id, index) };
    }),
    // The files behind the link, sandboxed: the page and the styles, scripts and images it loads from its project.
    {
      method: 'GET',
      pattern: /^\/api\/open\/([A-Za-z0-9_-]{32})\/(.+)$/,
      keys: ['token', 'path'],
      handler: async (request, _url, params) => {
        let path: string;
        try {
          path = (params.path ?? '').split('/').map(decodeURIComponent).join('/');
        } catch {
          throw new HttpError(400, 'bad path');
        }
        const file = await readOpenFile(approvedProjects(), openLinks, params.token ?? '', path);
        return { raw: file.body, type: file.type, headers: openHeaders(request.headers.host?.toLowerCase() ?? ''), noStore: true };
      },
    },
  ];
}

const PROJECT_PARAM = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/**
 * The page "Progetti" (D-134): an approved project read on this computer.
 * Read only: folders, files, branches, changes, commits and their diff;
 * "Apri" for a page or an image with the links of D-117. Nothing is written
 * in the project, nothing goes out. Hidden entries only with the consent of
 * D-135, which the core reads for each request.
 */
function projectBrowserRoutes(sql: Sql, approvedProjects: () => readonly Project[], openLinks: OpenLinks): Route[] {
  const projectParam = (params: Params): string => {
    const name = params.project ?? '';
    if (!PROJECT_PARAM.test(name)) throw new HttpError(404, 'not found');
    return name;
  };
  const pathParam = (url: URL, key: string, required: boolean): string => {
    const value = url.searchParams.get(key) ?? '';
    if (value.length > 4096 || (required && value === '')) throw new HttpError(400, `${key} must be a path of the project`);
    return value;
  };
  return [
    route('GET', '/api/browse', async () => ({ body: { projects: browsableProjects(approvedProjects(), await hiddenConsents(sql)) } })),
    route('POST', '/api/browse/:project/hidden', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['on']);
      if (typeof body.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
      await setHiddenShown(sql, approvedProjects(), name, body.on);
      return { body: { hidden: body.on } };
    }),
    route('GET', '/api/browse/:project/tree', async (_request, url, params) => {
      const name = projectParam(params);
      const projects = approvedProjects();
      return { body: await listProjectDir(projects, name, pathParam(url, 'dir', false), await hiddenShown(sql, projects, name)) };
    }),
    route('GET', '/api/browse/:project/file', async (_request, url, params) => {
      const name = projectParam(params);
      const projects = approvedProjects();
      return { body: { file: await readBrowsedFile(projects, name, pathParam(url, 'path', true), { showHidden: await hiddenShown(sql, projects, name) }) } };
    }),
    // "Mostra" on a covered secret (D-135): a POST, so that no other page can write its event; the trace before the text.
    route('POST', '/api/browse/:project/reveal', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string' || body.path === '' || body.path.length > 4096) throw new HttpError(400, 'path must be a file of the project');
      return { body: { file: await revealBrowsedFile(sql, approvedProjects(), name, body.path) } };
    }),
    route('POST', '/api/browse/:project/open', async (request, _url, params) => {
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['path']);
      if (typeof body.path !== 'string' || body.path === '' || body.path.length > 4096) throw new HttpError(400, 'path must be a file of the project');
      return { body: await openBrowsedFile(approvedProjects(), openLinks, name, body.path) };
    }),
    route('GET', '/api/browse/:project/git', async (_request, _url, params) => ({ body: { git: await readProjectGit(sql, approvedProjects(), projectParam(params)) } })),
    route('GET', '/api/browse/:project/commits/:commit', async (_request, _url, params) => {
      const name = projectParam(params);
      const projects = approvedProjects();
      return { body: { diff: await readCommitDiff(sql, projects, name, params.commit ?? '', await hiddenShown(sql, projects, name)) } };
    }),
  ];
}

/**
 * The tab Servizi (D-134, tappa 2): the commands the project declares, each
 * started or stopped by name after the user's confirmation in the page; the
 * log of a run, from memory. Never a command written in the request.
 */
function projectServiceRoutes(sql: Sql, approvedProjects: () => readonly Project[], services: ServiceManager | undefined): Route[] {
  const need = (): ServiceManager => {
    if (services === undefined) throw new HttpError(404, 'not found');
    return services;
  };
  const projectParam = (params: Params): string => {
    const name = params.project ?? '';
    if (!PROJECT_PARAM.test(name)) throw new HttpError(404, 'not found');
    return name;
  };
  const serviceParam = (value: unknown): string => {
    if (typeof value !== 'string' || !/^(?:package\.json|compose|Makefile):[A-Za-z0-9][\w:.-]{0,63}$/.test(value)) throw new HttpError(400, 'service must be one of the project');
    return value;
  };
  const act = (verb: 'start' | 'stop') =>
    route('POST', `/api/browse/:project/services/${verb}`, async (request, _url, params) => {
      const manager = need();
      const name = projectParam(params);
      const body = await readJson(request);
      onlyFields(body, ['service', 'fingerprint']);
      const id = serviceParam(body.service);
      // A start runs what the confirmation showed, or nothing: the fingerprint of the command and its script.
      const fingerprint = body.fingerprint;
      if (fingerprint !== undefined && (typeof fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fingerprint))) throw new HttpError(400, 'fingerprint must be the one of the list');
      if (verb === 'start' && fingerprint === undefined) throw new HttpError(400, 'fingerprint must be the one of the list');
      const { root, list } = await serviceStates(approvedProjects(), name, manager);
      const service = pickService(list, id, fingerprint);
      // Never while the Coder works there: it may be rewriting the scripts.
      if (verb === 'start') await notBusy(sql, name);
      if (verb === 'start') manager.start(name, root, service);
      else manager.stop(name, root, service);
      return { body: { run: manager.run(name, id) ?? null } };
    });
  return [
    route('GET', '/api/browse/:project/services', async (_request, _url, params) => {
      const manager = need();
      const { list } = await serviceStates(approvedProjects(), projectParam(params), manager);
      return { body: { services: list } };
    }),
    route('GET', '/api/browse/:project/services/log', (_request, url, params) => {
      const manager = need();
      const name = projectParam(params);
      const id = serviceParam(url.searchParams.get('service'));
      return Promise.resolve({ body: { run: manager.run(name, id) ?? null } });
    }),
    act('start'),
    act('stop'),
  ];
}

function routes(sql: Sql, { projects, models, defaultModel, agents, characters, voice, calls, pusher, settings, local, capture, modelEvals, approvedProjects, installation, onError, directAgents, leaveRule, services, incognito }: RouteOptions): Route[] {
  // The links of "Apri" (D-117, tappa 3; D-134): in memory, gone with a restart.
  const openLinks = createOpenLinks();
  return [
    ...delegationRoutes(sql, approvedProjects, openLinks),
    ...projectBrowserRoutes(sql, approvedProjects, openLinks),
    ...projectServiceRoutes(sql, approvedProjects, services),
    ...modelEvalRoutes(modelEvals),
    ...voiceRoutes(voice),
    ...captureRoutes(sql, capture, onError),
    ...searchRoutes(sql, capture),
    ...settingsRoutes(settings, local, onError),
    ...callRoutes(sql, voice, calls, pusher),
    route('GET', '/api/health', () => Promise.resolve({ body: { ok: true } })),

    // The status panel (D-060): agents, last router decision, gateway today. Counts and labels only.
    route('GET', '/api/status', async () => ({ body: await loadStatus(sql, agents()) })),

    // What this installation is (D-089): development or production, the name of its folder, the commit.
    route('GET', '/api/installation', () => {
      if (installation === undefined) throw new HttpError(404, 'not found');
      return Promise.resolve({ body: { installation: installation() } });
    }),

    // The character packs and who wears what. Refused folders are named with the reason, never their content.
    route('GET', '/api/characters', async () => {
      if (characters === undefined) return { body: { packs: [], refused: [], agents: {} } };
      const { packs, refused } = await listPacks(characters.dirs);
      return { body: { packs, refused, agents: assignCharacters(agents(), characters.choices(), packs) } };
    }),
    // A sheet uploaded from the chat (D-118): decoded, written again, saved in data/characters/miei.
    // A character of the same name answers 409 with `existing`: the page asks, then sends `replace`.
    route('POST', '/api/characters/upload', async (request) => {
      if (characters === undefined) throw new HttpError(404, 'not found');
      try {
        return { status: 201, body: { character: await uploadSheet(characters.dirs, parseUpload(await readJson(request, MAX_UPLOAD_BODY))) } };
      } catch (error) {
        if (error instanceof HttpError && error.status === 413) throw new HttpError(413, 'the sheet is too large');
        if (error instanceof UploadError && error.code === 'conflict') return { status: 409, body: { error: error.message, existing: error.existing } };
        throw error;
      }
    }),
    route('GET', '/api/characters/:pack/:character', async (_request, _url, params) => {
      const png = characters === undefined ? undefined : await readSheet(characters.dirs, params.pack ?? '', params.character ?? '');
      if (png === undefined) throw new HttpError(404, 'not found');
      return { raw: png, type: 'image/png' };
    }),

    // The cloud models of this installation: what the selector of a work conversation offers.
    route('GET', '/api/models', () => Promise.resolve({ body: { models: models() } })),

    // The approved projects (D-058): what a new work conversation may choose.
    route('GET', '/api/projects', () =>
      Promise.resolve({ body: { projects: projects().map(({ name, path, label }) => ({ name, path, label })) } }),
    ),

    // The list, with ?origin=system the system chats (D-064), with ?archived=1 the archived conversations (D-057).
    route('GET', '/api/conversations', async (_request, url) => {
      const archived = url.searchParams.get('archived');
      if (archived !== null && archived !== '0' && archived !== '1') throw new HttpError(400, 'archived must be 0 or 1');
      const asked = url.searchParams.get('origin');
      const origin = asked === null ? null : (['user', 'system'] as const).find((item) => item === asked);
      if (origin === undefined) throw new HttpError(400, 'origin must be user or system');
      if (origin !== null && archived === '1') throw new HttpError(400, 'the archive is not split by origin');
      const options = { archived: archived === '1', ...(origin === null ? {} : { origin }) };
      return { body: { conversations: await listConversations(sql, limitParam(url), options) } };
    }),

    // The agents the user may talk with directly now (D-111d), with what each one allows: no prompt, no permission.
    route('GET', '/api/direct-agents', () => Promise.resolve({ body: { agents: directAgents?.() ?? [] } })),
    route('POST', '/api/conversations', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['mode', 'project', 'agent', 'incognito']);
      if (body.mode !== 'work' && body.mode !== 'private') throw new HttpError(400, 'mode must be work or private');
      if (body.incognito !== undefined && typeof body.incognito !== 'boolean') throw new HttpError(400, 'incognito must be true or false');
      // An incognito conversation is answered by Arianna (D-136): a direct chat keeps its agent's session.
      if (body.incognito === true && body.agent !== undefined) throw new HttpError(400, 'an incognito conversation has no direct agent');
      if (body.project !== undefined && typeof body.project !== 'string') throw new HttpError(400, 'project must be a string');
      // Who answers in place of Arianna (D-111d): only here, at creation; no route changes it later. Its card says how.
      const policy = body.agent === undefined ? undefined : (directAgents?.() ?? []).find((item) => item.agent === body.agent);
      if (body.agent !== undefined && policy === undefined) throw new HttpError(400, 'agent is not one the user may talk with now');
      const agent = policy === undefined ? undefined : { name: policy.agent, modes: policy.modes, project: policy.project };
      // A work conversation starts with the user's default model, while this installation offers it:
      // this check, against what the selector offers, is the one that counts.
      const model = body.mode === 'work' ? defaultModel() : undefined;
      const conversation = await createConversation(sql, {
        mode: body.mode,
        ...(body.project === undefined ? {} : { project: body.project }),
        ...(agent === undefined ? {} : { agent }),
        ...(body.incognito === true ? { incognito: true } : {}),
        projects: projects().map((project) => project.name),
        ...(model !== undefined && models().some((entry) => entry.model === model) ? { model } : {}),
      });
      return { status: 201, body: { conversation } };
    }),

    route('GET', '/api/conversations/:id', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const conversation = await loadConversation(sql, id);
      if (conversation === undefined) {
        // A closed incognito conversation says why it closed (D-136), so a page left open on it can tell.
        const closed = await incognitoClosedCause(sql, id);
        if (closed !== undefined) return { status: 404, body: { error: 'not found', closed } };
        throw new HttpError(404, 'not found');
      }
      return { body: { conversation } };
    }),

    // The user's model for the delegated steps of a work conversation; null lets the router choose.
    route('POST', '/api/conversations/:id/model', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['model']);
      if (body.model !== null && typeof body.model !== 'string') throw new HttpError(400, 'model must be a string or null');
      const conversation = await setConversationModel(sql, id, body.model, models().map((entry) => entry.model));
      return { body: { conversation } };
    }),

    route('POST', '/api/conversations/:id/title', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['title']);
      return { body: { conversation: await renameConversation(sql, id, body.title) } };
    }),

    // Archives a conversation, or brings it back to the list: nothing is deleted.
    route('POST', '/api/conversations/:id/archive', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['archived']);
      if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
      return { body: { conversation: await archiveConversation(sql, id, body.archived) } };
    }),

    // Pins a conversation at the top of the list, or unpins it (D-089); an archived one is restored first (409).
    route('POST', '/api/conversations/:id/pin', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { conversation: await pinConversation(sql, id, true) } };
    }),
    route('POST', '/api/conversations/:id/unpin', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { body: { conversation: await pinConversation(sql, id, false) } };
    }),

    // Deletes the texts of an archived conversation for good (D-057): the user confirmed it in the page.
    route('POST', '/api/conversations/:id/purge', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      await purgeConversation(sql, id);
      return { body: { purged: id } };
    }),

    // "Termina" of an incognito conversation (D-136): its work stops, its texts are deleted; the answer is the closing card.
    route('POST', '/api/conversations/:id/end', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      try {
        return { body: incognito === undefined ? await closeIncognito(sql, id, 'user') : await incognito.close(id, 'user') };
      } catch (error) {
        if (error instanceof ChatError && error.code === 'not-incognito') return { status: 409, body: { error: 'not incognito' } };
        // The work did not stop in time, or the conversation was in use: a stable code, the chat tries again.
        if (error instanceof ChatError && error.code === 'busy') return { status: 409, body: { error: 'busy' } };
        throw error;
      }
    }),
    // What the opening card of an incognito conversation needs (D-136): whether anything may reach the cloud, and the project.
    route('GET', '/api/incognito/notice', (_request, url) => {
      const mode = url.searchParams.get('mode');
      if (mode !== 'private' && mode !== 'work') throw new HttpError(400, 'mode must be private or work');
      const project = url.searchParams.get('project');
      if (project !== null && mode !== 'work') throw new HttpError(400, 'only a work conversation has a project');
      if (project !== null && !projects().some((item) => item.name === project)) throw new HttpError(400, 'project is not among the approved projects');
      // A private conversation never leaves the Mac; a work one reaches Claude only while a cloud model can take a step.
      // `localCache`: a local server writes blocks of the prompts to the SSD; they stay until evicted.
      return Promise.resolve({ body: { cloud: mode === 'work' && models().length > 0, project, localCache: incognito?.localCache?.() ?? false } });
    }),

    // Attaches the question of the failed task to its system chat: only when the user asks (D-064).
    route('POST', '/api/conversations/:id/question', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      return { status: 201, body: { message: await attachQuestion(sql, id) } };
    }),

    route('GET', '/api/conversations/:id/messages', async (_request, url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      const before = url.searchParams.get('before');
      if (before !== null && !/^\d{1,19}$/.test(before)) throw new HttpError(400, 'before must be a message id');
      const messages = await listMessages(sql, id, { limit: limitParam(url), ...(before === null ? {} : { beforeId: before }) });
      return { body: { messages } };
    }),

    route('POST', '/api/conversations/:id/messages', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['body']);
      if (typeof body.body !== 'string') throw new HttpError(400, 'body must be a string');
      const leave = leaveRule?.();
      const { message, task } = await postUserMessage(sql, id, body.body, leave === undefined ? {} : { leave });
      return { status: 201, body: { message, task } };
    }),

    // The tasks waiting for the user, oldest first, up to L2; the others only counted (D-091). Before /api/tasks/:id.
    route('GET', '/api/tasks/waiting', async () => ({ body: await listWaitingTasks(sql) })),

    route('GET', '/api/tasks/:id', async (_request, _url, params) => {
      const task = await loadTask(sql, idParam(params, 'id'));
      if (task === undefined) throw new HttpError(404, 'not found');
      return { body: { task } };
    }),

    // The activity lines a task saved (D-083), read as the messages of its conversation are.
    route('GET', '/api/tasks/:id/activities', async (_request, _url, params) => {
      const activities = await listTaskActivities(sql, idParam(params, 'id'));
      if (activities === undefined) throw new HttpError(404, 'not found');
      return { body: { activities } };
    }),
    // How many lines each task of a conversation saved: the chat offers "Mostra i passi (N)" (D-083).
    route('GET', '/api/conversations/:id/activity-counts', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { counts: await countConversationActivities(sql, id) } };
    }),

    // Why the task failed (D-064): origin, code and scalar details; null when nothing was recorded.
    // `current` is false once the task is no longer failed (retried): the error is history then.
    route('GET', '/api/tasks/:id/error', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      const task = await loadTask(sql, id);
      if (task === undefined) throw new HttpError(404, 'not found');
      return { body: { error: (await loadFailure(sql, id)) ?? null, current: task.status === 'failed' } };
    }),

    // The user retries a failed task from the step that failed (D-064).
    route('POST', '/api/tasks/:id/retry', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if ((await loadTask(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { task: await retryTask(sql, id) } };
    }),

    // "Chiudi" in "Decisioni in attesa" (D-109): a waiting task closes as done, its pending approvals expire.
    route('POST', '/api/tasks/:id/dismiss', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      if ((await loadTask(sql, id)) === undefined) throw new HttpError(404, 'not found');
      return { body: { task: await dismissWaitingTask(sql, id) } };
    }),

    // Opens the system chat of a failed task, or the one already open (D-064).
    route('POST', '/api/tasks/:id/system-chat', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      // Claude answers by default only where Arianna could not (D-064): Sonnet, or Opus when Sonnet is off (D-071).
      const directModel = DIRECT_MODELS.find((model) => models().some((entry) => entry.executor === 'claude' && entry.model === model));
      const direct = directModel === undefined ? {} : { directModel };
      return { body: { conversation: await openFailureChat(sql, id, direct) } };
    }),

    route('GET', '/api/approvals', async (_request, url) => {
      const state = url.searchParams.get('state') ?? 'pending';
      const known = APPROVAL_STATES.find((candidate) => candidate === state);
      if (known === undefined) throw new HttpError(400, 'unknown state');
      // Each with its conversation and `incognito` (D-136: the chat shows those of an incognito only in its page); `conversation` keeps one.
      const conversation = url.searchParams.get('conversation');
      if (conversation !== null && !isUuid(conversation)) throw new HttpError(400, 'conversation must be a conversation id');
      return { body: { approvals: await listApprovals(sql, known, limitParam(url), conversation === null ? {} : { conversationId: conversation }) } };
    }),

    route('GET', '/api/approvals/:id', async (_request, _url, params) => {
      const approval = await loadApproval(sql, idParam(params, 'id'));
      if (approval === undefined) throw new HttpError(404, 'not found');
      return { body: { approval } };
    }),

    // The web chat is the channel of the decision: a declassification can be decided only here.
    route('POST', '/api/approvals/:id/decision', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const body = await readJson(request);
      onlyFields(body, ['state']);
      if (body.state !== 'approved' && body.state !== 'rejected') throw new HttpError(400, 'state must be approved or rejected');
      const current = await loadApproval(sql, id);
      if (current === undefined) throw new HttpError(404, 'not found');
      if (current.state !== 'pending') throw new HttpError(409, `the approval is already ${current.state}`);
      try {
        return { body: { approval: await recordDecision(sql, id, body.state, 'web') } };
      } catch (error) {
        // Decided meanwhile (another tab, Telegram): the database refused the second decision.
        if (error instanceof Error && /already decided/.test(error.message)) throw new HttpError(409, 'the approval is already decided');
        throw error;
      }
    }),
  ];
}

/** What the routes of "Sviluppo di Arianna" need (D-102). */
export interface DevProgressApi {
  /** ARIANNA_HOME: the documents are `docs/*.md` under it, the answers `data/dev/RISPOSTE.md`. */
  home: string;
  /** Tests only: the gateway and the event, which otherwise use the database of the core. */
  gate?: AnswerGate;
  recorded?: (saved: { key: string; question: OpenQuestion }) => Promise<void>;
}

/**
 * "Sviluppo di Arianna" (D-102): progress read from the documents, and the
 * answers to the open questions appended to data/dev/RISPOSTE.md for Claude
 * Code. The client names a question by its key only: the path is fixed and the
 * question's text comes from the documents. Claude Code is a cloud reader:
 * every answer passes the gateway as L1 towards it, logged in gateway_log, and
 * only the text it allows is written.
 */
function devRoutes(sql: Sql, dev: DevProgressApi | undefined, onError: (error: unknown) => void): Route[] {
  const need = (): DevProgressApi => {
    if (dev === undefined) throw new HttpError(404, 'not found');
    return dev;
  };
  const viaGateway: AnswerGate = async (answer, key) => {
    const decision = await passGateway(sql, [{ value: answer, label: 'L1', source: 'dev:answer' }], createContext('L1'), { kind: 'executor', id: 'claude', locality: 'cloud' }, { summary: key });
    if (decision.decision !== 'allow') return { allow: false, reason: decision.rule };
    const [text] = decision.texts;
    return text === undefined ? { allow: false, reason: 'empty' } : { allow: true, text };
  };
  return [
    route('GET', '/api/dev/progress', () => Promise.resolve({ body: { progress: loadProgress(need().home), maxAnswer: MAX_ANSWER_CHARS } })),
    // The dot of the chat (D-120): only the number leaves, no text of the documents.
    route('GET', '/api/dev/pending', () => Promise.resolve({ body: { pending: pendingQuestions(loadProgress(need().home)) } })),
    route('POST', '/api/dev/answers', async (request) => {
      const { home, gate = viaGateway, recorded = (saved) => recordAnswer(sql, saved) } = need();
      const body = await readJson(request, 64 * 1024);
      onlyFields(body, ['key', 'text']);
      const { key, text } = body;
      if (typeof key !== 'string' || !/^[A-Za-z0-9#-]{1,80}$/.test(key)) throw new HttpError(400, 'key must be the key of a question');
      if (typeof text !== 'string') throw new HttpError(400, 'text is required');
      let saved;
      try {
        saved = await saveAnswer(home, key, text, gate);
      } catch (error) {
        if (!(error instanceof DevAnswerError)) throw error;
        throw new HttpError({ invalid: 400, 'unknown-question': 404, blocked: 422, unavailable: 503 }[error.code], error.message);
      }
      // The answer is in the file: an event that fails is reported, and the answer is not sent twice.
      let logged = true;
      try {
        await recorded(saved);
      } catch (error) {
        logged = false;
        onError(error);
      }
      return { status: 201, body: { key: saved.key, at: saved.at, logged } };
    }),
  ];
}

/**
 * "Novità": the register of the versions from CHANGELOG.md, documentation of
 * the repository (L2 by default, as the documents of D-102), served only to
 * the local web chat like /api/dev/progress.
 */
function changelogRoutes(changelog: { home: string } | undefined): Route[] {
  return [
    route('GET', '/api/changelog', () => {
      if (changelog === undefined) throw new HttpError(404, 'not found');
      return Promise.resolve({ body: { changelog: loadChangelog(changelog.home) } });
    }),
  ];
}

/**
 * The user's agents (D-119). Promotion into agents/ lifts the L1/A1 ceiling:
 * it needs `{ confirm: true }`, sent only by the confirmation of the page;
 * so does taking it back, and a deletion needs the agent's name.
 */
function userAgentRoutes(userAgents: UserAgents | undefined): Route[] {
  const need = (): UserAgents => {
    if (userAgents === undefined) throw new HttpError(404, 'not found');
    return userAgents;
  };
  const answer = async (run: () => Result | Promise<Result>): Promise<Result> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof UserAgentError)) throw error;
      throw new HttpError(error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400, error.message);
    }
  };
  const name = (params: Params): string => params.id ?? '';
  return [
    route('GET', '/api/agents', () => answer(() => ({ body: need().list() }))),
    route('GET', '/api/agents/sources', () => answer(() => ({ body: need().sources() }))),
    // Tappa T3b: a card is written only as `prepare` showed it, with the confirmation id it returned.
    route('POST', '/api/agents/prepare', async (request) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['name', 'description', 'prompt', 'permissions']);
      return answer(() => ({ body: { proposal: service.prepareCreate(body as unknown as NewUserAgent) } }));
    }),
    route('POST', '/api/agents', async (request) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['name', 'description', 'prompt', 'permissions', 'confirmation']);
      return answer(() => ({ status: 201, body: { agent: service.create(body as unknown as ConfirmedNewUserAgent) } }));
    }),
    route('GET', '/api/agents/:id/permissions', (_request, _url, params) => answer(() => ({ body: { agent: need().permissions(name(params)) } }))),
    route('POST', '/api/agents/:id/activate', async (request, _url, params) => {
      const service = need();
      onlyFields(await readJson(request), []);
      return answer(() => ({ body: { agent: service.activate(name(params)) } }));
    }),
    route('POST', '/api/agents/:id/deactivate', async (request, _url, params) => {
      const service = need();
      onlyFields(await readJson(request), []);
      return answer(() => ({ body: { agent: service.deactivate(name(params)) } }));
    }),
    route('POST', '/api/agents/:id/promote', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return answer(() => ({ body: { agent: service.promote(name(params), body.confirm) } }));
    }),
    // Tappa T3: read and change the texts, delete a disabled agent (its name as confirmation), take back a promotion.
    // The prompt is the user's own text (L1 by declaration), served only to the local web chat like the personas.
    route('GET', '/api/agents/:id/prompt', (_request, _url, params) => answer(() => ({ body: { prompt: need().prompt(name(params)) } }))),
    route('POST', '/api/agents/:id/prepare', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['description', 'prompt', 'permissions']);
      return answer(() => ({ body: { proposal: service.prepareEdit(name(params), body) } }));
    }),
    route('POST', '/api/agents/:id/edit', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['description', 'prompt', 'permissions', 'confirmation']);
      return answer(() => ({ body: { agent: service.update(name(params), body) } }));
    }),
    route('POST', '/api/agents/:id/delete', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return answer(() => ({ body: { deleted: service.remove(name(params), body.confirm) } }));
    }),
    route('POST', '/api/agents/:id/demote', async (request, _url, params) => {
      const service = need();
      const body = await readJson(request);
      onlyFields(body, ['confirm']);
      return answer(() => ({ body: { agent: service.demote(name(params), body.confirm) } }));
    }),
  ];
}

const SPRITE_STATUS: Record<SpriteError['code'], number> = { invalid: 400, unavailable: 409, busy: 409, blocked: 403, quota: 429, failed: 502, 'bad-reply': 502 };

/**
 * A character drawn by the model of `[sprites]` (D-123): what draws and what
 * leaves (GET), and one drawing (POST), returned as a PNG in base64 and never
 * saved here: "Tieni" sends it to /api/characters/upload (D-118).
 */
function spriteRoutes(sprites: SpriteGenerator | undefined): Route[] {
  const need = (): SpriteGenerator => {
    if (sprites === undefined) throw new HttpError(404, 'not found');
    return sprites;
  };
  return [
    route('GET', '/api/characters/generate', () => Promise.resolve({ body: need().info() })),
    route('POST', '/api/characters/generate', async (request) => {
      const service = need();
      const body = await readJson(request);
      // A page closed meanwhile stops the drawing: no quota spent for nobody, and the next one is not "busy".
      const closed = new AbortController();
      const abort = (): void => {
        closed.abort();
      };
      request.socket.once('close', abort);
      try {
        const drawn = await service.generate(body, closed.signal);
        return { body: { png: drawn.png.toString('base64'), rows: drawn.rows, model: drawn.model, label: drawn.label } };
      } catch (error) {
        if (!(error instanceof SpriteError)) throw error;
        return { status: SPRITE_STATUS[error.code], body: { error: error.message, code: error.code, resetsAt: error.resetsAt?.toISOString() ?? null } };
      } finally {
        // A kept-alive socket serves the next requests: no listener left behind.
        request.socket.off('close', abort);
      }
    }),
  ];
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** A file of the built web chat; unknown paths get index.html (client-side routes). */
async function staticFile(dir: string, pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const root = await realpath(normalize(dir)).catch(() => undefined);
  if (root === undefined) return undefined;
  const inside = (path: string): boolean => path === root || path.startsWith(root + sep);
  const candidate = normalize(join(root, decoded));
  if (!inside(candidate)) return undefined;
  for (const path of [candidate, join(root, 'index.html')]) {
    try {
      // A symbolic link inside the folder must not lead out of it.
      if (!inside(await realpath(path)) || !(await stat(path)).isFile()) continue;
      return { body: await readFile(path), type: CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' };
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/**
 * The first line is awaited before the headers, so a refused request still
 * gets its error status; then each line goes out as it comes. A client that
 * goes away stops the producer (the iterator's `return`).
 */
async function sendLines(response: ServerResponse, lines: AsyncIterableIterator<unknown>, headers: Record<string, string>): Promise<void> {
  const gone = () => {
    if (!response.writableFinished) void lines.return?.();
  };
  response.on('close', gone);
  try {
    let item = await lines.next();
    response.writeHead(200, { ...headers, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    while (item.done !== true) {
      response.write(`${JSON.stringify(item.value)}\n`);
      item = await lines.next();
    }
    response.end();
  } finally {
    response.off('close', gone);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function errorStatus(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  if (error instanceof ChatError) {
    const status =
      error.code === 'not-found'
        ? 404
        : error.code === 'scanner'
          ? 422
          : error.code === 'archived' || error.code === 'busy' || error.code === 'incognito' || error.code === 'not-incognito'
            ? 409
            : 400;
    return { status, message: error.message };
  }
  if (error instanceof TaskError) return { status: 409, message: 'the task cannot do this now' };
  if (error instanceof TrialError || error instanceof CloneError || error instanceof PushError || error instanceof ScheduleError) return { status: 400, message: error.message };
  if (error instanceof CallError) {
    const status = { 'not-found': 404, invalid: 400, archived: 409, busy: 409, 'voice-off': 503, 'not-ready': 409, unauthorized: 401, ended: 409 }[error.code];
    return { status, message: error.code === 'unauthorized' ? 'unauthorized' : `${error.code}: ${error.message}` };
  }
  if (error instanceof SettingsError) {
    const status = { invalid: 400, changed: 409, unreadable: 409, unknown: 404, expired: 410 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof CaptureError) {
    const status = { invalid: 400, 'too-large': 413, 'not-allowed': 403, unavailable: 503 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof NoteError) {
    const status = { invalid: 400, 'not-found': 404, 'above-clearance': 403, conflict: 409, changed: 409, unavailable: 503 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof ServiceError) return { status: error.code === 'unknown' ? 404 : 409, message: error.message };
  if (error instanceof DelegationFileError) {
    const status = { 'not-found': 404, deleted: 410, 'not-approved': 403, refused: 403, 'too-large': 413, binary: 415, archived: 409, busy: 409 }[error.code];
    return { status, message: error.message };
  }
  if (error instanceof SearchError) return { status: 400, message: error.message };
  if (error instanceof UploadError) return { status: error.code === 'invalid' ? 400 : 409, message: error.message };
  if (error instanceof ModelEvalError) return { status: { 'not-found': 404, invalid: 400, conflict: 409 }[error.code], message: error.message };
  if (error instanceof VoiceError) return { status: 503, message: error.code === 'off' ? 'voice not ready' : 'voice unreachable' };
  return undefined;
}

const AGENT_PARAM = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The participants of a conversation (D-125): who is in it besides the user
 * and Arianna, with where each runs; the user takes one out with a click.
 */
function participantRoutes(sql: Sql, agentOf: NonNullable<ApiServerOptions['participantAgent']>): Route[] {
  return [
    route('GET', '/api/conversations/:id/participants', async (_request, _url, params) => {
      const id = idParam(params, 'id');
      if ((await loadConversation(sql, id)) === undefined) throw new HttpError(404, 'not found');
      const participants = (await activeParticipants(sql, id)).map((participant) => ({ ...participant, executor: agentOf(participant.agent)?.executor ?? null }));
      return { body: { participants } };
    }),
    route('POST', '/api/conversations/:id/participants/:agent/remove', async (request, _url, params) => {
      const id = idParam(params, 'id');
      const agent = params.agent ?? '';
      if (!AGENT_PARAM.test(agent)) throw new HttpError(404, 'not found');
      onlyFields(await readJson(request), []);
      await removeParticipant(sql, id, agent, agentOf(agent)?.nameLabel ?? 'L1');
      return { body: { removed: agent } };
    }),
  ];
}

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `{"type":"visibility","visible":true|false,"focused":true|false,"conversation":"<id>"|null}`,
 * the only frame a page may send; undefined for anything else. `focused`
 * (D-128): the page is also the window in front; without it, as visible.
 * `conversation`: the one open in the page, an id and nothing else; without
 * it, none.
 */
export function visibilityOf(frame: string): { visible: boolean; focused: boolean; conversation: string | null } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => !['type', 'visible', 'focused', 'conversation'].includes(key))) return undefined;
  const { type, visible, focused, conversation } = value as { type?: unknown; visible?: unknown; focused?: unknown; conversation?: unknown };
  if (type !== 'visibility' || typeof visible !== 'boolean') return undefined;
  if (focused !== undefined && typeof focused !== 'boolean') return undefined;
  if (conversation !== undefined && conversation !== null && (typeof conversation !== 'string' || !CONVERSATION_ID.test(conversation))) return undefined;
  return { visible, focused: visible && (focused ?? true), conversation: typeof conversation === 'string' ? conversation : null };
}

const INCOGNITO_CAUSES: readonly IncognitoCause[] = ['user', 'idle', 'restart'];

/** `{"type":"conversation.incognito-closed","conversationId","cause"}` for the event of the same kind (D-136); undefined for any other. */
export function incognitoClosedFrame(event: { kind: string; payload: unknown }): { type: 'conversation.incognito-closed'; conversationId: string; cause: IncognitoCause } | undefined {
  if (event.kind !== 'conversation.incognito-closed') return undefined;
  const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as { conversationId?: unknown; cause?: unknown };
  const cause = INCOGNITO_CAUSES.find((item) => item === payload.cause);
  if (typeof payload.conversationId !== 'string' || cause === undefined) return undefined;
  return { type: 'conversation.incognito-closed', conversationId: payload.conversationId, cause };
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { sql, live } = options;
  const table = routes(sql, {
    projects: options.projects ?? (() => []),
    models: options.models ?? (() => []),
    defaultModel: options.defaultModel ?? (() => undefined),
    agents: options.agents ?? (() => []),
    characters: options.characters,
    voice: options.voice,
    calls: options.calls,
    pusher: options.pusher ?? (() => undefined),
    settings: options.settings,
    local: options.local,
    capture: options.capture,
    modelEvals: options.modelEvals,
    approvedProjects: options.approvedProjects ?? (() => []),
    installation: options.installation,
    onError: options.onError ?? (() => undefined),
    directAgents: options.directAgents,
    services: options.services,
    leaveRule: options.leaveRule,
    incognito: options.incognito,
  });
  table.push(...devRoutes(sql, options.devProgress, options.onError ?? (() => undefined)));
  // The service worker asks what an empty push was about (I-1); null when nothing recent.
  table.push(route('GET', '/api/notifications/latest', () => Promise.resolve({ body: { notice: options.notices?.latest() ?? null } })));
  // A trial notice (I-1): the same way as a real one, to every open page, with no conversation;
  // asked by a click, so neither [notifications] nor the quiet hours hold it back. No push.
  table.push(
    route('POST', '/api/notifications/test', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['kind']);
      const kind = body.kind;
      if (kind !== 'reply' && kind !== 'approval' && kind !== 'failure') throw new HttpError(400, 'kind must be reply, approval or failure');
      const helper = helpers.size > 0;
      return { body: { sent: kind, pages: broadcastNotice({ kind, conversationId: null, helper }, true), helpers: noticeToHelpers({ kind, conversationId: null }) } };
    }),
  );
  // Whether the helper of the Mac is connected (D-128): the page then leaves the notifications of the system to it.
  table.push(route('GET', '/api/notifications/helper', () => Promise.resolve({ body: { connected: helpers.size > 0 } })));
  // A page on this Mac says which push address is its own (D-128): while the helper is connected, notices skip it.
  // In memory: the page says it again at every connection of the live feed.
  table.push(
    route('POST', '/api/notifications/this-mac', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['endpoint']);
      const { endpoint } = body;
      if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) throw new HttpError(400, 'endpoint must be a push address');
      if (!macEndpoints.has(endpoint) && macEndpoints.size >= MAX_MAC_ENDPOINTS) {
        const oldest = macEndpoints.values().next().value;
        if (oldest !== undefined) macEndpoints.delete(oldest);
      }
      macEndpoints.add(endpoint);
      return { body: { ok: true } };
    }),
  );
  table.push(...changelogRoutes(options.changelog));
  table.push(...userAgentRoutes(options.userAgents));
  table.push(...participantRoutes(sql, options.participantAgent ?? (() => undefined)));
  table.push(...spriteRoutes(options.sprites));
  const sockets = new Set<WebSocket>();
  /** The pages that last said they are in view (I-1). */
  const visible = new Set<WebSocket>();
  /** The pages also in front (D-128), with the conversation each has open: the helper is silent only for that one. */
  const focused = new Map<WebSocket, string | null>();
  /** The conversation each page said it has open, in view or not (D-136). */
  const openOn = new Map<WebSocket, string>();
  /** To every open page; how many it reached. */
  function broadcastNotice(notice: Notice & { kind: NoticeKind; helper?: boolean }, trial = false): number {
    const frame = JSON.stringify({
      type: 'notice',
      kind: notice.kind,
      conversationId: notice.conversationId,
      ...(trial ? { trial: true } : {}),
      ...(notice.helper === true ? { helper: true } : {}),
    });
    let reached = 0;
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      ws.send(frame);
      reached += 1;
    }
    return reached;
  }
  /**
   * The native helpers of the Mac (D-128): events sent by the server, one
   * per notice, kind and conversation id only. Same Host and Origin checks as
   * every request; the header says it is the helper, which an EventSource of
   * a page cannot send, so no page counts as one by mistake.
   */
  const helpers = new Set<ServerResponse>();
  /** The push addresses of the browsers on this Mac (D-128). */
  const macEndpoints = new Set<string>();
  function openHelperStream(request: IncomingMessage, response: ServerResponse, headers: Record<string, string>): void {
    if (request.headers['x-arianna-helper'] !== '1') {
      sendJson(response, 400, { error: 'only the helper of the Mac reads this stream' }, headers);
      return;
    }
    if (helpers.size >= MAX_HELPERS) {
      sendJson(response, 429, { error: 'too many helpers' }, headers);
      return;
    }
    response.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    response.write(': arianna\n\n');
    helpers.add(response);
    // A comment now and then: a dead connection shows up, and nothing in between closes an idle one.
    const beat = setInterval(() => response.write(': beat\n\n'), HELPER_BEAT_MS);
    response.on('close', () => {
      clearInterval(beat);
      helpers.delete(response);
    });
  }
  /** To every helper; how many it reached. */
  function noticeToHelpers(notice: Notice & { kind: NoticeKind }): number {
    const frame = `event: notice\ndata: ${JSON.stringify({ kind: notice.kind, conversationId: notice.conversationId })}\n\n`;
    let reached = 0;
    for (const response of helpers) {
      if (response.writableLength > MAX_BUFFERED_BYTES) continue;
      response.write(frame);
      reached += 1;
    }
    return reached;
  }
  let hosts = allowedHosts(options.host, options.port);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host?.toLowerCase() ?? '';
    const headers = securityHeaders(host);
    const check = checkRequest(
      { method: request.method ?? 'GET', host: request.headers.host, origin: request.headers.origin, contentType: request.headers['content-type'] },
      hosts,
    );
    if (!check.ok) {
      sendJson(response, check.status, { error: check.reason }, headers);
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/api/notifications/stream') {
      openHelperStream(request, response, headers);
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        const matches = table.map((candidate) => ({ candidate, match: candidate.pattern.exec(url.pathname) })).filter(({ match }) => match !== null);
        if (matches.length === 0) throw new HttpError(404, 'not found');
        const found = matches.find(({ candidate }) => candidate.method === request.method);
        if (found === undefined) throw new HttpError(405, 'method not allowed');
        const params: Params = {};
        found.candidate.keys.forEach((key, index) => {
          params[key] = found.match?.[index + 1] ?? '';
        });
        const result = await found.candidate.handler(request, url, params);
        if ('lines' in result) {
          await sendLines(response, result.lines, headers);
        } else if ('raw' in result) {
          response.writeHead(200, { ...headers, ...result.headers, 'content-type': result.type, 'content-length': result.raw.length, 'cache-control': result.noStore === true ? 'no-store' : 'no-cache' });
          response.end(result.raw);
        } else {
          sendJson(response, result.status ?? 200, result.body, headers);
        }
        return;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && options.staticDir !== undefined) {
        const file = await staticFile(options.staticDir, url.pathname);
        if (file !== undefined) {
          response.writeHead(200, { ...headers, 'content-type': file.type, 'content-length': file.body.length, 'cache-control': 'no-cache' });
          response.end(request.method === 'HEAD' ? undefined : file.body);
          return;
        }
      }
      throw new HttpError(404, 'not found');
    } catch (error) {
      const known = errorStatus(error);
      if (known === undefined) options.onError?.(error);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      // The rest of an oversized body is not read: close instead of draining it.
      const close: Record<string, string> = known?.status === 413 ? { connection: 'close' } : {};
      sendJson(response, known?.status ?? 500, { error: known?.message ?? 'internal error' }, { ...headers, ...close });
    }
  }

  const server: Server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    socket.on('error', () => {
      socket.destroy();
    });
    const url = new URL(request.url ?? '/', 'http://upgrade');
    const check = checkRequest(
      { method: 'GET', host: request.headers.host, origin: request.headers.origin, contentType: undefined, upgrade: true },
      hosts,
    );
    if (url.pathname !== '/api/ws' || !check.ok) {
      socket.end(`HTTP/1.1 ${url.pathname === '/api/ws' ? '403 Forbidden' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void connect(ws, url.searchParams.get('after') ?? undefined);
    });
  });

  async function connect(ws: WebSocket, after: string | undefined): Promise<void> {
    sockets.add(ws);
    // An oversized or malformed frame is reported here; without a listener it would stop the process.
    ws.on('error', () => {
      ws.terminate();
    });
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, PING_MS);
    // Nothing is accepted from the client but whether the page is in view
    // (I-1): actions go through HTTP.
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const shown = isBinary || !Buffer.isBuffer(data) ? undefined : visibilityOf(data.toString('utf8'));
      if (shown === undefined) {
        ws.close(1008, 'read-only socket');
        return;
      }
      if (shown.visible) visible.add(ws);
      else visible.delete(ws);
      if (shown.focused) focused.set(ws, shown.conversation);
      else focused.delete(ws);
      if (shown.conversation !== null) openOn.set(ws, shown.conversation);
      else openOn.delete(ws);
    });
    let stop: (() => void) | undefined;
    ws.on('close', () => {
      clearInterval(ping);
      sockets.delete(ws);
      visible.delete(ws);
      focused.delete(ws);
      openOn.delete(ws);
      stop?.();
    });
    const send = (message: LiveMessage | { type: 'ready' }): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'too far behind');
        return;
      }
      ws.send(JSON.stringify(message));
      // The closing of an incognito conversation (D-136), also from the backlog after a restart: its own frame for the chat.
      const closed = message.type === 'event' ? incognitoClosedFrame(message.event) : undefined;
      if (closed !== undefined) ws.send(JSON.stringify(closed));
    };
    try {
      stop = await live.subscribe({ send }, after);
      if (ws.readyState !== ws.OPEN) stop();
      // The backlog is out: from here on everything is live.
      else send({ type: 'ready' });
    } catch (error) {
      options.onError?.(error);
      ws.close(1011, 'internal error');
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  hosts = allowedHosts(options.host, port);

  return {
    port,
    clients: () => sockets.size,
    visiblePages: () => visible.size,
    readingPages: (conversationId) => [...focused.values()].filter((open) => open === conversationId).length,
    broadcast(notice) {
      broadcastNotice(notice);
    },
    helpers: () => helpers.size,
    macEndpoints: () => macEndpoints,
    notifyHelpers: (notice) => noticeToHelpers(notice),
    pagesOn: (conversationId) => [...openOn.values()].filter((open) => open === conversationId).length,
    incognitoClosing(conversationId, inSeconds) {
      const frame = JSON.stringify({ type: 'conversation.incognito-closing', conversationId, inSeconds });
      for (const ws of sockets) {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
        ws.send(frame);
      }
    },
    async close() {
      for (const response of helpers) response.end();
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}
