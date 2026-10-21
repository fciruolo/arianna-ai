import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { browserImageChecks } from '../src/install-checks.ts';
import { browserImageAgeDays, isImageId, parseBrowserImageLock, readBrowserImageLock } from '../src/browser/image.ts';

const lock = {
  image: `sha256:${'a'.repeat(64)}`,
  builtAt: '2026-10-21T00:53:52.936Z',
  chromium: '155.0.8059.79',
  snapshot: '20261020T000000Z',
  base: `debian:trixie-slim@sha256:${'b'.repeat(64)}`,
};

test('a lock written by pnpm browser:build is read back', () => {
  assert.deepEqual(parseBrowserImageLock(JSON.stringify(lock)), lock);
});

test('only an image id is accepted, never a tag or a name (D-264)', () => {
  assert.ok(isImageId(lock.image));
  for (const image of ['arianna-browser:local', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `arianna-browser@sha256:${'a'.repeat(64)}`]) {
    assert.equal(isImageId(image), false, image);
    assert.equal(parseBrowserImageLock(JSON.stringify({ ...lock, image })), null, image);
  }
});

test('a broken lock is no lock', () => {
  assert.equal(parseBrowserImageLock('not json'), null);
  assert.equal(parseBrowserImageLock('null'), null);
  assert.equal(parseBrowserImageLock(JSON.stringify({ ...lock, builtAt: 'ieri' })), null);
  assert.equal(parseBrowserImageLock(JSON.stringify({ ...lock, snapshot: '2026-10-20' })), null);
  assert.equal(parseBrowserImageLock(JSON.stringify({ ...lock, base: 'debian:trixie-slim' })), null);
  const withoutVersion: Record<string, unknown> = { ...lock };
  delete withoutVersion.chromium;
  assert.equal(parseBrowserImageLock(JSON.stringify(withoutVersion)), null);
});

test('the lock is read from config/ of ARIANNA_HOME; a missing file is null', () => {
  const home = mkdtempSync(join(tmpdir(), 'arianna-browser-lock-'));
  try {
    assert.equal(readBrowserImageLock(home), null);
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, 'config', 'browser-image.lock'), JSON.stringify(lock));
    assert.deepEqual(readBrowserImageLock(home), lock);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the age of the image is counted in whole days', () => {
  assert.equal(browserImageAgeDays(lock, new Date('2026-10-21T12:00:00Z')), 0);
  assert.equal(browserImageAgeDays(lock, new Date('2026-11-21T00:53:52.936Z')), 31);
});

test('the doctor checks the browser image only when it is built, and fails it after 30 days', () => {
  const home = mkdtempSync(join(tmpdir(), 'arianna-browser-doctor-'));
  try {
    assert.deepEqual(browserImageChecks(home, new Date('2026-10-21T12:00:00Z')), []);
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, 'config', 'browser-image.lock'), JSON.stringify(lock));
    const [fresh] = browserImageChecks(home, new Date('2026-11-20T00:00:00Z'));
    assert.equal(fresh?.id, 'browser.image');
    assert.equal(fresh.ok, true);
    const [old] = browserImageChecks(home, new Date('2026-11-21T01:00:00Z'));
    assert.equal(old?.ok, false);
    assert.match(old.detail, /31 days ago: rebuild it with pnpm browser:build/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
