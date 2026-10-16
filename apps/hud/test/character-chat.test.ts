import assert from 'node:assert/strict';
import { test } from 'node:test';

import { castByShow, castLook, characterNotice, chatCast, conversationCharacter, rememberChatCast } from '../src/lib/character-chat.ts';
import { choiceCharacter, draftFromAddress, draftPath, sameChoice } from '../src/lib/draft.ts';
import type { ChatCharacter } from '../src/lib/types.ts';

const CAST: ChatCharacter[] = [
  { id: 'jd', name: 'J.D.', show: 'Scrubs', rows: 4 },
  { id: 'turk', name: 'Turk', show: 'Scrubs', rows: 4 },
  { id: 'pam', name: 'Pam', show: 'The Office (US)', rows: 3 },
];

test('the people of the series are grouped by series, in the order of the core', () => {
  assert.deepEqual(
    castByShow(CAST).map((group) => [group.show, group.characters.map((entry) => entry.id)]),
    [
      ['Scrubs', ['jd', 'turk']],
      ['The Office (US)', ['pam']],
    ],
  );
  assert.deepEqual(castByShow([]), []);
});

test('a character looks as the core lists it; one no longer listed keeps its id and a sheet of the series', () => {
  rememberChatCast(CAST);
  assert.equal(chatCast.value.length, 3);
  assert.deepEqual(castLook('pam'), { name: 'Pam', show: 'The Office (US)', choice: { pack: 'serie', character: 'pam', rows: 3 } });
  assert.deepEqual(castLook('cox', []), { name: 'cox', show: '', choice: { pack: 'serie', character: 'cox', rows: 4 } });
  assert.match(characterNotice('J.D.'), /Claude.*J\.D\..*gateway la ferma/);
  rememberChatCast([]);
});

test('the character of a conversation only in the plain chat with Claude', () => {
  assert.equal(conversationCharacter({ seriesCharacter: 'jd', agent: 'claude', workspace: null }), 'jd');
  assert.equal(conversationCharacter({ seriesCharacter: null, agent: 'claude', workspace: null }), null);
  assert.equal(conversationCharacter({ agent: 'claude', workspace: null }), null);
  assert.equal(conversationCharacter({ seriesCharacter: 'jd', agent: 'coder', workspace: 'demo' }), null);
  assert.equal(conversationCharacter({ seriesCharacter: 'jd', agent: 'claude', workspace: 'demo' }), null);
});

test('a draft with a character has its address, and only with Claude at work without a project', () => {
  const choice = { mode: 'work' as const, agent: 'claude', character: 'jd' };
  assert.equal(choiceCharacter(choice), 'jd');
  assert.equal(draftPath(choice), '/nuova?con=claude&personaggio=jd&tipo=lavoro');
  assert.deepEqual(draftFromAddress('/nuova', '?con=claude&personaggio=jd&tipo=lavoro'), choice);
  assert.ok(sameChoice(choice, { ...choice }));
  assert.ok(!sameChoice(choice, { ...choice, character: 'turk' }));
  assert.ok(!sameChoice(choice, { mode: 'work', agent: 'claude' }));
  // Never in a private draft, with another agent, on a project, incognito, or with an id that is not one.
  assert.equal(choiceCharacter({ ...choice, mode: 'private' }), undefined);
  assert.equal(choiceCharacter({ ...choice, agent: 'coder' }), undefined);
  assert.equal(choiceCharacter({ ...choice, project: 'arianna' }), undefined);
  assert.equal(choiceCharacter({ ...choice, incognito: true }), undefined);
  assert.equal(choiceCharacter({ ...choice, character: 'J.D.' }), undefined);
  assert.deepEqual(draftFromAddress('/nuova', '?con=coder&personaggio=jd&tipo=lavoro'), { mode: 'work', agent: 'coder' });
  assert.deepEqual(draftFromAddress('/nuova', '?con=claude&personaggio=jd&tipo=privata'), { mode: 'private', agent: 'claude' });
  assert.equal(draftPath({ mode: 'work', agent: 'coder', character: 'jd', project: 'demo' }), '/nuova?con=coder&tipo=lavoro&progetto=demo');
});
