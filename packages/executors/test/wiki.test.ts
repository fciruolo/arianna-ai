// The Wiki proposed by the local model (D-280): what the model's answer may be.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cutText,
  isWikiFolderPath,
  isWikiPagePath,
  LocalModelError,
  MAX_WIKI_POINT,
  MAX_WIKI_POINTS,
  MAX_WIKI_TITLE,
  normalizeWikiPath,
  proposeWiki,
  readWikiAnswer,
  readWikiIndexAnswer,
  wikiIndexLines,
  wikiInputLines,
  wikiSchema,
  wikiSegment,
  writeWikiIndexSummary,
  type ChatRequest,
  type LocalModel,
  type WikiInput,
} from '@arianna/executors';

function model(answer: unknown, requests: ChatRequest[] = [], finishReason = 'stop'): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ text: '', value: answer, finishReason, endpoint: 'stub', model: 'stub-model', durationMs: 1 });
    },
  };
}

const INPUT: WikiInput = {
  note: { id: 'nota-1', title: 'Octane e Swoole', text: 'Octane tiene in memoria l’app fra una richiesta e l’altra.' },
  sources: [{ id: 'nota-2', title: 'Code di Laravel', text: 'Horizon gestisce le code su Redis.' }],
  folders: ['laravel', 'laravel/octane'],
  pages: [{ path: 'laravel/octane/swoole', title: 'Swoole', summary: 'Server per Octane.', points: ['Swoole è un’estensione di PHP.', 'Va installata con PECL.'] }],
};

const CREATE = {
  action: 'create',
  page: '',
  path: 'Laravel/Octane/Memoria condivisa',
  title: 'Memoria in Octane',
  summary: 'Come Octane tiene l’app in memoria.',
  points: [{ text: 'L’app resta in memoria fra le richieste.', sources: ['nota-1'], replaces: 0 }],
  questions: ['Come si svuota lo stato fra le richieste?'],
  related: ['laravel/octane/swoole'],
  reason: 'Nessuna pagina parla della memoria.',
};

describe('wiki paths', () => {
  it('takes 2 or 3 segments of lowercase words, a folder 1 or 2', () => {
    assert.equal(wikiSegment('Laravel Octane!'), 'laravel-octane');
    assert.equal(wikiSegment('Perché è così'), 'perche-e-cosi');
    assert.equal(isWikiPagePath('laravel/octane/swoole'), true);
    assert.equal(isWikiPagePath('laravel/octane'), true);
    assert.equal(isWikiPagePath('laravel'), false);
    assert.equal(isWikiPagePath('a/b/c/d'), false);
    assert.equal(isWikiPagePath('laravel/_indice'), false);
    assert.equal(isWikiPagePath('laravel/../x'), false);
    assert.equal(isWikiPagePath('laravel/a--b'), false);
    assert.equal(isWikiFolderPath('laravel'), true);
    assert.equal(isWikiFolderPath('laravel/octane'), true);
    assert.equal(isWikiFolderPath('laravel/octane/swoole'), false);
    assert.equal(isWikiFolderPath('.proposte'), false);
  });

  it('normalizes what the model wrote, or refuses it', () => {
    assert.equal(normalizeWikiPath('kb/wiki/Laravel/Octane/Swoole.md'), 'laravel/octane/swoole');
    assert.equal(normalizeWikiPath(' wiki\\php\\fpm '), 'php/fpm');
    assert.equal(normalizeWikiPath('solo-uno'), undefined);
    assert.equal(normalizeWikiPath('a/b/c/d'), undefined);
    // Dots are not segments: going up a folder is not possible.
    assert.equal(normalizeWikiPath('../../segreti/chiavi'), 'segreti/chiavi');
    assert.equal(normalizeWikiPath('!!!/???'), undefined);
  });

  it('cuts a text at a sentence or a word', () => {
    assert.equal(cutText('Breve.', 100), 'Breve.');
    assert.equal(cutText('Prima frase lunga. Seconda frase lunga.', 30), 'Prima frase lunga.');
    assert.equal(cutText('una parola dopo l’altra senza punto', 20), 'una parola dopo…');
  });
});

