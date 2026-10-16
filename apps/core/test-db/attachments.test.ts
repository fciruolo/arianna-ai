// Images and files attached in the chat (D-247): kept as pending, bound to
// the message that carries them only in a private conversation answered on
// the Mac, read by the vision model only, gone with «Elimina» (D-157).
// Fake data only: the images are made here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { type Answer } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, VISION_ALIAS } from '@arianna/config';
import { LocalModelError, type ChatRequest, type LocalModel } from '@arianna/executors';

import {
  AttachmentError,
  discardAttachment,
  PENDING_TTL_MS,
  pruneAttachments,
  readAttachment,
  saveAttachment,
  sweepAttachmentFiles,
} from '../src/attachments.ts';
import { ChatError, createConversation, listMessages, postUserMessage } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE } from '../src/engine.ts';
import { eraseConversation } from '../src/erase.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { postOrQueue } from '../src/message-queue.ts';
import { VISION_PROMPT } from '../src/orchestrator/attachment-reading.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { encodePng } from '../src/png.ts';
import { startApiServer } from '../src/server/http.ts';
import { useTestDatabase } from './support/database.ts';
import { committedAgents } from '../test/support/committed-agents.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const agents = committedAgents(HOME);
const RULES = parseLabelRules('[[folder]]\npath = "kb/work"\nlabel = "L1"\n');
const CONFIG = loadConfig();
const OPTIONS = {
  allowedActions: () => agents.get('arianna')?.card.approvals ?? [],
  agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }),
};
const kb = createKb({ home: HOME, rules: RULES });
// The folder of the attachments of these tests, in data/test-tmp (never in git).
const DATA = join(HOME, 'data', 'test-tmp', `attachments-${randomUUID()}`);
const DIR = join(DATA, 'attachments');
after(() => {
  rmSync(DATA, { recursive: true, force: true });
});

/** A 3×2 PNG made here: a fake screenshot. */
const PNG = encodePng({ width: 3, height: 2, rgba: Buffer.alloc(24, 90) });
const png = (name = 'schermata.png') => ({ name, data: PNG.toString('base64') });
const text = (name: string, body: string) => ({ name, data: Buffer.from(body).toString('base64') });

async function attachmentRow(id: string) {
  const [row] = await db().owner<{ messageId: string | null; conversationId: string | null; readState: string; reading: string | null; label: string }[]>`
    SELECT message_id::text AS "messageId", conversation_id::text AS "conversationId", read_state AS "readState", reading, label
    FROM message_attachments WHERE id = ${id}`;
  return row;
}

const files = (): string[] => (existsSync(DIR) ? readdirSync(DIR).sort() : []);

test('an upload is kept as a pending attachment, L2, its file private; an image needs a model with the vision role', async () => {
  const { sql } = db();
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  assert.deepEqual({ ...image, id: undefined }, { id: undefined, kind: 'image', name: 'schermata.png', mediaType: 'image/png', size: PNG.length });
  assert.deepEqual(await attachmentRow(image.id), { messageId: null, conversationId: null, readState: 'pending', reading: null, label: 'L2' });
  assert.ok(files().includes(`${image.id}.png`));
  assert.equal(statSync(join(DIR, `${image.id}.png`)).mode & 0o777, 0o600);
  assert.equal(statSync(DIR).mode & 0o777, 0o700);
  assert.deepEqual((await readAttachment(sql, DIR, image.id)).bytes, PNG);

  // A text file is read at once: its text is what the model will read.
  const note = await saveAttachment(sql, DIR, text('spesa.md', '# Spesa\n- latte'), { vision: false });
  assert.deepEqual(await attachmentRow(note.id), { messageId: null, conversationId: null, readState: 'done', reading: '# Spesa\n- latte', label: 'L2' });

  // Without the vision role an image is refused, and nothing is written.
  const before = files();
  await assert.rejects(saveAttachment(sql, DIR, png('altra.png'), { vision: false }), (error: unknown) => error instanceof AttachmentError && error.code === 'no-vision');
  assert.deepEqual(files(), before);
});

