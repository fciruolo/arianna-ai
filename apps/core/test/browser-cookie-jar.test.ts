// The cookies of the site of an access made by the user (D-276): only that site, in memory.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CookieJar, MAX_COOKIES, onSite } from '../src/browser/cookie-jar.ts';

const NOW = Date.parse('2026-10-21T10:00:00Z');
const at = (address: string): URL => new URL(address);

test('kept from the site of the access and sent back to it and its subdomains, never to another site', () => {
  const jar = new CookieJar('banca-finta.it');
  assert.equal(jar.store(['sid=abc123; Path=/; Secure; HttpOnly', 'pref=it; Domain=banca-finta.it; Path=/'], at('https://www.banca-finta.it/login'), NOW), 2);
  // sid is host-only: only www; pref has the Domain: every subdomain.
  assert.equal(jar.header(at('https://www.banca-finta.it/conti'), NOW), 'sid=abc123; pref=it');
  assert.equal(jar.header(at('https://api.banca-finta.it/v1'), NOW), 'pref=it');
  for (const other of ['https://tracker-finto.net/', 'https://notbanca-finta.it/', 'https://banca-finta.it.raccolta-finta.net/']) assert.equal(jar.header(at(other), NOW), undefined, other);
  assert.ok(onSite('a.b.banca-finta.it', 'banca-finta.it'));
  assert.ok(!onSite('xbanca-finta.it', 'banca-finta.it'));
});

test('an answer from another site keeps nothing, nor a Domain outside the site or not covering the host', () => {
  const jar = new CookieJar('banca-finta.it');
  assert.equal(jar.store(['t=1'], at('https://tracker-finto.net/'), NOW), 0);
  assert.equal(jar.store(['t=1; Domain=tracker-finto.net'], at('https://www.banca-finta.it/'), NOW), 0);
  assert.equal(jar.store(['t=1; Domain=it'], at('https://www.banca-finta.it/'), NOW), 0);
  assert.equal(jar.store(['t=1; Domain=api.banca-finta.it'], at('https://www.banca-finta.it/'), NOW), 0);
  assert.equal(jar.size, 0);
});

test('Secure only from https and only to https; the prefixes; Path; expiry by Max-Age and Expires', () => {
  const jar = new CookieJar('banca-finta.it');
  assert.equal(jar.store(['s=1; Secure'], at('http://banca-finta.it/'), NOW), 0);
  assert.equal(jar.store(['__Secure-a=1'], at('https://banca-finta.it/'), NOW), 0);
  assert.equal(jar.store(['__Host-b=1; Secure; Path=/; Domain=banca-finta.it'], at('https://banca-finta.it/'), NOW), 0);
  assert.equal(jar.store(['__Host-b=1; Secure; Path=/', 's=1; Secure', 'area=x; Path=/area', 'short=1; Max-Age=60', 'old=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT'], at('https://banca-finta.it/area/pagina'), NOW), 4);
  // Without Path, the folder of the address: short=1 goes to /area too.
  assert.equal(jar.header(at('http://banca-finta.it/area/x'), NOW), 'area=x; short=1');
  // Over https the Secure ones too; the longest path first.
  assert.equal(jar.header(at('https://banca-finta.it/area/x'), NOW), 's=1; area=x; short=1; __Host-b=1');
  assert.ok(!(jar.header(at('https://banca-finta.it/altro'), NOW) ?? '').includes('area='));
  // A minute later the short one is gone; Max-Age=0 removes one.
  assert.ok((jar.header(at('https://banca-finta.it/area/x'), NOW + 59_000) ?? '').includes('short='));
  assert.ok(!(jar.header(at('https://banca-finta.it/area/x'), NOW + 61_000) ?? '').includes('short='));
  assert.equal(jar.store(['s=; Max-Age=0; Secure; Path=/area'], at('https://banca-finta.it/'), NOW), 1);
  assert.ok(!(jar.header(at('https://banca-finta.it/area/x'), NOW) ?? '').startsWith('s=1'));
});

test('malformed lines are dropped; at most MAX_COOKIES, the oldest go first', () => {
  const jar = new CookieJar('banca-finta.it');
  assert.equal(jar.store(['', '=x', 'na me=x', 'a=b;c', `big=${'x'.repeat(5000)}`, 'ctl=a\u0001b'], at('https://banca-finta.it/'), NOW), 1);
  assert.equal(jar.header(at('https://banca-finta.it/'), NOW), 'a=b');
  const many = Array.from({ length: MAX_COOKIES + 5 }, (_, index) => `c${String(index)}=1`);
  for (const [index, line] of many.entries()) jar.store([line], at('https://banca-finta.it/'), NOW + index);
  assert.equal(jar.size, MAX_COOKIES);
  assert.ok(!(jar.header(at('https://banca-finta.it/'), NOW + 100) ?? '').includes('c0='));
});
