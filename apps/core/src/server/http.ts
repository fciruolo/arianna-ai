import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import type { CharacterChoices } from '@arianna/config';

import { listApprovals, loadApproval, type ApprovalState } from '../approvals.ts';
import { assignCharacters, listPacks, readSheet, type CharacterDirs } from '../characters.ts';
import {
  archiveConversation,
  ChatError,
  createConversation,
  DIRECT_MODELS,
  isUuid,
  listConversations,
  listMessages,
  loadConversation,
  postUserMessage,
  purgeConversation,
  renameConversation,
  setConversationModel,
} from '../conversations.ts';
import type { Sql } from '../db/client.ts';
import { recordDecision, retryTask } from '../engine.ts';
import { loadFailure } from '../failures.ts';
import type { LiveFeed, LiveMessage } from '../live.ts';
import type { LocalServerStatus } from '../local-servers.ts';
import { SettingsError, type SettingsPage } from '../settings-page.ts';
import { loadStatus } from '../status.ts';
import { attachQuestion, openFailureChat } from '../system-chats.ts';
import { loadTask, TaskError } from '../tasks.ts';
import { CallError, listCalls, liveCall, type CallEndReason, type Calls } from '../voice/calls.ts';
import { parseSubscription, PushError, type Pusher } from '../voice/push.ts';
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
  /** The settings page (D-071): arianna.toml read and written with its fingerprint. */
  settings?: SettingsPage;
  /** The local servers the core watches (D-071): state, restart, end of the log. */
  local?: LocalApi;
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
}

export interface ApiServer {
  /** The bound port, useful with port 0 in tests. */
  readonly port: number;
  /** Pages holding the live feed now: with none, a call of Arianna rings by Web Push (D-066). */
  clients(): number;
  close(): Promise<void>;
}

// A message of MAX_MESSAGE_LENGTH 4-byte characters, JSON-escaped, fits.
export const MAX_BODY_BYTES = 128 * 1024;
/** A client that reads this far behind is dropped; it catches up on reconnection. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
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
      return { status: 201, body: await need().start(conversationId, { sdp, type }) };
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
      const { conversationId, at } = body;
      if (typeof conversationId !== 'string' || !isUuid(conversationId) || typeof at !== 'string') throw new HttpError(400, 'conversationId and at (ISO time) are required');
      return { status: 201, body: { call: await scheduleCall(sql, conversationId, new Date(at)) } };
    }),
    route('POST', '/api/tasks/:id/call-when-done', async (request, _url, params) => {
      onlyFields(await readJson(request), []);
      need();
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
    route('GET', '/api/settings', () => Promise.resolve({ body: { ...need().read(), local: local?.status() ?? [] } })),
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

function routes(sql: Sql, { projects, models, defaultModel, agents, characters, voice, calls, pusher, settings, local, onError }: RouteOptions): Route[] {
  return [
    ...voiceRoutes(voice),
    ...settingsRoutes(settings, local, onError),
    ...callRoutes(sql, voice, calls, pusher),
    route('GET', '/api/health', () => Promise.resolve({ body: { ok: true } })),

    // The status panel (D-060): agents, last router decision, gateway today. Counts and labels only.
    route('GET', '/api/status', async () => ({ body: await loadStatus(sql, agents()) })),

    // The character packs and who wears what. Refused folders are named with the reason, never their content.
    route('GET', '/api/characters', async () => {
      if (characters === undefined) return { body: { packs: [], refused: [], agents: {} } };
      const { packs, refused } = await listPacks(characters.dirs);
      return { body: { packs, refused, agents: assignCharacters(agents(), characters.choices(), packs) } };
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

    route('POST', '/api/conversations', async (request) => {
      const body = await readJson(request);
      onlyFields(body, ['mode', 'project']);
      if (body.mode !== 'work' && body.mode !== 'private') throw new HttpError(400, 'mode must be work or private');
      if (body.project !== undefined && typeof body.project !== 'string') throw new HttpError(400, 'project must be a string');
      // A work conversation starts with the user's default model, while this installation offers it:
      // this check, against what the selector offers, is the one that counts.
      const model = body.mode === 'work' ? defaultModel() : undefined;
      const conversation = await createConversation(sql, {
        mode: body.mode,
        ...(body.project === undefined ? {} : { project: body.project }),
        projects: projects().map((project) => project.name),
        ...(model !== undefined && models().some((entry) => entry.model === model) ? { model } : {}),
      });
      return { status: 201, body: { conversation } };
    }),

    route('GET', '/api/conversations/:id', async (_request, _url, params) => {
      const conversation = await loadConversation(sql, idParam(params, 'id'));
      if (conversation === undefined) throw new HttpError(404, 'not found');
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

    // Deletes the texts of an archived conversation for good (D-057): the user confirmed it in the page.
    route('POST', '/api/conversations/:id/purge', async (request, _url, params) => {
      const id = idParam(params, 'id');
      onlyFields(await readJson(request), []);
      await purgeConversation(sql, id);
      return { body: { purged: id } };
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
      const { message, task } = await postUserMessage(sql, id, body.body);
      return { status: 201, body: { message, task } };
    }),

    route('GET', '/api/tasks/:id', async (_request, _url, params) => {
      const task = await loadTask(sql, idParam(params, 'id'));
      if (task === undefined) throw new HttpError(404, 'not found');
      return { body: { task } };
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
      return { body: { approvals: await listApprovals(sql, known, limitParam(url)) } };
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
    const status = error.code === 'not-found' ? 404 : error.code === 'scanner' ? 422 : error.code === 'archived' || error.code === 'busy' ? 409 : 400;
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
  if (error instanceof VoiceError) return { status: 503, message: error.code === 'off' ? 'voice not ready' : 'voice unreachable' };
  return undefined;
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
    onError: options.onError ?? (() => undefined),
  });
  const sockets = new Set<WebSocket>();
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
    // Nothing is accepted from the client: actions go through HTTP.
    ws.on('message', () => {
      ws.close(1008, 'read-only socket');
    });
    let stop: (() => void) | undefined;
    ws.on('close', () => {
      clearInterval(ping);
      sockets.delete(ws);
      stop?.();
    });
    const send = (message: LiveMessage | { type: 'ready' }): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'too far behind');
        return;
      }
      ws.send(JSON.stringify(message));
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
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}
