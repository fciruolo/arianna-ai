import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { VoicePaths } from '@arianna/config';
import { localRequestBytes, Watchdog, type HttpBytesResponse, type WatchdogEvent, type WatchdogState } from '@arianna/executors';

import { cleanChildEnv } from '../child-env.ts';
import { removeLeftovers } from './clones.ts';

/**
 * apps/voice, started and watched by the core (D-066). The service listens on
 * 127.0.0.1 and answers only requests with the token generated here at each
 * start; it exits when its standard input closes, so it dies with the core.
 * The environment is built from nothing: no database password, no age key of
 * sops, no proxy, and Hugging Face offline (the weights come from the catalog).
 */
export type VoiceState = 'not-installed' | WatchdogState;

export interface VoiceServiceOptions {
  paths: VoicePaths;
  port: number;
  /** Output of the service, in data/ (it may name files, never transcripts: the service logs codes only). */
  logFile?: string;
  /** Tests run a fake service; the core runs the venv's Python. */
  command?: readonly string[];
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: WatchdogEvent) => void;
  /** Watchdog timings, shortened by the tests. */
  timing?: { intervalMs?: number; startupTimeoutMs?: number; backoffMs?: number; stopGraceMs?: number };
}

export interface VoiceService {
  readonly state: VoiceState;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A request to the service with its token; the caller checks the status. */
  request(method: 'GET' | 'POST' | 'DELETE', path: string, options?: { json?: unknown; timeoutMs?: number; maxBytes?: number }): Promise<HttpBytesResponse>;
}

/** The only variables of the core the service inherits. */
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG'] as const;

export function voiceEnv(from: NodeJS.ProcessEnv, paths: VoicePaths, port: number, token: string): Record<string, string> {
  return {
    // No network beyond loopback: a library that tries to download or report
    // anything goes to a closed port and fails.
    ...cleanChildEnv(from, INHERITED),
    PYTHONPATH: paths.src,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    TMPDIR: paths.tmp,
    // Caches of the libraries inside data/, never in the user's cache folder.
    XDG_CACHE_HOME: join(paths.tmp, 'cache'),
    NUMBA_CACHE_DIR: join(paths.tmp, 'numba'),
    HF_HOME: join(paths.tmp, 'hf'),
    ARIANNA_VOICE_PORT: String(port),
    ARIANNA_VOICE_TOKEN: token,
    ARIANNA_MODELS_DIR: paths.models,
    ARIANNA_VOICE_TMP: paths.tmp,
    ARIANNA_VOICE_CLONES: paths.clones,
  };
}

export class VoiceError extends Error {
  override name = 'VoiceError';
  readonly code: 'off' | 'unreachable';

  constructor(code: 'off' | 'unreachable') {
    super(`voice ${code}`);
    this.code = code;
  }
}

export function createVoiceService(options: VoiceServiceOptions): VoiceService {
  const { paths, port } = options;
  const token = randomBytes(32).toString('base64url');
  const url = `http://127.0.0.1:${String(port)}`;
  const command = options.command ?? [paths.python, '-m', 'arianna_voice'];
  const installed = options.command !== undefined || existsSync(paths.python);
  let watchdog: Watchdog | undefined;

  return {
    get state(): VoiceState {
      if (!installed) return 'not-installed';
      return watchdog?.state ?? 'idle';
    },

    async start() {
      if (!installed || watchdog !== undefined) return;
      mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });
      mkdirSync(paths.clones, { recursive: true, mode: 0o700 });
      removeLeftovers(paths.clones);
      watchdog = new Watchdog({
        id: 'voice',
        url,
        command,
        cwd: paths.project,
        env: voiceEnv(options.env ?? process.env, paths, port, token),
        stdin: 'pipe',
        healthPath: '/health',
        healthHeaders: { authorization: `Bearer ${token}` },
        ...(options.logFile === undefined ? {} : { logFile: options.logFile }),
        // The models load on the first request, not at start: a few seconds are enough.
        startupTimeoutMs: options.timing?.startupTimeoutMs ?? 30_000,
        ...(options.timing?.intervalMs === undefined ? {} : { intervalMs: options.timing.intervalMs }),
        ...(options.timing?.backoffMs === undefined ? {} : { backoffMs: options.timing.backoffMs }),
        ...(options.timing?.stopGraceMs === undefined ? {} : { stopGraceMs: options.timing.stopGraceMs }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      await watchdog.start();
    },

    async stop() {
      await watchdog?.stop();
    },

    async request(method, path, { json, timeoutMs = 120_000, maxBytes } = {}) {
      if (watchdog === undefined || !watchdog.isAvailable()) throw new VoiceError('off');
      try {
        return await localRequestBytes(`${url}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          signal: AbortSignal.timeout(timeoutMs),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        });
      } catch (error) {
        watchdog.reportFailure();
        throw Object.assign(new VoiceError('unreachable'), { cause: error });
      }
    },
  };
}
