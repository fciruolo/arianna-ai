// The examples of the styles and the Italian descriptions of the skills (I-20, D-185), with a fake Sonnet.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { CloudTextError, createCloudText, type CloudTextRequest } from '../src/cloud-text.ts';
import type { Sql } from '../src/db/client.ts';
import { createSkillTranslations, parseTranslations } from '../src/skill-translations.ts';
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
  assert.match(examples.read('alfa', 'landing'), /Ciao/);
  assert.match(examples.read('alfa', 'deck'), /data-slide/);
  assert.equal(examples.status().examples.alfa?.current, true);
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

test('without Claude on this installation nothing starts', async () => {
  const ask = createCloudText({ sql: {} as Sql, claude: undefined, data: HOME });
  await assert.rejects(ask({ parts: [{ text: 'x', source: 's' }], purpose: 'prova' }), (error: unknown) => error instanceof CloudTextError && error.code === 'unavailable');
});
