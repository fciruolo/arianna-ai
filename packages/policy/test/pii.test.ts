import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createContext,
  fakePiiCheck,
  gatewayCheck,
  piiReport,
  piiUnavailable,
  piiVerdict,
  secretMatcher,
  type Labeled,
  type PiiCheck,
  type PiiEntity,
  type Target,
} from '../src/index.ts';

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const TELEGRAM: Target = { kind: 'channel', id: 'telegram' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };
const LINK: Target = { kind: 'link', consent: 'click' };

const fragment = (value: unknown, label: 'L0' | 'L1' | 'L2' = 'L1'): Labeled<unknown> => ({ value, label, source: 'test' });
const entity = (text: string, value: string, kind: string): PiiEntity => {
  const start = text.indexOf(value);
  assert.ok(start >= 0, 'the value is in the text');
  return { kind, start, end: start + value.length, score: 0.98 };
};
const check = (payload: Labeled<unknown>[], target: Target, pii: PiiCheck) => gatewayCheck(payload, createContext('L1'), target, secretMatcher([]), pii);

test('a person found by the second scanner blocks an exit to a cloud executor', () => {
  const text = 'Scrivi a Mario Rossi per il preventivo';
  const decision = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, 'Mario Rossi', 'FULLNAME')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
  assert.equal(decision.next, 'wait-user');
  assert.deepEqual(decision.pii, [{ kind: 'FULLNAME', fragment: 0 }]);
  assert.ok(!decision.reason.includes('Mario'), 'the reason names kinds, never the text');
});

test('a finding towards Telegram notifies with a reference', () => {
  const text = 'Chiama il 333 1234567';
  const decision = check([fragment(text)], TELEGRAM, fakePiiCheck([fragment(text)], [[entity(text, '333 1234567', 'TELEPHONENUM')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
  assert.equal(decision.next, 'notify-reference');
});

test('nothing found lets a clean text go to the cloud', () => {
  const payload = [fragment('Aggiungi un test per la somma')];
  const decision = check(payload, CLAUDE, fakePiiCheck(payload));
  assert.ok(decision.decision === 'allow');
  assert.equal(decision.reason, 'L1 to a cloud target, scan clean', 'both scanners clean');
});

test('kinds that alone point at no one do not block, every other kind does', () => {
  const text = 'Il 3 marzo alle 10 a Milano, porta 7420, 40 anni, 120 euro, Acme srl';
  const harmless: PiiEntity[] = [
    entity(text, '3 marzo', 'DATE'),
    entity(text, '10', 'TIME'),
    entity(text, 'Milano', 'CITY'),
    entity(text, '7420', 'BUILDINGNUM'),
    entity(text, '40 anni', 'AGE'),
    entity(text, '120 euro', 'AMOUNT'),
    entity(text, 'Acme srl', 'ORG'),
  ];
  assert.equal(check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [harmless])).decision, 'allow');
  const unknown = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, 'Acme srl', 'BRANDNEW')]]));
  assert.ok(unknown.decision === 'block');
  assert.equal(unknown.rule, 'pii', 'a kind the policy does not know blocks');
});

test('a house number with a postcode is an address, either alone is not', () => {
  const text = 'Consegna al 12, 20121';
  const both = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, '12', 'BUILDINGNUM'), entity(text, '20121', 'ZIPCODE')]]));
  assert.ok(both.decision === 'block');
  assert.deepEqual(both.pii, [{ kind: 'ADDRESS', fragment: 0 }]);
  assert.equal(check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, '20121', 'ZIPCODE')]])).decision, 'allow');
});

