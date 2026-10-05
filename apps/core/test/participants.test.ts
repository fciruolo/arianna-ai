// The lines and texts of the agents that join a conversation (D-125), without
// the database: what the chat shows, what the agent and Arianna read.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LoadedAgent } from '@arianna/agents';

import { ADDING_PREFIX } from '../../hud/src/lib/adding-line.ts';
import { LOCAL_FRAME, localSystem } from '../src/orchestrator/delegate.ts';
import { addedLine, addingLine, ENTRY_TEXT, nameLabelOf, participantName, participantsNote, removedLine } from '../src/participants.ts';

test('the chat recognises the line of Arianna bringing an agent in by its start', () => {
  assert.ok(addingLine('traduttore', 'Traduzione').startsWith(ADDING_PREFIX));
  assert.ok(addingLine('coder', undefined).startsWith(ADDING_PREFIX));
  assert.ok(!addedLine('coder').startsWith(ADDING_PREFIX));
});

test('the lines of the chat name the agent, the Coder with its capital', () => {
  assert.equal(addingLine('coder', 'per sviluppare la landing page'), 'Arianna aggiunge Coder: per sviluppare la landing page');
  assert.equal(addedLine('coder'), 'Coder è stato aggiunto');
  assert.equal(removedLine('traduttore'), 'Hai tolto traduttore');
  assert.equal(participantName('revisore'), 'revisore');
});

test('a reason the gateway did not let through, or an empty one, leaves only who joins', () => {
  assert.equal(addingLine('coder', undefined), 'Arianna aggiunge Coder');
  assert.equal(addingLine('coder', '   '), 'Arianna aggiunge Coder');
  assert.equal(addingLine('coder', '  per i test  '), 'Arianna aggiunge Coder: per i test');
});

test('Arianna reads who is in the conversation, and nothing when nobody joined', () => {
  assert.equal(participantsNote(['coder', 'revisore']), 'In this conversation: coder, revisore.');
  assert.equal(participantsNote([]), undefined);
});

test("the name of an agent of agents/ is L0 in the chat, a user's one L1, a gone one L1", () => {
  const card = {} as LoadedAgent['card'];
  assert.equal(nameLabelOf({ card, prompt: '' }), 'L0');
  assert.equal(nameLabelOf({ card, prompt: '', origin: 'user' }), 'L1');
  assert.equal(nameLabelOf(undefined), 'L1');
});

test('an agent that only answers reads the entry text only at its first delegation', () => {
  assert.equal(localSystem('Traduci.', false), `${LOCAL_FRAME}\nTraduci.`);
  assert.equal(localSystem('Traduci.', true), `${LOCAL_FRAME}\nTraduci.\n\n${ENTRY_TEXT}`);
  assert.match(ENTRY_TEXT, /one line only that greets them/);
  assert.match(ENTRY_TEXT, /colleagues/);
  // Fixed and ours (L0): no date or other changing part.
  assert.doesNotMatch(ENTRY_TEXT, /\d/);
});