test('a private conversation takes attachments with the message; the message lists them, never their reading', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  const note = await saveAttachment(sql, DIR, text('dati.csv', 'data;importo\n2026-10-01;12,50'), { vision: true });
  const posted = await postUserMessage(sql, conversation.id, 'Cosa c’è qui?', { attachments: [image.id, note.id] });
  assert.equal(posted.message.label, 'L2');
  assert.deepEqual(posted.message.attachments.map((item) => [item.id, item.kind, item.name]), [
    [image.id, 'image', 'schermata.png'],
    [note.id, 'text', 'dati.csv'],
  ]);
  assert.equal(JSON.stringify(posted.message).includes('12,50'), false);
  assert.deepEqual((await listMessages(sql, conversation.id, { limit: 10 }))[0]?.attachments.map((item) => item.id), [image.id, note.id]);
  assert.equal((await attachmentRow(image.id))?.messageId, posted.message.id);
  // The event carries ids and a count only.
  const [event] = await owner<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'attachment.sent' AND payload ->> 'messageId' = ${posted.message.id}`;
  assert.deepEqual(event?.payload, { conversationId: conversation.id, messageId: posted.message.id, count: 2 });
  // Sent once: another message cannot carry it again.
  await assert.rejects(postUserMessage(sql, conversation.id, 'Di nuovo', { attachments: [image.id] }), (error: unknown) => error instanceof AttachmentError && error.code === 'not-found');
});

test('a work conversation, an incognito one or a chat with Claude refuses the attachment; text and attachment stay', async () => {
  const { sql, owner } = db();
  const work = await createConversation(sql, { mode: 'work' });
  const claude = await createConversation(sql, { mode: 'work', agent: { name: 'claude', modes: ['work'], project: false } });
  const incognito = await createConversation(sql, { mode: 'private', incognito: true });
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  for (const conversation of [work, claude, incognito]) {
    await assert.rejects(postUserMessage(sql, conversation.id, 'Guarda', { attachments: [image.id] }), (error: unknown) => error instanceof ChatError && error.code === 'invalid');
    const [count] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${conversation.id}`;
    assert.equal(count?.n, 0);
  }
  assert.equal((await attachmentRow(image.id))?.messageId, null);
  // The database refuses it too, whatever the core would do.
  const [message] = await owner<{ id: string }[]>`
    INSERT INTO messages (conversation_id, role, label, body) VALUES (${work.id}, 'user', 'L1', 'Ciao') RETURNING id::text`;
  await assert.rejects(owner`UPDATE message_attachments SET message_id = ${message?.id ?? ''}::bigint, conversation_id = ${work.id} WHERE id = ${image.id}`, /only in a private conversation/);
  // A private conversation still takes it.
  const conversation = await createConversation(sql, { mode: 'private' });
  assert.ok('sent' in (await postOrQueue(sql, conversation.id, 'Ecco', { attachments: [image.id] })));
});

test('an attachment never waits in the queue: refused while an answer is at work', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  assert.ok('sent' in (await postOrQueue(sql, conversation.id, 'Prima domanda')));
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  await assert.rejects(postOrQueue(sql, conversation.id, 'Guarda', { attachments: [image.id] }), (error: unknown) => error instanceof ChatError && error.code === 'busy');
  assert.equal((await attachmentRow(image.id))?.messageId, null);
  // Without the attachment the text waits, as before (D-218).
  assert.ok('queued' in (await postOrQueue(sql, conversation.id, 'Guarda')));
});

test('a bound attachment never moves nor changes; its reading is written once', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const other = await createConversation(sql, { mode: 'private' });
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  const posted = await postUserMessage(sql, conversation.id, 'Guarda', { attachments: [image.id] });
  const otherPost = await postUserMessage(sql, other.id, 'Altro');
  await assert.rejects(owner`UPDATE message_attachments SET message_id = ${otherPost.message.id}::bigint, conversation_id = ${other.id} WHERE id = ${image.id}`, /bound to its message/);
  await assert.rejects(owner`UPDATE message_attachments SET name = 'altro.png' WHERE id = ${image.id}`, /never changes/);
  await owner`UPDATE message_attachments SET read_state = 'done', reading = 'Lettura finta', read_at = now() WHERE id = ${image.id}`;
  await assert.rejects(owner`UPDATE message_attachments SET reading = 'Altra lettura' WHERE id = ${image.id}`, /read once/);
  await assert.rejects(owner`UPDATE message_attachments SET label = 'L1' WHERE id = ${image.id}`);
  // Born pending only.
  await assert.rejects(owner`
    INSERT INTO message_attachments (kind, media_type, name, size_bytes, sha256, read_state, message_id, conversation_id)
    VALUES ('image', 'image/png', 'x.png', 10, ${'a'.repeat(64)}, 'pending', ${posted.message.id}::bigint, ${conversation.id})`);
  // An SVG never enters, whatever a caller writes.
  await assert.rejects(owner`
    INSERT INTO message_attachments (kind, media_type, name, size_bytes, sha256, read_state) VALUES ('image', 'image/svg+xml', 'x.svg', 10, ${'a'.repeat(64)}, 'pending')`);
});

