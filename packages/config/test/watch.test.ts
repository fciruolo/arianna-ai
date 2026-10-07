import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  CATALOG_FILE,
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE,
  diffConfig,
  loadConfig,
  renderSettings,
  resolveHome,
  watchConfig,
  type ConfigChange,
  type Settings,
} from '../src/index.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `watch-${randomUUID()}`);
const ENV = { ARIANNA_HOME: HOME };
const SHA = 'd'.repeat(64);

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function entry(id: string): string {
  return `  - id: ${id}
    family: fake
    runtime: mlx
    ram_min_gib: 4
    roles: [orchestrator, extractor]
    status: experimental
    files: [{ path: m.bin, url: "https://example.org/${id}", size_bytes: 1, sha256: ${SHA} }]
`;
}

const BASE: Settings = {
  ...DEFAULT_SETTINGS,
  roles: { orchestrator: 'first-mlx' },
  endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:7001/v1' }],
};

/** Replaced with a rename, as the wizard does. */
function write(settings: Settings | string): void {
  const temporary = join(HOME, 'config', '.arianna.toml.test');
  writeFileSync(temporary, typeof settings === 'string' ? settings : renderSettings(settings));
  renameSync(temporary, join(HOME, CONFIG_FILE));
}

mkdirSync(join(HOME, 'config'), { recursive: true });
writeFileSync(join(HOME, CATALOG_FILE), `version: 1\nmodels:\n${entry('first-mlx')}${entry('second-mlx')}`);
write(BASE);

