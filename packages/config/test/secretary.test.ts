import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ConfigError, DEFAULT_SECRETARY, diffConfig, EMPTY_CATALOG, parseConfig, readSettings, renderSettings } from '../src/index.ts';

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
const secretary = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).secretary;

test('[secretary] (D-144): absent or empty means on, 9:00, 14:30, 18:30, every day', () => {
  const every = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  assert.deepEqual(secretary(''), { enabled: true, morning: '09:00', afternoon: '14:30', evening: '18:30', days: every });
  assert.deepEqual(secretary('[secretary]'), DEFAULT_SECRETARY);
});

test('[secretary]: the switch, the clocks and the days are read, days Monday first', () => {
  assert.deepEqual(secretary('[secretary]\nenabled = false\nmorning = "08:15"\nafternoon = "13:00"\nevening = "19:45"\ndays = ["fri", "mon"]'), {
    enabled: false,
    morning: '08:15',
    afternoon: '13:00',
    evening: '19:45',
    days: ['mon', 'fri'],
  });
});

test('[secretary]: invalid values are refused', () => {
  const bad = [
    '[secretary]\nenabled = "yes"',
    '[secretary]\nmorning = "9:00"',
    '[secretary]\nmorning = "25:00"',
    '[secretary]\nmorning = "15:00"',
    '[secretary]\nevening = "14:00"',
    '[secretary]\ndays = []',
    '[secretary]\ndays = ["lun"]',
    '[secretary]\ndays = "mon"',
    '[secretary]\nother = 1',
  ];
  for (const section of bad) assert.throws(() => secretary(section), ConfigError, section);
});

test('[secretary]: written back only when the file has it, and its change is applied without a restart', () => {
  const before = readSettings(VALID, HOME, EMPTY_CATALOG);
  assert.equal(before.secretary, undefined);
  assert.match(renderSettings(before), /^# \[secretary\]$/m);
  const changed = { ...before, secretary: { ...DEFAULT_SECRETARY, morning: '08:30', days: ['mon' as const] } };
  const text = renderSettings(changed);
  assert.match(text, /^\[secretary\]\nenabled = true\nmorning = "08:30"\nafternoon = "14:30"\nevening = "18:30"\ndays = \["mon"\]$/m);
  assert.deepEqual(readSettings(text, HOME, EMPTY_CATALOG).secretary, changed.secretary);
  const diff = diffConfig(parseConfig(VALID, HOME), parseConfig(text, HOME));
  assert.deepEqual(diff, { applied: ['secretary'], restart: [] });
});
