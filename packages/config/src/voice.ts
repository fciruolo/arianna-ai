import { join } from 'node:path';

import { asInteger, asString, asTable, asVaultRef, ConfigError, onlyKeys } from './validate.ts';

/**
 * Calls over the internet (D-066): `[voice]` of arianna.toml. Absent: the core
 * does not start apps/voice and the chat offers no call. The models come from
 * `[roles]` (`stt`, `tts`, and `voice` for the replies); this section holds the
 * service, the limits and the rules for the calls Arianna makes. A restart
 * applies a change.
 */
export interface VoiceConfig {
  /** Loopback port of apps/voice; only the core talks to it. */
  port: number;
  /** The voice of the tts model (D-067): Kokoro "if_sara", Voxtral "it_female", a Qwen3-TTS speaker. Missing on that model: its first voice. */
  voice: string;
  limits: VoiceLimits;
  outgoing: OutgoingRules;
  /** Web Push (D-066): absent, a call while the chat is closed only leaves a written message. */
  push?: PushConfig;
}

export interface VoiceLimits {
  callMinutes: number;
  /** A spoken notice this long before the end of a call. */
  warnSeconds: number;
  /** Delegations to Arianna's task within one call. */
  delegations: number;
  /** How long the call waits for a delegation; past it the work goes on as a task. */
  delegationSeconds: number;
}

export interface OutgoingRules {
  maxPerDay: number;
  /** Quiet hours, "HH:MM" local time; `from` after `to` spans midnight. Equal: no quiet hours. */
  quietFrom: string;
  quietTo: string;
  /** No call on Saturday and Sunday, except the ones the user scheduled. */
  quietWeekend: boolean;
  /** How long a call rings before Arianna leaves a written message instead. */
  ringSeconds: number;
  /** A task waiting for the user this long makes Arianna call. */
  waitingMinutes: number;
}

export interface PushConfig {
  /** VAPID public key: the uncompressed P-256 point, base64url (65 bytes). */
  publicKey: string;
  /** `vault://name` of the VAPID private key (the 32-byte scalar, base64url). */
  privateKey: string;
  /** Contact for the push services: `mailto:` or `https:`. */
  subject: string;
}

export const DEFAULT_VOICE: VoiceConfig = {
  port: 7421,
  voice: 'if_sara',
  limits: { callMinutes: 15, warnSeconds: 60, delegations: 6, delegationSeconds: 90 },
  outgoing: { maxPerDay: 3, quietFrom: '21:00', quietTo: '08:00', quietWeekend: true, ringSeconds: 30, waitingMinutes: 30 },
};

/** Push key reference (key `vapid-private-key` in the vault). */
export const VAPID_PRIVATE_KEY_REF = 'vault://vapid-private-key';

const VOICE_ID = /^[a-z][a-z0-9_]{1,40}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function parseVoice(value: unknown): VoiceConfig | undefined {
  if (value === undefined) return undefined;
  const voice = asTable(value, 'voice');
  onlyKeys(voice, ['port', 'voice', 'limits', 'outgoing', 'push'], 'voice');
  const name = voice.voice === undefined ? DEFAULT_VOICE.voice : asString(voice.voice, 'voice.voice');
  if (!VOICE_ID.test(name)) throw new ConfigError('voice.voice: a voice of the tts model, e.g. "if_sara" or "it_female"');
  const push = parsePush(voice.push);
  return {
    port: voice.port === undefined ? DEFAULT_VOICE.port : asInteger(voice.port, 'voice.port', 1024, 65535),
    voice: name,
    limits: parseLimits(voice.limits),
    outgoing: parseOutgoing(voice.outgoing),
    ...(push === undefined ? {} : { push }),
  };
}

function parseLimits(value: unknown): VoiceLimits {
  const defaults = DEFAULT_VOICE.limits;
  if (value === undefined) return { ...defaults };
  const table = asTable(value, 'voice.limits');
  onlyKeys(table, ['call_minutes', 'warn_seconds', 'delegations', 'delegation_seconds'], 'voice.limits');
  const limits = {
    callMinutes: table.call_minutes === undefined ? defaults.callMinutes : asInteger(table.call_minutes, 'voice.limits.call_minutes', 1, 120),
    warnSeconds: table.warn_seconds === undefined ? defaults.warnSeconds : asInteger(table.warn_seconds, 'voice.limits.warn_seconds', 0, 600),
    delegations: table.delegations === undefined ? defaults.delegations : asInteger(table.delegations, 'voice.limits.delegations', 0, 50),
    delegationSeconds:
      table.delegation_seconds === undefined ? defaults.delegationSeconds : asInteger(table.delegation_seconds, 'voice.limits.delegation_seconds', 5, 600),
  };
  if (limits.warnSeconds >= limits.callMinutes * 60) throw new ConfigError('voice.limits.warn_seconds: must be shorter than the call');
  return limits;
}

