import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkArt, renderSheet } from '../characters/compose.ts';
import { GOD } from '../characters/art/god.ts';
import { ORIGINALS } from '../characters/originals.ts';
import { agentDescription, agentName, knownAgentName } from '../src/lib/italian.ts';
import { assignIslands, containerOf, placeOfRepo } from '../src/lib/office/snapshot.ts';
import { islandName } from '../src/lib/office/view.ts';

test('GOD has an original character of its own, in the sheet format of the others (D-127, G5)', () => {
  checkArt(GOD);
  const sheet = renderSheet(GOD);
  assert.equal(sheet.width, 112);
  assert.equal(sheet.height, 128);
  assert.ok(ORIGINALS.some((art) => art.id === 'god'));
  assert.equal(agentName('god'), 'GOD');
  assert.equal(knownAgentName('god'), 'GOD');
  assert.equal(agentDescription('god', 'Develops Arianna from inside Arianna, in a clone of its code'), 'Sviluppa Arianna da dentro Arianna, in un clone del suo codice');
});

test('the clones of Arianna share one island, named GOD; the parts of any container share their project\'s', () => {
  const projects = [
    { name: 'demo', path: 'repos/demo', label: 'L1' },
    { name: 'arianna:main', path: 'repos/arianna/main', label: 'L1' },
    { name: 'arianna:g001-quota', path: 'repos/arianna/g001-quota', label: 'L1' },
    { name: 'progetto-test:progetto-test-admin', path: 'repos/progetto-test/progetto-test-admin', label: 'L1' },
  ];
  const { islands, unnamed } = assignIslands(projects, 5);
  assert.deepEqual(
    islands.map((island) => island.project),
    ['demo', 'arianna', 'progetto-test'],
  );
  assert.equal(unnamed, 0);
  assert.deepEqual(placeOfRepo('arianna:g001-quota', projects, islands), { kind: 'island', slot: 1 });
  assert.deepEqual(placeOfRepo('arianna:main', projects, islands), { kind: 'island', slot: 1 });
  assert.equal(containerOf('arianna:main'), 'arianna');
  assert.equal(containerOf('demo'), 'demo');
  assert.equal(islandName('arianna'), 'GOD');
  assert.equal(islandName('demo'), 'demo');
});
