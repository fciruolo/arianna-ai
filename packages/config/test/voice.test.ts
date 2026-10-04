import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { aliasesOf, DEFAULT_SETTINGS, DEFAULT_VOICE, EMPTY_CATALOG, parseConfig, readSettings, renderSettings, VOICE_ALIAS } from '../src/index.ts';

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
const voice = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).voice;
const PUBLIC_KEY = `B${'A'.repeat(86)}`;

test('voice (D-066): absent means off; an empty section takes the defaults chosen by the user', () => {
  assert.equal(voice(''), undefined);
  assert.deepEqual(voice('[voice]'), DEFAULT_VOICE);
  assert.deepEqual(DEFAULT_VOICE.limits, { callMinutes: 15, warnSeconds: 60, delegations: 6, delegationSeconds: 90 });
  assert.deepEqual(DEFAULT_VOICE.outgoing, { maxPerDay: 3, quietFrom: '21:00', quietTo: '08:00', quietWeekend: true, ringSeconds: 30, waitingMinutes: 30 });
});

test('voice: every key can be set, and push takes the key from the vault', () => {
  const parsed = voice(`[voice]
port = 7500
voice = "im_nicola"
[voice.limits]
call_minutes = 30
warn_seconds = 0
delegations = 0
delegation_seconds = 120
[voice.outgoing]
max_per_day = 0
quiet_from = "22:30"
quiet_to = "22:30"
quiet_weekend = false
ring_seconds = 45
waiting_minutes = 15
[voice.push]
public_key = "${PUBLIC_KEY}"
private_key = "vault://vapid-private-key"
subject = "mailto:me@example.org"`);
  assert.deepEqual(parsed, {
    port: 7500,
    voice: 'im_nicola',
    limits: { callMinutes: 30, warnSeconds: 0, delegations: 0, delegationSeconds: 120 },
    outgoing: { maxPerDay: 0, quietFrom: '22:30', quietTo: '22:30', quietWeekend: false, ringSeconds: 45, waitingMinutes: 15 },
    push: { publicKey: PUBLIC_KEY, privateKey: 'vault://vapid-private-key', subject: 'mailto:me@example.org' },
  });
});

test('voice: invalid values and unknown keys are rejected', () => {
  const bad = [
    '[voice]\nport = 80',
    '[voice]\nport = 7420',
    '[voice]\nvoice = "../x"',
    '[voice]\nvoice = "Sara"',
    '[voice]\nmodel = "x"',
    '[voice.limits]\ncall_minutes = 0',
    '[voice.limits]\ncall_minutes = 1\nwarn_seconds = 60',
    '[voice.limits]\ndelegations = -1',
    '[voice.outgoing]\nquiet_from = "9:00"',
    '[voice.outgoing]\nquiet_to = "24:00"',
    '[voice.outgoing]\nquiet_weekend = "yes"',
    '[voice.outgoing]\nring_seconds = 1',
    '[voice.outgoing]\nretry = true',
    `[voice.push]\npublic_key = "${PUBLIC_KEY}"\nprivate_key = "abc"\nsubject = "mailto:me@example.org"`,
    `[voice.push]\npublic_key = "short"\nprivate_key = "vault://k"\nsubject = "mailto:me@example.org"`,
    `[voice.push]\npublic_key = "${PUBLIC_KEY}"\nprivate_key = "vault://k"\nsubject = "http://example.org"`,
    `[voice.push]\npublic_key = "${PUBLIC_KEY}"\nprivate_key = "vault://k"`,
  ];
  for (const section of bad) assert.throws(() => voice(section), { name: 'ConfigError' }, section);
});

test('voice: the wizard writes the section back unchanged, and leaves it commented when absent', () => {
  const text = `${VALID}\n[voice]\nvoice = "im_nicola"\n[voice.outgoing]\nquiet_weekend = false\n[voice.push]\npublic_key = "${PUBLIC_KEY}"\nprivate_key = "vault://vapid-private-key"\nsubject = "https://example.org"\n`;
  const settings = readSettings(text, HOME, EMPTY_CATALOG);
  const rendered = renderSettings(settings);
  assert.deepEqual(parseConfig(rendered, HOME).voice, parseConfig(text, HOME).voice);
  assert.equal(parseConfig(renderSettings(DEFAULT_SETTINGS), HOME).voice, undefined);
  assert.match(renderSettings(DEFAULT_SETTINGS), /^# \[voice\]$/m);
});

test('the voice role gets its own alias on the local servers, outside the router (D-066)', () => {
  assert.deepEqual(aliasesOf({ orchestrator: 'big', voice: 'small' }), { 'local-large': 'big', [VOICE_ALIAS]: 'small' });
  assert.deepEqual(aliasesOf({ orchestrator: 'big' }), { 'local-large': 'big' });
});
