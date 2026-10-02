import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { ConfigError, resolveHome, resolveInHome } from '../src/index.ts';

test('home defaults to the repository the code runs from', () => {
  const home = resolveHome({});
  assert.ok(existsSync(join(home, 'pnpm-workspace.yaml')));
});

test('ARIANNA_HOME overrides the default and is made absolute', () => {
  assert.equal(resolveHome({ ARIANNA_HOME: 'somewhere/else' }), resolve('somewhere/else'));
  assert.equal(resolveHome({ ARIANNA_HOME: '' }), resolveHome({}));
});

test('paths inside home are resolved', () => {
  const home = resolve('some-home');
  assert.equal(resolveInHome(home, 'data', 'paths.data'), join(home, 'data'));
  assert.equal(resolveInHome(home, 'data/../data/models', 'x'), join(home, 'data', 'models'));
});

test('absolute paths and escapes from home are rejected', () => {
  const home = resolve('some-home');
  assert.throws(() => resolveInHome(home, resolve('elsewhere'), 'paths.data'), ConfigError);
  assert.throws(() => resolveInHome(home, '../outside', 'paths.data'), ConfigError);
  assert.throws(() => resolveInHome(home, 'data/../../outside', 'paths.data'), ConfigError);
});
