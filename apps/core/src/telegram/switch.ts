import { isDeepStrictEqual } from 'node:util';

import type { TelegramConfig } from '@arianna/config';

/** What the switch opens and closes: a running bot. */
export interface RunningBot {
  close(): Promise<void>;
}

export interface TelegramSwitchOptions {
  /** Opens the bot of this configuration; a rejection leaves Telegram off. */
  start: (config: TelegramConfig) => Promise<RunningBot>;
  /** `[telegram]` changed while the core runs (not at `begin`), before the attempt: the event log. */
  onChange?: (config: TelegramConfig | undefined) => void;
  /** The bot is up (`true`), or down (`false`): turned off, or its start failed (with the configuration it had). */
  onState?: (on: boolean, config: TelegramConfig | undefined) => void;
  onError: (error: unknown) => void;
}

export interface TelegramSwitch {
  /**
   * Applies `[telegram]` (D-071): the bot opens, closes or restarts with the
   * new chats, one change at a time. Ignored before `begin`, which reads the
   * configuration of that moment anyway.
   */
  sync(config: TelegramConfig | undefined): void;
  /** Starts applying changes, from this configuration; resolves once it is applied. */
  begin(config: TelegramConfig | undefined): Promise<void>;
  /** Closes the bot, after a start in progress; later changes are ignored. */
  close(): Promise<void>;
}

/**
 * Telegram on, off or changed while the core runs (task 1.15, D-044, D-071).
 * A failed start is tried again at the next change of the section.
 */
export function createTelegramSwitch(options: TelegramSwitchOptions): TelegramSwitch {
  let ready = false;
  let closing = false;
  let bot: RunningBot | undefined;
  let applied: TelegramConfig | undefined;
  // One change at a time: a bot is closed before the next one starts.
  let queue: Promise<void> = Promise.resolve();

  function apply(next: TelegramConfig | undefined, initial: boolean): Promise<void> {
    queue = queue
      .then(async () => {
        if (closing || isDeepStrictEqual(next, applied)) return;
        if (!initial) options.onChange?.(next);
        const was = bot;
        bot = undefined;
        applied = next;
        if (was !== undefined) await was.close();
        if (next === undefined) {
          if (was !== undefined) options.onState?.(false, undefined);
          return;
        }
        try {
          // A close during the start waits for this queue, then closes the bot.
          bot = await options.start(next);
          options.onState?.(true, next);
        } catch (error) {
          // Off until the section changes again: then it is tried once more.
          applied = undefined;
          options.onError(error);
          options.onState?.(false, next);
        }
      })
      .catch(options.onError);
    return queue;
  }

  return {
    sync(config) {
      if (ready) void apply(config, false);
    },
    begin(config) {
      ready = true;
      return apply(config, true);
    },
    async close() {
      closing = true;
      await queue;
      const was = bot;
      bot = undefined;
      await was?.close();
    },
  };
}
