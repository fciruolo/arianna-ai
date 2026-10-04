import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_VOICE, type PushConfig, type VoiceConfig } from '@arianna/config';

import type { Pusher } from '../src/voice/push.ts';
import { VoiceError, type VoiceService, type VoiceState } from '../src/voice/service.ts';
import { createVoiceSwitch } from '../src/voice/switch.ts';

const PUSH: PushConfig = { publicKey: `B${'a'.repeat(86)}`, privateKey: 'vault://vapid-private-key', subject: 'mailto:test@example.com' };
const ON: VoiceConfig = structuredClone(DEFAULT_VOICE);

/** A switch on fake services and pushers: `log` lists what happened, in order. */
function fake(options: { busy?: () => boolean | Promise<boolean>; failPush?: boolean; failStop?: boolean } = {}) {
  const log: string[] = [];
  const errors: unknown[] = [];
  const voice = createVoiceSwitch({
    createService: (port): VoiceService => {
      let state: VoiceState = 'idle';
      log.push(`create ${String(port)}`);
      return {
        get state() {
          return state;
        },
        start: () => {
          log.push(`start ${String(port)}`);
          state = 'up';
          return Promise.resolve();
        },
        stop: () => {
          log.push(`stop ${String(port)}`);
          state = 'stopped';
          return options.failStop === true ? Promise.reject(new Error('stop failed')) : Promise.resolve();
        },
        request: (_method, path) => Promise.resolve({ status: 200, headers: {}, body: Buffer.from(`${String(port)}${path}`) }),
      };
    },
    createPusher: (push): Promise<Pusher> => {
      log.push(`pusher ${push.subject}`);
      if (options.failPush === true) return Promise.reject(new Error('no key'));
      return Promise.resolve({ publicKey: push.publicKey, subscribe: () => Promise.resolve(), unsubscribe: () => Promise.resolve(), notify: () => Promise.resolve(0) });
    },
    busy: async () => (await options.busy?.()) ?? false,
    onChange: (config) => log.push(`event ${config === undefined ? 'off' : String(config.port)}`),
    onError: (error) => errors.push(error),
    retryMs: 20,
  });
  return { voice, log, errors };
}

/** Lets the queue of the switch run. */
const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test('off without [voice]: state off, requests refused, no pusher', async () => {
  const { voice, log } = fake();
  await voice.begin(undefined);
  assert.equal(voice.service.state, 'off');
  await assert.rejects(voice.service.request('GET', '/health'), (error: unknown) => error instanceof VoiceError && error.code === 'off');
  assert.equal(voice.pusher(), undefined);
  assert.deepEqual(log, []);
  await voice.close();
});

test('changes before begin are ignored; begin starts the service of that moment, without an event', async () => {
  const { voice, log } = fake();
  voice.sync({ ...ON, port: 7500 });
  await settle();
  assert.deepEqual(log, []);
  await voice.begin(ON);
  await settle();
  assert.equal(voice.service.state, 'up');
  assert.equal((await voice.service.request('GET', '/health')).body.toString(), '7421/health');
  assert.deepEqual(log, ['create 7421', 'start 7421']);
  await voice.close();
  assert.deepEqual(log.slice(-1), ['stop 7421']);
});

test('a new port restarts the service under the same facade; off stops it; each change is an event', async () => {
  const { voice, log } = fake();
  const { service } = voice;
  await voice.begin(ON);
  voice.sync({ ...ON, port: 7500 });
  await settle();
  assert.equal(service.state, 'up');
  assert.equal((await service.request('GET', '/x')).body.toString(), '7500/x');
  voice.sync(undefined);
  await settle();
  assert.equal(service.state, 'off');
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500', 'stop 7421', 'create 7500', 'start 7500', 'event off', 'stop 7500']);
  await voice.close();
});

test('the voice name, limits and outgoing rules restart nothing, but are an event', async () => {
  const { voice, log } = fake();
  await voice.begin(ON);
  voice.sync({ ...ON, voice: 'it_female', limits: { ...ON.limits, callMinutes: 5 } });
  await settle();
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7421']);
  await voice.close();
});

test('a call in progress delays the restart until it ends; the service stays up meanwhile', async () => {
  let busy = false;
  const { voice, log } = fake({ busy: () => busy });
  await voice.begin(ON);
  busy = true;
  voice.sync({ ...ON, port: 7500 });
  await settle(60);
  // The call goes on with the old service.
  assert.equal(voice.service.state, 'up');
  assert.equal((await voice.service.request('GET', '/x')).body.toString(), '7421/x');
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500']);
  busy = false;
  await settle(60);
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500', 'stop 7421', 'create 7500', 'start 7500']);
  await voice.close();
});

test('negative: with no call at begin nothing waits; with a call, a change put back as it was restarts nothing', async () => {
  let busy = false;
  const { voice, log } = fake({ busy: () => busy });
  await voice.begin(ON);
  busy = true;
  voice.sync({ ...ON, port: 7500 });
  await settle();
  voice.sync(ON);
  busy = false;
  await settle(60);
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500', 'event 7421']);
  await voice.close();
});