test('the name of the assistant and of the agents is not a person, a longer name is', () => {
  const text = 'Arianna chiede al Coder Bruno di parlare con Arianna Bianchi';
  const names = [entity(text, 'Arianna', 'FULLNAME'), entity(text, 'Bruno', 'FULLNAME')];
  const texts = [text];
  assert.equal(check([fragment(text)], CLAUDE, piiReport(texts, [names], ['Bruno'])).decision, 'allow');
  const withoutAgent = check([fragment(text)], CLAUDE, piiReport(texts, [names]));
  assert.ok(withoutAgent.decision === 'block', 'Bruno is a person when no agent has that name');
  const person = check([fragment(text)], CLAUDE, piiReport(texts, [[entity(text, 'Arianna Bianchi', 'FULLNAME')]], ['Bruno']));
  assert.ok(person.decision === 'block');
  assert.equal(person.rule, 'pii');
});

test('inside a hash of git, a sha256 or a UUID nothing counts; personal data never look like that', () => {
  const brief = 'Skill webapp-testing [739de001433318de], sha 3f2a9c81d04e7b65, notes in data/worktrees/fc19c988-b759-4e36-8439-83aa3065752b/.notes';
  const codes = [entity(brief, '9de001433318de', 'ID_DOC'), entity(brief, '3f2a9c81d04e7b65', 'DOCID'), entity(brief, 'b759-4e36-8439', 'IBAN'), entity(brief, '83aa3065752b', 'TELEPHONENUM')];
  assert.equal(check([fragment(brief)], CLAUDE, piiReport([brief], [codes])).decision, 'allow');
  const data = 'Carta CA12345AB, passaporto YA1234567, IBAN IT00X0000000000000000000000, cell 3331234567, P.IVA 01234567890, codice abcdefabcdef, mail a1b2c3d4@example.it';
  const found = [
    entity(data, 'CA12345AB', 'ID_DOC'),
    entity(data, 'YA1234567', 'ID_DOC'),
    entity(data, 'IT00X0000000000000000000000', 'IBAN'),
    entity(data, '3331234567', 'TELEPHONENUM'),
    entity(data, '01234567890', 'PIVA'),
    entity(data, 'abcdefabcdef', 'DOCID'),
    entity(data, 'a1b2c3d4@example.it', 'EMAIL'),
  ];
  for (const one of found) {
    const decision = check([fragment(data)], CLAUDE, piiReport([data], [[one]]));
    assert.ok(decision.decision === 'block', data.slice(one.start, one.end));
    assert.equal(decision.rule, 'pii');
  }
  // Written in lowercase, as in a chat: a hexadecimal look must not hide them (reviewer of 2026-10-14).
  const lower = 'carta ca12345ab, patente ab1234567c, passaporto aa1234567, targa ab123cd, cf bbddaa80a01f205c, commit 2b27894, mail dade1980ab12@gmail.com';
  const lowerFound = [
    entity(lower, 'ca12345ab', 'ID_DOC'),
    entity(lower, 'ab1234567c', 'ID_DOC'),
    entity(lower, 'aa1234567', 'ID_DOC'),
    entity(lower, 'ab123cd', 'TARGA'),
    entity(lower, 'bbddaa80a01f205c', 'CF'),
    entity(lower, '2b27894', 'DOCID'),
    entity(lower, 'dade1980ab12', 'EMAIL'),
  ];
  for (const one of lowerFound) {
    const decision = check([fragment(lower)], CLAUDE, piiReport([lower], [[one]]));
    assert.ok(decision.decision === 'block', lower.slice(one.start, one.end));
  }
});

test('the names of the cloud assistants are not persons either, a person with that first name is', () => {
  const prompt = 'You are Claude, in a plain chat; Codex and ChatGPT answer elsewhere';
  const names = [entity(prompt, 'Claude', 'FULLNAME'), entity(prompt, 'Codex', 'FULLNAME'), entity(prompt, 'ChatGPT', 'FULLNAME')];
  assert.equal(check([fragment(prompt)], CLAUDE, piiReport([prompt], [names])).decision, 'allow');
  const person = 'Scrivi a Claude Rossi';
  assert.equal(check([fragment(person)], CLAUDE, piiReport([person], [[entity(person, 'Claude Rossi', 'FULLNAME')]])).decision, 'block');
});

