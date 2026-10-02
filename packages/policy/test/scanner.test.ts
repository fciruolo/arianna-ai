import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanText, type FindingKind } from '../src/index.ts';

// All fake: textbook examples and test numbers. Tokens are built at runtime so
// that no secret scanner mistakes this file for a leak.
const IBAN = 'IT60X0542811101000000123456';
const TAX_CODE = 'RSSMRA85T10A562S';
const CARD = '4111111111111111';

const kinds = (text: string): FindingKind[] => scanText(text).map((finding) => finding.kind);
const names = (text: string): string[] => scanText(text).map((finding) => finding.name);

test('IBAN: compact, grouped and lower case are found', () => {
  assert.deepEqual(kinds(`pay to ${IBAN} by Friday`), ['iban']);
  assert.deepEqual(kinds('IT60 X054 2811 1010 0000 0123 456'), ['iban']);
  assert.deepEqual(kinds(IBAN.toLowerCase()), ['iban']);
  assert.deepEqual(kinds('DE89370400440532013000'), ['iban']);
});

test('IBAN: a grouped IBAN followed by a short word is still found', () => {
  assert.deepEqual(kinds('ES91 2100 0418 4502 0005 1332 per favore'), ['iban']);
  assert.deepEqual(kinds('BE68 5390 0754 7034 come detto'), ['iban']);
  assert.deepEqual(kinds('ES91 2100 0418 4502 0005 1333 per favore'), []);
});

test('boundaries: an underscore does not hide a match, a longer run of letters does', () => {
  assert.deepEqual(kinds(`iban_${IBAN}`), ['iban']);
  assert.deepEqual(kinds(`card_${CARD}`), ['card-number']);
  assert.deepEqual(kinds(`X${IBAN}`), []);
});

test('IBAN: a wrong checksum or a git hash is not an IBAN', () => {
  assert.deepEqual(kinds('IT61X0542811101000000123456'), []);
  assert.deepEqual(kinds('commit be12d3a4f5e6d7c8b9a0e1f2a3b4c5d6e7f8a9b0'), []);
  assert.deepEqual(kinds('version AB12 is out'), []);
});

test('tax code: found, also with omocodia and in lower case', () => {
  assert.deepEqual(kinds(`CF: ${TAX_CODE}`), ['tax-code']);
  assert.deepEqual(kinds('RSSMRA85T1LA562S'), ['tax-code']);
  assert.deepEqual(kinds(TAX_CODE.toLowerCase()), ['tax-code']);
});

test('tax code: other 16-character words do not match', () => {
  assert.deepEqual(kinds('ABSTRACTFACTORYS'), []);
  assert.deepEqual(kinds('RSSMRA85T10A562'), []);
});

test('card numbers: found with spaces or hyphens when the Luhn checksum holds', () => {
  assert.deepEqual(kinds(`card ${CARD}`), ['card-number']);
  assert.deepEqual(kinds('4111 1111 1111 1111'), ['card-number']);
  assert.deepEqual(kinds('5555-5555-5555-4444'), ['card-number']);
  assert.deepEqual(kinds('4111.1111.1111.1111'), ['card-number']);
  assert.deepEqual(kinds('378282246310005'), ['card-number']);
});

test('card numbers: bad checksum, timestamps and short numbers are ignored', () => {
  assert.deepEqual(kinds('4111111111111112'), []);
  assert.deepEqual(kinds('ts 1727870000000 and 1727870000004'), []);
  assert.deepEqual(kinds('call 3331234567'), []);
});

test('private keys: PEM headers of any kind and age keys', () => {
  assert.deepEqual(kinds('-----BEGIN PRIVATE KEY-----\nMIIE'), ['private-key']);
  assert.deepEqual(kinds('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private-key']);
  assert.deepEqual(kinds('-----BEGIN PGP PRIVATE KEY BLOCK-----'), ['private-key']);
  assert.deepEqual(kinds(`AGE-SECRET-KEY-1${'Q'.repeat(58)}`), ['private-key']);
});

test('private keys: public keys and certificates are not secrets', () => {
  assert.deepEqual(kinds('-----BEGIN PUBLIC KEY-----'), []);
  assert.deepEqual(kinds('-----BEGIN CERTIFICATE-----'), []);
  assert.deepEqual(kinds('age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs'), []);
});

test('tokens: each known format is found', () => {
  const tokens: Record<string, string> = {
    aws: `AKIA${'A'.repeat(16)}`,
    github: `ghp_${'a'.repeat(36)}`,
    gitlab: `glpat-${'a'.repeat(20)}`,
    'api-key': `sk-ant-${'a'.repeat(24)}`,
    stripe: `sk_live_${'a'.repeat(24)}`,
    slack: `xoxb-${'1'.repeat(12)}`,
    google: `AIza${'a'.repeat(35)}`,
    telegram: `123456789:AA${'a'.repeat(33)}`,
    npm: `npm_${'a'.repeat(36)}`,
    jwt: `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`,
    'url-password': 'postgres://arianna:not-a-real-password@localhost/db',
  };
  for (const [name, token] of Object.entries(tokens)) {
    assert.deepEqual(names(`value: ${token} end`), [name], name);
  }
});

test('tokens: look-alikes do not match', () => {
  assert.deepEqual(kinds('use the skill sk-short and ghp_tooshort'), []);
  assert.deepEqual(kinds('https://example.com/path and mailto:someone@example.com'), []);
  assert.deepEqual(kinds('const AKIA = 1; risk-assessment-for-all-tasks'), []);
});

test('hidden spellings: full-width digits and zero-width characters do not hide a match', () => {
  const fullWidth = IBAN.replace(/[A-Z0-9]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));
  assert.deepEqual(kinds(fullWidth), ['iban']);
  assert.deepEqual(kinds('IT60X054​2811101000000123456'), ['iban']);
});

test('findings report kind and offset, never the matched text', () => {
  const [finding] = scanText(`IBAN ${IBAN}`);
  assert.deepEqual(finding, { kind: 'iban', name: 'iban', index: 5 });
  assert.equal(JSON.stringify(scanText(`IBAN ${IBAN}`)).includes(IBAN), false);
});

test('clean text has no findings', () => {
  assert.deepEqual(scanText('Refactor the router tests and update ROUTER-SPEC.md (task 1.7).'), []);
  assert.deepEqual(scanText(''), []);
});
