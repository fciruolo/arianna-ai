import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHANGELOG_PATH, DEV_PATH, isSettingsPath, settingsPathFor, settingsSlug } from '../src/lib/route.ts';
import { BEHAVIOUR_TEXT, hrefOf, legacySection, pendingTitles, resolveSection, sectionDirty, SETTINGS_INDEX, unsavedText } from '../src/lib/settings-index.ts';

const items = SETTINGS_INDEX.flatMap((group) => group.items);
function byId(id: string) {
  const item = items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`no entry ${id}`);
  return item;
}

test('six groups by subject (D-192), with the new names of the entries', () => {
  assert.deepEqual(
    SETTINGS_INDEX.map((group) => group.group),
    ['Intelligenza', 'Comunicazione', 'Lavoro', 'Privacy e uscite', 'Sistema', 'Informazioni'],
  );
  assert.deepEqual(
    SETTINGS_INDEX.map((group) => group.items.map((entry) => entry.title)),
    [
      ['Modelli', 'Agenti', 'Su di te', 'Skill e stili', 'Catalogo agenti'],
      ['Voce e chiamate', 'Notifiche', 'Segretaria'],
      ['Progetti', 'Regole dei progetti'],
      ['Claude e Codex', 'Link da riassumere'],
      ['Server dei modelli', 'Aspetto e installazione'],
      ['Novità', 'Consumi', 'Sviluppo di Arianna'],
    ],
  );
  // Ids and slugs are unique.
  assert.equal(new Set(items.map((entry) => entry.id)).size, items.length);
  assert.equal(new Set(items.map((entry) => entry.slug)).size, items.length);
});

test('every entry that lets data out has the lock and asks for confirmation; the others do not', () => {
  assert.deepEqual(
    items.filter((entry) => entry.privacy === true).map((entry) => entry.title),
    ['Progetti', 'Claude e Codex', 'Link da riassumere', 'Server dei modelli'],
  );
  for (const item of items) assert.equal(item.privacy === true, item.behaviour === 'confirm', item.title);
});

test('one pill per section: Vale subito, Al riavvio or Con conferma; none for what is only read', () => {
  assert.equal(BEHAVIOUR_TEXT.now, 'Vale subito');
  assert.equal(BEHAVIOUR_TEXT.restart, 'Al riavvio');
  assert.equal(BEHAVIOUR_TEXT.confirm, 'Con conferma');
  assert.equal(BEHAVIOUR_TEXT.read, null);
  assert.equal(BEHAVIOUR_TEXT.browser, null);
});

test('every section says what it is for; the editable ones also give an example, and no text says «nucleo»', () => {
  for (const item of items) {
    assert.ok(item.lead.length > 20, item.title);
    assert.doesNotMatch(item.lead, /nucleo/i);
    assert.doesNotMatch(item.example ?? '', /nucleo/i);
    if (item.behaviour === 'now' || item.behaviour === 'confirm') assert.ok((item.example ?? '').length > 10, item.title);
  }
});

test('Etichette is no longer an entry: its address opens Claude e Codex, where the table is', () => {
  assert.ok(!items.some((entry) => entry.id === 'labels'));
  assert.deepEqual(resolveSection('etichette'), { item: byId('executors'), explicit: true });
});

test('the address names the section; none or an unknown one falls back to the first', () => {
  assert.deepEqual(resolveSection('progetti'), { item: byId('projects'), explicit: true });
  // Telegram is off (D-110): its old address falls back to the first section.
  assert.equal(resolveSection('telegram').item.id, 'models');
  assert.equal(resolveSection(undefined).item.id, 'models');
  assert.equal(resolveSection(undefined).explicit, false);
  assert.equal(resolveSection('non-esiste').item.id, 'models');
  assert.equal(resolveSection('non-esiste').explicit, false);
});

test('the old addresses of renamed or merged sections open the new one (D-192)', () => {
  const moved: [string, string][] = [
    ['esecutori-cloud', 'executors'],
    ['server-locali', 'servers'],
    ['link-scaricati', 'links'],
    ['aspetto', 'system'],
    ['installazione', 'system'],
    ['personaggi', 'agents'],
    ['personalita', 'agents'],
    ['modelli-locali', 'models'],
    ['prove-dei-modelli', 'models'],
    ['modelli-cloud', 'models'],
    ['provino-della-voce', 'voice'],
  ];
  for (const [old, id] of moved) assert.deepEqual(resolveSection(old), { item: byId(id), explicit: true }, old);
  // A near miss is not an old address.
  assert.equal(resolveSection('modelli-locale').explicit, false);
  assert.equal(resolveSection('tema').explicit, false);
});

test('Novità and Sviluppo di Arianna are sections now, and their old pages lead there', () => {
  assert.deepEqual(resolveSection('novita'), { item: byId('changelog'), explicit: true });
  assert.deepEqual(resolveSection('sviluppo'), { item: byId('dev-progress'), explicit: true });
  assert.equal(hrefOf(byId('dev-progress')), '/impostazioni/sviluppo');
  assert.equal(hrefOf(byId('changelog')), '/impostazioni/novita');
  assert.equal(legacySection(CHANGELOG_PATH), 'novita');
  assert.equal(legacySection(`${CHANGELOG_PATH}/`), 'novita');
  assert.equal(legacySection(DEV_PATH), 'sviluppo');
  assert.equal(legacySection(`${DEV_PATH}/`), 'sviluppo');
  assert.equal(legacySection('/sviluppo/altro'), undefined);
  assert.equal(legacySection('/impostazioni/novita'), undefined);
  assert.equal(legacySection('/'), undefined);
});

test('the entries lead to their section', () => {
  assert.equal(hrefOf(byId('servers')), '/impostazioni/server-dei-modelli');
  assert.equal(hrefOf(byId('skills')), '/impostazioni/skill-e-stili');
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

test('the parts each section edits: any of them makes it dirty, the others do not', () => {
  for (const part of ['roles', 'sprites', 'cloudModels']) assert.equal(sectionDirty('models', (section) => section === part), true);
  assert.equal(sectionDirty('models', (section) => section === 'voice'), false);
  for (const part of ['characters', 'personas', 'agents', 'skills', 'participants']) assert.equal(sectionDirty('agents', (section) => section === part), true);
  // The keys of the push notifications are in Notifiche, the rest of [voice] in Voce (D-192).
  assert.equal(sectionDirty('notifications', (section) => section === 'push'), true);
  assert.equal(sectionDirty('voice', (section) => section === 'push'), false);
  assert.equal(sectionDirty('voice', (section) => section === 'voice'), true);
  // Read-only and browser-only sections are never dirty.
  for (const id of ['system', 'changelog', 'dev-progress', 'skills']) assert.equal(sectionDirty(id, () => true), false, id);
});

test('sections left with unsaved edits are named, the open one never', () => {
  const changed = new Set(['voice', 'endpoints', 'roles']);
  assert.deepEqual(
    pendingTitles('models', (section) => changed.has(section)),
    ['Voce e chiamate', 'Server dei modelli'],
  );
  assert.deepEqual(
    pendingTitles('voice', (section) => changed.has(section)),
    ['Modelli', 'Server dei modelli'],
  );
  assert.deepEqual(
    pendingTitles('system', () => false),
    [],
  );
});

test('the save bar counts the edits in Italian', () => {
  assert.equal(unsavedText(1), '1 modifica non salvata');
  assert.equal(unsavedText(3), '3 modifiche non salvate');
});
