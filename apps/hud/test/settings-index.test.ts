import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEV_PATH, isSettingsPath, settingsPathFor, settingsSlug, VOICE_TRIAL_PATH } from '../src/lib/route.ts';
import { BEHAVIOUR_TEXT, hrefOf, pendingTitles, resolveSection, sectionDirty, SETTINGS_INDEX } from '../src/lib/settings-index.ts';

const items = SETTINGS_INDEX.flatMap((group) => group.items);
function byId(id: string) {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no entry ${id}`);
  return item;
}

test('groups by subject, no group named after how a section takes effect', () => {
  assert.deepEqual(
    SETTINGS_INDEX.map((group) => group.group),
    ['Modelli', 'Agenti e voce', 'Collegamenti', 'Sistema'],
  );
  // Every entry that lets data out is in Collegamenti and asks for confirmation.
  for (const item of items.filter((entry) => entry.privacy === true)) assert.equal(item.behaviour, 'confirm');
  assert.deepEqual(
    items.filter((entry) => entry.privacy === true).map((entry) => entry.title),
    ['Esecutori cloud', 'Progetti', 'Server locali', 'Link scaricati'],
  );
  assert.equal(BEHAVIOUR_TEXT.confirm, 'Chiede conferma prima di salvare');
  // Ids and slugs are unique.
  assert.equal(new Set(items.map((entry) => entry.id)).size, items.length);
  assert.equal(new Set(items.map((entry) => entry.slug)).size, items.length);
});

test('the address names the section; none or an unknown one falls back to the first', () => {
  assert.deepEqual(resolveSection('progetti'), { item: byId('projects'), explicit: true });
  // Telegram is off (D-110): its old address falls back to the first section.
  assert.equal(resolveSection('telegram').item.id, 'models');
  assert.equal(resolveSection(undefined).item.id, 'models');
  assert.equal(resolveSection(undefined).explicit, false);
  assert.equal(resolveSection('non-esiste').item.id, 'models');
  assert.equal(resolveSection('non-esiste').explicit, false);
  // A page of its own is not a section of this page.
  assert.equal(resolveSection('provino-della-voce').item.id, 'models');
  assert.equal(resolveSection('sviluppo').explicit, false);
});

test('Personaggi and Personalità are in Agenti (D-116): their old addresses open it', () => {
  assert.deepEqual(resolveSection('agenti'), { item: byId('agents'), explicit: true });
  assert.deepEqual(resolveSection('personaggi'), { item: byId('agents'), explicit: true });
  assert.deepEqual(resolveSection('personalita'), { item: byId('agents'), explicit: true });
  assert.ok(!items.some((entry) => entry.id === 'characters' || entry.id === 'personas'));
  // Its card edits three parts: any of them makes it dirty.
  assert.equal(sectionDirty('agents', (section) => section === 'personas'), true);
  assert.equal(sectionDirty('agents', (section) => section === 'participants'), true);
  assert.equal(sectionDirty('agents', (section) => section === 'roles'), false);
  assert.deepEqual(pendingTitles('roles', (section) => section === 'agents'), ['Agenti']);
});

test('Modelli locali, Prove dei modelli and Modelli cloud are in Modelli (D-137): their old addresses open it', () => {
  assert.deepEqual(resolveSection('modelli'), { item: byId('models'), explicit: true });
  for (const old of ['modelli-locali', 'prove-dei-modelli', 'modelli-cloud']) assert.deepEqual(resolveSection(old), { item: byId('models'), explicit: true });
  assert.deepEqual(
    SETTINGS_INDEX[0]?.items.map((entry) => entry.title),
    ['Modelli'],
  );
  assert.ok(!items.some((entry) => entry.id === 'roles' || entry.id === 'model-evals' || entry.id === 'cloud-models'));
  // Roles, the model of the characters and the cloud switches: any of them makes it dirty, the voice does not.
  for (const part of ['roles', 'sprites', 'cloudModels']) assert.equal(sectionDirty('models', (section) => section === part), true);
  assert.equal(sectionDirty('models', (section) => section === 'voice'), false);
  // A near miss is not an old address.
  assert.equal(resolveSection('modelli-locale').explicit, false);
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
    pendingTitles('models', (section) => changed.has(section)),
    ['Voce', 'Server locali'],
  );
  assert.deepEqual(
    pendingTitles('voice', (section) => changed.has(section)),
    ['Modelli', 'Server locali'],
  );
  assert.deepEqual(
    pendingTitles('labels', () => false),
    [],
  );
});

test('Aspetto holds the theme of this browser (D-158): its own address, no Salva, no data out', () => {
  assert.deepEqual(resolveSection('aspetto'), { item: byId('appearance'), explicit: true });
  assert.equal(byId('appearance').behaviour, 'browser');
  assert.equal(byId('appearance').privacy, undefined);
  assert.equal(BEHAVIOUR_TEXT.browser, 'Vale subito, solo in questo browser');
  assert.equal(sectionDirty('appearance', () => true), false);
  assert.notEqual(resolveSection('tema').item.id, 'appearance');
});
