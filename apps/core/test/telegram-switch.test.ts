import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TelegramConfig } from '@arianna/config';

import { createTelegramSwitch, type RunningBot } from '../src/telegram/switch.ts';

const ONE: TelegramConfig = { token: 'vault://telegram-bot-token', chats: [1] };
const TWO: TelegramConfig = { token: 'vault://telegram-bot-token', chats: [1, 2] };

/** A switch on fake bots: `log` lists what happened, in order. */
function fake(options: { fail?: (config: TelegramConfig) => boolean; slowStart?: Promise<void> } = {}) {
  const log: string[] = [];
  const errors: unknown[] = [];
  const telegram = createTelegramSwitch({
    start: async (config): Promise<RunningBot> => {
      const name = `bot${String(config.chats.length)}`;
      log.push(`start ${name}`);
      await options.slowStart;
      if (options.fail?.(config) === true) throw new Error('no token');
      return {
        close: () => {
          log.push(`close ${name}`);
          return Promise.resolve();
        },
      };
    },
    onChange: (config) => log.push(`event ${config === undefined ? 'off' : String(config.chats.length)}`),
    onState: (on) => log.push(on ? 'on' : 'off'),
    onError: (error) => errors.push(error),
  });
  return { telegram, log, errors };
}

/** Lets the queue of the switch run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('changes before begin are ignored: begin opens the configuration of that moment, without an event', async () => {
  const { telegram, log } = fake();
  telegram.sync(TWO);
  await settle();
  assert.deepEqual(log, []);
  await telegram.begin(ONE);
  assert.deepEqual(log, ['start bot1', 'on']);
  await telegram.close();
});

test('a change closes the old bot before the new one starts; off closes it; each change is an event', async () => {
  const { telegram, log } = fake();
  await telegram.begin(ONE);
  telegram.sync(TWO);
  telegram.sync(TWO);
  telegram.sync(undefined);
  await settle();
  assert.deepEqual(log, ['start bot1', 'on', 'event 2', 'close bot1', 'start bot2', 'on', 'event off', 'close bot2', 'off']);
  await telegram.close();
});

test('a failed start leaves Telegram off and is tried again at the next change', async () => {
  let failing = true;
  const { telegram, log, errors } = fake({ fail: () => failing });
  await telegram.begin(ONE);
  assert.deepEqual(log, ['start bot1', 'off']);
  assert.equal(errors.length, 1);
  failing = false;
  telegram.sync(ONE);
  await settle();
  assert.deepEqual(log.slice(2), ['event 1', 'start bot1', 'on']);
  await telegram.close();
});

test('close waits for a start in progress, then closes that bot; later changes are ignored', async () => {
  let release = (): void => undefined;
  const slowStart = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { telegram, log } = fake({ slowStart });
  const begun = telegram.begin(ONE);
  await settle();
  assert.deepEqual(log, ['start bot1'], 'the start is in progress');
  const closed = telegram.close();
  release();
  await begun;
  await closed;
  telegram.sync(TWO);
  await settle();
  assert.deepEqual(log, ['start bot1', 'on', 'close bot1']);
});

test('a close before the start begins opens nothing', async () => {
  const { telegram, log } = fake();
  const begun = telegram.begin(ONE);
  await telegram.close();
  await begun;
  assert.deepEqual(log, []);
});
