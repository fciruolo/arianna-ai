// The chat with a person of the series on Claude (D-225, tappa B): who may be
// chosen, the short prompt of role-play, the block of the character and its
// lines with their labels and sources, the order of the brief, and the names
// of the series that are no person in that brief alone.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { SERIES_PERSONAS, seriesNamesOf, seriesNamesOfSource, seriesShowNames } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

import { CHARACTER_CHAT_PROMPT, characterChatNames, chatCharacters } from '../src/character-chat.ts';
import { servedRowsSync, servesSync } from '../src/characters.ts';
import { fragmentNamesOf, namesFor } from '../src/gateway.ts';
import { characterBrief } from '../src/orchestrator/claude-direct.ts';
import { characterDirsOf, chatCharacterPart, chatLinesPart, type LinesSource, type TailConfig } from '../src/prompt-tail.ts';

const HOME = resolveHome({});
const root = join(HOME, 'data', 'test-tmp', randomUUID());
mkdirSync(root, { recursive: true });
after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An archive of real lines (D-224) that has lines for J.D. only, and says what it was asked. */
function archive(): LinesSource & { asked: { character: string; named: boolean }[] } {
  const asked: { character: string; named: boolean }[] = [];
  return {
    asked,
    has: (character) => character === 'jd',
    draw: (character, options) => {
      asked.push({ character, named: options.named });
      return ['Aquila!', 'Nota per me stesso: respira.'];
    },
  };
}

const config = (extra: Partial<TailConfig> = {}): TailConfig => ({ personas: {}, ...extra });

test('the characters to chat with: every person of the series the pack serves, in order, with the rows of its sheet', () => {
  const dirs = characterDirsOf(HOME, root);
  const all = chatCharacters((pack, character) => servedRowsSync(dirs, pack, character));
  assert.deepEqual(
    all.map((entry) => entry.id),
    Object.keys(SERIES_PERSONAS),
  );
  assert.deepEqual(all[0], { id: 'jd', name: 'J.D.', show: 'Scrubs', rows: 4 });
  // The people of one series stay together.
  const shows = all.map((entry) => entry.show);
  assert.deepEqual(shows, [...shows].sort((a, b) => shows.indexOf(a) - shows.indexOf(b)));
  // One the pack does not serve is left out; servesSync says the same as the rows.
  assert.deepEqual(chatCharacters((_pack, character) => (character === 'pam' ? 4 : undefined)).map((entry) => entry.id), ['pam']);
  assert.equal(servesSync(dirs, 'serie', 'jd'), true);
  assert.equal(servedRowsSync(dirs, 'serie', 'nessuno'), undefined);
  assert.equal(servesSync(dirs, 'serie', 'nessuno'), false);
});

test('the prompt of role-play is short, ours, and names no character', () => {
  assert.ok(CHARACTER_CHAT_PROMPT.length < 1200);
  assert.match(CHARACTER_CHAT_PROMPT, /Stay in character/);
  assert.match(CHARACTER_CHAT_PROMPT, /Italian/);
  assert.match(CHARACTER_CHAT_PROMPT, /never ask for personal data/);
  assert.match(CHARACTER_CHAT_PROMPT, /no tools/);
  for (const person of Object.values(SERIES_PERSONAS)) {
    for (const name of seriesNamesOf(person)) assert.ok(!CHARACTER_CHAT_PROMPT.includes(name), name);
    assert.ok(!CHARACTER_CHAT_PROMPT.includes(person.show), person.show);
  }
});

test('the block of the character plays for real, scene included: the repository text L0, the user rewrite L1 with its own source', () => {
  const part = chatCharacterPart(config(), 'jd');
  assert.ok(part !== undefined);
  assert.equal(part.label, 'L0');
  assert.equal(part.source, 'character:serie/jd');
  assert.match(part.text, /You are J\.D\. of Scrubs, never Arianna/);
  assert.match(part.text, /<scene>.*Turk.*<\/scene>/s);
  // Without lines apart the fixed catchphrases are in.
  assert.match(part.text, /Aquilaaa!/);
  // With lines from the archive the catchphrases stay out.
  const lines = archive();
  const withLines = chatCharacterPart(config({ lines }), 'jd', 'L1', true);
  assert.doesNotMatch(withLines?.text ?? '', /Aquilaaa!/);
  // A character the archive has nothing for keeps its catchphrases.
  assert.match(chatCharacterPart(config({ lines }), 'turk', 'L1', true)?.text ?? '', /Ce l’abbiamo fatta/);
  // The user's rewrite (D-223): L1, `#own`, in a work step too.
  const own = chatCharacterPart(config({ series: { jd: { traits: 'Un J.D. tutto mio, molto timido.' } } }), 'jd');
  assert.deepEqual([own?.label, own?.source], ['L1', 'character:serie/jd#own']);
  assert.match(own?.text ?? '', /tutto mio/);
  // Not a person of the series: nothing.
  assert.equal(chatCharacterPart(config(), 'arianna'), undefined);
  assert.equal(chatCharacterPart(config(), 'constructor'), undefined);
});

