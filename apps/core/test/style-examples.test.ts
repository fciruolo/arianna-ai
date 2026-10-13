// The examples of the styles and the Italian descriptions of the skills (I-20, D-185), with a fake Sonnet.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { CloudTextError, createCloudText, type CloudTextRequest } from '../src/cloud-text.ts';
import type { Sql } from '../src/db/client.ts';
import { createSkillTranslations, parseTranslations, ROLE_TRANSLATIONS_FILE, ROLE_UNREADABLE_STOP, UNREADABLE_STOP } from '../src/skill-translations.ts';
import { checkedPage, createStyleExamples, EXAMPLE_PROMPT, parseExamples, StyleExampleError } from '../src/style-examples.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `style-examples-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const LANDING = '<!doctype html><html><head><style>body{color:#111}</style></head><body><h1>Ciao</h1><a href="https://example.com">sito</a></body></html>';
const DECK = '<!doctype html><html><body><section data-slide><h1>Uno</h1></section><section data-slide><h2>Due</h2></section><section data-slide><h2>Tre</h2></section></body></html>';
const ANSWER = `=====LANDING=====\n${LANDING}\n=====DECK=====\n${DECK}\n`;

test('a page is kept whole; a font link, a script and links to sites are taken out', () => {
  const page = checkedPage('```html\n<!doctype html><html><head><link rel="stylesheet" href="https://fonts.example/x.css"><script>alert(1)</script></head><body><a href="https://x.it">x</a></body></html>\n```');
  assert.ok(page !== undefined);
  assert.doesNotMatch(page, /<link|<script|https:/);
  assert.match(page, /href="#"/);
});

test('a page that still asks the network, has handlers or is not a document is refused', () => {
  assert.equal(checkedPage('<html><body><img src="https://x.it/a.png"></body></html>'), undefined);
  assert.equal(checkedPage('<html><body style="background:url(//x.it/a.png)"></body></html>'), undefined);
  assert.equal(checkedPage('<html><body onload="x()"></body></html>'), undefined);
  assert.equal(checkedPage('<div>non è un documento</div>'), undefined);
  assert.equal(checkedPage(`<html><body>${'a'.repeat(500 * 1024)}</body></html>`), undefined);
});

test('the answer: two pages in the format, the presentation with its slides', () => {
  assert.ok(parseExamples(ANSWER) !== undefined);
  assert.equal(parseExamples(`=====LANDING=====\n${LANDING}\n=====DECK=====\n${LANDING}`), undefined, 'a deck without slides');
  assert.equal(parseExamples(LANDING), undefined);
});

function source(texts: Record<string, string>): { list: () => { styles: { slug: string }[] }; styleText: (slug: string) => { text: string } } {
  return {
    list: () => ({ styles: Object.keys(texts).map((slug) => ({ slug })) }),
    styleText: (slug) => {
      const text = texts[slug];
      if (text === undefined) throw new Error('gone');
      return { text };
    },
  };
}

test('examples are made once per DESIGN.md: the missing ones only, again when it changes', async () => {
  const texts: Record<string, string> = { alfa: '# Alfa\n`#112233`', beta: '# Beta\n`#445566`' };
  const asked: CloudTextRequest[] = [];
  const examples = createStyleExamples({
    dir: join(HOME, 'a'),
    source: source(texts),
    ask: (request) => {
      asked.push(request);
      return Promise.resolve(ANSWER);
    },
  });
  examples.generate('alfa');
  await examples.idle();
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]?.parts.map((part) => part.text), [EXAMPLE_PROMPT, texts.alfa]);
  assert.ok(asked.every((request) => request.model === 'opus'));
  assert.match(examples.read('alfa', 'landing'), /Ciao/);
  assert.match(examples.read('alfa', 'deck'), /data-slide/);
  assert.equal(examples.status().examples.alfa?.current, true);
  examples.generate('alfa');
  await examples.idle();
  assert.equal(asked.length, 1, 'asked again for a current example: nothing made');
  examples.generateMissing();
  await examples.idle();
  assert.equal(asked.length, 2, 'only beta was missing');
  examples.generateMissing();
  await examples.idle();
  assert.equal(asked.length, 2, 'nothing changed: nothing made again');
  texts.alfa = '# Alfa\n`#ffffff`';
  assert.equal(examples.status().examples.alfa?.current, false);
  examples.generateMissing();
  await examples.idle();
  assert.equal(asked.length, 3, 'the changed style is made again');
});

test('an answer out of format leaves no example; out of quota the queue stops', async () => {
  let calls = 0;
  const examples = createStyleExamples({
    dir: join(HOME, 'b'),
    source: source({ uno: 'u', due: 'd', tre: 't' }),
    ask: () => {
      calls += 1;
      return calls === 1 ? Promise.resolve('niente pagine') : Promise.reject(new CloudTextError('quota', 'Claude è senza quota'));
    },
  });
  examples.generateMissing();
  await examples.idle();
  const status = examples.status();
  assert.deepEqual(status.examples, {});
  assert.match(status.failed.uno ?? '', /formato/);
  assert.equal(status.stopped, 'Claude è senza quota');
  assert.equal(calls, 2, 'the third was not tried');
  assert.throws(() => examples.read('uno', 'landing'), (error: unknown) => error instanceof StyleExampleError && error.code === 'not-found');
  assert.throws(() => examples.read('../x', 'landing'), (error: unknown) => error instanceof StyleExampleError && error.code === 'invalid');
  assert.throws(() => examples.read('uno', 'pdf'), (error: unknown) => error instanceof StyleExampleError && error.code === 'invalid');
  assert.throws(() => examples.generate('altro'), (error: unknown) => error instanceof StyleExampleError && error.code === 'not-found');
});

