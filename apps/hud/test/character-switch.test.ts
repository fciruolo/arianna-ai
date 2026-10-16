import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SERIES_PACK_ID } from '../../../packages/agents/src/series-personas.ts';
import { CHARACTER_OFF_TITLE, CHARACTER_ON_TITLE, characterSwitch, SERIES_PACK } from '../src/lib/character-switch.ts';
import type { CharacterChoice } from '../src/lib/types.ts';

const COX: Record<string, CharacterChoice> = { arianna: { pack: 'originali', character: 'arianna', rows: 4 }, coder: { pack: 'serie', character: 'cox', rows: 4 } };
const ORIGINALS: Record<string, CharacterChoice> = { arianna: { pack: 'originali', character: 'arianna', rows: 4 } };
const WITH_ARIANNA = { agent: null, workspace: null, trialModel: null };

test('characterSwitch (D-225): on by default, also from a core that does not send it', () => {
  assert.equal(SERIES_PACK, SERIES_PACK_ID);
  assert.deepEqual(characterSwitch({ ...WITH_ARIANNA }, COX), { shown: true, on: true, text: 'Personaggio acceso', title: CHARACTER_ON_TITLE });
  assert.equal(characterSwitch({ ...WITH_ARIANNA, character: true }, COX).on, true);
  // A work chat with the Coder on a project: the switch is there too.
  assert.equal(characterSwitch({ agent: 'coder', workspace: 'demo', trialModel: null }, COX).shown, true);
});

test('characterSwitch (D-225): off says so, and how to turn it on again', () => {
  assert.deepEqual(characterSwitch({ ...WITH_ARIANNA, character: false }, COX), { shown: true, on: false, text: 'Personaggio spento', title: CHARACTER_OFF_TITLE });
});

test('characterSwitch (D-225): hidden without a person of the series, in a trial or in the plain chat with Claude or ChatGPT', () => {
  assert.equal(characterSwitch({ ...WITH_ARIANNA }, ORIGINALS).shown, false);
  assert.equal(characterSwitch({ ...WITH_ARIANNA }, undefined).shown, false);
  assert.equal(characterSwitch({ ...WITH_ARIANNA, trialModel: 'qwen' }, COX).shown, false);
  assert.equal(characterSwitch({ agent: 'claude', workspace: null, trialModel: null }, COX).shown, false);
  assert.equal(characterSwitch({ agent: 'codex', workspace: null, trialModel: null }, COX).shown, false);
});
