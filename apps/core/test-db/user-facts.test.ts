// «Su di te» (D-114, tappa A): the facts of the profile in user_facts, written
// only by the Settings; the scanner and the vault on the topic and on an L1
// text; lowering a fact (L2 → L1) prepared, confirmed, with its row in
// label_changes; events without the text. And «Su di te, per chi sviluppa Arianna»
// through the gateway towards the cloud.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { sha256Hex } from '@arianna/policy';
import { Secret } from '@arianna/vault';

import { USER_FILE } from '../src/dev-progress.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createUserFacts, FactsError } from '../src/user-facts.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const scratch = join(resolveHome({}), 'data', 'test-tmp', `user-facts-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const IBAN = 'IT60X0542811101000000123456';

// One schema for the file: each test starts from an empty profile (as the owner: the core has no DELETE).
beforeEach(async () => {
  await db().owner`DELETE FROM user_facts`;
});

async function serve(t: { after: (fn: () => unknown) => void }, home?: string): Promise<ApiServer> {
  const { sql } = db();
  const server = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, ...(home === undefined ? {} : { devProgress: { home } }) });
  t.after(() => server.close());
  return server;
}

function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

async function insertFact(sql: ReturnType<typeof db>['sql'], topic: string, text: string, label = 'L2'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO user_facts (topic, text, label) VALUES (${topic}, ${text}, ${label}::privacy_label) RETURNING id::text`;
  if (row === undefined) throw new Error('no row');
  return row.id;
}

interface FactBody {
  id: string;
  topic: string;
  text: string;
  label: string;
  updatedAt: string;
}

const factOf = (response: { body: Record<string, unknown> }): FactBody => response.body.fact as FactBody;

describe('user_facts in the database (migration 0061)', () => {
  it('a topic once, ignoring case; L1 or L2 only; text within 300 characters', async () => {
    const { sql } = db();
    await sql`INSERT INTO user_facts (topic, text) VALUES ('Città', 'Borgo Finto')`;
    await assert.rejects(sql`INSERT INTO user_facts (topic, text) VALUES ('città', 'Altro Borgo')`, /user_facts_topic_idx/);
    await assert.rejects(sql`INSERT INTO user_facts (topic, text, label) VALUES ('salute', 'finto', 'L3')`, /check/i);
    await assert.rejects(sql`INSERT INTO user_facts (topic, text, label) VALUES ('pubblico', 'finto', 'L0')`, /check/i);
    await assert.rejects(sql`INSERT INTO user_facts (topic, text) VALUES ('lungo', ${'a'.repeat(301)})`, /check/i);
    await assert.rejects(sql`INSERT INTO user_facts (topic, text) VALUES (' ', 'finto')`, /check/i);
    const [row] = await sql<{ label: string }[]>`SELECT label::text FROM user_facts WHERE topic = 'Città'`;
    assert.equal(row?.label, 'L2');
  });

  it('the core role has no DELETE: a fact goes with user_fact_delete', async () => {
    const { sql } = db();
    const id = await insertFact(sql, 'hobby', 'Modellismo finto');
    await assert.rejects(sql`DELETE FROM user_facts WHERE id = ${id}::uuid`, /permission denied/);
    await sql`SELECT user_fact_delete(${id}::uuid)`;
    await assert.rejects(sql`SELECT user_fact_delete(${id}::uuid)`, /does not exist/);
  });

  it('lowering L2 → L1 without its approved label_changes row is refused; raising is not', async () => {
    const { sql } = db();
    const id = await insertFact(sql, 'sport', 'Corsa finta');
    await assert.rejects(sql`UPDATE user_facts SET label = 'L1' WHERE id = ${id}::uuid`, /declassification/);
    const shared = await insertFact(sql, 'lingua', 'Italiano', 'L1');
    await sql`UPDATE user_facts SET label = 'L2' WHERE id = ${shared}::uuid`;
    await assert.rejects(sql`UPDATE user_facts SET created_at = now() - interval '1 day' WHERE id = ${shared}::uuid`, /never change/);
  });
});