// D-215: what Rizzo-PII found in the dossier of GOD and in the diary of the works.
const blocks = (text: string, value: string, kind: string, names: readonly string[] = []): boolean => {
  const found = check([fragment(text)], CLAUDE, piiReport([text], [[entity(text, value, kind)]], names));
  return found.decision === 'block';
};

test('a CF counts only with the form of a codice fiscale around it', () => {
  const dossier = '- D-158 (2026-10-10): "Chiama" nella chat; claude-sonnet-5-5 alla 0.85.0';
  assert.equal(blocks(dossier, '-1', 'CF'), false, 'a piece of a date');
  assert.equal(blocks(dossier, '5', 'CF'), false, 'a piece of the name of a model');
  assert.equal(blocks(dossier, '0.85', 'CF'), false, 'a piece of a version');
  const data = 'cf RSSMRA85T10A562S, figlia bncrsa90a41g702q, scritto RSS MRA 85T10 A562S, sbagliato RSSMRA85X10A562S, ditta 01234567890';
  assert.ok(blocks(data, 'RSSMRA85T10A562S', 'CF'));
  assert.ok(blocks(data, 'MRA85', 'CF'), 'a piece of a codice fiscale still counts');
  assert.ok(blocks(data, 'bncrsa90a41g702q', 'CF'), 'in lowercase');
  assert.ok(blocks(data, 'RSS MRA 85T10 A562S', 'CF'), 'with spaces');
  assert.ok(blocks(data, '85T10', 'CF'), 'a piece of the spaced form');
  assert.ok(blocks(data, 'RSSMRA85X10A562S', 'CF'), 'a wrong month letter still has the form');
  assert.ok(blocks(data, '01234567890', 'CF'), 'the 11 digits of a company');
});

test('the form is looked for as a reader sees the text: other spaces, separators, invisible and full-width characters (reviewer of D-215)', () => {
  const cases: [string, string, string][] = [
    ['CF RSS MRA 85T10 A562S di Mario', '85T10', 'CF'],
    ['CF RSS  MRA  85T10  A562S', 'MRA', 'CF'],
    ['CF RSS/MRA/85T10/A562S', 'A562S', 'CF'],
    ['CF RSSMRA\n85T10A562S', '85T10', 'CF'],
    ['CF RSS_MRA_85T10_A562S', 'RSS', 'CF'],
    ['codicefiscaleRSSMRA85T10A562S', 'RSSMRA', 'CF'],
    ['CF RSSMRA85​T10A562S', 'T10', 'CF'],
    ['CF ＲＳＳＭＲＡ８５Ｔ１０Ａ５６２Ｓ', '８５', 'CF'],
    ['Il CF di Mario inizia con RSSMRA85T10', 'RSSMRA85T10', 'CF'],
    ['P.IVA IT01234567890', '01234567890', 'CF'],
    ['targa AB 123 CD', '123', 'TARGA'],
    ['targa AB.123.CD', 'AB.123', 'TARGA'],
    ['targa ＡＢ１２３ＣＤ', '１２３', 'TARGA'],
  ];
  for (const [text, value, kind] of cases) assert.ok(blocks(text, value, kind), JSON.stringify(text));
  const invisible = 'Via Roma 14, 401​27 Bologna';
  const address = check([fragment(invisible)], CLAUDE, piiReport([invisible], [[entity(invisible, '14', 'BUILDINGNUM'), entity(invisible, '401', 'ZIPCODE')]]));
  assert.ok(address.decision === 'block' && address.pii?.some((finding) => finding.kind === 'ADDRESS'), 'a postcode with an invisible character');
});

test('a TARGA counts only with the form of an Italian plate', () => {
  const brief = '- 1.2 Installer: download con sha256, 2 modelli, porta 7420, v0.85.0';
  for (const value of ['2', 'sha256', '7420', '0.85']) assert.equal(blocks(brief, value, 'TARGA'), false, value);
  const data = 'auto AB123CD, scritta ab 123 cd, moto AB 12345, vecchia MI 123456, ROMA A12345';
  for (const value of ['AB123CD', 'ab 123 cd', '123', 'AB 12345', 'MI 123456', 'ROMA A12345']) assert.ok(blocks(data, value, 'TARGA'), value);
});