test('a translation is exactly one plain string per description', () => {
  assert.deepEqual(parseTranslations('Ecco:\n["Uno", "Due"]', 2), ['Uno', 'Due']);
  assert.equal(parseTranslations('["Uno"]', 2), undefined);
  assert.equal(parseTranslations('[1, "Due"]', 2), undefined);
  assert.equal(parseTranslations('["Uno‮", "Due"]', 2), undefined);
  assert.equal(parseTranslations('non è JSON', 1), undefined);
});

test('descriptions are translated once: an unchanged one never goes again, a changed one does', async () => {
  const skills = [
    { id: 'a/b/web', description: 'Builds web pages.' },
    { id: 'a/b/deck', description: 'Builds decks.' },
    { id: 'a/b/same', description: 'Builds web pages.' },
  ];
  const sent: string[][] = [];
  const translations = createSkillTranslations({
    dir: join(HOME, 'c'),
    list: () => skills,
    ask: (request) => {
      const items = JSON.parse(request.parts[1]?.text ?? '[]') as string[];
      sent.push(items);
      return Promise.resolve(JSON.stringify(items.map((item) => `IT: ${item}`)));
    },
  });
  assert.equal(translations.status().missing, 2);
  translations.translateMissing();
  await translations.idle();
  assert.deepEqual(sent, [['Builds web pages.', 'Builds decks.']], 'one description sent once, even for two skills');
  assert.deepEqual(translations.status().translations, { 'a/b/web': 'IT: Builds web pages.', 'a/b/deck': 'IT: Builds decks.', 'a/b/same': 'IT: Builds web pages.' });
  translations.translateMissing();
  await translations.idle();
  assert.equal(sent.length, 1);
  skills[1] = { id: 'a/b/deck', description: 'Builds slide decks.' };
  translations.translateMissing();
  await translations.idle();
  assert.deepEqual(sent[1], ['Builds slide decks.']);
});

test('an unreadable answer stops the run: the good batch stays, the same missing ones are not asked again', async () => {
  // 30 descriptions: a batch of 25 answered well, one of 5 unreadable.
  const skills = Array.from({ length: 30 }, (_, index) => ({ id: `a/b/s${String(index)}`, description: `Skill number ${String(index)}.` }));
  let calls = 0;
  const translations = createSkillTranslations({
    dir: join(HOME, 'u'),
    list: () => skills,
    ask: (request) => {
      calls += 1;
      const items = JSON.parse(request.parts[1]?.text ?? '[]') as string[];
      return Promise.resolve(items.length === 25 ? JSON.stringify(items.map((item) => `IT: ${item}`)) : '["rotto"');
    },
  });
  translations.translateMissing();
  await translations.idle();
  const after = translations.status();
  assert.equal(calls, 2);
  assert.equal(Object.keys(after.translations).length, 25, 'the readable batch is saved');
  assert.equal(after.missing, 5);
  assert.equal(after.stopped, UNREADABLE_STOP);
  assert.equal(translations.translateMissing().running, false, 'the same missing ones do not start again');
  await translations.idle();
  assert.equal(calls, 2);
  // The missing ones change (a new skill): one more try.
  skills.push({ id: 'a/b/new', description: 'A new skill.' });
  assert.equal(translations.translateMissing().running, true);
  await translations.idle();
  assert.equal(calls, 3);
  // A new run of the core (a restart): one more try for the same set.
  const restarted = createSkillTranslations({ dir: join(HOME, 'u'), list: () => skills, ask: () => Promise.resolve('[]') });
  assert.equal(restarted.translateMissing().running, true);
  await restarted.idle();
  assert.equal(restarted.status().stopped, UNREADABLE_STOP);
  // The unreadable skills taken away: nothing left, no stop said.
  skills.splice(25);
  assert.equal(restarted.status().missing, 0);
  assert.equal(restarted.status().stopped, null);
});

test('an unreadable batch first, a good one after: the good one is saved and the run ends stopped', async () => {
  const skills = Array.from({ length: 30 }, (_, index) => ({ id: `a/b/s${String(index)}`, description: `Other skill ${String(index)}.` }));
  const translations = createSkillTranslations({
    dir: join(HOME, 'v'),
    list: () => skills,
    ask: (request) => {
      const items = JSON.parse(request.parts[1]?.text ?? '[]') as string[];
      return Promise.resolve(items.length === 25 ? 'non è JSON' : JSON.stringify(items.map((item) => `IT: ${item}`)));
    },
  });
  translations.translateMissing();
  await translations.idle();
  assert.equal(Object.keys(translations.status().translations).length, 5);
  assert.equal(translations.status().stopped, UNREADABLE_STOP);
});

