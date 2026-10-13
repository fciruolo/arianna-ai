import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { checkFetchSites, ConfigError, diffConfig, EMPTY_CATALOG, isFetchSite, parseConfig, readSettings, renderSettings, siteListed } from '../src/index.ts';

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
const capture = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).capture;

test('[capture] (D-154): absent or empty means no site', () => {
  assert.deepEqual(capture(''), { fetchSites: [] });
  assert.deepEqual(capture('[capture]'), { fetchSites: [] });
});

test('[capture]: host names are read, each once', () => {
  assert.deepEqual(capture('[capture]\nfetch_sites = ["x.com", "youtube.com", "x.com"]'), { fetchSites: ['x.com', 'youtube.com'] });
});

test('[capture]: anything but a lowercase host name is refused', () => {
  for (const bad of ['"https://x.com"', '"x.com/a"', '"X.com"', '"localhost"', '"10.0.0.1"', '"x.com:443"', '""', '1', '"-x.com"', '"*.x.com"']) {
    assert.throws(() => capture(`[capture]\nfetch_sites = [${bad}]`), ConfigError, bad);
  }
  assert.throws(() => capture('[capture]\nfetch_sites = "x.com"'), ConfigError);
  assert.throws(() => capture('[capture]\nother = 1'), ConfigError);
  assert.throws(() => checkFetchSites(Array.from({ length: 101 }, (_, index) => `s${String(index)}.com`)), ConfigError);
  assert.equal(isFetchSite('mobile.x.com'), true);
});

test('a site covers its subdomains, never a name that only ends the same way', () => {
  assert.equal(siteListed(['x.com'], 'mobile.x.com'), true);
  assert.equal(siteListed(['x.com'], 'x.com.'), true);
  assert.equal(siteListed(['x.com'], 'notx.com'), false);
  assert.equal(siteListed(['x.com'], 'x.com.evil.com'), false);
});

test('[capture] is kept when written, absent when not, and its change applies without a restart', () => {
  const settings = readSettings(`${VALID}\n[capture]\nfetch_sites = ["x.com"]\n`, HOME, EMPTY_CATALOG);
  assert.deepEqual(settings.fetchSites, ['x.com']);
  assert.match(renderSettings(settings), /^\[capture\]\nfetch_sites = \["x\.com"\]$/m);
  const without = readSettings(VALID, HOME, EMPTY_CATALOG);
  assert.equal(without.fetchSites, undefined);
  assert.match(renderSettings(without), /^# \[capture\]$/m);
  const change = diffConfig(parseConfig(VALID, HOME), parseConfig(`${VALID}\n[capture]\nfetch_sites = ["x.com"]\n`, HOME));
  assert.deepEqual(change, { applied: ['capture'], restart: [] });
});