test('«×» removes a pending attachment and its file; one already sent stays with its message', async () => {
  const { sql } = db();
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  await discardAttachment(sql, DIR, image.id);
  assert.equal(await attachmentRow(image.id), undefined);
  assert.equal(files().includes(`${image.id}.png`), false);
  const conversation = await createConversation(sql, { mode: 'private' });
  const sent = await saveAttachment(sql, DIR, png(), { vision: true });
  await postUserMessage(sql, conversation.id, 'Guarda', { attachments: [sent.id] });
  await assert.rejects(discardAttachment(sql, DIR, sent.id), (error: unknown) => error instanceof AttachmentError && error.code === 'conflict');
  assert.ok(files().includes(`${sent.id}.png`));
});

test('«Elimina» takes the attachments of the conversation and their files (D-157)', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  const note = await saveAttachment(sql, DIR, text('nota.txt', 'Testo finto da cancellare'), { vision: true });
  const posted = await postUserMessage(sql, conversation.id, 'Guarda', { attachments: [image.id, note.id] });
  await owner`UPDATE jobs SET status = 'done' WHERE key = ${`task:${posted.task.id}`}`;
  await owner`UPDATE tasks SET status = 'done', assignee = 'user' WHERE id = ${posted.task.id}`;
  await eraseConversation(sql, conversation.id, { dataDir: DATA });
  assert.equal(await attachmentRow(image.id), undefined);
  assert.equal(await attachmentRow(note.id), undefined);
  assert.equal(files().includes(`${image.id}.png`), false);
  assert.equal(files().includes(`${note.id}.txt`), false);
  const [left] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM events WHERE payload::text LIKE ${`%${image.id}%`} OR (kind = 'attachment.sent' AND payload ->> 'conversationId' = ${conversation.id})`;
  assert.equal(left?.n, 0);
});

test('at start the pending attachments older than a day go, and the files without a row', async () => {
  const { sql, owner } = db();
  const old = await saveAttachment(sql, DIR, png(), { vision: true });
  const fresh = await saveAttachment(sql, DIR, png(), { vision: true });
  // A day ago: the guard keeps created_at, so it is set below the guard, as the owner.
  await owner.begin(async (tx) => {
    await tx`ALTER TABLE message_attachments DISABLE TRIGGER message_attachments_guard`;
    await tx`UPDATE message_attachments SET created_at = now() - interval '25 hours' WHERE id = ${old.id}`;
    await tx`ALTER TABLE message_attachments ENABLE TRIGGER message_attachments_guard`;
  });
  // A file whose row never came, older than the grace, and one just written.
  const stray = join(DIR, `${randomUUID()}.png`);
  writeFileSync(stray, PNG);
  const past = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(stray, past, past);
  utimesSync(join(DIR, `${old.id}.png`), past, past);
  const young = join(DIR, `${randomUUID()}.png`);
  writeFileSync(young, PNG);
  const outcome = await pruneAttachments(sql, DIR);
  assert.ok(outcome.rows >= 1);
  assert.equal(await attachmentRow(old.id), undefined);
  assert.notEqual(await attachmentRow(fresh.id), undefined);
  assert.equal(existsSync(join(DIR, `${old.id}.png`)), false);
  assert.equal(existsSync(stray), false);
  assert.equal(existsSync(young), true);
  assert.equal(existsSync(join(DIR, `${fresh.id}.png`)), true);
  // Something else in the folder is left alone.
  writeFileSync(join(DIR, 'leggimi.txt'), 'altro');
  utimesSync(join(DIR, 'leggimi.txt'), past, past);
  await sweepAttachmentFiles(sql, DIR);
  assert.equal(existsSync(join(DIR, 'leggimi.txt')), true);
  assert.equal(PENDING_TTL_MS, 24 * 60 * 60 * 1000);
});

/**
 * A local model: the vision alias answers with `vision` (a reading or an
 * error), the orchestrator's requests with the scripted answers. Every
 * request and unload is kept.
 */
function fake(answers: Answer[], vision: string | LocalModelError) {
  const requests: ChatRequest[] = [];
  const unloads: string[] = [];
  let answered = 0;
  const model: LocalModel = {
    chat(request) {
      requests.push(request);
      const reply = (body: string, value?: unknown) =>
        Promise.resolve({ text: body, ...(value === undefined ? {} : { value }), finishReason: 'stop', endpoint: 'stub', model: 'stub', durationMs: 1 });
      if (request.model === VISION_ALIAS) return vision instanceof LocalModelError ? Promise.reject(vision) : reply(vision);
      const next = answers[answered];
      answered += 1;
      if (next === undefined || request.schema === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = JSON.stringify(request.schema.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return reply(JSON.stringify(value), value);
    },
    unload(alias) {
      unloads.push(alias);
      return Promise.resolve(true);
    },
  };
  return { model, requests, unloads };
}

async function drain(taskId: string, model: LocalModel): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const executor = createOrchestrator({
    sql: db().sql,
    agents,
    kb,
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() } }),
    rules: RULES,
    attachmentsDir: DIR,
  });
  const results: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (job.payload.taskId !== taskId) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

const contents = (request: ChatRequest | undefined) => (request?.messages ?? []).map((message) => message.content);

test('the vision model reads the image once, then is unloaded; Arianna reads its reading and the text file, L2, locally', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const image = await saveAttachment(sql, DIR, png('scontrino.png'), { vision: true });
  const note = await saveAttachment(sql, DIR, text('lista.txt', 'latte, pane'), { vision: true });
  const posted = await postUserMessage(sql, conversation.id, 'Quanto ho speso?', { attachments: [image.id, note.id] });
  const stub = fake([{ action: 'reply', text: 'Hai speso 12,50 €.' }], '<think>guardo</think>Scontrino finto: totale 12,50 €.');
  assert.deepEqual(await drain(posted.task.id, stub.model), ['answered']);

  // First the vision model, with the prompt and the image as a data URL; then unloaded; then the answer.
  const [vision, answer] = stub.requests;
  assert.equal(stub.requests.length, 2);
  assert.equal(vision?.model, VISION_ALIAS);
  assert.equal(vision.messages[0]?.content, VISION_PROMPT);
  assert.deepEqual(vision.messages[1]?.images, [`data:image/png;base64,${PNG.toString('base64')}`]);
  assert.deepEqual(stub.unloads, [VISION_ALIAS]);
  assert.deepEqual(await attachmentRow(image.id), { messageId: posted.message.id, conversationId: conversation.id, readState: 'done', reading: 'Scontrino finto: totale 12,50 €.', label: 'L2' });

  // The answer reads the message, then each attachment as data; no image reaches it.
  const read = contents(answer).at(-1) ?? '';
  assert.ok(read.startsWith('Quanto ho speso?\n\n[Allegato "scontrino.png" (immagine)'), read);
  assert.ok(read.includes('Scontrino finto: totale 12,50 €.'));
  assert.ok(read.includes('[Allegato "lista.txt" (file di testo)'));
  assert.ok(read.includes('latte, pane'));
  assert.ok((answer?.messages ?? []).every((message) => message.images === undefined));

  // Every exit was local and L2: the reading of the image and the answer.
  const log = await sql<{ target: string; locality: string; label: string; decision: string }[]>`
    SELECT target, locality, label, decision FROM gateway_log WHERE task_id = ${posted.task.id} ORDER BY id`;
  assert.ok(log.length >= 2);
  for (const row of log) assert.deepEqual([row.locality, row.label, row.decision], ['local', 'L2', 'allow']);

  // The next task reads the reading again, without asking the vision model.
  const next = await postUserMessage(sql, conversation.id, 'E il totale?');
  const again = fake([{ action: 'reply', text: '12,50 €.' }], new LocalModelError('unavailable', 'stub'));
  assert.deepEqual(await drain(next.task.id, again.model), ['answered']);
  assert.equal(again.requests.filter((request) => request.model === VISION_ALIAS).length, 0);
  assert.deepEqual(again.unloads, []);
  assert.ok(contents(again.requests[0]).join('\n').includes('Scontrino finto: totale 12,50 €.'));
});

test('an image the vision model cannot read is marked failed; Arianna is told and answers', async () => {
  const { sql, owner } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const image = await saveAttachment(sql, DIR, png(), { vision: true });
  const posted = await postUserMessage(sql, conversation.id, 'Cosa vedi?', { attachments: [image.id] });
  const stub = fake([{ action: 'reply', text: 'Non riesco a vederla.' }], new LocalModelError('no-endpoint', 'no local endpoint serves local-vision'));
  assert.deepEqual(await drain(posted.task.id, stub.model), ['answered']);
  assert.equal((await attachmentRow(image.id))?.readState, 'failed');
  assert.deepEqual(stub.unloads, [VISION_ALIAS]);
  assert.match(contents(stub.requests.at(-1)).at(-1) ?? '', /non è riuscito a leggerla/);
  const [event] = await owner<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'attachment.unread' AND task_id = ${posted.task.id}`;
  assert.deepEqual(event?.payload, { attachmentId: image.id, reason: 'no-endpoint' });
});

