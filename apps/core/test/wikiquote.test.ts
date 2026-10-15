// The real lines of the people of the series from Italian Wikiquote (D-224): the parser of the wikitext, on invented
// extracts in the markup of the real pages (fixtures/), and the import into the archive with a fake client. No network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { secretMatcher } from '@arianna/policy';

import { CloudTextError } from '../src/cloud-text.ts';
import { createSeriesLines, SERIES_LINES_DIR, SeriesLinesError, WIKIQUOTE_CONSENT_FILE } from '../src/series-lines.ts';
import { createWikiquoteClient, cutAtSentence, parseWikiquote, plainOf, WIKIQUOTE_MAX_BYTES, WIKIQUOTE_PAGES, WIKIQUOTE_SPEAKERS, WikiquoteError, wikiquoteName, wikitextOf } from '../src/wikiquote.ts';

const HOME = resolveHome({});
const root = join(HOME, 'data', 'test-tmp', randomUUID());
mkdirSync(root, { recursive: true });
after(() => {
  rmSync(root, { recursive: true, force: true });
});

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SEASON = fixture('wikiquote-season.wiki');
const SERIES = fixture('wikiquote-series.wiki');

describe('wikiquote parser', () => {
  it('takes the quotes and the turns of a character, with the episode of the page season, without stage directions, notes or links', () => {
    const lines = parseWikiquote(SEASON, WIKIQUOTE_SPEAKERS.jd ?? [], { season: 2 });
    assert.deepEqual(lines, [
      { text: 'Oggi non è un giorno qualunque: oggi provo il parser.', episode: '2x01' },
      { text: 'Ehi, amico, hai visto il mio stetoscopio?', episode: '2x01' },
      { text: 'Il mio primo giorno e già mi sento un vero medico, più o meno.', episode: '2x01' },
      { text: 'Ok.', episode: '2x12' },
    ]);
  });

  it('leaves out the other speakers, the sub-items and the sections that are not of the series', () => {
    const cox = parseWikiquote(SEASON, WIKIQUOTE_SPEAKERS.cox ?? [], { season: 2 }).map((line) => line.text);
    assert.equal(cox.length, 4);
    assert.ok(cox.every((text) => !text.includes('stetoscopio') && !text.includes('Coso')));
    assert.ok(!parseWikiquote(SEASON, ['J.D.'], { season: 2 }).some((line) => line.text.includes('nota sotto') || line.text.includes('non viene dalla serie')));
    assert.deepEqual(parseWikiquote(SEASON, ['Nessuno'], { season: 2 }), []);
    // A template after the speaker ({{Cfr}}) does not hide it.
    assert.deepEqual(parseWikiquote("*Una battuta con un rimando dopo la firma. ('''J.D.''') {{Cfr|altra pagina}}", ['J.D.'], { season: 1 }), [{ text: 'Una battuta con un rimando dopo la firma.' }]);
  });

  it('reads the season from «Stagione N» on a page of the whole series, and nothing outside a season', () => {
    assert.deepEqual(parseWikiquote(SERIES, WIKIQUOTE_SPEAKERS.pam ?? []), [
      { text: 'Dici sul serio? Sono solo test.', episode: '1x01' },
      { text: 'Non è così che funziona, lo sai benissimo.', episode: '6x04' },
    ]);
    assert.deepEqual(
      parseWikiquote(SERIES, WIKIQUOTE_SPEAKERS.michael ?? []).map((line) => line.text),
      ['Me non volere sentire questo, perché i test rossi sono una brutta cosa.'],
    );
  });

  it('plainOf and cutAtSentence', () => {
    assert.equal(plainOf("Uno [[medico specializzando|specializzando]] ''bravo''&nbsp;e [[Dio]]{{NDR|ride}}"), 'Uno specializzando bravo e Dio');
    assert.equal(plainOf('L&#x27;ho detto, [[File:x.jpg|thumb|una foto]] &#39;davvero&#39;&#x7f;'), "L'ho detto, una foto 'davvero'");
    assert.equal(cutAtSentence('Prima frase. Seconda frase più lunga.', 20), 'Prima frase.');
    assert.equal(cutAtSentence('Una frase sola troppo lunga per stare qui.', 10), undefined);
    assert.equal(cutAtSentence('Corta.', 10), 'Corta.');
  });

  it('the answer of the API: the wikitext, a missing page, a limit', () => {
    assert.equal(wikitextOf('{"parse":{"title":"X","wikitext":"ciao"}}'), 'ciao');
    assert.throws(() => wikitextOf('{"error":{"code":"missingtitle"}}'), (error) => error instanceof WikiquoteError && error.code === 'missing');
    assert.throws(() => wikitextOf('You are making too many requests to the API.'), (error) => error instanceof WikiquoteError && error.code === 'limited');
    assert.throws(() => wikitextOf('{"parse":{}}'), (error) => error instanceof WikiquoteError && error.code === 'upstream');
  });

  it('every series of the personas has its pages, every persona its names', () => {
    const scrubs = (WIKIQUOTE_PAGES.Scrubs ?? []).map((page) => page.title);
    assert.equal(scrubs.length, 9);
    assert.equal(scrubs[0], 'Scrubs - Medici ai primi ferri (prima stagione)');
    assert.equal(wikiquoteName('Scrubs'), 'Scrubs - Medici ai primi ferri');
    assert.equal(wikiquoteName('The Office (US)'), 'The Office');
    assert.equal(wikiquoteName('Una serie che non c’è'), undefined);
    for (const id of ['jd', 'turk', 'elliot', 'carla', 'cox', 'michael', 'dwight', 'jim', 'pam']) assert.ok((WIKIQUOTE_SPEAKERS[id]?.length ?? 0) > 0, id);
  });
});

