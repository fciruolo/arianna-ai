import { isDeepStrictEqual } from 'node:util';

import type { VoiceConfig } from '@arianna/config';

import { VoiceError, type VoiceService, type VoiceState } from './service.ts';

export interface VoiceSwitchOptions {
  /** The service of this port, not started yet (the core: apps/voice in its venv). */
  createService: (port: number) => VoiceService;
  /** A call is ringing, connecting or active: the service is not touched until it ends. */
  busy: () => Promise<boolean>;
  /** `[voice]` changed while the core runs (not at `begin`): the event log. */
  onChange?: (config: VoiceConfig | undefined) => void;
  /** What changed was applied: the service of `config` is in place. */
  onApplied?: (config: VoiceConfig | undefined) => void;
  onError: (error: unknown) => void;
  /** How often a change waiting for a call to end is tried again; 5 s by default. */
  retryMs?: number;
}

export interface VoiceSwitch {
  /**
   * The service in place, for calls, ringer and API: `off` without `[voice]`,
   * `starting` while it is being replaced. It never changes identity, so the
   * ones holding it see the replacement.
   */
  readonly service: VoiceFacade;
  /**
   * Applies `[voice]` (D-071): a new port, or the section turned on or off,
   * restarts apps/voice once no call is in progress: the call ends with the
   * old values. The rest of the section (voice, limits, outgoing rules) is
   * read at each use and needs nothing here; `[voice.push]` belongs to the
   * push switch since D-292. Ignored before `begin`.
   */
  sync(config: VoiceConfig | undefined): void;
  /** Starts applying changes, from this configuration; resolves once it is applied. */
  begin(config: VoiceConfig | undefined): Promise<void>;
  /** Stops the service, after a change in progress; later changes are ignored. */
  close(): Promise<void>;
}

/** The service in place, as calls, ringer and API see it. */
export interface VoiceFacade extends Pick<VoiceService, 'state' | 'request'> {
  /**
   * Runs `work`, the check of `state` and the row of a new call, so that a
   * replacement of the service never falls in between: it waits for `work`.
   */
  hold<T>(work: () => Promise<T>): Promise<T>;
}

/** What restarts apps/voice: the section on or off, and its port. */
function servicePart(config: VoiceConfig | undefined): number | undefined {
  return config?.port;
}

/** apps/voice turned on, off or moved while the core runs (D-066, D-071). */
export function createVoiceSwitch(options: VoiceSwitchOptions): VoiceSwitch {
  const retryMs = options.retryMs ?? 5000;
  let ready = false;
  let closing = false;
  let service: VoiceService | undefined;
  // What is in place, and what the file asks for.
  let applied: number | undefined;
  let wanted: VoiceConfig | undefined;
  let reported: VoiceConfig | undefined;
  // While the service is replaced, no new call starts on it.
  let switching = false;
  let retry: NodeJS.Timeout | undefined;
  // One change at a time.
  let queue: Promise<void> = Promise.resolve();

  // Calls being opened: between the check of the state and the row of the call.
  // `close` may come during any wait of a change: read it after each one.
  const closed = (): boolean => closing;
  let opening = 0;
  let opened: (() => void) | undefined;

  function later(): void {
    retry ??= setTimeout(() => {
      retry = undefined;
      void apply(false);
    }, retryMs);
    retry.unref();
  }

  async function step(initial: boolean): Promise<void> {
    if (closing) return;
    const next = wanted;
    const sameService = isDeepStrictEqual(servicePart(next), applied);
    if (!initial && !isDeepStrictEqual(next, reported)) options.onChange?.(next);
    reported = next;
    if (sameService) return;
    // New calls are refused first; the ones already past the check write their
    // row (`hold`); only then a call in progress is looked for.
    switching = true;
    while (opening > 0) {
      await new Promise<void>((resolve) => {
        opened = resolve;
      });
    }
    let busy: boolean;
    try {
      busy = await options.busy();
    } catch (error) {
      switching = false;
      later();
      throw error;
    }
    if (busy || closed()) {
      switching = false;
      if (busy) later();
      return;
    }
    const was = service;
    service = undefined;
    try {
      await was?.stop();
    } catch (error) {
      options.onError(error);
    }
    if (next !== undefined && !closed()) service = options.createService(next.port);
    applied = servicePart(next);
    switching = false;
    if (closed()) return;
    options.onApplied?.(next);
    // Started last and not awaited by the queue: loading may take a while, and a later change stops it.
    if (service !== undefined) service.start().catch(options.onError);
  }

  function apply(initial: boolean): Promise<void> {
    queue = queue.then(() => step(initial)).catch((error: unknown) => {
      switching = false;
      options.onError(error);
    });
    return queue;
  }

  const facade: VoiceSwitch['service'] = {
    get state(): VoiceState {
      if (switching) return 'starting';
      return service?.state ?? 'off';
    },
    // Refused only without a service: a call in progress keeps talking to it while a change waits.
    request(method, path, request) {
      if (service === undefined) return Promise.reject(new VoiceError('off'));
      return service.request(method, path, request);
    },
    async hold(work) {
      opening += 1;
      try {
        return await work();
      } finally {
        opening -= 1;
        if (opening === 0) {
          opened?.();
          opened = undefined;
        }
      }
    },
  };

  return {
    service: facade,
    sync(config) {
      if (!ready) return;
      wanted = config;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      void apply(false);
    },
    begin(config) {
      ready = true;
      wanted = config;
      return apply(true);
    },
    async close() {
      closing = true;
      if (retry !== undefined) clearTimeout(retry);
      await queue;
      const was = service;
      service = undefined;
      await was?.stop();
    },
  };
}
