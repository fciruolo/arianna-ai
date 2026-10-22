// Reading one public page for a tool (D-262, P7): every address through the
// gateway with the consent of the caller, redirects of a user address on its site.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createContext, piiReport, type PageConsent } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import type { FetchOptions, FetchResult } from '../src/link-fetch.ts';
import { configurePiiGuard } from '../src/pii-guard.ts';
import { addressesInText, readPage, redirectConsent } from '../src/web-page.ts';

// The second scanner finds nothing: these tests are about the consent.
configurePiiGuard({ state: 'ready', warm: () => Promise.resolve(true), scan: (texts) => Promise.resolve(piiReport(texts, texts.map(() => []))), stop: () => Promise.resolve() });

/** A database that takes every gateway_log row and remembers the targets. */
function fakeSql(rows: unknown[][]): Sql {
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    rows.push(values);
    return Promise.resolve([]);
  };
  return sql as unknown as Sql;
}

/** A downloader that asks the gateway for `hops` in order, as fetchLink does for redirects. */
function hopping(hops: string[]) {
  return async (_address: string, options: FetchOptions): Promise<FetchResult> => {
    for (const hop of hops) {
      if ((await options.authorize(hop)) !== hop) return { ok: false, reason: 'blocked' };
    }
    return { ok: true, link: { url: hops.at(-1) ?? '', site: 'example.com', text: 'Listino finto', truncated: false } };
  };
}

describe('readPage', () => {
  it('reads a page the user wrote, and follows its redirect on the same site', async () => {
    const rows: unknown[][] = [];
    const consent: PageConsent = { from: 'user', addresses: ['https://example.com/listino'] };
    const result = await readPage({
      sql: fakeSql(rows),
      address: 'https://example.com/listino',
      context: createContext('L1', 'L1'),
      consent,
      fetchLink: hopping(['https://example.com/listino', 'https://www.example.com/listino/']),
    });
    assert.equal(result.ok, true);
    // One gateway_log row per address: target name and rule, never the address.
    assert.deepEqual(rows.map((values) => [values[3], values[7]]), [['web-page-user', 'page'], ['web-page-sites', 'page']]);
    assert.ok(rows.every((values) => !values.some((value) => typeof value === 'string' && value.includes('example.com'))));
  });

  it('refuses a redirect of a user address towards another site', async () => {
    const result = await readPage({
      sql: fakeSql([]),
      address: 'https://example.com/listino',
      context: createContext('L1', 'L1'),
      consent: { from: 'user', addresses: ['https://example.com/listino'] },
      fetchLink: hopping(['https://example.com/listino', 'https://example.net/?q=Rossi']),
    });
    assert.deepEqual(result, { ok: false, reason: 'blocked' });
  });

  it('refuses any address from a private session', async () => {
    const result = await readPage({
      sql: fakeSql([]),
      address: 'https://example.com/listino',
      context: createContext('L2', 'L2'),
      consent: { from: 'user', addresses: ['https://example.com/listino'] },
      fetchLink: hopping(['https://example.com/listino']),
    });
    assert.deepEqual(result, { ok: false, reason: 'blocked' });
  });

  it('a post of X the user wrote: the post passes with its consent, then its oEmbed; another post does not', async () => {
    const rows: unknown[][] = [];
    const post = 'https://x.com/finto/status/123';
    const oembed = `https://publish.twitter.com/oembed?url=${encodeURIComponent(post)}`;
    const consent: PageConsent = { from: 'user', addresses: [post] };
    const read = await readPage({ sql: fakeSql(rows), address: post, context: createContext('L1', 'L1'), consent, fetchLink: hopping([oembed]) });
    assert.equal(read.ok, true);
    assert.deepEqual(rows.map((values) => values[3]), ['web-page-user', 'web-page-sites']);
    const other = await readPage({ sql: fakeSql([]), address: 'https://x.com/altro/status/9', context: createContext('L1', 'L1'), consent, fetchLink: hopping([oembed]) });
    assert.deepEqual(other, { ok: false, reason: 'blocked' });
  });

  it('in a public session the model may follow links anywhere', async () => {
    const result = await readPage({
      sql: fakeSql([]),
      address: 'https://example.com/a',
      context: createContext('L1', 'L0'),
      consent: { from: 'public' },
      fetchLink: hopping(['https://example.com/a', 'https://example.org/b']),
    });
    assert.equal(result.ok, true);
  });
});

describe('readPage, a post of X on a listed site', () => {
  it('reads the post through its oEmbed; another site after it stays refused', async () => {
    const consent: PageConsent = { from: 'sites', sites: ['x.com'] };
    const post = 'https://x.com/someone/status/123';
    const oembed = `https://publish.twitter.com/oembed?url=${encodeURIComponent(post)}`;
    const read = (hops: string[]) => readPage({ sql: fakeSql([]), address: post, context: createContext('L1', 'L1'), consent, fetchLink: hopping(hops) });
    assert.equal((await read([oembed])).ok, true);
    assert.deepEqual(await read([oembed, 'https://example.net/?q=Rossi']), { ok: false, reason: 'blocked' });
  });
});

describe('redirectConsent', () => {
  it('keeps public and sites, turns user into the site of the address', () => {
    assert.deepEqual(redirectConsent({ from: 'public' }, 'https://a.example/'), { from: 'public' });
    assert.deepEqual(redirectConsent({ from: 'sites', sites: ['b.example'] }, 'https://a.example/'), { from: 'sites', sites: ['b.example'] });
    // A post of X on a listed site is read through its oEmbed: publish.twitter.com joins the list for the redirects only.
    assert.deepEqual(redirectConsent({ from: 'sites', sites: ['x.com'] }, 'https://x.com/a/status/1'), { from: 'sites', sites: ['x.com', 'publish.twitter.com'] });
    assert.deepEqual(redirectConsent({ from: 'sites', sites: ['x.com'] }, 'https://x.com/a'), { from: 'sites', sites: ['x.com'] });
    assert.deepEqual(redirectConsent({ from: 'user', addresses: ['https://www.a.example/x'] }, 'https://www.a.example/x'), { from: 'sites', sites: ['a.example'] });
    assert.deepEqual(redirectConsent({ from: 'user', addresses: ['https://x.com/a/status/1'] }, 'https://x.com/a/status/1'), { from: 'sites', sites: ['x.com', 'publish.twitter.com'] });
  });
});

describe('addressesInText', () => {
  it('finds every http(s) address, without the punctuation of the sentence', () => {
    // A final dot may be the address's own («…+S.r.l.», D-283): both forms count as written.
    assert.deepEqual(addressesInText('Leggi https://example.com/listino. Poi (https://example.org/a?b=1) e file:///etc/passwd'), ['https://example.com/listino', 'https://example.com/listino.', 'https://example.org/a?b=1']);
    assert.deepEqual(addressesInText('niente link qui'), []);
    assert.equal(addressesInText(Array.from({ length: 5 }, (_, index) => `https://e${String(index)}.example/`).join(' '), 3).length, 3);
  });
});
