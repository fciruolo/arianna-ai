import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AREAS, NAV_GROUPS } from '../src/lib/nav-groups.ts';
import { PHONE_TABS, TAB_AREAS, moreGroups, remoteLimit, tabBadge, tabBarShown, tabOf, type AppPage } from '../src/lib/phone-nav.ts';
import { isMorePath, isPendingPath, MORE_PATH, PENDING_PATH } from '../src/lib/route.ts';
import { SETTINGS_INDEX } from '../src/lib/settings-index.ts';

test('the bar has five entries, each once', () => {
  assert.equal(PHONE_TABS.length, 5);
  assert.equal(new Set(PHONE_TABS.map((tab) => tab.id)).size, 5);
  assert.deepEqual(
    PHONE_TABS.map((tab) => tab.label),
    ['Chat', 'Attende te', 'Pensieri', 'Dashboard', 'Altro'],
  );
});

test('every page lights one entry: its own, or «Altro»', () => {
  assert.equal(tabOf('chat'), 'chat');
  assert.equal(tabOf('pending'), 'pending');
  assert.equal(tabOf('thoughts'), 'thoughts');
  assert.equal(tabOf('dashboard'), 'dashboard');
  const others: AppPage[] = ['settings', 'voice-trial', 'new-agent', 'wiki', 'god', 'routines', 'office', 'studio', 'knowledge', 'projects', 'clients', 'finance', 'cardwall', 'followed', 'more'];
  for (const page of others) assert.equal(tabOf(page), 'more', page);
});

test('the bar hides inside a conversation and with the keyboard', () => {
  assert.equal(tabBarShown({ page: 'chat', conversationOpen: false, keyboard: false }), true);
  assert.equal(tabBarShown({ page: 'chat', conversationOpen: true, keyboard: false }), false);
  assert.equal(tabBarShown({ page: 'wiki', conversationOpen: false, keyboard: true }), false);
  // A conversation still in the store does not hide the bar of another page.
  assert.equal(tabBarShown({ page: 'settings', conversationOpen: true, keyboard: false }), true);
});

test('«Altro» holds every area of the left bar once, except those of the bar', () => {
  const areas = moreGroups().flatMap((group) => group.areas);
  assert.equal(new Set(areas).size, areas.length);
  for (const area of TAB_AREAS) assert.equal(areas.includes(area), false, area);
  const all = NAV_GROUPS.flatMap((group) => group.areas);
  assert.equal(areas.length, all.length - TAB_AREAS.length);
  assert.ok(areas.includes('settings'));
  for (const area of all) assert.ok(AREAS[area].label.length > 0, area);
});

test('a group left empty by the bar goes away', () => {
  const groups = moreGroups([
    { id: 'work', title: 'Lavoro', areas: ['dashboard'] },
    { id: 'system', title: 'Sistema', areas: ['settings'] },
  ]);
  assert.deepEqual(
    groups.map((group) => group.id),
    ['system'],
  );
});

test('the badge of «Attende te»', () => {
  assert.equal(tabBadge(0), null);
  assert.equal(tabBadge(-1), null);
  assert.equal(tabBadge(Number.NaN), null);
  assert.equal(tabBadge(3), '3');
  assert.equal(tabBadge(12), '9+');
});

test('the limits of the phone follow the remote door of the core', () => {
  const byId = new Map(SETTINGS_INDEX.flatMap((group) => group.items).map((item) => [item.id, item]));
  const devices = byId.get('devices');
  assert.ok(devices !== undefined);
  assert.equal(remoteLimit(devices), 'mac-only');
  // The sections that let data out save through /api/settings/privacy/, refused from the phone.
  for (const item of byId.values()) if (item.privacy === true) assert.equal(remoteLimit(item), 'read-only', item.id);
  const models = byId.get('models');
  assert.ok(models !== undefined);
  assert.equal(remoteLimit(models), undefined);
  assert.equal(remoteLimit({ id: 'notifications' }), undefined);
});

test('the two pages of the phone have an address of their own', () => {
  assert.equal(isPendingPath(PENDING_PATH), true);
  assert.equal(isPendingPath('/attende-te/'), true);
  assert.equal(isPendingPath('/attende'), false);
  assert.equal(isMorePath(MORE_PATH), true);
  assert.equal(isMorePath('/altro/x'), false);
});
