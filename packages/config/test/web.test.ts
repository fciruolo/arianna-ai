import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { checkCoderSites, ConfigError, diffConfig, EMPTY_CATALOG, parseConfig, readSettings, renderSettings } from '../src/index.ts';

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
const web = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).web;

test('[web] (D-262): absent or empty means no site for the Coder', () => {
  assert.deepEqual(web(''), { coderSites: [] });
  assert.deepEqual(web('[web]'), { coderSites: [] });
});

test('[web]: host names are read, each once', () => {
  assert.deepEqual(web('[web]\ncoder_sites = ["developer.mozilla.org", "nodejs.org", "nodejs.org"]'), { coderSites: ['developer.mozilla.org', 'nodejs.org'] });
});

test('[web]: anything but a lowercase host name is refused, and at most 100 sites', () => {
  for (const bad of ['"https://nodejs.org"', '"nodejs.org/api"', '"NodeJS.org"', '"localhost"', '"192.168.1.1"', '"nodejs.org:443"', '""', '1', '"*.nodejs.org"']) {
    assert.throws(() => web(`[web]\ncoder_sites = [${bad}]`), ConfigError, bad);
  }
  assert.throws(() => web('[web]\ncoder_sites = "nodejs.org"'), ConfigError);
  assert.throws(() => web('[web]\nother = 1'), ConfigError);
  assert.throws(() => checkCoderSites(Array.from({ length: 101 }, (_, index) => `s${String(index)}.com`)), /web\.coder_sites: at most 100/);
  assert.equal(checkCoderSites(Array.from({ length: 100 }, (_, index) => `s${String(index)}.com`)).length, 100);
});

test('[web] is kept when written, absent when not, and its change applies without a restart', () => {
  const settings = readSettings(`${VALID}\n[web]\ncoder_sites = ["nodejs.org"]\n`, HOME, EMPTY_CATALOG);
  assert.deepEqual(settings.coderSites, ['nodejs.org']);
  assert.match(renderSettings(settings), /^\[web\]\ncoder_sites = \["nodejs\.org"\]$/m);
  // What is written reads back the same.
  assert.deepEqual(parseConfig(renderSettings(settings), HOME).web, { coderSites: ['nodejs.org'] });
  const without = readSettings(VALID, HOME, EMPTY_CATALOG);
  assert.equal(without.coderSites, undefined);
  assert.match(renderSettings(without), /^# \[web\]$/m);
  const change = diffConfig(parseConfig(VALID, HOME), parseConfig(`${VALID}\n[web]\ncoder_sites = ["nodejs.org"]\n`, HOME));
  assert.deepEqual(change, { applied: ['web'], restart: [] });
});
