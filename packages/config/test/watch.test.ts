import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  CATALOG_FILE,
  CONFIG_FILE,
  DEFAULT_SETTINGS,
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

test('a new model for a role applies live; privacy sections wait for a restart; an invalid file changes nothing', async () => {
  const seen = { events: [] as (ConfigChange | Error)[] };
  const watcher = watchConfig({
    initial: loadConfig(ENV),
    intervalMs: 20,
    onChange: (change) => seen.events.push(change),
    onError: (error) => seen.events.push(error instanceof Error ? error : new Error(String(error))),
  });
  try {
    write({ ...BASE, roles: { orchestrator: 'second-mlx' } });
    assert.deepEqual(await next(seen), { applied: ['roles', 'local.models'], restart: [] });
    assert.deepEqual(watcher.current().roles, { orchestrator: 'second-mlx' });
    assert.deepEqual(watcher.current().local.endpoints[0]?.models, { 'local-large': 'second-mlx' });

    write({ ...BASE, roles: { orchestrator: 'second-mlx' }, cloud: { executors: ['claude'] } });
    assert.deepEqual(await next(seen), { applied: [], restart: ['cloud'] });
    assert.deepEqual(watcher.current().cloud.executors, []);

    // An approved project applies at once (D-058); taking it off too.
    write({ ...BASE, roles: { orchestrator: 'second-mlx' }, cloud: { executors: ['claude'] }, projects: [{ name: 'demo', path: 'repos/demo', label: 'L1' }] });
    assert.deepEqual(await next(seen), { applied: ['projects'], restart: ['cloud'] });
    assert.deepEqual(watcher.current().projects.map((project) => project.name), ['demo']);
    assert.deepEqual(watcher.current().cloud.executors, []);
    // An unreadable file closes the projects until it is valid again; the rest stays.
    write('[paths]\ndata = "/elsewhere"\n');
    assert.deepEqual(await next(seen), { applied: ['projects'], restart: [] });
    assert.ok((await next(seen)) instanceof Error);
    assert.deepEqual(watcher.current().projects, []);
    assert.deepEqual(watcher.current().roles, { orchestrator: 'second-mlx' });
    write({ ...BASE, roles: { orchestrator: 'second-mlx' }, cloud: { executors: ['claude'] }, projects: [{ name: 'demo', path: 'repos/demo', label: 'L1' }] });
    assert.deepEqual(await next(seen), { applied: ['projects'], restart: ['cloud'] });
    assert.deepEqual(watcher.current().projects.map((project) => project.name), ['demo']);
    write({ ...BASE, roles: { orchestrator: 'second-mlx' }, cloud: { executors: ['claude'] } });
    assert.deepEqual(await next(seen), { applied: ['projects'], restart: ['cloud'] });
    assert.deepEqual(watcher.current().projects, []);

    // Put back as it was: nothing to report, the next event is the one below.
    write({ ...BASE, roles: { orchestrator: 'second-mlx' } });
    // Where L2 requests go and what the watchdog runs wait for a restart.
    write({ ...BASE, roles: { orchestrator: 'second-mlx' }, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:9999/v1', command: ['other'] }] });
    assert.deepEqual(await next(seen), { applied: [], restart: ['local.endpoints'] });
    assert.equal(watcher.current().local.endpoints[0]?.url, 'http://127.0.0.1:7001/v1');
    assert.equal(watcher.current().local.endpoints[0]?.command, undefined);

    write('[paths]\ndata = "/elsewhere"\n');
    assert.ok((await next(seen)) instanceof Error);
    assert.deepEqual(watcher.current().roles, { orchestrator: 'second-mlx' });

    // A catalog that drops the model a role uses is invalid too: the old configuration stays.
    write({ ...BASE, roles: { orchestrator: 'second-mlx' } });
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
  assert.deepEqual(diffConfig(config, { ...config, telegram: { token: 'vault://t', chats: [1] } }), { applied: [], restart: ['telegram'] });
  assert.deepEqual(diffConfig(config, { ...config, characters: { coder: 'p/robot' } }), { applied: ['characters'], restart: [] });
});
