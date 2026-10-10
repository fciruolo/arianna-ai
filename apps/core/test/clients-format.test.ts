// The fields of a client (I-16, D-168): the Italian codes with their check
// characters, the codes of the electronic invoice by country and kind, the
// addresses, the terms of payment, the limits and the logo by its bytes.
// Every value here is invented: the codes are generated to pass the check,
// they belong to nobody.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  areaOf,
  changedFields,
  checkClient,
  checkContact,
  effectiveSdi,
  EMPTY_CLIENT,
  isCodiceFiscale,
  isEuVatNumber,
  isIban,
  isPartitaIva,
  logoTypeOf,
  type ClientFields,
  type Issue,
} from '../src/clients-format.ts';
import * as hud from '../../hud/src/lib/client-codes.ts';

// Invented, generated with the check digit.
const PIVA = '12345678903';
const PIVA_2 = '98765432103';
const CF_PERSON = 'RSSMRA80A01H501U';
const CF_PERSON_2 = 'BNCLRA85T45F205L';
const IBAN = 'IT60X0542811101000000123456';

function issues(input: Record<string, unknown>, base?: ClientFields): Issue[] {
  const checked = checkClient(input, base);
  return checked.ok ? [] : checked.issues;
}

function value(input: Record<string, unknown>, base?: ClientFields): ClientFields {
  const checked = checkClient(input, base);
  if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
  return checked.value;
}

test('partita IVA: 11 digits with the check digit', () => {
  assert.equal(isPartitaIva(PIVA), true);
  assert.equal(isPartitaIva(PIVA_2), true);
  assert.equal(isPartitaIva('12345678901'), false);
  assert.equal(isPartitaIva('00000000000'), false);
  assert.equal(isPartitaIva('1234567890'), false);
  assert.equal(isPartitaIva('1234567890A'), false);
});

test('codice fiscale: a person with its check letter, or the 11 digits of a company', () => {
  assert.equal(isCodiceFiscale(CF_PERSON), true);
  assert.equal(isCodiceFiscale(CF_PERSON_2), true);
  assert.equal(isCodiceFiscale('RSSMRA80A01H501A'), false);
  assert.equal(isCodiceFiscale('RSSMRA80Z01H501U'), false);
  assert.equal(isCodiceFiscale(PIVA), true);
  assert.equal(isCodiceFiscale('12345678901'), false);
  // Omocodia: digits replaced by letters still pass with their own check letter.
  assert.equal(isCodiceFiscale(`RSSMRA80A01H50M${checkLetter('RSSMRA80A01H50M')}`), true);
});

function checkLetter(first15: string): string {
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (isCodiceFiscale(first15 + letter)) return letter;
  throw new Error('no letter');
}

test('IBAN with the mod 97 check, an Italian one 27 characters', () => {
  assert.equal(isIban(IBAN), true);
  assert.equal(isIban('IT60X0542811101000000123457'), false);
  assert.equal(isIban('IT60X054281110100000012345'), false);
  assert.equal(isIban('DE89370400440532013000'), true);
});

test('VAT numbers of the EU: the prefix of the country and its form', () => {
  assert.equal(isEuVatNumber('DE123456789', 'DE'), true);
  assert.equal(isEuVatNumber('EL123456789', 'GR'), true);
  assert.equal(isEuVatNumber('GR123456789', 'GR'), false);
  assert.equal(isEuVatNumber('FR12345678901', 'FR'), true);
  assert.equal(isEuVatNumber('NL123456789B01', 'NL'), true);
  assert.equal(isEuVatNumber('DE12345678', 'DE'), false);
  assert.equal(isEuVatNumber('ATU12345678', 'AT'), true);
  assert.equal(isEuVatNumber('AT12345678', 'AT'), false);
});