function next(watcher: { events: (ConfigChange | Error)[] }): Promise<ConfigChange | Error> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = (): void => {
      const event = watcher.events.shift();
      if (event !== undefined) resolve(event);
      else if (Date.now() - started > 5000) reject(new Error('no reload within 5 s'));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

test('every section but paths, database and server applies live; an invalid file closes the exits only (D-071)', async () => {
  const seen = { events: [] as (ConfigChange | Error)[] };
  const watcher = watchConfig({
    initial: loadConfig(ENV),
    intervalMs: 20,
    onChange: (change) => seen.events.push(change),
    onError: (error) => seen.events.push(error instanceof Error ? error : new Error(String(error))),
  });
  const SECOND = { ...BASE, roles: { orchestrator: 'second-mlx' } };
  const DEMO = [{ name: 'demo', path: 'repos/demo', label: 'L1' as const }];
  const TELEGRAM = { token: 'vault://telegram-bot-token', chats: [123] };
  try {
    write(SECOND);
    assert.deepEqual(await next(seen), { applied: ['roles', 'local.models'], restart: [] });
    assert.deepEqual(watcher.current().roles, { orchestrator: 'second-mlx' });
    assert.deepEqual(watcher.current().local.endpoints[0]?.models, { 'local-large': 'second-mlx' });

    // The cloud executors apply at once, like the projects and Telegram.
    write({ ...SECOND, cloud: { executors: ['claude'] } });
    assert.deepEqual(await next(seen), { applied: ['cloud.executors'], restart: [] });
    assert.deepEqual(watcher.current().cloud.executors, ['claude']);

    // The cloud models (D-071).
    const models = { sonnet: { enabled: true }, opus: { enabled: false }, fable: { enabled: true, name: 'claude-fable-5-1' }, luna: { enabled: true }, sol: { enabled: true }, astra: { enabled: true } };
    write({ ...SECOND, cloud: { executors: ['claude'], models } });
    assert.deepEqual(await next(seen), { applied: ['cloud.models'], restart: [] });
    assert.deepEqual(watcher.current().cloud, { executors: ['claude'], models });
    write({ ...SECOND, cloud: { executors: ['claude'] } });
    assert.deepEqual(await next(seen), { applied: ['cloud.models'], restart: [] });
    assert.equal(watcher.current().cloud.models.opus.enabled, true);

    // The agents' models (D-116).
    write({ ...SECOND, cloud: { executors: ['claude'] }, agents: { coder: { model: 'opus' } } });
    assert.deepEqual(await next(seen), { applied: ['agents'], restart: [] });
    assert.deepEqual(watcher.current().agents, { coder: { model: 'opus' } });
    write({ ...SECOND, cloud: { executors: ['claude'] } });
    assert.deepEqual(await next(seen), { applied: ['agents'], restart: [] });

    // An approved project applies at once (D-058), Telegram too.
    write({ ...SECOND, cloud: { executors: ['claude'] }, projects: DEMO, telegram: TELEGRAM });
    assert.deepEqual(await next(seen), { applied: ['projects', 'telegram'], restart: [] });
    assert.deepEqual(watcher.current().projects.map((project) => project.name), ['demo']);
    assert.deepEqual(watcher.current().telegram, TELEGRAM);

    // An unreadable file closes every exit until it is valid again; the rest stays.
    write('[paths]\ndata = "/elsewhere"\n');
    assert.deepEqual(await next(seen), { applied: ['cloud.executors', 'projects', 'telegram'], restart: [] });
    assert.ok((await next(seen)) instanceof Error);
    assert.deepEqual(watcher.current().projects, []);
    assert.deepEqual(watcher.current().cloud.executors, []);
    assert.equal(watcher.current().telegram, undefined);
    assert.deepEqual(watcher.current().roles, { orchestrator: 'second-mlx' });
    write({ ...SECOND, cloud: { executors: ['claude'] }, projects: DEMO, telegram: TELEGRAM });
    assert.deepEqual(await next(seen), { applied: ['cloud.executors', 'projects', 'telegram'], restart: [] });
    assert.deepEqual(watcher.current().cloud.executors, ['claude']);
    write(SECOND);
    assert.deepEqual(await next(seen), { applied: ['cloud.executors', 'projects', 'telegram'], restart: [] });
    assert.deepEqual(watcher.current().projects, []);
    assert.deepEqual(watcher.current().cloud.executors, []);
    assert.equal(watcher.current().telegram, undefined);

    // Where L2 requests go and what the watchdog runs: the core restarts the server.
    write({ ...SECOND, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:9999/v1', command: ['other'] }] });
    assert.deepEqual(await next(seen), { applied: ['local.endpoints'], restart: [] });
    assert.equal(watcher.current().local.endpoints[0]?.url, 'http://127.0.0.1:9999/v1');
    assert.deepEqual(watcher.current().local.endpoints[0]?.command, ['other']);

    // The server address waits for a restart.
    write({ ...SECOND, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:9999/v1', command: ['other'] }], server: { host: '127.0.0.1', port: 7999 } });
    assert.deepEqual(await next(seen), { applied: [], restart: ['server'] });
    assert.equal(watcher.current().server.port, 7420);

    // Reported once: a later change of another section does not name the server again.
    write({ ...SECOND, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:9999/v1', command: ['other'] }], server: { host: '127.0.0.1', port: 7999 }, characters: { coder: 'p/robot' } });
    assert.deepEqual(await next(seen), { applied: ['characters'], restart: [] });
    // Changed again: reported again.
    write({ ...SECOND, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:9999/v1', command: ['other'] }], server: { host: '127.0.0.1', port: 7998 }, characters: { coder: 'p/robot' } });
    assert.deepEqual(await next(seen), { applied: [], restart: ['server'] });
    // Not after an invalid file either, once it is valid again with the same server.
    write('[paths]\ndata = "/elsewhere"\n');
    assert.ok((await next(seen)) instanceof Error);
    write({ ...SECOND, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:9999/v1', command: ['other'] }], server: { host: '127.0.0.1', port: 7998 } });
    assert.deepEqual(await next(seen), { applied: ['characters'], restart: [] });
    assert.equal(watcher.current().server.port, 7420);

    // [voice] applies live too (D-071): on, changed, off.
    write({ ...SECOND, voice: structuredClone(DEFAULT_VOICE) });
    assert.deepEqual(await next(seen), { applied: ['local.endpoints', 'voice'], restart: [] });
    assert.deepEqual(watcher.current().voice, DEFAULT_VOICE);
    const moved = { ...structuredClone(DEFAULT_VOICE), port: 7499, limits: { ...DEFAULT_VOICE.limits, callMinutes: 5 } };
    write({ ...SECOND, voice: moved });
    assert.deepEqual(await next(seen), { applied: ['voice'], restart: [] });
    assert.equal(watcher.current().voice?.port, 7499);
    assert.equal(watcher.current().voice?.limits.callMinutes, 5);

    // With no exit open, an invalid file only reports the error; the voice is not an exit and stays.
    write('[paths]\ndata = "/elsewhere"\n');
    assert.ok((await next(seen)) instanceof Error);
    assert.equal(watcher.current().voice?.port, 7499);
    write(SECOND);
    assert.deepEqual(await next(seen), { applied: ['voice'], restart: [] });
    assert.equal(watcher.current().voice, undefined);

    // A catalog that drops the model a role uses is invalid too: the old configuration stays.
    // Valid again, as the core already runs it: nothing to report.
    write(SECOND);
    writeFileSync(join(HOME, CATALOG_FILE), `version: 1\nmodels:\n${entry('first-mlx')}`);
    assert.ok((await next(seen)) instanceof Error);
    assert.deepEqual(watcher.current().roles, { orchestrator: 'second-mlx' });
  } finally {
    writeFileSync(join(HOME, CATALOG_FILE), `version: 1\nmodels:\n${entry('first-mlx')}${entry('second-mlx')}`);
    watcher.close();
  }
});

test('diffConfig names the changed sections only', () => {
  write(BASE);
  const config = loadConfig(ENV);
  assert.deepEqual(diffConfig(config, structuredClone(config)), { applied: [], restart: [] });
  assert.deepEqual(diffConfig(config, { ...config, server: { host: '::1', port: 1 } }), { applied: [], restart: ['server'] });
  assert.deepEqual(diffConfig(config, { ...config, telegram: { token: 'vault://t', chats: [1] } }), { applied: ['telegram'], restart: [] });
  assert.deepEqual(diffConfig(config, { ...config, cloud: { ...config.cloud, executors: ['codex'] } }), { applied: ['cloud.executors'], restart: [] });
  assert.deepEqual(diffConfig(config, { ...config, voice: structuredClone(DEFAULT_VOICE) }), { applied: ['voice'], restart: [] });
  assert.deepEqual(diffConfig(config, { ...config, characters: { coder: 'p/robot' } }), { applied: ['characters'], restart: [] });
});
