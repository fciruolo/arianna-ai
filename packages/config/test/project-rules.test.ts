import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_SETTINGS, EMPTY_CATALOG, MAX_PROJECT_RULES, parseConfig, parseProjectRules, readSettings, renderSettings, rulesOfProject, type Settings } from '@arianna/config';

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