function clock(value: unknown, where: string): string {
  const text = asString(value, where);
  if (!CLOCK.test(text)) throw new ConfigError(`${where}: expected "HH:MM", e.g. "21:00"`);
  return text;
}

function parseOutgoing(value: unknown): OutgoingRules {
  const defaults = DEFAULT_VOICE.outgoing;
  if (value === undefined) return { ...defaults };
  const table = asTable(value, 'voice.outgoing');
  onlyKeys(table, ['max_per_day', 'quiet_from', 'quiet_to', 'quiet_weekend', 'ring_seconds', 'waiting_minutes'], 'voice.outgoing');
  if (table.quiet_weekend !== undefined && typeof table.quiet_weekend !== 'boolean') {
    throw new ConfigError('voice.outgoing.quiet_weekend: expected true or false');
  }
  return {
    maxPerDay: table.max_per_day === undefined ? defaults.maxPerDay : asInteger(table.max_per_day, 'voice.outgoing.max_per_day', 0, 50),
    quietFrom: table.quiet_from === undefined ? defaults.quietFrom : clock(table.quiet_from, 'voice.outgoing.quiet_from'),
    quietTo: table.quiet_to === undefined ? defaults.quietTo : clock(table.quiet_to, 'voice.outgoing.quiet_to'),
    quietWeekend: table.quiet_weekend ?? defaults.quietWeekend,
    ringSeconds: table.ring_seconds === undefined ? defaults.ringSeconds : asInteger(table.ring_seconds, 'voice.outgoing.ring_seconds', 5, 300),
    waitingMinutes:
      table.waiting_minutes === undefined ? defaults.waitingMinutes : asInteger(table.waiting_minutes, 'voice.outgoing.waiting_minutes', 1, 1440),
  };
}

function parsePush(value: unknown): PushConfig | undefined {
  if (value === undefined) return undefined;
  const table = asTable(value, 'voice.push');
  onlyKeys(table, ['public_key', 'private_key', 'subject'], 'voice.push');
  const publicKey = asString(table.public_key, 'voice.push.public_key');
  // 65 bytes in base64url without padding are 87 characters, starting with 0x04 ("B").
  if (!BASE64URL.test(publicKey) || publicKey.length !== 87 || !publicKey.startsWith('B')) {
    throw new ConfigError('voice.push.public_key: the uncompressed P-256 public key, base64url (pnpm voice:vapid)');
  }
  const subject = asString(table.subject, 'voice.push.subject');
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(subject) && !/^https:\/\/\S+$/.test(subject)) {
    throw new ConfigError('voice.push.subject: a mailto: address or an https: URL');
  }
  return { publicKey, privateKey: asVaultRef(table.private_key, 'voice.push.private_key'), subject };
}

/** Where apps/voice lives on disk, everything inside ARIANNA_HOME (D-066). */
export interface VoicePaths {
  /** The Python sources, run with PYTHONPATH. */
  src: string;
  /** The uv project: pyproject.toml and uv.lock. */
  project: string;
  /** The environment `uv sync` builds, and its interpreter. */
  venv: string;
  python: string;
  /** Python installs and download cache of uv. */
  uvPython: string;
  uvCache: string;
  /** Private scratch files and log of the service. */
  tmp: string;
  /** Model weights, shared with the catalog: data/models/<id>. */
  models: string;
  /** Voices copied from a sample (D-069): data/voice/voices/<id>, L2, never in git. */
  clones: string;
}

export function voicePaths(home: string, data: string): VoicePaths {
  const root = join(data, 'voice');
  const venv = join(root, 'venv');
  return {
    src: join(home, 'apps', 'voice', 'src'),
    project: join(home, 'apps', 'voice'),
    venv,
    python: join(venv, 'bin', 'python'),
    uvPython: join(root, 'python'),
    uvCache: join(root, 'cache'),
    tmp: join(root, 'tmp'),
    models: join(data, 'models'),
    clones: join(root, 'voices'),
  };
}

/** The variables that keep uv inside data/voice; merged into a clean environment. */
export function uvEnvironment(paths: VoicePaths): Record<string, string> {
  return {
    UV_PROJECT_ENVIRONMENT: paths.venv,
    UV_PYTHON_INSTALL_DIR: paths.uvPython,
    UV_CACHE_DIR: paths.uvCache,
    // The interpreter uv downloads into data/voice, never one of the machine.
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_CONFIG: '1',
  };
}
