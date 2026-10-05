import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS, completion, filterCommands, findCommand, goesToArianna, menuQuery, moveSelection, resolveDraft, usage } from '../src/lib/commands.ts';

const names = (list: readonly { name: string }[]) => list.map((command) => command.name);

test('the registry: unique lowercase names and aliases, an Italian description each', () => {
  const keys = COMMANDS.flatMap((command) => [command.name, ...(command.alias === undefined ? [] : [command.alias])]);
  assert.equal(new Set(keys).size, keys.length);
  for (const command of COMMANDS) {
    assert.match(command.name, /^\p{Ll}+$/u);
    assert.ok(command.description.length > 0);
  }
  assert.deepEqual(names(COMMANDS), ['nota', 'pensieri', 'conoscenza', 'nuova', 'impostazioni', 'cerca', 'aiuto']);
});

test('the menu opens on a slash and one word, and closes at the first space', () => {
  assert.equal(menuQuery('/'), '');
  assert.equal(menuQuery('/pen'), 'pen');
  assert.equal(menuQuery('/nota '), undefined);
  assert.equal(menuQuery('/nota testo'), undefined);
  assert.equal(menuQuery('ciao /nota'), undefined);
  assert.equal(menuQuery(''), undefined);
  assert.equal(menuQuery(' /nota'), undefined);
});

test('the filter: all for an empty query, then exact, prefix, inside the name, inside the description', () => {
  assert.equal(filterCommands('').length, COMMANDS.length);
  assert.deepEqual(names(filterCommands('n')), ['nota', 'nuova', 'pensieri', 'conoscenza', 'impostazioni']);
  assert.deepEqual(names(filterCommands('pen')), ['pensieri', 'nota', 'cerca']);
  assert.deepEqual(names(filterCommands('PEN')), ['pensieri', 'nota', 'cerca']);
  assert.deepEqual(names(filterCommands('grafo')), ['conoscenza']);
  assert.deepEqual(names(filterCommands('g')), ['conoscenza']);
  assert.deepEqual(names(filterCommands('el')), []);
  assert.deepEqual(names(filterCommands('elenco')), ['aiuto']);
  assert.deepEqual(filterCommands('xyz'), []);
});

test('the arrows move the highlighted row and wrap around', () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(0, -1, 3), 2);
  assert.equal(moveSelection(-1, 1, 3), 0);
  assert.equal(moveSelection(-1, -1, 3), 2);
  assert.equal(moveSelection(5, 1, 3), 0);
  assert.equal(moveSelection(0, 1, 0), -1);
});

function command(name: string) {
  const found = findCommand(name);
  assert.ok(found !== undefined, name);
  return found;
}

test('choosing a command: a space after one that takes a text, none otherwise', () => {
  assert.equal(completion(command('nota')), '/nota ');
  assert.equal(completion(command('pensieri')), '/pensieri');
  assert.equal(usage(command('nota')), '/nota <testo>');
  assert.equal(usage(command('aiuto')), '/aiuto');
});

test('aliases and any case find the command', () => {
  assert.equal(findCommand('N')?.name, 'nota');
  assert.equal(findCommand('p')?.name, 'pensieri');
  assert.equal(findCommand('Conoscenza')?.name, 'conoscenza');
  assert.equal(findCommand('note'), undefined);
});

test('a draft: a message, a known command with its text, or a refusal in Italian', () => {
  assert.deepEqual(resolveDraft('ciao Arianna'), { kind: 'message' });
  assert.deepEqual(resolveDraft('/etc/hosts non si apre'), { kind: 'message' });
  const note = resolveDraft('/nota  comprare il pane ');
  assert.ok(note.kind === 'command');
  assert.equal(note.argument, 'comprare il pane');
  const thoughts = resolveDraft('  /pensieri');
  assert.equal(thoughts.kind === 'command' ? thoughts.command.action.kind : '', 'open');
  assert.deepEqual(resolveDraft('/pensieri oggi'), { kind: 'error', text: '/pensieri non vuole testo dopo il nome.' });
  const unknown = resolveDraft('/boh');
  assert.ok(unknown.kind === 'error');
  assert.match(unknown.text, /^Comando sconosciuto: \/boh\./);
});

test('a slash and letters is always a command, after spaces and invisible characters; only a path passes', () => {
  const refused = (draft: string) => {
    const meaning = resolveDraft(draft);
    return meaning.kind === 'error' ? meaning.text : undefined;
  };
  assert.match(refused('/pensieri.') ?? '', /^Comando sconosciuto: \/pensieri\.\./);
  assert.match(refused('/nota:testo') ?? '', /^Comando sconosciuto: \/nota:/);
  assert.match(refused('​/boh') ?? '', /^Comando sconosciuto: \/boh\./);
  assert.equal(resolveDraft(' /aiuto').kind, 'command');
  assert.equal(resolveDraft('﻿/nota x').kind, 'command');
  assert.deepEqual(resolveDraft('/etc/hosts non si apre'), { kind: 'message' });
  assert.deepEqual(resolveDraft('/usr/local/bin'), { kind: 'message' });
  assert.deepEqual(resolveDraft('/ 2 fa 3'), { kind: 'message' });
  assert.deepEqual(resolveDraft('/123'), { kind: 'message' });
});

test('goesToArianna: messages yes, every command or refused command no', () => {
  for (const draft of ['ciao', '/etc/hosts', 'ricorda /nota x', '/ 2 fa 3']) assert.equal(goesToArianna(draft), true, draft);
  for (const draft of ['/PENSIERI', '/Nuova', '\t/aiuto', '/p', '​/pensieri', ' /conoscenza', '/pensieri.', '/nota x', '/boh']) {
    assert.equal(goesToArianna(draft), false, JSON.stringify(draft));
  }
});
