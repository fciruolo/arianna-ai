// "Sviluppo di Arianna" (D-102): an answer passes the gateway towards Claude
// Code (a row in gateway_log), and a saved one leaves an L0 event without its text.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { ANSWERS_FILE, parseAnswers, recordAnswer, type OpenQuestion } from '../src/dev-progress.ts';
import { readEvents, verifyEventChain } from '../src/events.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const scratch = join(resolveHome({}), 'data', 'test-tmp', `dev-progress-db-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const PROPOSALS = `## D-078 — Arianna sviluppata da dentro Arianna

### Domande per l'utente

1. **Chi fa il commit nel clone?** Raccomandazione: l'utente.
2. **Una sola delega attiva?** Raccomandazione: sì.
`;

function post(port: number, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/dev/answers', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

test('an answer goes through the gateway towards Claude Code: allowed is written, blocked is not', async (t) => {
  const { sql } = db();
  const home = join(scratch, randomUUID());
  mkdirSync(join(home, 'docs'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'docs', 'PROPOSTE.md'), PROPOSALS);
  const server = await startApiServer({ sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, devProgress: { home } });
  t.after(() => server.close());

  const saved = await post(server.port, { key: 'D-078#1', text: 'Lo faccio io.' });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.logged, true);
  const blocked = await post(server.port, { key: 'D-078#2', text: 'paga su IT60X0542811101000000123456' });
  assert.equal(blocked.status, 422);

  const rows = await sql<{ target: string; locality: string; decision: string; rule: string | null; label: string; summary: string | null }[]>`
    SELECT target, locality, decision, rule, label, summary FROM gateway_log ORDER BY id DESC LIMIT 2`;
  assert.deepEqual(
    rows.map((row) => [row.target, row.locality, row.decision, row.label]),
    [
      ['claude', 'cloud', 'block', 'L1'],
      ['claude', 'cloud', 'allow', 'L1'],
    ],
  );
  assert.equal(rows[1]?.summary, 'D-078#1');
  assert.equal(rows[0]?.summary, null);

  const text = readFileSync(join(home, ANSWERS_FILE), 'utf8');
  assert.deepEqual(
    parseAnswers(text).map((entry) => entry.key),
    ['D-078#1'],
  );
  assert.ok(!text.includes('IT60X'));

  const events = (await readEvents(sql, { limit: 1000 })).filter((event) => event.kind === 'dev.answer_saved');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.label, 'L0');
  assert.deepEqual(events[0].payload, { key: 'D-078#1', kind: 'proposal', source: 'PROPOSTE.md' });
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});

test('the event of a key made from a row holds a hash, never the slug', async () => {
  const { sql } = db();
  const question: OpenQuestion = { key: 'ho-chiave-age-vera', kind: 'waiting', ref: 'In attesa', topic: '', text: 'Chiave age vera', detail: null, explain: null, source: 'HANDOFF.md', answer: null, rewrite: null };
  await recordAnswer(sql, { key: question.key, question });
  const events = (await readEvents(sql, { limit: 1000 })).filter((event) => event.kind === 'dev.answer_saved');
  const payload = events.at(-1)?.payload as { key: string; kind: string; source: string };
  assert.match(payload.key, /^sha256:[0-9a-f]{16}$/);
  assert.equal(payload.source, 'HANDOFF.md');
  assert.ok(!JSON.stringify(payload).includes('chiave'));
});

test('a rewrite asked leaves an L0 event of its own, without the text (D-153)', async () => {
  const { sql } = db();
  const question: OpenQuestion = { key: 'D-078#2', kind: 'proposal', ref: 'D-078', topic: '', text: 'Una sola delega attiva?', detail: null, explain: null, source: 'PROPOSTE.md', answer: null, rewrite: null };
  await recordAnswer(sql, { key: question.key, question, rewrite: true });
  const events = (await readEvents(sql, { limit: 1000 })).filter((event) => event.kind === 'dev.rewrite_requested');
  assert.equal(events.at(-1)?.label, 'L0');
  assert.deepEqual(events.at(-1)?.payload, { key: 'D-078#2', kind: 'proposal', source: 'PROPOSTE.md' });
  assert.deepEqual(await verifyEventChain(sql), { ok: true });
});