test('[voice.push] replaces the pusher without restarting the service; a key that cannot be read leaves push off', async () => {
  const { voice, log } = fake();
  await voice.begin(ON);
  voice.sync({ ...ON, push: PUSH });
  await settle();
  assert.equal(voice.pusher()?.publicKey, PUSH.publicKey);
  voice.sync(ON);
  await settle();
  assert.equal(voice.pusher(), undefined);
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7421', 'pusher mailto:test@example.com', 'event 7421']);
  await voice.close();

  const failing = fake({ failPush: true });
  await failing.voice.begin({ ...ON, push: PUSH });
  assert.equal(failing.voice.pusher(), undefined);
  assert.equal(failing.errors.length, 1);
  await failing.voice.close();
});

test('new calls are refused before the check for one in progress, and again allowed when it waits', async () => {
  const seen: string[] = [];
  let busy = false;
  const held: { voice?: ReturnType<typeof fake>['voice'] } = {};
  const { voice } = fake({
    busy: () => {
      if (held.voice !== undefined) seen.push(held.voice.service.state);
      return busy;
    },
  });
  held.voice = voice;
  await voice.begin(ON);
  seen.length = 0;
  busy = true;
  voice.sync({ ...ON, port: 7500 });
  await settle();
  // Checked while refusing (`starting`); then back to the old service, up, for the call in progress.
  assert.equal(seen[0], 'starting');
  assert.equal(voice.service.state, 'up');
  busy = false;
  await settle(60);
  assert.equal((await voice.service.request('GET', '/x')).body.toString(), '7500/x');
  await voice.close();
});

test('a call in progress keeps reaching its service while the switch looks for it', async () => {
  let release: (busy: boolean) => void = () => undefined;
  let waiting = false;
  const { voice } = fake({
    busy: () =>
      waiting
        ? new Promise<boolean>((resolve) => {
            release = resolve;
          })
        : false,
  });
  await voice.begin(ON);
  waiting = true;
  voice.sync({ ...ON, port: 7500 });
  await settle();
  // New calls are refused, the old one still talks to apps/voice.
  assert.equal(voice.service.state, 'starting');
  assert.equal((await voice.service.request('POST', '/calls/x/say')).body.toString(), '7421/calls/x/say');
  waiting = false;
  release(false);
  await settle();
  assert.equal((await voice.service.request('GET', '/x')).body.toString(), '7500/x');
  await voice.close();
});

test('hold: a call being opened delays the replacement until its row is written', async () => {
  let rows = 0;
  const { voice, log } = fake({ busy: () => rows > 0 });
  await voice.begin(ON);
  let write: () => void = () => undefined;
  const opening = voice.service.hold(async () => {
    assert.equal(voice.service.state, 'up');
    await new Promise<void>((resolve) => {
      write = resolve;
    });
    rows += 1;
  });
  voice.sync({ ...ON, port: 7500 });
  await settle();
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500'], 'nothing replaced while the call is opened');
  write();
  await opening;
  await settle(60);
  // The row is there: the change waits for the call, as for any call in progress.
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500']);
  rows = 0;
  await settle(60);
  assert.deepEqual(log.slice(3), ['stop 7421', 'create 7500', 'start 7500']);
  await voice.close();
});

test('close with a change waiting creates nothing; sync after close is ignored', async () => {
  const { voice, log } = fake({ busy: () => true });
  await voice.begin(undefined);
  voice.sync(ON);
  await settle();
  await voice.close();
  voice.sync({ ...ON, port: 7500 });
  await settle(60);
  assert.deepEqual(log, ['event 7421']);
});

test('a stop that fails is reported and the new service starts anyway', async () => {
  const { voice, log, errors } = fake({ failStop: true });
  await voice.begin(ON);
  voice.sync({ ...ON, port: 7500 });
  await settle();
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7500', 'stop 7421', 'create 7500', 'start 7500']);
  assert.equal(errors.length, 1);
  assert.equal(voice.service.state, 'up');
});

test('a check that fails (database down) is reported and tried again', async () => {
  let failures = 1;
  const { voice, log, errors } = fake({
    busy: () => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('database down'));
      }
      return false;
    },
  });
  failures = 0;
  await voice.begin(ON);
  failures = 1;
  voice.sync({ ...ON, port: 7500 });
  await settle(60);
  assert.equal(errors.length, 1);
  assert.equal(voice.service.state, 'up');
  assert.deepEqual(log.slice(3), ['stop 7421', 'create 7500', 'start 7500']);
  await voice.close();
});

test('[voice.push] waits for the call in progress too, then applies', async () => {
  let busy = false;
  const { voice, log } = fake({ busy: () => busy });
  await voice.begin(ON);
  busy = true;
  voice.sync({ ...ON, push: PUSH });
  await settle(60);
  assert.equal(voice.pusher(), undefined);
  // The service is not being replaced: calls are not refused meanwhile.
  assert.equal(voice.service.state, 'up');
  busy = false;
  await settle(60);
  assert.equal(voice.pusher()?.publicKey, PUSH.publicKey);
  assert.deepEqual(log, ['create 7421', 'start 7421', 'event 7421', 'pusher mailto:test@example.com']);
  await voice.close();
});