describe('«Su di te» in the Settings (D-114)', () => {
  it('creates, reads, edits and deletes facts; a new one is «Solo in casa»', async (t) => {
    const server = await serve(t);
    const created = await call(server.port, 'POST', '/api/profile/facts', { topic: '  lavoro  ', text: 'Sviluppatore web finto' });
    assert.equal(created.status, 201);
    const fact = factOf(created);
    assert.equal(fact.topic, 'lavoro');
    assert.equal(fact.label, 'L2');

    const listed = await call(server.port, 'GET', '/api/profile/facts');
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body.facts as FactBody[]).map((item) => item.topic), ['lavoro']);
    assert.deepEqual(listed.body.max, { topic: 60, text: 300 });

    const edited = await call(server.port, 'POST', `/api/profile/facts/${fact.id}`, { text: 'Grafico finto' });
    assert.equal(edited.status, 200);
    assert.equal(factOf(edited).text, 'Grafico finto');

    const twin = await call(server.port, 'POST', '/api/profile/facts', { topic: 'LAVORO', text: 'altro' });
    assert.equal(twin.status, 409);

    assert.equal((await call(server.port, 'DELETE', `/api/profile/facts/${fact.id}`, {})).status, 200);
    assert.equal((await call(server.port, 'DELETE', `/api/profile/facts/${fact.id}`, {})).status, 404);
    assert.deepEqual((await call(server.port, 'GET', '/api/profile/facts')).body.facts, []);
  });

  it('a new fact can be «Condivisibile» at once, checked by the scanner and the vault', async (t) => {
    const server = await serve(t);
    const shared = await call(server.port, 'POST', '/api/profile/facts', { topic: 'lingue', text: 'Italiano e inglese', label: 'L1' });
    assert.equal(shared.status, 201);
    assert.equal(factOf(shared).label, 'L1');

    const scanned = await call(server.port, 'POST', '/api/profile/facts', { topic: 'banca', text: `conto ${IBAN}`, label: 'L1' });
    assert.equal(scanned.status, 400);
    assert.match(String(scanned.body.error), /text looks like personal data/);
    assert.equal(String(scanned.body.error).includes(IBAN), false);

    const secret = new Secret('vault://user-facts-test', 'fake-profile-secret-0123456789abcdef');
    const vaulted = await call(server.port, 'POST', '/api/profile/facts', { topic: 'chiave', text: `è ${secret.reveal()}`, label: 'L1' });
    assert.equal(vaulted.status, 400);
  });

  it('the topic is always checked; the text of a fact «Solo in casa» is not', async (t) => {
    const server = await serve(t);
    const topic = await call(server.port, 'POST', '/api/profile/facts', { topic: IBAN, text: 'finto' });
    assert.equal(topic.status, 400);
    assert.match(String(topic.body.error), /topic looks like personal data/);
    // An L2 text stays at home: the scanner does not refuse it.
    const home = await call(server.port, 'POST', '/api/profile/facts', { topic: 'conto', text: `IBAN finto ${IBAN}` });
    assert.equal(home.status, 201);
  });

  it('L3 never enters the profile', async (t) => {
    const server = await serve(t);
    const refused = await call(server.port, 'POST', '/api/profile/facts', { topic: 'salute', text: 'finto', label: 'L3' });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /never enter the profile/);
  });

  it('«Condivisibile» from «Solo in casa» is prepared, shown and confirmed once, with its label_changes row', async (t) => {
    const { sql } = db();
    const server = await serve(t);
    const fact = factOf(await call(server.port, 'POST', '/api/profile/facts', { topic: 'città', text: 'Borgo Finto' }));

    const direct = await call(server.port, 'POST', `/api/profile/facts/${fact.id}`, { label: 'L1' });
    assert.equal(direct.status, 409);
    assert.match(String(direct.body.error), /needs-confirmation/);

    const prepared = await call(server.port, 'POST', `/api/profile/facts/${fact.id}/share/prepare`, { text: 'Vive a Borgo Finto' });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.text, 'Vive a Borgo Finto');
    assert.equal(prepared.body.topic, 'città');
    assert.deepEqual([prepared.body.from, prepared.body.to], ['L2', 'L1']);
    // Nothing changed yet.
    const [before] = await sql<{ label: string; text: string }[]>`SELECT label::text, text FROM user_facts WHERE id = ${fact.id}::uuid`;
    assert.deepEqual(before, { label: 'L2', text: 'Borgo Finto' });

    const confirmed = await call(server.port, 'POST', '/api/profile/facts/share/confirm', { id: prepared.body.id });
    assert.equal(confirmed.status, 200);
    assert.deepEqual([factOf(confirmed).label, factOf(confirmed).text], ['L1', 'Vive a Borgo Finto']);
    const again = await call(server.port, 'POST', '/api/profile/facts/share/confirm', { id: prepared.body.id });
    assert.equal(again.status, 404);

    const changes = await sql<{ subject: string; from: string; to: string; kind: string; state: string; via: string }[]>`
      SELECT c.subject, c.from_label::text AS from, c.to_label::text AS to, a.kind, a.state::text AS state, a.decided_via AS via
      FROM label_changes c JOIN approvals a ON a.id = c.approval_id
      WHERE c.subject = ${`content:${sha256Hex('Vive a Borgo Finto')}`}`;
    assert.deepEqual(changes.map((row) => ({ ...row })), [{ subject: `content:${sha256Hex('Vive a Borgo Finto')}`, from: 'L2', to: 'L1', kind: 'declassify', state: 'approved', via: 'web' }]);

    // Raising back is immediate.
    const raised = await call(server.port, 'POST', `/api/profile/facts/${fact.id}`, { label: 'L2' });
    assert.equal(raised.status, 200);
    assert.equal(factOf(raised).label, 'L2');

    // The events name the fact and its topic, never its text.
    const events = await sql<{ kind: string; label: string; payload: unknown }[]>`SELECT kind, label::text, payload FROM events WHERE kind LIKE 'user_fact.%' AND payload ->> 'factId' = ${fact.id} ORDER BY id`;
    assert.deepEqual(
      events.map((event) => event.kind),
      ['user_fact.created', 'user_fact.updated', 'user_fact.updated'],
    );
    for (const event of events) {
      assert.equal(event.label, 'L1');
      assert.equal(JSON.stringify(event.payload).includes('Borgo Finto'), false);
    }
  });

  it('a lowering is refused when the scanner finds something, and confirmed only on the fact as it was', async (t) => {
    const server = await serve(t);
    const fact = factOf(await call(server.port, 'POST', '/api/profile/facts', { topic: 'banca', text: `IBAN finto ${IBAN}` }));
    const scanned = await call(server.port, 'POST', `/api/profile/facts/${fact.id}/share/prepare`, {});
    assert.equal(scanned.status, 400);

    const other = factOf(await call(server.port, 'POST', '/api/profile/facts', { topic: 'cane', text: 'Si chiama Fido finto' }));
    const prepared = await call(server.port, 'POST', `/api/profile/facts/${other.id}/share/prepare`, {});
    assert.equal(prepared.status, 200);
    await call(server.port, 'POST', `/api/profile/facts/${other.id}`, { text: 'Si chiama Rex finto' });
    const stale = await call(server.port, 'POST', '/api/profile/facts/share/confirm', { id: prepared.body.id });
    assert.equal(stale.status, 409);
    const shared = await call(server.port, 'POST', `/api/profile/facts/${other.id}/share/prepare`, {});
    const already = factOf(await call(server.port, 'POST', '/api/profile/facts/share/confirm', { id: shared.body.id }));
    assert.equal(already.label, 'L1');
    const twice = await call(server.port, 'POST', `/api/profile/facts/${other.id}/share/prepare`, {});
    assert.equal(twice.status, 400);
  });

  it('a lowering expires after a few minutes', async () => {
    const { sql } = db();
    const clock = { now: 1_000_000 };
    const facts = createUserFacts(sql, { now: () => clock.now, confirmMs: 1000 });
    const fact = await facts.create({ topic: 'colore', text: 'Verde finto' });
    const proposal = await facts.prepareShare(fact.id, {});
    clock.now += 1001;
    await assert.rejects(facts.confirmShare({ id: proposal.id }), (error: unknown) => error instanceof FactsError && error.code === 'expired');
  });
});

