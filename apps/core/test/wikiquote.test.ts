// The real lines of the people of the series from Italian Wikiquote (D-224): the parser of the wikitext, on invented
// extracts in the markup of the real pages (fixtures/), and the import into the archive with a fake client. No network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SERIES_PERSONAS } from '@arianna/agents';
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

  it('the people of Springfield by the names of the Italian dub, Mr. Burns with his dot and Boe also as Moe (D-237)', () => {
    const page = [
      '==Stagione 1==',
      '===Episodio 1, \'\'Un parser inventato\'\'===',
      "*'''Mr. Burns''': Eccellente, il parser funziona.<br />'''Homer''': Mmm… test verdi.",
      "*Un'altra birra di prova, offre la casa. ('''Boe''')",
      "*'''Moe''': Il nome originale vale lo stesso.",
      "*'''Signor Burns''': Anche col titolo italiano.",
    ].join('\n');
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.burns ?? []).map((line) => line.text), ['Eccellente, il parser funziona.', 'Anche col titolo italiano.']);
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.boe ?? []).map((line) => line.text), ["Un'altra birra di prova, offre la casa.", 'Il nome originale vale lo stesso.']);
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.homer ?? []), [{ text: 'Mmm… test verdi.', episode: '1x01' }]);
    // Negative: nobody of Springfield speaks for another one.
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.lisa ?? []), []);
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
    assert.equal(wikiquoteName('I Simpson'), 'I Simpson');
    assert.equal(wikiquoteName('Family Guy'), 'I Griffin');
    for (const person of Object.values(SERIES_PERSONAS)) assert.ok(wikiquoteName(person.show) !== undefined, person.show);
    assert.equal(wikiquoteName('American Dad!'), 'American Dad!');
    assert.equal(wikiquoteName('Prison Break'), 'Prison Break');
    assert.equal(wikiquoteName('Futurama'), 'Futurama');
    assert.equal(wikiquoteName('The Big Bang Theory'), 'The Big Bang Theory');
    assert.equal(wikiquoteName('Una serie che non c’è'), undefined);
    for (const id of Object.keys(SERIES_PERSONAS)) assert.ok((WIKIQUOTE_SPEAKERS[id]?.length ?? 0) > 0, id);
  });
});

