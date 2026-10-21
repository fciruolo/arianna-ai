import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createContext, forgetCatalogTexts, markCatalogText, piiReport, piiUnavailable, type Labeled, type PiiCheck, type Target } from '@arianna/policy';

import { passGateway } from '../src/gateway.ts';
import { configurePiiGuard, type PiiGuard } from '../src/pii-guard.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };

/** A fake service: answers with `answer`, counts the texts it was asked. */
function fakeGuard(answer: (texts: readonly string[]) => PiiCheck): PiiGuard & { asked: (readonly string[])[] } {
  const asked: (readonly string[])[] = [];
  return {
    asked,
    state: 'ready', warm: () => Promise.resolve(true),
    scan: (texts) => {
      asked.push(texts);
      return Promise.resolve(answer(texts));
    },
    stop: () => Promise.resolve(),
  };
}

const clean = (texts: readonly string[]) => piiReport(texts, texts.map(() => []));

after(() => {
  configurePiiGuard(fakeGuard(clean));
});

interface LogRow {
  decision: string;
  rule: string;
  reason: string;
  payload_sha256: string | null;
  summary: string | null;
}

async function lastLog(): Promise<LogRow> {
  const [row] = await db().sql<LogRow[]>`SELECT decision, rule, reason, payload_sha256, summary FROM gateway_log ORDER BY id DESC LIMIT 1`;
  if (row === undefined) throw new Error('gateway_log is empty');
  return row;
}

test('a person found by the second scanner blocks the exit and leaves a row without the text', async () => {
  const text = 'Scrivi a Mario Rossi per il preventivo';
  const guard = fakeGuard((texts) => piiReport(texts, [[{ kind: 'FULLNAME', start: 9, end: 20, score: 0.99 }]]));
  configurePiiGuard(guard);
  const payload: Labeled<string>[] = [{ value: text, label: 'L1', source: 'test' }];
  const decision = await passGateway(db().sql, payload, createContext('L1'), CLAUDE, { summary: 'brief per Mario Rossi' });
  assert.equal(decision.decision, 'block');
  assert.deepEqual(guard.asked, [[text]], 'the service read the exact text that would leave');
  const row = await lastLog();
  assert.equal(row.rule, 'pii');
  assert.equal(row.reason, 'second scanner found personal data: FULLNAME');
  assert.equal(row.summary, null);
  assert.equal(row.payload_sha256, null, 'no hash: a short sentence with a name could be guessed from it');
});

test('a clean answer lets the exit go', async () => {
  configurePiiGuard(fakeGuard(clean));
  const decision = await passGateway(db().sql, [{ value: 'Aggiungi un test', label: 'L1', source: 'test' }], createContext('L1'), CLAUDE, { summary: 'brief di prova' });
  assert.equal(decision.decision, 'allow');
  const row = await lastLog();
  assert.equal(row.rule, 'cloud');
  assert.equal(row.summary, 'brief di prova');
});

test('no answer stops the exit; on a development installation it goes and the row says so', async () => {
  configurePiiGuard(fakeGuard(() => piiUnavailable('timeout')));
  const blocked = await passGateway(db().sql, [{ value: 'Aggiungi un test', label: 'L1', source: 'test' }], createContext('L1'), CLAUDE);
  assert.equal(blocked.decision, 'block');
  assert.equal((await lastLog()).rule, 'pii-unavailable');
  configurePiiGuard(fakeGuard(() => piiUnavailable('off', true)));
  const allowed = await passGateway(db().sql, [{ value: 'Aggiungi un test', label: 'L1', source: 'test' }], createContext('L1'), CLAUDE);
  assert.equal(allowed.decision, 'allow');
  assert.match((await lastLog()).reason, /second check skipped on a development installation \(off\)/);
});

test('the service is not asked when another rule decides', async () => {
  const guard = fakeGuard(clean);
  configurePiiGuard(guard);
  assert.equal((await passGateway(db().sql, [{ value: 'Mario Rossi', label: 'L2', source: 'test' }], createContext('L2'), LOCAL_MODEL)).decision, 'allow');
  assert.equal((await passGateway(db().sql, [{ value: 'testo', label: 'L1', source: 'test' }], createContext('L2', 'L2'), CLAUDE)).decision, 'block');
  assert.equal((await lastLog()).rule, 'contaminated');
  assert.equal((await passGateway(db().sql, [{ value: 'IBAN IT60X0542811101000000123456', label: 'L1', source: 'test' }], createContext('L1'), CLAUDE)).decision, 'block');
  assert.equal((await lastLog()).rule, 'scanner');
  assert.deepEqual(guard.asked, []);
});

/** A fake Rizzo-PII that reads «xAI» and «Mario Bianchi» as persons wherever they are, as the model read the style x-ai. */
const findsPersons = (texts: readonly string[]) =>
  piiReport(
    texts,
    texts.map((text) =>
      ['xAI', 'Mario Bianchi'].flatMap((name) => [...text.matchAll(new RegExp(name, 'g'))].map((match) => ({ kind: 'FULLNAME', start: match.index, end: match.index + name.length, score: 0.97 }))),
    ),
  );

const STYLE = '----- BEGIN STYLE x-ai [0123456789abcdef] -----\n# Design System Inspired by xAI\nInvented palette.\n----- END STYLE x-ai [0123456789abcdef] -----';

test('the block of a catalog marked by the core is never read by the service; the brief beside it is (D-250)', async () => {
  try {
    markCatalogText('skills:designer', STYLE);
    const guard = fakeGuard(findsPersons);
    configurePiiGuard(guard);
    const style: Labeled<string> = { value: STYLE, label: 'L0', source: 'skills:designer' };
    const allowed = await passGateway(db().sql, [{ value: "fai un'altra versione", label: 'L1', source: 'task:x' }, style], createContext('L1'), CLAUDE);
    assert.equal(allowed.decision, 'allow');
    assert.deepEqual(guard.asked, [["fai un'altra versione", '']], 'the style went to the service as an empty text');
    assert.match((await lastLog()).reason, /1 catalog text not read by the second check/);

    const person = await passGateway(db().sql, [{ value: 'rifai la pagina per Mario Bianchi', label: 'L1', source: 'task:x' }, style], createContext('L1'), CLAUDE);
    assert.equal(person.decision, 'block', 'a person in the brief still blocks beside the exempt style');
    assert.equal((await lastLog()).rule, 'pii');

    // The same text in another fragment, or changed by one character: read, and blocked as before.
    for (const fragment of [
      { value: STYLE, label: 'L0', source: 'task:x' },
      { value: `${STYLE}.`, label: 'L0', source: 'skills:designer' },
    ] as Labeled<string>[]) {
      const blocked = await passGateway(db().sql, [fragment], createContext('L1'), CLAUDE);
      assert.equal(blocked.decision, 'block', fragment.source);
      assert.equal((await lastLog()).rule, 'pii');
    }
  } finally {
    forgetCatalogTexts();
  }
});