test('a postcode is five digits and an address needs a house number close to it', () => {
  const dossier = '`main` alla 0.83.0, larghezza 1120 px; - Etichetta: L1; riga 251';
  const pairs: [string, string][] = [
    ['0.83', '1120'],
    ['0', '251'],
    ['L1', '251'],
  ];
  for (const [zip, number] of pairs) {
    const found = check([fragment(dossier)], CLAUDE, piiReport([dossier], [[entity(dossier, zip, 'ZIPCODE'), entity(dossier, number, 'BUILDINGNUM')]]));
    assert.equal(found.decision, 'allow', `${zip} + ${number}`);
  }
  const version = 'Versione 1.20121 al civico 12';
  assert.equal(check([fragment(version)], CLAUDE, piiReport([version], [[entity(version, '20121', 'ZIPCODE'), entity(version, '12', 'BUILDINGNUM')]])).decision, 'allow');
  const addresses = ['Via dei Glicini 14, 40127 Bologna', 'al 14/B\n40127 Bologna', 'CAP 40127, civico 14'];
  for (const text of addresses) {
    const found = check([fragment(text)], CLAUDE, piiReport([text], [[entity(text, '40127', 'ZIPCODE'), entity(text, '14', 'BUILDINGNUM')]]));
    assert.ok(found.decision === 'block', text);
    assert.ok(found.pii?.some((finding) => finding.kind === 'ADDRESS'));
  }
  const far = `Porta 14 del core. ${'Testo del fascicolo. '.repeat(10)}Ci sono 40127 righe.`;
  assert.equal(check([fragment(far)], CLAUDE, piiReport([far], [[entity(far, '40127', 'ZIPCODE'), entity(far, '14', 'BUILDINGNUM')]])).decision, 'allow', 'far apart');
});

test('cadastral data count only with a word of the cadastre', () => {
  const brief = 'Il pulsante è in GodCarryProposal.vue, riga 78.';
  assert.equal(blocks(brief, '8', 'CATASTO'), false);
  const data = 'Appartamento al foglio 12, particella 345, subalterno 6; box fg. 3 part. 77; catasto 9/12';
  for (const value of ['foglio 12, particella 345, subalterno 6', '345', '6', '77', '9/12']) assert.ok(blocks(data, value, 'CATASTO'), value);
  assert.ok(blocks('Immobile F. 12 P. 345 a Lucca', '345', 'CATASTO'), 'abbreviations of a visura');
  assert.ok(blocks('Dati 12/345/6 (foglio/particella/sub)', '12/345/6', 'CATASTO'), 'the word after the numbers');
});

test('a piece of an ignored name is not a person; a person next to it is', () => {
  const diary = '## 12:44 · Coder · Claude Sonnet (claude-sonnet-5-5) · riuscito\nproject: arianna';
  const names = ['Claude Sonnet'];
  assert.equal(blocks(diary, 'Claude Sonnet', 'FULLNAME', names), false);
  assert.equal(blocks(diary, 'net', 'FULLNAME', names), false, 'a piece of «Claude Sonnet»');
  assert.equal(blocks(diary, 'a', 'FULLNAME', names), false, 'a piece of «arianna»');
  assert.ok(blocks(diary, 'Claude Sonnet', 'FULLNAME'), 'without the name of the model it counts');
  const person = 'Il Coder Claude Sonnetti ha scritto a Mario Rossi';
  assert.ok(blocks(person, 'Claude Sonnetti', 'FULLNAME', names), 'a longer name');
  assert.ok(blocks(person, 'Sonnetti', 'FULLNAME', names));
  const display = 'Scrivi a Giulia Bianchi';
  assert.equal(blocks(display, 'Giulia Bianchi', 'FULLNAME', ['Giulia Bianchi']), false, 'a name of two words ignored whole');
  assert.ok(blocks(display, 'Giulia', 'FULLNAME', ['Giulia Bianchi']), 'but not its pieces');
  assert.ok(blocks(display, 'Bianchi', 'FULLNAME', ['Giulia Bianchi']));
  const arianna = 'Scrivi ad Arianna Bianchi';
  assert.ok(blocks(arianna, 'Arianna Bianchi', 'FULLNAME', names));
  assert.ok(blocks(arianna, 'a Bi', 'FULLNAME', names), 'across the end of an ignored name');
});