describe('pages and forms of the series as Wikiquote writes them (D-245, seen on 2026-10-16)', () => {
  it('the series with a page per season list all of them, with their Italian ordinal', () => {
    const titles = (show: string) => (WIKIQUOTE_PAGES[show] ?? []).map((page) => page.title);
    assert.equal(titles('I Simpson').length, 34);
    assert.equal(titles('I Simpson')[33], 'I Simpson (trentaquattresima stagione)');
    assert.equal(titles('I Simpson')[16], 'I Simpson (diciassettesima stagione)');
    assert.deepEqual(titles('The Big Bang Theory').slice(10), ['The Big Bang Theory (undicesima stagione)', 'The Big Bang Theory (dodicesima stagione)']);
    assert.equal(titles('Futurama').length, 8);
    assert.deepEqual(WIKIQUOTE_PAGES['Futurama']?.[7], { title: 'Futurama (ottava stagione)', season: 8 });
    assert.deepEqual(titles('American Dad!'), ['American Dad!']);
    assert.equal(wikiquoteName('I Simpson'), 'I Simpson');
    assert.equal(wikiquoteName('Scrubs'), 'Scrubs - Medici ai primi ferri');
  });

  it('a page of a season with its episodes at the first level: every episode read, the incipit and the notes not', () => {
    const page = [
      '==[[Incipit]]==',
      "*Un incipit, non una battuta della serie. ('''Sheldon''')",
      "==Episodio 1, ''Pilota''==",
      "*Questa non è una casa qualunque, è un vortice di entropia di prova. ('''Sheldon''')",
      "*'''Penny''': Senti, ce l'hai un secondo?<br />'''Sheldon''': Ce l'avevo, ma è già passato.",
      "==Episodio 12, ''La città replicata''==",
      "*{{NDR|Svegliandosi}} Big Boy di prova! ('''Sheldon''')",
      '==Note==',
      "*Una nota che cita ('''Sheldon''')",
    ].join('\n');
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.sheldon ?? [], { season: 1 }), [
      { text: 'Questa non è una casa qualunque, è un vortice di entropia di prova.', episode: '1x01' },
      { text: 'Ce l’avevo, ma è già passato.'.replace('’', "'"), episode: '1x01' },
      { text: 'Big Boy di prova!', episode: '1x12' },
    ]);
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.penny ?? [], { season: 1 }).map((line) => line.text), ["Senti, ce l'hai un secondo?"]);
    // The same headings on a page of the whole series are not episodes of a known season: nothing is read.
    assert.deepEqual(parseWikiquote(page, WIKIQUOTE_SPEAKERS.sheldon ?? []), []);
  });

  it('«Frasi» and «Dialoghi» of a page without seasons, and a note after the speaker', () => {
    const page = [
      '==Frasi==',
      "*Il Messico, la zona cieca di prova! ('''Stan''')",
      "* C'è una sola cosa di prova che faccio coi drink! ('''Roger''')(S.3 Ep.13)",
      "*Ti tirerò fuori di qui, è una prova. ('''Michael Scofield''') EPISODIO 1 STAGIONE 1",
      "*Per me l'uomo è un essere da aiutare, di prova. ('''Dott.ssa Tancredi''') STAGIONE 1",
      "*Bacia il mio fondoschiena metallico di prova! ('''Bender''') (stagione 1: episodio 1, 13)",
      "*Brutto bacarospo di prova! ('''Homer''') '''[a Bart]'''",
      '==Dialoghi==',
      "*'''Hayley''': Roger, che ti è successo di prova?<br />'''Roger''': Niente di prova.",
      "==Citazioni su ''American Dad!''==",
      "*Una serie di prova. ('''Stan''')",
    ].join('\n');
    const of = (id: string) => parseWikiquote(page, WIKIQUOTE_SPEAKERS[id] ?? []).map((line) => line.text);
    assert.deepEqual(of('stan'), ['Il Messico, la zona cieca di prova!']);
    assert.deepEqual(of('roger'), ["C'è una sola cosa di prova che faccio coi drink!", 'Niente di prova.']);
    assert.deepEqual(of('scofield'), ['Ti tirerò fuori di qui, è una prova.']);
    assert.deepEqual(of('sara'), ["Per me l'uomo è un essere da aiutare, di prova."]);
    assert.deepEqual(of('bender'), ['Bacia il mio fondoschiena metallico di prova!']);
    assert.deepEqual(of('homer'), ['Brutto bacarospo di prova!']);
    assert.deepEqual(of('hayley'), ['Roger, che ti è successo di prova?']);
    // Text after the speaker that is not a note: not a line of the speaker.
    assert.deepEqual(parseWikiquote("==Frasi==\n*Una frase di prova. ('''Stan''') e poi altro testo", ['Stan']), []);
  });

  it('a sub-heading under an episode of the first level keeps the episode; a section that is no episode stops the reading', () => {
    const page = [
      "==Episodio 3, ''Il corollario del gatto''==",
      '===Dialoghi===',
      "*'''Sheldon''': Una battuta di prova sotto un sottotitolo.",
      '==Altri progetti==',
      "*Una voce che non è della serie. ('''Sheldon''')",
    ].join('\n');
    assert.deepEqual(parseWikiquote(page, ['Sheldon'], { season: 2 }), [{ text: 'Una battuta di prova sotto un sottotitolo.', episode: '2x03' }]);
  });

  it('text anyone can edit: a strange or long line costs little time and gives no line (D-245)', () => {
    const lines = [
      `*Frase ('''Stan''') ${'A '.repeat(1500)}!`,
      `*${"('''A''') ".repeat(40_000)}z`,
      `*${'A'.repeat(100_000)}!`,
      `*Una battuta lunga ${'x'.repeat(5000)} ('''Stan''')`,
    ];
    const started = Date.now();
    assert.deepEqual(parseWikiquote(`==Frasi==\n${lines.join('\n')}`, ['Stan', 'A']), []);
    assert.ok(Date.now() - started < 1000, `${String(Date.now() - started)} ms`);
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
      limitedWaitMs: 0,
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
    // The limited page is asked once more before giving up (D-245).
    assert.deepEqual(asked, [first, second, second]);
  });

  it('asks a limited page once more after a wait, and goes on when Wikiquote answers (D-245)', async () => {
    const asked: string[] = [];
    let limitedOnce = false;
    const lines = createSeriesLines({
      dir: join(root, randomUUID()),
      secrets: secretMatcher([]),
      random: () => 0.5,
      pauseMs: 0,
      limitedWaitMs: 0,
      ask: () => Promise.reject(new CloudTextError('failed', 'Claude non serve qui')),
      wikiquote: (title) => {
        asked.push(title);
        if (title === first) return Promise.resolve(SEASON);
        if (title === second && !limitedOnce) {
          limitedOnce = true;
          return Promise.reject(new WikiquoteError('limited', 'Wikiquote chiede di rallentare: riprova fra qualche minuto'));
        }
        return Promise.reject(new WikiquoteError('missing', 'la pagina non c’è su Wikiquote'));
      },
    });
    lines.importWikiquote('jd', true);
    await lines.idle();
    assert.equal(lines.status('jd').stopped, null);
    assert.equal(asked.filter((title) => title === second).length, 2);
    assert.equal(asked.length, 10, 'the nine seasons, the second twice');
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