test('a task without images never asks the vision model nor unloads it', async () => {
  const { sql } = db();
  const conversation = await createConversation(sql, { mode: 'private' });
  const posted = await postUserMessage(sql, conversation.id, 'Ciao');
  const stub = fake([{ action: 'reply', text: 'Ciao!' }], 'mai');
  assert.deepEqual(await drain(posted.task.id, stub.model), ['answered']);
  assert.equal(stub.requests.filter((request) => request.model === VISION_ALIAS).length, 0);
  assert.deepEqual(stub.unloads, []);
});

/** node:http, not fetch: with NODE_USE_ENV_PROXY fetch would send loopback requests to a proxy. */
function call(origin: string, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      {
        method,
        agent: false,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          ...(method === 'GET' ? {} : { origin }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

test('the routes: upload, the image shown sandboxed, «×», and the message refused in a work conversation', async () => {
  const { sql } = db();
  let vision = true;
  const live = await startLiveFeed(sql);
  const server = await startApiServer({ sql, live, host: '127.0.0.1', port: 0, attachments: { dir: DIR, vision: () => vision } });
  const origin = `http://127.0.0.1:${String(server.port)}`;
  try {
    const uploaded = await call(origin, 'POST', '/api/attachments', png());
    assert.equal(uploaded.status, 201);
    const { attachment } = JSON.parse(uploaded.text) as { attachment: { id: string; kind: string } };
    assert.equal(attachment.kind, 'image');
    const shown = await call(origin, 'GET', `/api/attachments/${attachment.id}`);
    assert.equal(shown.status, 200);
    assert.equal(shown.headers['content-type'], 'image/png');
    assert.equal(shown.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(shown.headers['x-content-type-options'], 'nosniff');
    assert.equal(shown.headers['cache-control'], 'no-store');

    // A work conversation refuses it before anything is written; the attachment stays pending.
    const work = await createConversation(sql, { mode: 'work' });
    const refused = await call(origin, 'POST', `/api/conversations/${work.id}/messages`, { body: 'Guarda', attachments: [attachment.id] });
    assert.equal(refused.status, 400);
    assert.match(refused.text, /only in a private conversation/);
    assert.equal((await attachmentRow(attachment.id))?.messageId, null);

    // An SVG, an unknown field, an image without the vision role.
    assert.equal((await call(origin, 'POST', '/api/attachments', { name: 'a.svg', data: Buffer.from('<svg/>').toString('base64') })).status, 415);
    assert.equal((await call(origin, 'POST', '/api/attachments', { ...png(), conversationId: work.id })).status, 400);
    vision = false;
    const off = await call(origin, 'POST', '/api/attachments', png());
    assert.equal(off.status, 409);
    assert.match(off.text, /vision role/);

    // «×» removes it.
    assert.equal((await call(origin, 'DELETE', `/api/attachments/${attachment.id}`, {})).status, 204);
    assert.equal((await call(origin, 'GET', `/api/attachments/${attachment.id}`)).status, 404);
  } finally {
    await server.close();
    await live.close();
  }
});