test('a word of the trade alone is not a person; a name around it still is', () => {
  const plan = 'Piano: landing page con hero, skeleton di caricamento, Vite e Tailwind, mockup in Figma, cache su Redis';
  for (const value of ['hero', 'skeleton', 'Vite', 'Tailwind', 'Figma', 'Redis']) assert.equal(blocks(plan, value, 'FULLNAME'), false, value);
  assert.equal(blocks('La HERO della pagina', 'HERO', 'FULLNAME'), false, 'whatever the case');
  assert.equal(blocks(plan, 'er', 'FULLNAME'), false, 'a piece of «hero»');
  const person = 'Mi ha scritto Hero Rossi per la landing page con hero';
  assert.ok(blocks(person, 'Hero Rossi', 'FULLNAME'), 'a name of two words');
  assert.ok(blocks(person, 'Rossi', 'FULLNAME'), 'the surname next to it');
  assert.ok(blocks('Ho parlato con marco della landing page', 'marco', 'FULLNAME'), 'a first name in lowercase still counts');
  assert.ok(blocks('Il nuovo designer è Heron', 'Heron', 'FULLNAME'), 'a longer word');
  assert.ok(blocks('Il nuovo designer è Heron', 'Hero', 'FULLNAME'), 'the word cut out of a longer name');
  assert.ok(blocks('Scrivi a HeroRossi', 'Hero', 'FULLNAME'), 'a name written glued');
  assert.ok(blocks('Il cliente è Vitello', 'Vite', 'FULLNAME'));
});

test('inside a local IPv4 address nothing counts; a public one, or an email, still counts', () => {
  const diary = '- Conversazione: [apri in Arianna](http://127.0.0.1:7420/c/x), anche 192.168.1.20 e 10.0.0.2';
  for (const value of ['2', '.', '127.0.0.1', '192.168.1.20', '10.0.0.2']) assert.equal(blocks(diary, value, 'EMAIL'), false, value);
  const data = 'Il server di Mario è 93.41.12.7; scrivi a 127.0.0.1@example.it o a mario127.0.0.1';
  assert.ok(blocks(data, '93.41.12.7', 'EMAIL'), 'a public address');
  assert.ok(blocks(data, '127.0.0.1@example.it', 'EMAIL'));
  assert.ok(blocks(data, 'mario127.0.0.1', 'EMAIL'));
  assert.ok(blocks('scrivi a mario@10.1.2.3', '1.2.3', 'EMAIL'), 'after an @');
  assert.ok(blocks('telefono 10.345.678.901', '10.345.678.901', 'TELEPHONENUM'), 'not an address: octets over 255');
});

test('an ignored name only covers FULLNAME', () => {
  const text = 'Arianna';
  assert.equal(check([fragment(text)], CLAUDE, piiReport([text], [[{ kind: 'TELEPHONENUM', start: 0, end: 7, score: 0.9 }]])).decision, 'block');
});

test('no answer blocks: off, starting, timeout, error', () => {
  for (const reason of ['off', 'starting', 'timeout', 'error'] as const) {
    const decision = check([fragment('Aggiungi un test')], CLAUDE, piiUnavailable(reason));
    assert.ok(decision.decision === 'block', reason);
    assert.equal(decision.rule, 'pii-unavailable');
    assert.equal(decision.next, 'wait-user');
    assert.match(decision.reason, new RegExp(reason));
  }
});