test('the area: Italia, UE, extra UE', () => {
  assert.equal(areaOf('IT'), 'IT');
  assert.equal(areaOf('FR'), 'EU');
  assert.equal(areaOf('GR'), 'EU');
  assert.equal(areaOf('CH'), 'extra-EU');
  assert.equal(areaOf('SM'), 'extra-EU');
  assert.equal(areaOf('US'), 'extra-EU');
});

test('an Italian company: codes normalized, the display name from the legal name', () => {
  const client = value({ legalName: 'Rossi Srl', vatNumber: 'IT 123 456 789 03', taxCode: PIVA, sdiCode: 'abc1234', pec: 'Rossi@PEC.example.it', registeredAddress: { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'mi' } });
  assert.equal(client.displayName, 'Rossi Srl');
  assert.equal(client.vatNumber, PIVA);
  assert.equal(client.sdiCode, 'ABC1234');
  assert.equal(client.pec, 'rossi@pec.example.it');
  assert.deepEqual(client.registeredAddress, { street: 'Via Finta', number: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' });
  assert.equal(effectiveSdi(client), 'ABC1234');
  assert.equal(effectiveSdi({ ...client, sdiCode: null }), '0000000');
});

test('the Italian codes refused: wrong check digit, wrong form', () => {
  assert.deepEqual(issues({ displayName: 'Rossi', vatNumber: '12345678901' }), [{ field: 'vatNumber', code: 'checksum' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', vatNumber: '1234' }), [{ field: 'vatNumber', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', taxCode: 'RSSMRA80A01H501A' }), [{ field: 'taxCode', code: 'checksum' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', taxCode: 'RSSMRA' }), [{ field: 'taxCode', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', sdiCode: 'ABC12' }), [{ field: 'sdiCode', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', pec: 'non-una-pec' }), [{ field: 'pec', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', iban: 'IT60X0542811101000000123457' }), [{ field: 'iban', code: 'checksum' }]);
});

test('a name is required, unknown fields and wrong types are refused', () => {
  assert.deepEqual(issues({}), [{ field: 'displayName', code: 'required' }]);
  assert.deepEqual(issues({ displayName: '   ' }), [{ field: 'displayName', code: 'required' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', colore: 'blu' }), [{ field: 'colore', code: 'unknown' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', splitPayment: 'sì' }), [{ field: 'splitPayment', code: 'type' }]);
  assert.deepEqual(issues({ displayName: 42 }), [{ field: 'displayName', code: 'type' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', kind: 'alieno' }), [{ field: 'kind', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', status: 'archived' }), [{ field: 'status', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', registeredAddress: { street: 'Via Finta', piano: '2' } }), [{ field: 'registeredAddress.piano', code: 'unknown' }]);
});

test('the limits of length', () => {
  assert.deepEqual(issues({ displayName: 'x'.repeat(201) }), [{ field: 'displayName', code: 'too-long' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', notes: 'x'.repeat(10_001) }), [{ field: 'notes', code: 'too-long' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', notes: 'x'.repeat(10_000) }), []);
  assert.deepEqual(issues({ displayName: 'Rossi', tags: Array.from({ length: 21 }, (_, index) => `t${String(index)}`) }), [{ field: 'tags', code: 'too-long' }]);
  assert.deepEqual(value({ displayName: 'Rossi', tags: ['Web', 'web', ' ', 'Grafica'] }).tags, ['Web', 'Grafica']);
});

test('an Italian address: CAP of 5 digits and a province of 2 letters; a foreign one is freer', () => {
  assert.deepEqual(issues({ displayName: 'Rossi', registeredAddress: { postalCode: '2010', city: 'Milano' } }), [{ field: 'registeredAddress.postalCode', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', registeredAddress: { province: 'Milano' } }), [{ field: 'registeredAddress.province', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', country: 'GB', registeredAddress: { postalCode: 'SW1A 1AA', city: 'London', province: 'Greater London' } }), []);
  assert.equal(value({ displayName: 'Rossi', registeredAddress: { street: ' ', city: '' } }).registeredAddress, null);
  // An address abroad of an Italian client follows its own country.
  assert.deepEqual(issues({ displayName: 'Rossi', shippingAddress: { postalCode: '75001', city: 'Paris', country: 'fr' } }), []);
});

test('foreign clients: XXXXXXX as SDI, no PEC nor Italian codes, the EU VAT number with its prefix', () => {
  const french = value({ displayName: 'Dupont SARL', country: 'FR', euVatNumber: 'fr 12 345678901' });
  assert.equal(french.euVatNumber, 'FR12345678901');
  assert.equal(effectiveSdi(french), 'XXXXXXX');
  assert.deepEqual(issues({ displayName: 'Dupont', country: 'FR', euVatNumber: 'DE123456789' }), [{ field: 'euVatNumber', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Dupont', country: 'FR', sdiCode: 'ABC1234' }), [{ field: 'sdiCode', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Dupont', country: 'FR', sdiCode: 'XXXXXXX' }), []);
  assert.deepEqual(issues({ displayName: 'Dupont', country: 'FR', pec: 'a@pec.example.it' }), [{ field: 'pec', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Dupont', country: 'FR', vatNumber: PIVA }), [{ field: 'vatNumber', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Dupont', country: 'FR', foreignTaxId: '123' }), [{ field: 'foreignTaxId', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Smith Ltd', country: 'US', foreignTaxId: '12-3456789' }), []);
  assert.deepEqual(issues({ displayName: 'Smith Ltd', country: 'US', euVatNumber: 'DE123456789' }), [{ field: 'euVatNumber', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', sdiCode: 'XXXXXXX' }), [{ field: 'sdiCode', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', country: 'Italia' }), [{ field: 'country', code: 'format' }]);
});

test('a public administration: the IPA code in place of the SDI code, split payment, CIG and CUP', () => {
  const pa = value({ kind: 'public_administration', displayName: 'Comune di Finta', taxCode: '8000000000' + checkDigit('8000000000'), ipaCode: 'uf1234', splitPayment: true, cig: 'z1a2b3c4d5', cup: 'A12B34567890123' });
  assert.equal(pa.ipaCode, 'UF1234');
  assert.equal(effectiveSdi(pa), 'UF1234');
  assert.deepEqual(issues({ kind: 'public_administration', displayName: 'Comune', sdiCode: 'ABC1234' }), [{ field: 'sdiCode', code: 'not-allowed' }]);
  assert.deepEqual(issues({ kind: 'public_administration', displayName: 'Comune', ipaCode: 'UF12' }), [{ field: 'ipaCode', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', ipaCode: 'UF1234' }), [{ field: 'ipaCode', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', cig: 'Z1A2B3C4D5' }), [{ field: 'cig', code: 'not-allowed' }]);
  assert.deepEqual(issues({ kind: 'individual', displayName: 'Mario', splitPayment: true }), [{ field: 'splitPayment', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Rossi Spa', splitPayment: true }), []);
});

function checkDigit(ten: string): string {
  for (let digit = 0; digit <= 9; digit += 1) if (isPartitaIva(ten + String(digit))) return String(digit);
  throw new Error('no digit');
}

test('a person: first and last name make the display name; a company has none', () => {
  const person = value({ kind: 'freelancer', firstName: 'Laura', lastName: 'Bianchi', taxCode: CF_PERSON_2 });
  assert.equal(person.displayName, 'Laura Bianchi');
  assert.deepEqual(issues({ displayName: 'Rossi Srl', firstName: 'Mario' }), [{ field: 'firstName', code: 'not-allowed' }]);
});

test('VAT: a rate of 0-100 with two decimals, the nature of FatturaPA, no nature with a rate above zero', () => {
  assert.equal(value({ displayName: 'Rossi', vatRate: 22 }).vatRate, 22);
  assert.equal(value({ displayName: 'Rossi', vatRate: 0, vatNature: 'N2.2' }).vatNature, 'N2.2');
  assert.equal(value({ displayName: 'Rossi', vatNature: 'n6.2' }).vatNature, 'N6.2');
  assert.deepEqual(issues({ displayName: 'Rossi', vatRate: 101 }), [{ field: 'vatRate', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', vatRate: 22.555 }), [{ field: 'vatRate', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', vatRate: '22' }), [{ field: 'vatRate', code: 'type' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', vatNature: 'N8' }), [{ field: 'vatNature', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', vatNature: 'N3' }), [{ field: 'vatNature', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', vatRate: 22, vatNature: 'N2.2' }), [{ field: 'vatNature', code: 'not-allowed' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', country: 'FR', withholdingAgent: true }), [{ field: 'withholdingAgent', code: 'not-allowed' }]);
});

test('payment: method, days 0-365, end of month, currency, language', () => {
  const client = value({ displayName: 'Rossi', paymentMethod: 'riba', paymentDays: 60, paymentEndOfMonth: true, currency: 'chf', invoiceLanguage: 'EN', iban: 'it60 x054 2811 1010 0000 0123 456' });
  assert.equal(client.currency, 'CHF');
  assert.equal(client.invoiceLanguage, 'en');
  assert.equal(client.iban, IBAN);
  assert.deepEqual(issues({ displayName: 'Rossi', paymentDays: 400 }), [{ field: 'paymentDays', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', paymentDays: 30.5 }), [{ field: 'paymentDays', code: 'type' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', paymentMethod: 'baratto' }), [{ field: 'paymentMethod', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', currency: 'EURO' }), [{ field: 'currency', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', invoiceLanguage: 'ita' }), [{ field: 'invoiceLanguage', code: 'too-long' }]);
});

test('contacts of the client as a whole: e-mail, phone, site', () => {
  const client = value({ displayName: 'Rossi', email: 'Info@Rossi.example', phone: '+39 02 1234 5678', website: 'rossi.example' });
  assert.equal(client.email, 'info@rossi.example');
  assert.equal(client.website, 'https://rossi.example');
  assert.deepEqual(issues({ displayName: 'Rossi', email: 'info@rossi' }), [{ field: 'email', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', phone: 'chiamami' }), [{ field: 'phone', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', website: 'javascript:alert(1)' }), [{ field: 'website', code: 'format' }]);
  assert.deepEqual(issues({ displayName: 'Rossi', website: 'https://utente:segreto@rossi.example' }), [{ field: 'website', code: 'format' }]);
});

test('a change is merged over the client as it is and checked as a whole', () => {
  const italian = value({ legalName: 'Rossi Srl', vatNumber: PIVA, pec: 'rossi@pec.example.it' });
  // Becoming French with the PEC still there is refused: the chat clears the fields it hides.
  assert.deepEqual(issues({ country: 'FR' }, italian), [{ field: 'vatNumber', code: 'not-allowed' }, { field: 'pec', code: 'not-allowed' }]);
  const french = value({ country: 'FR', vatNumber: null, pec: null }, italian);
  assert.equal(french.legalName, 'Rossi Srl');
  assert.deepEqual(changedFields(italian, french), ['country', 'vatNumber', 'pec']);
  assert.deepEqual(changedFields(italian, italian), []);
});

test('a contact: a name, e-mail and phones in their form, a primary flag', () => {
  const checked = checkContact({ name: ' Anna  Verdi ', role: 'Amministrazione', email: 'Anna@Rossi.example', phone: '02 1234567', primary: true });
  assert.ok(checked.ok);
  assert.deepEqual(checked.value, { name: 'Anna Verdi', role: 'Amministrazione', email: 'anna@rossi.example', phone: '02 1234567', mobile: null, notes: null, primary: true });
  const missing = checkContact({ role: 'Tecnico' });
  assert.ok(!missing.ok && missing.issues[0]?.field === 'name' && missing.issues[0].code === 'required');
  const unknown = checkContact({ name: 'Anna', compleanno: '1/1' });
  assert.ok(!unknown.ok && unknown.issues[0]?.code === 'unknown');
  const badMail = checkContact({ name: 'Anna', email: 'anna' });
  assert.ok(!badMail.ok && badMail.issues[0]?.field === 'email');
});

test('the logo by its first bytes: PNG, JPEG, WebP; never SVG or anything else', () => {
  assert.equal(logoTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(logoTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(logoTypeOf(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1')), 'image/webp');
  assert.equal(logoTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), undefined);
  assert.equal(logoTypeOf(Buffer.from('GIF89a')), undefined);
  assert.equal(logoTypeOf(Buffer.from([])), undefined);
});

test('the web chat gives the same verdict on the codes (apps/hud/src/lib/client-codes.ts)', () => {
  for (const code of [PIVA, PIVA_2, '12345678901', '00000000000', '1234']) assert.equal(hud.isPartitaIva(code), isPartitaIva(code), code);
  for (const code of [CF_PERSON, CF_PERSON_2, 'RSSMRA80A01H501A', PIVA, 'XYZ']) assert.equal(hud.isCodiceFiscale(code), isCodiceFiscale(code), code);
  for (const code of [IBAN, 'IT60X0542811101000000123457', 'DE89370400440532013000']) assert.equal(hud.isIban(code), isIban(code), code);
  for (const [code, country] of [['DE123456789', 'DE'], ['EL123456789', 'GR'], ['FR1234', 'FR']] as const) assert.equal(hud.isEuVatNumber(code, country), isEuVatNumber(code, country), code);
  for (const country of ['IT', 'FR', 'GR', 'CH', 'US', 'SM']) assert.equal(hud.areaOf(country), areaOf(country), country);
  // The same issues, field by field, on forms as the chat holds them.
  const address = (parts: Record<string, unknown>): Record<string, unknown> => ({ street: null, number: null, postalCode: null, city: null, province: null, country: 'IT', ...parts });
  const samples: Record<string, unknown>[] = [
    { displayName: 'Rossi', vatNumber: '12345678901', sdiCode: 'ABC', pec: 'no', registeredAddress: address({ postalCode: '123', province: 'Milano' }) },
    { displayName: '', legalName: null },
    { legalName: 'Rossi Srl', vatNumber: PIVA, taxCode: CF_PERSON, sdiCode: 'ABC1234', iban: IBAN, paymentDays: 400, currency: 'EURO' },
    { displayName: 'Dupont', country: 'FR', vatNumber: PIVA, pec: 'a@pec.example.it', euVatNumber: 'DE123456789', sdiCode: 'ABC1234' },
    { displayName: 'Smith', country: 'US', foreignTaxId: '12-3456789', euVatNumber: 'DE123456789', withholdingAgent: true },
    { kind: 'public_administration', displayName: 'Comune', sdiCode: 'ABC1234', ipaCode: 'UF12', cig: 'Z1A2B3C4D5', splitPayment: true },
    { kind: 'individual', displayName: 'Mario', splitPayment: true, vatRate: 22, vatNature: 'N2.2', website: 'javascript:alert(1)' },
    { displayName: 'Rossi Srl', firstName: 'Mario', email: 'info@rossi', phone: 'chiamami', iban: 'IT60X0542811101000000123457' },
    { displayName: 'Rossi', country: 'GB', registeredAddress: address({ postalCode: 'SW1A 1AA', province: 'Greater London', country: 'GB' }), vatNature: 'N8' },
  ];
  for (const sample of samples) {
    const form = { ...EMPTY_CLIENT, ...sample };
    const sorted = (list: Issue[]): string[] => list.map((issue) => `${issue.field}:${issue.code}`).sort();
    assert.deepEqual(sorted(hud.clientIssues(form)), sorted(issues(form)), JSON.stringify(sample));
  }
});