describe('import from wikiquote', () => {
  function archive(pages: Record<string, string | Error>) {
    const asked: string[] = [];
    const dir = join(root, randomUUID());
    const lines = createSeriesLines({
      dir,
      secrets: secretMatcher([]),
      random: () => 0.5,
      pauseMs: 0,
      ask: () => Promise.reject(new CloudTextError('failed', 'Claude non serve qui')),
      wikiquote: (title) => {
        asked.push(title);
        const page = pages[title];
        if (page === undefined) return Promise.reject(new WikiquoteError('missing', 'la pagina non c’è su Wikiquote'));
        return page instanceof Error ? Promise.reject(page) : Promise.resolve(page);
      },
    });
    return { lines, asked, dir };
  }
  const first = 'Scrubs - Medici ai primi ferri (prima stagione)';
  const second = 'Scrubs - Medici ai primi ferri (seconda stagione)';

  it('asks the yes once: refused without it, nothing downloaded; remembered after it', async () => {
    const { lines, asked, dir } = archive({ [first]: SEASON });
    assert.equal(lines.status('cox').wikiquote.consent, false);
    assert.throws(() => lines.importWikiquote('cox', false), (error) => error instanceof SeriesLinesError && error.code === 'consent');
    assert.deepEqual(asked, []);
    lines.importWikiquote('cox', true);
    await lines.idle();
    assert.ok(existsSync(join(dir, SERIES_LINES_DIR, WIKIQUOTE_CONSENT_FILE)));
    assert.equal(lines.status('jd').wikiquote.consent, true);
    // Only the titles of the pages of the series leave, one per season.
    assert.deepEqual(asked, WIKIQUOTE_PAGES.Scrubs?.map((page) => page.title));
    // The second time no yes is asked: the doubles are dropped.
    lines.importWikiquote('cox', false);
    await lines.idle();
    assert.equal(lines.status('cox').added, 0);
    assert.equal(lines.status('cox').lines.length, 4);
  });

  it('keeps the lines of the character marked wikiquote, with the episode, cut at a sentence, named ones marked', async () => {
    const { lines } = archive({ [first]: SEASON });
    lines.importWikiquote('cox', true);
    await lines.idle();
    const status = lines.status('cox');
    assert.equal(status.job, 'wikiquote');
    assert.equal(status.stopped, null);
    assert.equal(status.added, 4);
    assert.ok(status.lines.every((line) => line.origin === 'wikiquote'));
    assert.deepEqual(
      status.lines.map((line) => [line.n, line.episode, line.named]),
      [
        [1, '1x01', false],
        [2, '1x12', false],
        [3, '1x12', false],
        [4, '1x12', true],
      ],
    );
    assert.ok(status.lines[1]?.text.endsWith('Chi arriva tardi paga il caffè.'));
    // A line written by hand afterwards is no wikiquote line.
    lines.add('cox', 'Una battuta scritta a mano, per prova.');
    assert.equal(lines.status('cox').lines.at(-1)?.origin, undefined);
  });

  it('refuses a line too short, one with personal data and the doubles of lines already kept', async () => {
    const page = `===Episodio 3, ''Prova''===
*Il mio IBAN è IT60X0542811101000000123456, segnatelo. ('''Dott. Cox''')
*Breve. ('''Dott. Cox''')
*Una battuta che c’è già nell’elenco, scritta a mano. ('''Dott. Cox''')`;
    const { lines } = archive({ [first]: page });
    lines.add('cox', 'Una battuta che c’è già nell’elenco, scritta a mano.');
    lines.importWikiquote('cox', true);
    await lines.idle();
    const status = lines.status('cox');
    assert.equal(status.added, 0);
    assert.equal(status.lines.length, 1);
    assert.ok(!status.lines.some((line) => line.text.includes('IBAN')));
  });

  it('says so when Wikiquote has no lines of the character or no page at all', async () => {
    const none = archive({ [first]: SEASON });
    none.lines.importWikiquote('carla', true);
    await none.lines.idle();
    assert.match(none.lines.status('carla').stopped ?? '', /non ci sono battute di Carla/);
    const missing = archive({});
    missing.lines.importWikiquote('jd', true);
    await missing.lines.idle();
    assert.match(missing.lines.status('jd').stopped ?? '', /non c’è la pagina di Scrubs/);
    assert.equal(missing.lines.status('jd').lines.length, 0);
  });

  it('keeps what it read when Wikiquote stops it half way, and says how far it got', async () => {
    const { lines, asked } = archive({ [first]: SEASON, [second]: new WikiquoteError('limited', 'Wikiquote chiede di rallentare: riprova fra qualche minuto') });
    lines.importWikiquote('jd', true);
    await lines.idle();
    const status = lines.status('jd');
    assert.equal(status.lines.length, 3);
    assert.match(status.stopped ?? '', /rallentare.*pagine lette: 1 su 9; battute aggiunte: 3/);
    assert.equal(asked.length, 2);
  });

  it('one queue and one download per page for all the people of a series', async () => {
    const { lines, asked } = archive({ [first]: SEASON });
    lines.importWikiquote('jd', true);
    lines.importWikiquote('cox', false);
    await lines.idle();
    assert.equal(lines.status('jd').lines.length, 3);
    assert.equal(lines.status('cox').lines.length, 4);
    assert.deepEqual(asked, WIKIQUOTE_PAGES.Scrubs?.map((page) => page.title));
  });

  it('a page of the whole series for The Office', async () => {
    const { lines, asked } = archive({ 'The Office': SERIES });
    lines.importWikiquote('jim', true);
    await lines.idle();
    assert.deepEqual(asked, ['The Office']);
    assert.deepEqual(
      lines.status('jim').lines.map((line) => [line.text, line.episode]),
      [['Il mio lavoro consiste nel parlare di carta per fotocopie, tutto il giorno.', '1x01']],
    );
  });
});

