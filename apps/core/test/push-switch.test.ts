import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PushConfig } from '@arianna/config';

import { createPushSwitch } from '../src/push-switch.ts';
import type { Pusher } from '../src/voice/push.ts';

const PUSH: PushConfig = { publicKey: `B${'a'.repeat(86)}`, privateKey: 'vault://vapid-private-key', subject: 'mailto:test@example.com' };
const OTHER: PushConfig = { ...PUSH, subject: 'https://example.org' };

function fake(options: { fail?: boolean } = {}) {
  const log: string[] = [];
  const errors: unknown[] = [];
  const push = createPushSwitch({
    createPusher: (config): Promise<Pusher> => {
      log.push(`pusher ${config.subject}`);
      if (options.fail === true) return Promise.reject(new Error('no key'));
      return Promise.resolve({ publicKey: config.publicKey, subscribe: () => Promise.resolve(), unsubscribe: () => Promise.resolve(), notify: () => Promise.resolve(0) });
    },
    onApplied: (config, on) => log.push(`applied ${config === undefined ? 'none' : config.subject} ${on ? 'on' : 'off'}`),
    onError: (error) => errors.push(error),
  });
  return { push, log, errors };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('D-292: Web Push stands on its own keys, without the voice service', async () => {
  const { push, log } = fake();
  await push.begin(PUSH);
  assert.equal(push.pusher()?.publicKey, PUSH.publicKey);
  assert.deepEqual(log, ['pusher mailto:test@example.com', 'applied mailto:test@example.com on']);
  await push.close();
  assert.equal(push.pusher(), undefined);
});

test('without keys there is no pusher; the same keys again change nothing; new keys replace it', async () => {
  const { push, log } = fake();
  await push.begin(undefined);
  assert.equal(push.pusher(), undefined);
  push.sync(PUSH);
  await settle();
  push.sync(structuredClone(PUSH));
  await settle();
  push.sync(OTHER);
  await settle();
  assert.equal(push.pusher()?.publicKey, OTHER.publicKey);
  push.sync(undefined);
  await settle();
  assert.equal(push.pusher(), undefined);
  assert.deepEqual(log, [
    'applied none off',
    'pusher mailto:test@example.com',
    'applied mailto:test@example.com on',
    'pusher https://example.org',
    'applied https://example.org on',
    'applied none off',
  ]);
  await push.close();
});

test('changes before begin are ignored; a key that cannot be read leaves push off and is reported', async () => {
  const { push, log, errors } = fake({ fail: true });
  push.sync(PUSH);
  await settle();
  assert.deepEqual(log, []);
  await push.begin(PUSH);
  assert.equal(push.pusher(), undefined);
  assert.equal(errors.length, 1);
  assert.deepEqual(log, ['pusher mailto:test@example.com', 'applied mailto:test@example.com off']);
  await push.close();
  push.sync(OTHER);
  await settle();
  assert.equal(log.length, 2, 'closed: nothing more');
});

test('close while the key is being read: no pusher is put in place, nothing applied', async () => {
  let release: (() => void) | undefined;
  const log: string[] = [];
  const push = createPushSwitch({
    createPusher: (config) =>
      new Promise<Pusher>((resolve) => {
        release = () => {
          resolve({ publicKey: config.publicKey, subscribe: () => Promise.resolve(), unsubscribe: () => Promise.resolve(), notify: () => Promise.resolve(0) });
        };
      }),
    onApplied: () => log.push('applied'),
    onError: () => log.push('error'),
  });
  const begun = push.begin(PUSH);
  await settle();
  const closed = push.close();
  release?.();
  await begun;
  await closed;
  assert.equal(push.pusher(), undefined);
  assert.deepEqual(log, []);
});