describe('«Su di te, per chi sviluppa Arianna» (D-114)', () => {
  it('passes the gateway towards the cloud and replaces data/dev/UTENTE.md; a block writes nothing', async (t) => {
    const { sql } = db();
    const home = join(scratch, randomUUID());
    mkdirSync(join(home, 'data'), { recursive: true });
    const server = await serve(t, home);

    assert.deepEqual((await call(server.port, 'GET', '/api/dev/user-note')).body, { note: { text: '', at: null }, max: 4000 });
    const saved = await call(server.port, 'POST', '/api/dev/user-note', { text: 'Preferisco commit piccoli.' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.logged, true);
    const replaced = await call(server.port, 'POST', '/api/dev/user-note', { text: 'Lavoro la mattina.' });
    assert.equal(replaced.status, 200);
    const blocked = await call(server.port, 'POST', '/api/dev/user-note', { text: `pagami su ${IBAN}` });
    assert.equal(blocked.status, 422);

    const file = readFileSync(join(home, USER_FILE), 'utf8');
    assert.equal(file.includes('Lavoro la mattina.'), true);
    assert.equal(file.includes('Preferisco commit piccoli.'), false);
    assert.equal(file.includes(IBAN), false);
    assert.equal(((await call(server.port, 'GET', '/api/dev/user-note')).body.note as { text: string }).text, 'Lavoro la mattina.');

    const rows = await sql<{ target: string; decision: string; label: string; summary: string | null }[]>`
      SELECT target, decision, label::text, summary FROM gateway_log ORDER BY id`;
    assert.deepEqual(
      rows.map((row) => [row.target, row.decision, row.label]),
      [
        ['claude', 'allow', 'L1'],
        ['claude', 'allow', 'L1'],
        ['claude', 'block', 'L1'],
      ],
    );
    assert.equal(rows[0]?.summary, 'user-note');
    const events = await sql<{ payload: unknown }[]>`SELECT payload FROM events WHERE kind = 'dev.user_note_saved' ORDER BY id`;
    assert.deepEqual(
      events.map((event) => event.payload),
      [{ chars: 26 }, { chars: 18 }],
    );
  });
});
