// Impostazioni → Dispositivi (D-292, stage B): the texts of the page. Made-up times.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codeLeftText, codeText, lastSeenText, phoneAddress } from '../src/lib/devices.ts';
import { SETTINGS_INDEX } from '../src/lib/settings-index.ts';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

test('the last access: relative while recent, then the date; never when missing', () => {
  assert.equal(lastSeenText(null, NOW), 'mai');
  assert.equal(lastSeenText('x', NOW), 'mai');
  assert.equal(lastSeenText(ago(10_000), NOW), 'adesso');
  assert.equal(lastSeenText(ago(60_000), NOW), '1 minuto fa');
  assert.equal(lastSeenText(ago(25 * 60_000), NOW), '25 minuti fa');
  assert.equal(lastSeenText(ago(3 * 3_600_000), NOW), '3 ore fa');
  assert.equal(lastSeenText(ago(30 * 3_600_000), NOW), 'ieri');
  assert.match(lastSeenText(ago(20 * 86_400_000), NOW), /2026/);
});

test('the code: two groups of three, the minutes left, none once expired', () => {
  assert.equal(codeText('123456'), '123 456');
  assert.equal(codeLeftText(new Date(NOW + 272_000).toISOString(), NOW), '4:32');
  assert.equal(codeLeftText(new Date(NOW).toISOString(), NOW), null);
  assert.equal(phoneAddress('mac-prova.tail0000.ts.net'), 'https://mac-prova.tail0000.ts.net');
});

test('Dispositivi is in Comunicazione, after Notifiche, at /impostazioni/dispositivi', () => {
  const group = SETTINGS_INDEX.find((entry) => entry.group === 'Comunicazione');
  const ids = group?.items.map((item) => item.id) ?? [];
  assert.equal(ids.indexOf('devices'), ids.indexOf('notifications') + 1);
  const item = group?.items.find((entry) => entry.id === 'devices');
  assert.deepEqual([item?.slug, item?.title, item?.privacy], ['dispositivi', 'Dispositivi', undefined]);
});
