// «Pronta per i dati veri» (D-192): the groups are written twice, in the core
// (apps/core/src/readiness.ts) and in the chat (apps/hud, which imports no
// workspace package). A group only one side knows would show as «Altri
// controlli» or vanish: the two lists must be the same, in the same order.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { READINESS_IDS as CHAT_IDS, READINESS_TEXT } from '../apps/hud/src/lib/installation.ts';
import { READINESS_IDS as CORE_IDS, REQUIRED_GROUPS } from '../apps/core/src/readiness.ts';

test('the core and the chat name the same groups of «Pronta per i dati veri», in the same order', () => {
  assert.deepEqual([...CHAT_IDS], [...CORE_IDS]);
  assert.deepEqual(Object.keys(READINESS_TEXT).sort(), [...CORE_IDS].sort());
  for (const id of REQUIRED_GROUPS) assert.ok((CHAT_IDS as readonly string[]).includes(id), id);
});
