import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ConfigError, diffConfig, EMPTY_CATALOG, parseConfig, readSettings, renderSettings } from '../src/index.ts';

const HOME = resolve('some-home');
const VALID = `
[paths]
data = "data"

[database]
host = "127.0.0.1"
port = 54329
name = "arianna"
user = "arianna"
`;
const appearance = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).appearance;

test('[appearance] (D-103, D-246): absent or empty means the Base theme, with the feasts on', () => {
  assert.deepEqual(appearance(''), { theme: 'base', seasonal: true });
  assert.deepEqual(appearance('[appearance]'), { theme: 'base', seasonal: true });
});

test('[appearance]: a theme id and the switch of the feasts are read as written', () => {
  assert.deepEqual(appearance('[appearance]\ntheme = "corsia"'), { theme: 'corsia', seasonal: true });
  assert.deepEqual(appearance('[appearance]\ntheme = "natale-2"'), { theme: 'natale-2', seasonal: true });
  assert.deepEqual(appearance('[appearance]\nseasonal = false'), { theme: 'base', seasonal: false });
});

test('[appearance]: invalid values are refused', () => {
  const bad = [
    '[appearance]\ntheme = "Corsia"',
    '[appearance]\ntheme = "../corsia"',
    '[appearance]\ntheme = ""',
    '[appearance]\ntheme = "-corsia"',
    `[appearance]\ntheme = "${'a'.repeat(41)}"`,
    '[appearance]\ntheme = 1',
    '[appearance]\nother = "x"',
    '[appearance]\nseasonal = "yes"',
    '[appearance]\nseasonal = 1',
  ];
  for (const section of bad) assert.throws(() => appearance(section), ConfigError, section);
});

test('[appearance]: written back only when the file has it, and its change is applied without a restart', () => {
  const before = readSettings(VALID, HOME, EMPTY_CATALOG);
  assert.equal(before.appearance, undefined);
  assert.match(renderSettings(before), /^# \[appearance\]$/m);
  const changed = { ...before, appearance: { theme: 'ufficio', seasonal: false } };
  const text = renderSettings(changed);
  assert.match(text, /^\[appearance\]\ntheme = "ufficio"\nseasonal = false$/m);
  assert.deepEqual(readSettings(text, HOME, EMPTY_CATALOG).appearance, { theme: 'ufficio', seasonal: false });
  assert.deepEqual(diffConfig(parseConfig(VALID, HOME), parseConfig(text, HOME)), { applied: ['appearance'], restart: [] });
  // Only the switch changed: applied as well.
  const off = renderSettings({ ...before, appearance: { theme: 'base', seasonal: false } });
  const on = renderSettings({ ...before, appearance: { theme: 'base', seasonal: true } });
  assert.deepEqual(diffConfig(parseConfig(on, HOME), parseConfig(off, HOME)), { applied: ['appearance'], restart: [] });
});
