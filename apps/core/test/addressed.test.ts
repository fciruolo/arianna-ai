import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addressedBrief, parseAddressed } from '../src/addressed.ts';
import { mentionableAgents } from '../src/orchestrator/delegate.ts';
import { resolveHome } from '@arianna/config';
import { committedAgents } from './support/committed-agents.ts';
import { roundText } from '../src/participants.ts';

test('«@name text» addresses one agent; the brief is the rest of the message (D-107, tappa B2)', () => {
  assert.deepEqual(parseAddressed('@designer fammi tre colori per la landing'), { kind: 'mention', agent: 'designer', brief: 'fammi tre colori per la landing' });
  assert.deepEqual(parseAddressed('  @coder\nrifai il footer  '), { kind: 'mention', agent: 'coder', brief: 'rifai il footer' });
  assert.deepEqual(parseAddressed('@coder'), { kind: 'mention', agent: 'coder', brief: '' });
  assert.deepEqual(parseAddressed('@seo-expert controlla i titoli'), { kind: 'mention', agent: 'seo-expert', brief: 'controlla i titoli' });
  // A comma or a colon after the name, as one writes to a person.
  assert.deepEqual(parseAddressed('@designer, fai tre colori'), { kind: 'mention', agent: 'designer', brief: 'fai tre colori' });
  assert.deepEqual(parseAddressed('@designer: fai tre colori'), { kind: 'mention', agent: 'designer', brief: 'fai tre colori' });
  // The name in any letter case: «@Coder» is the coder, never a message for Arianna to give to another agent.
  assert.deepEqual(parseAddressed('@Coder, implementa una landing page'), { kind: 'mention', agent: 'coder', brief: 'implementa una landing page' });
  assert.deepEqual(parseAddressed('@DESIGNER fai tre colori'), { kind: 'mention', agent: 'designer', brief: 'fai tre colori' });
  assert.deepEqual(parseAddressed('@Seo-Expert controlla i titoli'), { kind: 'mention', agent: 'seo-expert', brief: 'controlla i titoli' });
});

test('an «@» that is not a name at the start is an ordinary message', () => {
  for (const body of ['scrivi a @designer', '@ designer ciao', '@designer,ciao', 'email@example.com', '@1 ciao', '']) {
    assert.equal(parseAddressed(body), undefined, body);
  }
});

test('«/giro text» addresses every agent of the conversation; other slashes do not', () => {
  assert.deepEqual(parseAddressed('/giro cosa ne pensate del preventivo?'), { kind: 'round', brief: 'cosa ne pensate del preventivo?' });
  assert.deepEqual(parseAddressed('/giro'), { kind: 'round', brief: '' });
  assert.deepEqual(parseAddressed('/Giro cosa ne pensate?'), { kind: 'round', brief: 'cosa ne pensate?' });
  for (const body of ['/girone ciao', 'facciamo un /giro', '/nota testo']) assert.equal(parseAddressed(body), undefined, body);
});

test('the brief of an addressed message is its text without «@name» or «/giro»; none for an ordinary one', () => {
  assert.equal(addressedBrief('@coder rifai il footer'), 'rifai il footer');
  assert.equal(addressedBrief('/giro opinioni?'), 'opinioni?');
  assert.equal(addressedBrief('ciao'), undefined);
});

test('«@» may call the agents Arianna may delegate to: never Arianna, GOD, the Finances or the local chat model', () => {
  const agents = committedAgents(resolveHome({}));
  const names = mentionableAgents(agents);
  for (const name of ['coder', 'designer', 'reviewer']) assert.ok(names.includes(name), name);
  for (const name of ['arianna', 'god', 'finanze', 'local-chat']) assert.ok(!names.includes(name), name);
  assert.deepEqual(names, [...names].sort());
});

test('the line of a round says who answers, and with one agent alone how to hear others', () => {
  assert.equal(roundText(['traduttore']), "Nel giro c'è solo traduttore: per sentire anche altri agenti chiamali prima con @nome.");
  assert.equal(roundText(['coder', 'traduttore']), 'Giro con Coder e traduttore, uno alla volta.');
  assert.equal(roundText(['critico', 'oroscopo', 'traduttore']), 'Giro con critico, oroscopo e traduttore, uno alla volta.');
});
