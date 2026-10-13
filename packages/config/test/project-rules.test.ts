import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, EMPTY_CATALOG, MAX_PROJECT_RULES, parseConfig, parseProjectRules, readSettings, renderSettings, ruleAudience, rulesFor, rulesOfProject, type Settings } from '@arianna/config';

const HOME = resolve('some-home');

test('[project_rules]: absent is no template and no project with its own rules (D-174)', () => {
  assert.deepEqual(parseProjectRules(undefined), { projects: {} });
  assert.deepEqual(parseConfig(renderSettings(DEFAULT_SETTINGS), HOME).projectRules, { projects: {} });
});

test('a project follows the template unless it has its own line; an empty own text is no rules', () => {
  const rules = parseProjectRules({ template: 'Comments in English.', projects: { site: 'Use pnpm.', bare: '  \n' } });
  assert.equal(rulesOfProject(rules, 'site'), 'Use pnpm.');
  assert.equal(rulesOfProject(rules, 'other'), 'Comments in English.');
  assert.equal(rulesOfProject(rules, 'bare'), undefined);
  assert.equal(rulesOfProject(parseProjectRules({ projects: {} }), 'site'), undefined);
  // An inherited key is no line of the user.
  assert.equal(rulesOfProject(rules, 'constructor'), 'Comments in English.');
});

test('refuses unknown keys, names that are not project names, long texts and control characters', () => {
  const cases: unknown[] = [
    { template: 'x', extra: 1 },
    { projects: { 'Site One': 'x' } },
    { projects: JSON.parse('{ "__proto__": "x" }') as unknown },
    { template: 'a'.repeat(MAX_PROJECT_RULES + 1) },
    { projects: { site: 'a\u0007b' } },
    { template: 7 },
  ];
  for (const value of cases) assert.throws(() => parseProjectRules(value), /project_rules/, JSON.stringify(value));
  assert.doesNotThrow(() => parseProjectRules({ template: `a\tb\r\nc${'a'.repeat(MAX_PROJECT_RULES - 6)}` }));
});

test('written and read back: several lines as a literal string, quotes and backslashes as they are', () => {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    projectRules: { template: "Comments in English.\nNever add a Co-Authored-By line.\nBackslashes like a\\b and \"quotes\".", projects: { site: "One line, ends with a quote'", other: "a '''triple''' quote\nsecond line", none: '' } },
  };
  const text = renderSettings(settings);
  assert.match(text, /^template = '''\nComments in English\.$/m);
  assert.deepEqual(readSettings(text, HOME, EMPTY_CATALOG).projectRules, settings.projectRules);
  assert.deepEqual(readSettings(renderSettings(DEFAULT_SETTINGS), HOME, EMPTY_CATALOG).projectRules, undefined);
});

test('rulesFor: an item marked for one executor reaches only it, without the mark (D-181)', () => {
  const text = [
    '# Stile',
    '- TypeScript strict',
    '- [solo Claude Code] Usa i subagenti per le ricerche',
    '  con un solo livello',
    '- [solo Codex] Niente patch enormi',
    '1. [Solo codex] Esegui i test prima',
    '',
    'Paragrafo per tutti.',
  ].join('\n');
  assert.equal(rulesFor(text, 'claude'), '# Stile\n- TypeScript strict\n- Usa i subagenti per le ricerche\n  con un solo livello\n\nParagrafo per tutti.');
  assert.equal(rulesFor(text, 'codex'), '# Stile\n- TypeScript strict\n- Niente patch enormi\n1. Esegui i test prima\n\nParagrafo per tutti.');
});

test('rulesFor: no marks is the same text for both; nothing left is undefined; a mark elsewhere is text (D-181)', () => {
  assert.equal(rulesFor('- a\n- b', 'claude'), '- a\n- b');
  assert.equal(rulesFor('Commenti in inglese.\n[solo Codex] Usa pnpm.\n## Titolo per tutti', 'claude'), 'Commenti in inglese.\n## Titolo per tutti');
  assert.equal(rulesFor('- [solo Codex] solo questa', 'claude'), undefined);
  assert.equal(rulesFor('Scrivi [solo Codex] nel testo', 'claude'), 'Scrivi [solo Codex] nel testo');
  assert.equal(rulesFor('    - [solo Codex] codice indentato', 'claude'), '- [solo Codex] codice indentato');
  assert.deepEqual(ruleAudience('[solo Claude Code] x'), { audience: 'claude', text: 'x' });
  assert.deepEqual(ruleAudience('[solo Gemini] x'), { audience: 'both', text: '[solo Gemini] x' });
});

test('rulesFor: sub-items follow their rule, CRLF lines are read, code blocks are text (D-181)', () => {
  const nested = '- [solo Claude Code] Subagenti\n  - un solo livello\n  - mai in parallelo\n- Per tutti\n  - [solo Claude Code] dettaglio di una regola per tutti';
  assert.equal(rulesFor(nested, 'codex'), '- Per tutti\n  - [solo Claude Code] dettaglio di una regola per tutti');
  assert.equal(rulesFor(nested, 'claude'), '- Subagenti\n  - un solo livello\n  - mai in parallelo\n- Per tutti\n  - [solo Claude Code] dettaglio di una regola per tutti');
  assert.equal(rulesFor('- A\r\n- [solo Codex] B\r\n- C', 'claude'), '- A\n- C');
  const fenced = 'Esempio:\n```\n- [solo Codex] dentro un blocco\n```\n- [solo Codex] fuori';
  assert.equal(rulesFor(fenced, 'claude'), 'Esempio:\n```\n- [solo Codex] dentro un blocco\n```');
  assert.equal(rulesFor('- [solo Codex] con esempio\n  ```\n- non una voce\n  ```\n- Per tutti', 'claude'), '- Per tutti');
});
