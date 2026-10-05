import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEV_PATH, isSettingsPath, settingsPathFor, settingsSlug, VOICE_TRIAL_PATH } from '../src/lib/route.ts';
import { BEHAVIOUR_TEXT, hrefOf, pendingTitles, resolveSection, SETTINGS_INDEX } from '../src/lib/settings-index.ts';

const items = SETTINGS_INDEX.flatMap((group) => group.items);
function byId(id: string) {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no entry ${id}`);
  return item;
}

test('groups by subject, no group named after how a section takes effect', () => {
  assert.deepEqual(
    SETTINGS_INDEX.map((group) => group.group),
    ['Modelli', 'Voce e aspetto', 'Collegamenti', 'Sistema'],
  );
  // Every entry that lets data out is in Collegamenti and asks for confirmation.
  for (const item of items.filter((entry) => entry.privacy === true)) assert.equal(item.behaviour, 'confirm');
  assert.deepEqual(
    items.filter((entry) => entry.privacy === true).map((entry) => entry.title),
    ['Esecutori cloud', 'Telegram', 'Progetti', 'Server locali'],
  );
  assert.equal(BEHAVIOUR_TEXT.confirm, 'Chiede conferma prima di salvare');
  // Ids and slugs are unique.
  assert.equal(new Set(items.map((entry) => entry.id)).size, items.length);
  assert.equal(new Set(items.map((entry) => entry.slug)).size, items.length);
});

test('the address names the section; none or an unknown one falls back to the first', () => {
  assert.deepEqual(resolveSection('telegram'), { item: byId('telegram'), explicit: true });
  assert.equal(resolveSection(undefined).item.id, 'roles');
  assert.equal(resolveSection(undefined).explicit, false);
  assert.equal(resolveSection('non-esiste').item.id, 'roles');
  assert.equal(resolveSection('non-esiste').explicit, false);
  // A page of its own is not a section of this page.
  assert.equal(resolveSection('provino-della-voce').item.id, 'roles');
  assert.equal(resolveSection('sviluppo').explicit, false);
});

test('the entries lead to their section, or to their own page', () => {
  assert.equal(hrefOf(byId('servers')), '/impostazioni/server-locali');
  assert.equal(hrefOf(byId('voice-trial')), VOICE_TRIAL_PATH);
  assert.equal(hrefOf(byId('dev-progress')), DEV_PATH);
});

test('the address of a section is read and written back', () => {
  assert.equal(isSettingsPath('/impostazioni'), true);
  assert.equal(isSettingsPath('/impostazioni/'), true);
  assert.equal(isSettingsPath('/impostazioni/modelli-locali'), true);
  assert.equal(isSettingsPath('/impostazioni/modelli-locali/'), true);
  assert.equal(isSettingsPath('/impostazioni/a/b'), false);
  assert.equal(isSettingsPath('/impostazioni/../c'), false);
  assert.equal(isSettingsPath('/impostazionix'), false);
  assert.equal(settingsSlug('/impostazioni/voce'), 'voce');
  assert.equal(settingsSlug('/impostazioni'), undefined);
  assert.equal(settingsPathFor('voce'), '/impostazioni/voce');
  assert.equal(settingsPathFor(undefined), '/impostazioni');
});

test('sections left with unsaved edits are named, the open one and read-only ones never', () => {
  const changed = new Set(['voice', 'endpoints', 'roles']);
  assert.deepEqual(
    pendingTitles('roles', (section) => changed.has(section)),
    ['Voce', 'Server locali'],
  );
  assert.deepEqual(
    pendingTitles('labels', () => false),
    [],
  );
});
