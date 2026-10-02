import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { labelForPath, labelForSource } from '@arianna/policy';

import { ConfigError, loadLabelRules, parseLabelRules } from '../src/index.ts';

const VALID = `
[[folder]]
path = "kb/public"
label = "L0"

[[folder]]
path = "kb/private/"
label = "L2"

[[source]]
name = "web"
label = "L0"
`;

test('a valid rules file is parsed and normalized', () => {
  assert.deepEqual(parseLabelRules(VALID), {
    folders: [
      { path: 'kb/public', label: 'L0' },
      { path: 'kb/private', label: 'L2' },
    ],
    sources: [{ name: 'web', label: 'L0' }],
  });
});

test('an empty rules file means everything is L2', () => {
  const rules = parseLabelRules('');
  assert.equal(labelForPath(rules, 'kb/public/a.md'), 'L2');
  assert.equal(labelForSource(rules, 'web'), 'L2');
});

test('the committed rules file loads and keeps secrets and real data at the top', () => {
  const rules = loadLabelRules({});
  assert.equal(labelForPath(rules, 'data/vault/x'), 'L3');
  assert.equal(labelForPath(rules, 'data/kb/x.md'), 'L2');
  assert.equal(labelForPath(rules, 'kb/public/x.md'), 'L0');
});

test('a missing rules file is an error, not an empty rule set', () => {
  const home = resolve('data', 'tmp', `labels-${randomUUID()}`);
  mkdirSync(home, { recursive: true });
  try {
    assert.throws(() => loadLabelRules({ ARIANNA_HOME: home }), /ENOENT/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unknown keys and invalid labels are rejected', () => {
  assert.throws(() => parseLabelRules(`${VALID}\n[[folders]]\npath = "x"\nlabel = "L1"\n`), ConfigError);
  assert.throws(() => parseLabelRules(VALID.replace('name = "web"', 'nme = "web"')), ConfigError);
  assert.throws(() => parseLabelRules(VALID.replace('"L0"', '"l0"')), ConfigError);
  assert.throws(() => parseLabelRules(VALID.replace('"L0"', '0')), ConfigError);
});

test('rules the policy rejects are reported as configuration errors', () => {
  assert.throws(() => parseLabelRules(VALID.replace('"kb/public"', '"/kb/public"')), ConfigError);
  assert.throws(() => parseLabelRules(VALID.replace('"kb/public"', '"../kb"')), ConfigError);
  assert.throws(() => parseLabelRules(VALID.replace('"kb/public"', '"."')), ConfigError);
  assert.throws(() => parseLabelRules(VALID.replace('"kb/public"', '"KB/Private"')), ConfigError);
});

test('malformed TOML and wrong shapes are rejected', () => {
  assert.throws(() => parseLabelRules('[[folder]\n'), ConfigError);
  assert.throws(() => parseLabelRules('folder = "kb"\n'), ConfigError);
  assert.throws(() => parseLabelRules('[folder]\npath = "kb"\nlabel = "L1"\n'), ConfigError);
});
