// "Novità": dates, order and tones of the register of the versions. Invented data.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareVersions, currentText, italianDate, orderVersions, sectionTone, skippedText, versionDate, versionTitle } from '../src/lib/changelog.ts';
import { CHANGELOG_PATH, isChangelogPath, isSettingsPath } from '../src/lib/route.ts';
import { hrefOf, resolveSection, SETTINGS_INDEX } from '../src/lib/settings-index.ts';
import type { ChangelogVersion } from '../src/lib/types.ts';

function version(number: string | null, date: string | null = null): ChangelogVersion {
  return { version: number, date, unreleased: number === null, summary: null, sections: [] };
}

test('dates are written in Italian', () => {
  assert.equal(italianDate('2026-10-05'), '5 ottobre 2026');
  assert.equal(italianDate('2027-01-31'), '31 gennaio 2027');
  assert.equal(italianDate('2026-12-01'), '1 dicembre 2026');
  // Not a date: as it is.
  assert.equal(italianDate('2026-13-01'), '2026-13-01');
  assert.equal(italianDate('ieri'), 'ieri');
});

test('versions are ordered from the most recent, unreleased first', () => {
  const ordered = orderVersions([version('0.1.0'), version('0.10.0'), version(null), version('0.2.0'), version('1.0.0')]);
  assert.deepEqual(ordered.map(versionTitle), ['Non rilasciato', '1.0.0', '0.10.0', '0.2.0', '0.1.0']);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.1.1', '0.1.1'), 0);
});

test('a version shows its date in Italian, or none', () => {
  assert.equal(versionDate(version('0.1.1', '2026-10-05')), '5 ottobre 2026');
  assert.equal(versionDate(version(null)), null);
  assert.equal(currentText('0.1.1'), 'Versione 0.1.1');
  assert.equal(currentText(null), null);
});

test('each known section has its tone, the others are neutral', () => {
  assert.equal(sectionTone('Aggiunto'), 'ok');
  assert.equal(sectionTone('Corretto'), 'info');
  assert.equal(sectionTone('sicurezza'), 'warn');
  assert.equal(sectionTone('Rimosso'), 'danger');
  assert.equal(sectionTone('Cambiato'), 'neutral');
  assert.equal(sectionTone('Deprecato'), 'neutral');
});

test('skipped lines are told only when there are some', () => {
  assert.equal(skippedText(0), null);
  assert.match(skippedText(1) ?? '', /^Una riga/);
  assert.match(skippedText(3) ?? '', /^3 righe/);
});

test('the page has its own address, reached from the settings index', () => {
  assert.equal(isChangelogPath(CHANGELOG_PATH), true);
  assert.equal(isChangelogPath(`${CHANGELOG_PATH}/`), true);
  assert.equal(isChangelogPath('/novita/altro'), false);
  assert.equal(isSettingsPath(CHANGELOG_PATH), false);
  const item = SETTINGS_INDEX.flatMap((group) => group.items).find((entry) => entry.id === 'changelog');
  assert.ok(item !== undefined);
  assert.equal(hrefOf(item), CHANGELOG_PATH);
  // A page of its own is not a section of the settings.
  assert.equal(resolveSection('novita').explicit, false);
});
