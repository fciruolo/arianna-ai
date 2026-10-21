// The eval group of the Wiki (D-280): what a passing case is, and the cases on disk.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';

import { loadCases } from '../src/cases.ts';
import { looksItalian, matchesWiki, wikiCaseInput } from '../src/notes-group.ts';

describe('the notes group', () => {
  it('passes the right action, page or place, with valid citations in Italian', () => {
    const good = { ok: true, action: 'update', path: 'laravel/octane/swoole', citationsValid: true, italian: true };
    assert.equal(matchesWiki(good, { action: 'update', page: 'laravel/octane/swoole' }), true);
    assert.equal(matchesWiki(good, { action: 'update', page: 'laravel/altro' }), false);
    assert.equal(matchesWiki(good, { action: 'create', places: ['laravel'] }), false);
    assert.equal(matchesWiki({ ...good, action: 'create' }, { action: 'create', places: ['laravel'] }), true);
    assert.equal(matchesWiki({ ...good, action: 'create', path: 'laravelx/a' }, { action: 'create', places: ['laravel'] }), false);
    assert.equal(matchesWiki({ ...good, italian: false }, { action: 'update', page: 'laravel/octane/swoole' }), false);
    assert.equal(matchesWiki({ ...good, citationsValid: false }, { action: 'update', page: 'laravel/octane/swoole' }), false);
    assert.equal(matchesWiki({ ok: true, action: 'none' }, { action: 'none' }), true);
    assert.equal(matchesWiki({ ok: false, reason: 'timeout' }, { action: 'none' }), false);
  });

  it('tells Italian from English', () => {
    assert.equal(looksItalian('Dopo il deploy i worker della coda vanno riavviati con il comando.'), true);
    assert.equal(looksItalian('After the deploy the workers of the queue must be restarted.'), false);
    assert.equal(looksItalian(''), false);
  });

  it('numbers the notes as the core does', () => {
    const input = wikiCaseInput({ note: { title: 'A', text: 'a' }, sources: [{ title: 'B', text: 'b' }] });
    assert.deepEqual([input.note.id, ...input.sources.map((source) => source.id)], ['nota-1', 'nota-2']);
    assert.deepEqual(input.pages, []);
  });

  it('has 15 invented notes tagged wiki, with update, create and none', () => {
    const cases = loadCases(join(resolveHome({}), 'evals', 'notes'));
    assert.equal(cases.length, 15);
    assert.ok(cases.every((evalCase) => evalCase.tags.includes('wiki')));
    for (const tag of ['update', 'create', 'none']) assert.ok(cases.some((evalCase) => evalCase.tags.includes(tag)), tag);
  });
});