describe('wikiInputLines and wikiSchema', () => {
  it('gives one JSON object per line and the points numbered', () => {
    const lines = wikiInputLines(INPUT);
    assert.deepEqual(JSON.parse(lines.note), { note: INPUT.note });
    assert.equal(lines.sources.length, 1);
    assert.deepEqual(JSON.parse(lines.folders[1] ?? ''), { folder: 'laravel/octane' });
    const page = JSON.parse(lines.pages[0] ?? '') as { page: { points: string[] } };
    assert.deepEqual(page.page.points, ['1. Swoole è un’estensione di PHP.', '2. Va installata con PECL.']);
  });

  it('closes citations and pages on those given', () => {
    const schema = wikiSchema(INPUT) as { properties: Record<string, { enum?: string[]; items?: { properties?: Record<string, { items?: { enum?: string[] }; maximum?: number }> } }> };
    assert.deepEqual(schema.properties.page?.enum, ['', 'laravel/octane/swoole']);
    assert.deepEqual(schema.properties.points?.items?.properties?.sources?.items?.enum, ['nota-1', 'nota-2']);
    assert.equal(schema.properties.points.items.properties.replaces?.maximum, 2);
    const empty = wikiSchema({ ...INPUT, pages: [] }) as { properties: Record<string, { maxItems?: number; enum?: string[] }> };
    assert.equal(empty.properties.related?.maxItems, 0);
    assert.deepEqual(empty.properties.page?.enum, ['']);
  });
});

describe('readWikiAnswer', () => {
  const read = (value: unknown, finishReason = 'stop') => readWikiAnswer({ value, finishReason }, INPUT);

  it('takes a page to create, its path made a page path', () => {
    const decision = read(CREATE);
    assert.ok(!('failed' in decision));
    assert.ok(decision.action === 'create');
    assert.equal(decision.path, 'laravel/octane/memoria-condivisa');
    assert.deepEqual(decision.points, [{ text: 'L’app resta in memoria fra le richieste.', sources: ['nota-1'], replaces: 0 }]);
    assert.deepEqual(decision.related, ['laravel/octane/swoole']);
  });

  it('takes an update of a page given, with points rewritten once', () => {
    const decision = read({
      ...CREATE,
      action: 'update',
      page: 'laravel/octane/swoole',
      path: '',
      title: 'Swoole',
      summary: '',
      points: [
        { text: 'Swoole è un’estensione di PHP scritta in C.', sources: ['nota-1', 'nota-1'], replaces: 1 },
        { text: 'Seconda riscrittura dello stesso punto.', sources: ['nota-2'], replaces: 1 },
        { text: 'Un fatto nuovo.', sources: ['nota-2'], replaces: 0 },
      ],
      related: ['laravel/octane/swoole'],
    });
    assert.ok(!('failed' in decision) && decision.action === 'update');
    assert.equal(decision.path, 'laravel/octane/swoole');
    assert.equal(decision.summary, '');
    assert.deepEqual(
      decision.points.map((point) => [point.replaces, point.sources]),
      [
        [1, ['nota-1']],
        [0, ['nota-2']],
      ],
    );
    // The page is not related to itself.
    assert.deepEqual(decision.related, []);
  });

  it('takes "none" with its reason only', () => {
    assert.deepEqual(read({ ...CREATE, action: 'none', points: [] }), { action: 'none', reason: 'Nessuna pagina parla della memoria.' });
  });

  it('drops a point over its limit, not the answer', () => {
    const decision = read({ ...CREATE, points: [...CREATE.points, { text: 'x'.repeat(MAX_WIKI_POINT + 1), sources: ['nota-1'], replaces: 0 }] });
    assert.ok(!('failed' in decision) && decision.action === 'create');
    assert.equal(decision.points.length, 1);
  });

  it('refuses what was not given or is out of shape', () => {
    assert.deepEqual(read(CREATE, 'length'), { failed: 'truncated' });
    const bad: unknown[] = [
      null,
      'testo',
      { ...CREATE, extra: 1 },
      { ...CREATE, action: 'delete' },
      { ...CREATE, path: 'solo' },
      { ...CREATE, title: '' },
      { ...CREATE, title: 'x'.repeat(MAX_WIKI_TITLE + 1) },
      { ...CREATE, summary: '' },
      { ...CREATE, points: [] },
      { ...CREATE, points: [{ text: 'x', sources: ['nota-9'], replaces: 0 }] },
      { ...CREATE, points: [{ text: 'x', sources: [], replaces: 0 }] },
      { ...CREATE, points: [{ text: 'x', sources: ['nota-1'], replaces: 1 }] },
      { ...CREATE, points: Array.from({ length: MAX_WIKI_POINTS + 1 }, () => CREATE.points[0]) },
      { ...CREATE, related: ['altra/pagina'] },
      { ...CREATE, action: 'update', page: 'laravel/altro' },
      { ...CREATE, action: 'update', page: 'laravel/octane/swoole', points: [{ text: 'x', sources: ['nota-1'], replaces: 3 }] },
      { ...CREATE, title: 'Titolo\u0007' },
    ];
    for (const value of bad) assert.deepEqual(read(value), { failed: 'bad-response' }, JSON.stringify(value));
  });
});