test('on a development installation no answer lets the exit go, and says so', () => {
  const decision = check([fragment('Aggiungi un test')], CLAUDE, piiUnavailable('off', true));
  assert.ok(decision.decision === 'allow');
  assert.match(decision.reason, /second check skipped on a development installation \(off\)/);
});

test('development never skips a finding', () => {
  const text = 'Scrivi a mario.rossi@example.it';
  const decision = check([fragment(text)], CLAUDE, fakePiiCheck([fragment(text)], [[entity(text, 'mario.rossi@example.it', 'EMAIL')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
});

test('an answer of the wrong shape is a check that did not happen', () => {
  const text = 'Aggiungi un test';
  const malformed: unknown[] = [
    undefined,
    'nothing',
    [],
    [[], []],
    [[{ kind: 'FULLNAME', start: 0, end: 99, score: 1 }]],
    [[{ kind: 'FULLNAME', start: 3, end: 3, score: 1 }]],
    [[{ kind: 'FULLNAME', start: -1, end: 2, score: 1 }]],
    [[{ kind: 'FULLNAME', start: 0.5, end: 2, score: 1 }]],
    [[{ kind: 'full name', start: 0, end: 2, score: 1 }]],
    [[{ kind: 'FULLNAME', start: 0, end: 2, score: Number.NaN }]],
    [[null]],
  ];
  for (const answer of malformed) {
    const decision = check([fragment(text)], CLAUDE, piiReport([text], answer));
    assert.ok(decision.decision === 'block', JSON.stringify(answer));
    assert.equal(decision.rule, 'pii-unavailable');
    assert.match(decision.reason, /malformed/);
  }
  assert.equal(check([fragment(text)], CLAUDE, piiReport([text], [[{ kind: 'DATE', start: 0, end: 2, score: 1 }]])).decision, 'allow');
});

test('a check made for other texts, or not made here, is no check', () => {
  const scanned = fakePiiCheck([fragment('un altro testo')]);
  const other = check([fragment('Aggiungi un test')], CLAUDE, scanned);
  assert.ok(other.decision === 'block');
  assert.equal(other.rule, 'pii-unavailable');
  assert.match(other.reason, /other-texts/);
  const forged = check([fragment('Aggiungi un test')], CLAUDE, Object.freeze({ brand: 'pii-check' }));
  assert.ok(forged.decision === 'block');
  assert.match(forged.reason, /not-checked/);
  const missing = gatewayCheck([fragment('Aggiungi un test')], createContext('L1'), CLAUDE, secretMatcher([]), undefined as unknown as PiiCheck);
  assert.ok(missing.decision === 'block');
  assert.equal(missing.rule, 'pii-unavailable');
  assert.deepEqual(piiVerdict(scanned, ['un altro testo']), { verdict: 'clean' });
});

test('the check binds each fragment: a finding in the second fragment names it', () => {
  const first = 'Aggiungi un test';
  const second = 'per Laura Verdi';
  const payload = [fragment(first), fragment(second)];
  const decision = check(payload, CLAUDE, fakePiiCheck(payload, [[], [entity(second, 'Laura Verdi', 'FULLNAME')]]));
  assert.ok(decision.decision === 'block');
  assert.deepEqual(decision.pii, [{ kind: 'FULLNAME', fragment: 1 }]);
});

test('JSON fragments are checked as the gateway serializes them', () => {
  const value = { to: 'Laura Verdi' };
  const text = JSON.stringify(value);
  const decision = check([fragment(value)], CLAUDE, piiReport([text], [[entity(text, 'Laura Verdi', 'FULLNAME')]]));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'pii');
});

test('local targets and links are not read by the second scanner', () => {
  assert.equal(gatewayCheck([fragment('Mario Rossi', 'L2')], createContext('L2'), LOCAL_MODEL, secretMatcher([]), piiUnavailable('off')).decision, 'allow');
  assert.equal(check([fragment('https://example.com/pagina')], LINK, piiUnavailable('off')).decision, 'allow');
});

test('the deterministic rules come first', () => {
  const decision = check([fragment('IBAN IT60X0542811101000000123456')], CLAUDE, piiUnavailable('off'));
  assert.ok(decision.decision === 'block');
  assert.equal(decision.rule, 'scanner');
  const l2 = gatewayCheck([fragment('fake text', 'L2')], createContext('L2', 'L1'), CLAUDE, secretMatcher([]), fakePiiCheck([fragment('fake text', 'L2')]));
  assert.ok(l2.decision === 'block');
  assert.equal(l2.rule, 'cloud-label', 'a clean second scan never lets L2 out');
});

test('names of one fragment (D-214) are no persons in that fragment alone, and still are in the others', () => {
  const character = 'Call yourself "Dr. Cox". <character>Burbero</character>';
  const brief = 'Scrivi a Dr. Cox e a Cox Bianchi';
  const texts = [character, brief];
  const found = [[entity(character, 'Dr. Cox', 'FULLNAME')], [entity(brief, 'Dr. Cox', 'FULLNAME'), entity(brief, 'Cox Bianchi', 'FULLNAME')]];
  const payload = [fragment(character), fragment(brief)];
  // Positive: the piece of the character alone passes with its own names.
  assert.equal(check([fragment(character)], CLAUDE, piiReport([character], [found[0]], [], [['Dr. Cox', 'Cox']])).decision, 'allow');
  // Negative: the same names do not reach the brief, and without them the piece of the character is found too.
  const decision = check(payload, CLAUDE, piiReport(texts, found, [], [['Dr. Cox', 'Cox'], undefined]));
  assert.ok(decision.decision === 'block');
  assert.deepEqual(decision.pii, [{ kind: 'FULLNAME', fragment: 1 }]);
  assert.ok(check([fragment(character)], CLAUDE, piiReport([character], [found[0]])).decision === 'block');
});

test('a piece of a name of the fragment, inside a whole occurrence of it, is no person there; outside it, or around it, it is (D-227)', () => {
  const character = 'Call yourself "Laverne". You are Dr. Kelso.';
  const at = (value: string, from = 0): PiiEntity => {
    const start = character.indexOf(value, from);
    assert.ok(start >= 0);
    return { kind: 'FULLNAME', start, end: start + value.length, score: 0.98 };
  };
  const names = [['Laverne', 'Dr. Kelso', 'Kelso']];
  // Positive: «verne» of «Laverne» and «so» of «Dr. Kelso», the cuts the model made on 2026-10-16.
  assert.equal(check([fragment(character)], CLAUDE, piiReport([character], [[at('verne'), at('so', character.indexOf('Kelso'))]], [], names)).decision, 'allow');
  // Negative: without the names of the fragment the piece is a person.
  assert.ok(check([fragment(character)], CLAUDE, piiReport([character], [[at('verne')]])).decision === 'block');
  // Negative: a span larger than the occurrence («Laverne Bianchi») is a person.
  const brief = 'Scrivi a Laverne Bianchi.';
  const around = { kind: 'FULLNAME', start: brief.indexOf('Laverne'), end: brief.indexOf('Laverne') + 'Laverne Bianchi'.length, score: 0.98 };
  assert.ok(check([fragment(brief)], CLAUDE, piiReport([brief], [[around]], [], names)).decision === 'block');
  // Negative: the same letters inside another word are not in an occurrence of the name.
  const word = 'Ciao Lavernetti.';
  const inside = { kind: 'FULLNAME', start: word.indexOf('verne'), end: word.indexOf('verne') + 5, score: 0.98 };
  assert.ok(check([fragment(word)], CLAUDE, piiReport([word], [[inside]], [], names)).decision === 'block');
  // Negative: the names of one fragment never cover a piece in another fragment without them.
  const other = 'Scrivi a Laverne.';
  const piece = { kind: 'FULLNAME', start: other.indexOf('verne'), end: other.indexOf('verne') + 5, score: 0.98 };
  const two = check([fragment(character), fragment(other)], CLAUDE, piiReport([character, other], [[at('verne')], [piece]], [], [names[0], undefined]));
  assert.ok(two.decision === 'block');
  assert.deepEqual(two.pii, [{ kind: 'FULLNAME', fragment: 1 }]);
});

test('an EMAIL that is a site alone, with no at sign near it, does not count; every other EMAIL does (D-268)', () => {
  for (const [text, value] of [['https://www.comune.torino.it/', 'www.comune.torino.it'], ['apri comune.torino.it/servizi', 'comune.torino.it'], ['https://it.wikipedia.org/wiki/Torino', 'it.wikipedia.org'], ['(vedi https://www.comune.torino.it/anagrafe)', 'torino.it']] as const) {
    assert.equal(blocks(text, value, 'EMAIL'), false, text);
  }
  // What Rizzo marked on 2026-10-21: the «.» after www in the address, «torino.it» in the host alone.
  const address = 'https://www.comune.torino.it/';
  assert.equal(check([fragment(address)], CLAUDE, piiReport([address], [[{ kind: 'EMAIL', start: 11, end: 12, score: 0.51 }]])).decision, 'allow');
  const host = 'www.comune.torino.it';
  assert.equal(check([fragment(host)], CLAUDE, piiReport([host], [[{ kind: 'EMAIL', start: 3, end: 4, score: 0.97 }, { kind: 'EMAIL', start: 10, end: 20, score: 0.77 }]])).decision, 'allow');
  // A piece in the path or the query is not in the host: it counts.
  assert.ok(blocks('https://sito-finto.it/utenti/mario.rossi', 'mario.rossi', 'EMAIL'));
  for (const [text, value] of [
    ['https://sito-finto.it/?contatto=mario.rossi@example.com', 'mario.rossi@example.com'],
    ['https://sito-finto.it/?contatto=mario.rossi@example.com', 'example.com'],
    ['https://sito-finto.it/?email=mario.rossi%40example.com', 'example.com'],
    ['https://sito-finto.it/?email=mario.rossi%40example.com', 'mario.rossi%40example.com'],
    ['mailto:mario.rossi%40example.com', 'mario.rossi'],
    ['https://t.example.net/r?u=https%3A%2F%2Fshop.example.com%2Fp%3Femail%3Dmario.rossi%2540example.com', 'example.com'],
    ['scrivi a mario.rossi(at)example.com', 'mario.rossi'],
    ['scrivi a mario.rossi ＠ example.com', 'example.com'],
    ['scrivi a mario.rossi @ example.com', 'mario.rossi'],
    ['scrivi a mario.rossi\u00a0@\u00a0example.com', 'example.com'],
    ['mario.rossi chiocciola gmail.com', 'gmail.com'],
    ['mario.rossi at gmail dot com', 'mario.rossi'],
    ['mario.rossi_at_example.com', 'example.com'],
    ['mario.rossi&#64;example.com', 'example.com'],
    ['mario.rossi&commat;example.com', 'example.com'],
    ['il server di casa è 93.41.12.7', '93.41.12.7'],
  ] as const) {
    assert.ok(blocks(text, value, 'EMAIL'), text);
  }
});

test('the same rule on the other exits: a site passes towards Telegram, an email does not', () => {
  const site = 'Guarda https://www.comune.torino.it/ per gli orari';
  assert.equal(check([fragment(site)], TELEGRAM, piiReport([site], [[entity(site, 'www.comune.torino.it', 'EMAIL')]])).decision, 'allow');
  const email = 'Scrivi a mario.rossi@example.com per gli orari';
  assert.equal(check([fragment(email)], TELEGRAM, piiReport([email], [[entity(email, 'mario.rossi@example.com', 'EMAIL')]])).decision, 'block');
});