test('the lines of each message: L1, lines naming the others drawn too, never in an L0 step', () => {
  const lines = archive();
  const part = chatLinesPart(config({ lines }), 'jd', 'L1', 'conversation-1');
  assert.deepEqual([part?.label, part?.source], ['L1', 'character:serie/jd#lines']);
  assert.match(part?.text ?? '', /<character_lines>[\s\S]*Aquila![\s\S]*<\/character_lines>/);
  assert.deepEqual(lines.asked, [{ character: 'jd', named: true }]);
  assert.equal(chatLinesPart(config({ lines }), 'jd', 'L0', 'conversation-1'), undefined);
  assert.equal(chatLinesPart(config({ lines }), 'turk', 'L1', 'conversation-1'), undefined);
  assert.equal(chatLinesPart(config(), 'jd', 'L1', 'conversation-1'), undefined);
});

test('the brief: prompt, block, exchanges, lines in a new start; the new message and the lines when resumed', () => {
  const role = { text: 'BLOCK', label: 'L0' as const, source: 'character:serie/jd' };
  const lines = { text: 'LINES', label: 'L1' as const, source: 'character:serie/jd#lines' };
  const prompt = { text: 'PROMPT', label: 'L0' as const, source: 'prompt:character-chat' };
  const user = { text: 'User:\nCiao', label: 'L1' as const, source: 'message:1' };
  assert.deepEqual(
    characterBrief([prompt, user], { role, lines }, false).map((fragment) => fragment.text),
    ['PROMPT', 'BLOCK', 'User:\nCiao', 'LINES'],
  );
  assert.deepEqual(
    characterBrief([user], { role, lines }, true).map((fragment) => fragment.text),
    ['User:\nCiao', 'LINES'],
  );
  // Without lines in the archive: nothing after the message.
  assert.deepEqual(
    characterBrief([user], { role, lines: undefined }, true).map((fragment) => fragment.source),
    ['message:1'],
  );
});

test('the names of the series of the character are no person in its brief only, whole, never those of another series', () => {
  const names = characterChatNames('jd');
  assert.deepEqual(names, seriesShowNames('jd'));
  for (const name of ['J.D.', 'JD', 'Turk', 'Elliot', 'Carla', 'Dr. Cox', 'Cox', 'Dr. Kelso'].filter((name) => Object.values(SERIES_PERSONAS).some((person) => seriesNamesOf(person).includes(name)))) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes('Pam') && !names.includes('Jim') && !names.includes('Dwight'));
  assert.ok(characterChatNames('pam').includes('Michael'));
  assert.ok(!characterChatNames('pam').includes('Turk'));
  assert.deepEqual(characterChatNames('constructor'), []);
  assert.deepEqual(characterChatNames('arianna'), []);

  // The gateway: the names of this payload join the worn ones for every fragment without names of its own.
  assert.deepEqual(namesFor({}, ['Carla']), ['Carla']);
  assert.deepEqual(namesFor({ names: ['Turk', '', ' '] }, ['Carla']), ['Carla', 'Turk']);
  const message = { value: 'Turk dice ciao', label: 'L1' as const, source: 'message:1' };
  assert.ok(fragmentNamesOf([message], namesFor({ names }, []))[0]?.includes('Turk'));
  // Without them (another brief) the same message has no exemption.
  assert.equal(fragmentNamesOf([message], namesFor({}, []))[0], undefined);
  // The pieces of the series keep every name of the series, as before.
  assert.ok((seriesNamesOfSource('character:serie/jd') ?? []).includes('Pam'));
});