describe('proposeWiki', () => {
  it('sends the lines given with the schema, and returns the decision', async () => {
    const requests: ChatRequest[] = [];
    const outcome = await proposeWiki(model(CREATE, requests), INPUT, ['{"note":1}', '{"folder":"laravel"}']);
    assert.ok(outcome.ok);
    assert.equal(outcome.decision.action, 'create');
    const [request] = requests;
    assert.equal(request?.messages[1]?.content, '{"note":1}\n{"folder":"laravel"}');
    assert.equal(request.schema?.name, 'wiki_proposal');
    assert.equal(request.temperature, 0);
  });

  it('says why it failed, never with the text', async () => {
    assert.deepEqual(await proposeWiki(model({ nope: 1 }), INPUT, []), { ok: false, reason: 'bad-response' });
    assert.deepEqual(await proposeWiki(model(CREATE, [], 'length'), INPUT, []), { ok: false, reason: 'truncated' });
    assert.deepEqual(await proposeWiki(model(new LocalModelError('timeout', 'slow')), INPUT, []), { ok: false, reason: 'timeout' });
    assert.deepEqual(await proposeWiki(model(new LocalModelError('unavailable', 'down')), INPUT, []), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await proposeWiki(model(new Error('boom')), INPUT, []), { ok: false, reason: 'model-error' });
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await proposeWiki(model(new Error('aborted')), INPUT, [], { signal: controller.signal }), { ok: false, reason: 'interrupted' });
  });
});

describe('the «In breve» of a folder', () => {
  it('reads one summary, cut within its limit', () => {
    assert.deepEqual(readWikiIndexAnswer({ value: { summary: '  Pagine su Laravel.  ' }, finishReason: 'stop' }), { summary: 'Pagine su Laravel.' });
    for (const value of [null, { summary: '' }, { summary: 1 }, { summary: 'x', other: 1 }]) assert.deepEqual(readWikiIndexAnswer({ value, finishReason: 'stop' }), { failed: 'bad-response' });
    assert.deepEqual(readWikiIndexAnswer({ value: { summary: 'x' }, finishReason: 'length' }), { failed: 'truncated' });
  });

  it('gives the folder and its pages as JSON lines', async () => {
    const lines = wikiIndexLines('laravel', [{ title: 'Swoole', summary: 'Server.' }]);
    assert.deepEqual(
      lines.map((line) => JSON.parse(line) as unknown),
      [{ folder: 'laravel' }, { page: { title: 'Swoole', summary: 'Server.' } }],
    );
    const outcome = await writeWikiIndexSummary(model({ summary: 'Pagine su Laravel.' }), lines);
    assert.deepEqual(outcome, { ok: true, summary: 'Pagine su Laravel.' });
  });
});
