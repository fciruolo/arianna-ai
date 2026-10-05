// A note whose model is not ready (D-100): when the organizer waits, which
// errors are tried again and how long between attempts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LocalModelError } from '@arianna/executors';

import {
  modelUnavailable,
  ORGANIZE_MAX_ATTEMPTS,
  ORGANIZE_RETRY_BASE_MS,
  ORGANIZE_RETRY_MAX_MS,
  organizeModelReady,
  organizeRetryDelayMs,
} from '../src/organize.ts';

describe('organizeModelReady', () => {
  const endpoints = [
    { id: 'omlx', models: { 'local-large': 'big' } },
    { id: 'spare', models: { 'local-large': 'big' } },
    { id: 'small', models: { 'local-small': 'tiny' } },
  ];
  const states = (map: Record<string, 'up' | 'starting' | 'down' | 'failed'>) => ({
    available: (id: string) => map[id] === 'up',
    settling: (id: string) => map[id] === 'starting',
  });

  it('waits while an endpoint serving local-large is starting and none is up', () => {
    const { available, settling } = states({ omlx: 'starting', spare: 'down', small: 'up' });
    assert.equal(organizeModelReady(endpoints, available, settling), false);
  });

  it('is ready when an endpoint serving local-large is up, even if another is starting', () => {
    const { available, settling } = states({ omlx: 'starting', spare: 'up' });
    assert.equal(organizeModelReady(endpoints, available, settling), true);
  });

  it('does not wait for a server settled on down or failed: the job starts and follows the backoff', () => {
    const { available, settling } = states({ omlx: 'failed', spare: 'down' });
    assert.equal(organizeModelReady(endpoints, available, settling), true);
  });

  it('does not wait when no endpoint serves local-large: the call fails and says so', () => {
    assert.equal(organizeModelReady([{ id: 'small', models: { 'local-small': 'tiny' } }], () => false, () => true), true);
    assert.equal(organizeModelReady([], () => false, () => true), true);
  });
});

describe('modelUnavailable', () => {
  it('tries again when no server answered or one is still loading', () => {
    assert.equal(modelUnavailable(new LocalModelError('unavailable', 'down', { endpoint: 'omlx' })), true);
    for (const status of [502, 503]) {
      assert.equal(modelUnavailable(new LocalModelError('http', 'loading', { endpoint: 'omlx', status })), true, String(status));
    }
  });

  it('does not try again an error that another attempt would repeat', () => {
    assert.equal(modelUnavailable(new LocalModelError('http', '500', { endpoint: 'omlx', status: 500 })), false);
    assert.equal(modelUnavailable(new LocalModelError('http', '400', { endpoint: 'omlx', status: 400 })), false);
    assert.equal(modelUnavailable(new LocalModelError('http', '504', { endpoint: 'omlx', status: 504 })), false);
    assert.equal(modelUnavailable(new LocalModelError('timeout', 'slow', { endpoint: 'omlx' })), false);
    assert.equal(modelUnavailable(new LocalModelError('bad-response', 'json', { endpoint: 'omlx' })), false);
    assert.equal(modelUnavailable(new LocalModelError('no-endpoint', 'none')), false);
    assert.equal(modelUnavailable(new Error('other')), false);
  });
});

describe('organizeRetryDelayMs', () => {
  it('doubles from the base after each attempt', () => {
    assert.equal(organizeRetryDelayMs(1), ORGANIZE_RETRY_BASE_MS);
    assert.equal(organizeRetryDelayMs(2), ORGANIZE_RETRY_BASE_MS * 2);
    assert.equal(organizeRetryDelayMs(3), ORGANIZE_RETRY_BASE_MS * 4);
  });

  it('never goes past the cap, nor below the base', () => {
    assert.equal(organizeRetryDelayMs(ORGANIZE_MAX_ATTEMPTS), ORGANIZE_RETRY_MAX_MS);
    assert.equal(organizeRetryDelayMs(1_000), ORGANIZE_RETRY_MAX_MS);
    assert.equal(organizeRetryDelayMs(0), ORGANIZE_RETRY_BASE_MS);
  });

  it('keeps the waits of all attempts within an hour', () => {
    let total = 0;
    for (let attempt = 1; attempt < ORGANIZE_MAX_ATTEMPTS; attempt += 1) total += organizeRetryDelayMs(attempt);
    assert.ok(total <= 3_600_000, String(total));
  });
});