test('a quota stop after an unreadable batch says the quota and is tried again at the next opening', async () => {
  const skills = Array.from({ length: 30 }, (_, index) => ({ id: `a/b/s${String(index)}`, description: `Third skill ${String(index)}.` }));
  let calls = 0;
  const translations = createSkillTranslations({
    dir: join(HOME, 'w'),
    list: () => skills,
    ask: () => {
      calls += 1;
      return calls === 2 ? Promise.reject(new CloudTextError('quota', 'Claude è senza quota: riprova dopo il reset')) : Promise.resolve('[');
    },
  });
  translations.translateMissing();
  await translations.idle();
  assert.equal(translations.status().stopped, 'Claude è senza quota: riprova dopo il reset');
  assert.equal(translations.translateMissing().running, true);
  await translations.idle();
});

test('a readable answer leaves the run not stopped', async () => {
  const translations = createSkillTranslations({
    dir: join(HOME, 'r'),
    list: () => [{ id: 'a/b/x', description: 'Does x.' }],
    ask: () => Promise.resolve('["Fa x."]'),
  });
  translations.translateMissing();
  await translations.idle();
  assert.equal(translations.status().stopped, null);
  assert.equal(translations.status().missing, 0);
});

test('the descriptions of the roles of the catalog of agents: their own file, prompt and events; one lookup for an agent', async () => {
  const roles = [{ id: 'acme/agents/api', description: 'Expert API platform engineer for public and partner APIs — contract-first design (OpenAPI/gRPC).' }];
  const asked: CloudTextRequest[] = [];
  const events: string[] = [];
  const dir = join(HOME, 'roles');
  const translations = createSkillTranslations({
    dir,
    list: () => roles,
    kind: 'roles',
    onEvent: (kind) => events.push(kind),
    ask: (request) => {
      asked.push(request);
      const items = JSON.parse(request.parts[1]?.text ?? '[]') as string[];
      return Promise.resolve(JSON.stringify(items.map(() => 'Ingegnere esperto di piattaforme API pubbliche e per partner: progettazione contract-first (OpenAPI/gRPC).')));
    },
  });
  translations.translateMissing();
  await translations.idle();
  const first = asked.at(0);
  assert.ok(first);
  assert.match(first.parts.at(0)?.text ?? '', /roles of AI agents/);
  assert.equal(first.parts.at(1)?.source, 'agents-catalog:descriptions');
  assert.match(first.purpose, /ruoli/);
  assert.deepEqual(events, ['agents.translated']);
  assert.match(translations.status().translations['acme/agents/api'] ?? '', /^Ingegnere esperto/);
  // An agent made from the role keeps the English description in its card: the page asks for the Italian one by the text.
  assert.match(translations.lookup(` ${roles[0]?.description ?? ''} `) ?? '', /^Ingegnere esperto/);
  assert.equal(translations.lookup('Written by the user.'), undefined);
  assert.ok(existsSync(join(dir, ROLE_TRANSLATIONS_FILE)));
  // The skills keep their own file: nothing of the roles there.
  assert.equal(existsSync(join(dir, 'skills.it.json')), false);
});

test('an unreadable answer for the roles says the roles, and the skills keep their own words', async () => {
  const translations = createSkillTranslations({ dir: join(HOME, 'roles-u'), list: () => [{ id: 'a/b/r', description: 'Reviews code.' }], kind: 'roles', ask: () => Promise.resolve('non è JSON') });
  translations.translateMissing();
  await translations.idle();
  assert.equal(translations.status().stopped, ROLE_UNREADABLE_STOP);
  assert.notEqual(ROLE_UNREADABLE_STOP, UNREADABLE_STOP);
});

test('without Claude on this installation nothing starts', async () => {
  const ask = createCloudText({ sql: {} as Sql, claude: undefined, data: HOME });
  await assert.rejects(ask({ parts: [{ text: 'x', source: 's' }], purpose: 'prova' }), (error: unknown) => error instanceof CloudTextError && error.code === 'unavailable');
});

test('a new version of the catalog with the same DESIGN.md keeps the example: only the notice changed', async () => {
  const texts: Record<string, string> = { alfa: 'Licenza, versione 1111111\n\n---\n\n# Alfa\n`#112233`\n' };
  let calls = 0;
  const examples = createStyleExamples({
    dir: join(HOME, 'd'),
    source: source(texts),
    ask: () => {
      calls += 1;
      return Promise.resolve(ANSWER);
    },
  });
  examples.generate('alfa');
  await examples.idle();
  texts.alfa = 'Licenza, versione 2222222\n\n---\n\n# Alfa\n`#112233`\n';
  assert.equal(examples.status().examples.alfa?.current, true);
  examples.generateMissing();
  await examples.idle();
  assert.equal(calls, 1);
  texts.alfa = 'Licenza, versione 2222222\n\n---\n\n# Alfa\n`#ffffff`\n';
  assert.equal(examples.status().examples.alfa?.current, false);
});