describe('wikiquote client', () => {
  let server: Server;
  let host = '';
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  before(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers });
      const page = new URL(request.url ?? '/', 'http://x').searchParams.get('page');
      switch (page) {
        case 'Buona':
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ parse: { title: 'Buona', wikitext: "*Ciao a tutti quanti. ('''J.D.''')" } }));
          return;
        case 'Spostata':
          response.writeHead(302, { location: 'http://127.0.0.1:1/altrove' }).end();
          return;
        case 'Limitata':
          response.writeHead(429).end('slow down');
          return;
        case 'Grande':
          response.writeHead(200).end('x'.repeat(WIKIQUOTE_MAX_BYTES + 10));
          return;
        case 'Lenta':
          response.writeHead(200);
          response.write('{');
          return;
        default:
          response.writeHead(200).end('{"error":{"code":"missingtitle"}}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  });
  const client = (deadlineMs?: number) => createWikiquoteClient({ allowHttp: true, host, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
  const code = (expected: WikiquoteError['code'], message?: RegExp) => (error: unknown) => error instanceof WikiquoteError && error.code === expected && (message === undefined || message.test(error.message));

  it('asks the wikitext of the page by its title alone, with a fixed user agent and nothing of the user', async () => {
    assert.equal(await client()('Buona'), "*Ciao a tutti quanti. ('''J.D.''')");
    const last = seen.at(-1);
    const query = new URL(last?.url ?? '/', 'http://x').searchParams;
    assert.deepEqual([...query.keys()].sort(), ['action', 'format', 'formatversion', 'page', 'prop', 'redirects']);
    assert.equal(query.get('page'), 'Buona');
    assert.match(last?.headers['user-agent'] ?? '', /^arianna-series-lines/);
    assert.equal(last?.headers.cookie, undefined);
    assert.equal(last?.headers.authorization, undefined);
  });

  it('refuses a strange title before any request, a redirect, a limit, a big answer, a missing page and a slow one', async () => {
    const before = seen.length;
    await assert.rejects(client()('../api?x=1'), code('upstream'));
    await assert.rejects(client()('a'.repeat(201)), code('upstream'));
    assert.equal(seen.length, before);
    await assert.rejects(client()('Spostata'), code('upstream', /302/));
    assert.equal(seen.length, before + 1);
    await assert.rejects(client()('Limitata'), code('limited'));
    await assert.rejects(client()('Grande'), code('upstream', /più grande/));
    await assert.rejects(client()('Mancante'), code('missing'));
    await assert.rejects(client(200)('Lenta'), code('upstream', /in tempo/));
  });
});
