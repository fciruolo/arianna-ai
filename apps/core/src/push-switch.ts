import { isDeepStrictEqual } from 'node:util';

import type { PushConfig } from '@arianna/config';

import type { Pusher } from './voice/push.ts';

/**
 * Web Push (D-066), on its own since D-292: the notifications of the chat
 * reach the phone with the voice service off too. `[push]` (or `[voice.push]`)
 * turned on, off or changed applies without a restart; only the fixed
 * sentences of `PUSH_TEXTS` ever leave.
 */
export interface PushSwitchOptions {
  /** The pusher of these keys; a rejection leaves Web Push off until they change. */
  createPusher: (push: PushConfig) => Promise<Pusher>;
  /** What changed was applied: `pusher` says whether Web Push is on. */
  onApplied?: (config: PushConfig | undefined, pusher: boolean) => void;
  onError: (error: unknown) => void;
}

export interface PushSwitch {
  /** The pusher in place; undefined without keys or when the private key could not be read. */
  pusher(): Pusher | undefined;
  /** Applies new keys, or none; the same keys again do nothing. Ignored before `begin`. */
  sync(config: PushConfig | undefined): void;
  /** Starts from this configuration; resolves once it is applied. */
  begin(config: PushConfig | undefined): Promise<void>;
  /** Later changes are ignored; the pusher is dropped. */
  close(): Promise<void>;
}

export function createPushSwitch(options: PushSwitchOptions): PushSwitch {
  let ready = false;
  let closing = false;
  let pusher: Pusher | undefined;
  let applied: PushConfig | undefined;
  let first = true;
  // `close` may come during the wait for a key: read it after it.
  const closed = (): boolean => closing;
  // One change at a time, in the order they came.
  let queue: Promise<void> = Promise.resolve();

  async function step(next: PushConfig | undefined): Promise<void> {
    if (closing) return;
    if (!first && isDeepStrictEqual(next, applied)) return;
    first = false;
    pusher = undefined;
    applied = next;
    if (next !== undefined) {
      try {
        const created = await options.createPusher(next);
        // `close` came during the wait: nothing is put in place any more.
        if (closed()) return;
        pusher = created;
      } catch (error) {
        options.onError(error);
      }
    }
    if (closed()) return;
    options.onApplied?.(next, pusher !== undefined);
  }

  function apply(next: PushConfig | undefined): Promise<void> {
    queue = queue.then(() => step(next)).catch(options.onError);
    return queue;
  }

  return {
    pusher: () => pusher,
    sync(config) {
      if (!ready) return;
      void apply(config);
    },
    begin(config) {
      ready = true;
      return apply(config);
    },
    async close() {
      closing = true;
      await queue;
      pusher = undefined;
    },
  };
}
