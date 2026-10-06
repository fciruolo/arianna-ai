import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_NOTIFICATIONS, diffConfig, EMPTY_CATALOG, inQuiet, parseConfig, parseQuiet, readSettings, renderSettings } from '../src/index.ts';

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
const notifications = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).notifications;
const at = (clock: string): Date => {
  const [hours = 0, minutes = 0] = clock.split(':').map(Number);
  return new Date(2026, 9, 5, hours, minutes);
};

test('notifications (I-1): absent or empty means every kind on and no quiet hours', () => {
  assert.deepEqual(notifications(''), DEFAULT_NOTIFICATIONS);
  assert.deepEqual(notifications('[notifications]'), { replies: true, approvals: true, failures: true });
});

test('notifications: kinds off and quiet hours are read', () => {
  assert.deepEqual(notifications('[notifications]\nreplies = false\napprovals = true\nfailures = false\nquiet = "22:00-07:00"'), {
    replies: false,
    approvals: true,
    failures: false,
    quiet: { from: '22:00', to: '07:00' },
  });
});

test('notifications: invalid values and unknown keys are rejected', () => {
  const bad = [
    '[notifications]\nreplies = "yes"',
    '[notifications]\nfailures = 1',
    '[notifications]\nsound = true',
    '[notifications]\nquiet = ""',
    '[notifications]\nquiet = "22:00"',
    '[notifications]\nquiet = "22-07"',
    '[notifications]\nquiet = "24:00-07:00"',
    '[notifications]\nquiet = "22:00-22:00"',
    '[notifications]\nquiet = 22',
    'notifications = true',
  ];
  for (const section of bad) assert.throws(() => notifications(section), { name: 'ConfigError' }, section);
});

test('parseQuiet: the shape and two different ends', () => {
  assert.deepEqual(parseQuiet(' 08:30-12:00 '), { from: '08:30', to: '12:00' });
  assert.equal(parseQuiet('8:30-12:00'), undefined);
  assert.equal(parseQuiet('12:00-12:00'), undefined);
});

test('inQuiet: within a day and across midnight; none without quiet hours', () => {
  const night = { from: '22:00', to: '07:00' };
  assert.equal(inQuiet(at('23:30'), night), true);
  assert.equal(inQuiet(at('00:10'), night), true);
  assert.equal(inQuiet(at('06:59'), night), true);
  assert.equal(inQuiet(at('07:00'), night), false);
  assert.equal(inQuiet(at('12:00'), night), false);
  assert.equal(inQuiet(at('21:59'), night), false);
  assert.equal(inQuiet(at('22:00'), night), true, 'the start is quiet');
  const lunch = { from: '13:00', to: '14:00' };
  assert.equal(inQuiet(at('13:30'), lunch), true);
  assert.equal(inQuiet(at('14:00'), lunch), false);
  assert.equal(inQuiet(at('03:00'), lunch), false);
  assert.equal(inQuiet(at('03:00'), undefined), false);
});

test('notifications: written back as read, absent stays absent, a change is applied live', () => {
  const withSection = `${VALID}\n[notifications]\nreplies = false\nquiet = "23:15-06:45"\n`;
  const settings = readSettings(withSection, HOME, EMPTY_CATALOG);
  assert.deepEqual(settings.notifications, { replies: false, approvals: true, failures: true, quiet: { from: '23:15', to: '06:45' } });
  const again = readSettings(renderSettings(settings), HOME, EMPTY_CATALOG);
  assert.deepEqual(again.notifications, settings.notifications);
  assert.equal(readSettings(VALID, HOME, EMPTY_CATALOG).notifications, undefined);
  assert.match(renderSettings(readSettings(VALID, HOME, EMPTY_CATALOG)), /^# \[notifications\]$/m);
  const change = diffConfig(parseConfig(VALID, HOME), parseConfig(withSection, HOME));
  assert.deepEqual(change, { applied: ['notifications'], restart: [] });
});
