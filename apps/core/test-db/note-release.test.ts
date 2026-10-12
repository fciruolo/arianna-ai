// I-11 P5 (D-187): a Private note of a project leaves once, anonymous, with the master password.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { ANONYMIZE_PROMPT, type ChatRequest, type LocalModel } from '@arianna/executors';
import { createLabelRules } from '@arianna/policy';

import { archiveConversation, ChatError, createConversation } from '../src/conversations.ts';
import { startLiveFeed } from '../src/live.ts';
import { createNoteReleaser, MAX_WRONG_PASSWORDS, ReleaseError, type PasswordCheck } from '../src/note-release.ts';
import { readProjectNote } from '../src/project-knowledge.ts';
import { startApiServer } from '../src/server/http.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = join(resolveHome({}), 'data', 'test-tmp', `note-release-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// Fake data only: a container with one git part and its management folders.
const ORIGINAL = '# Fattura finta\n\nFattura al cliente Rossi Srl di 1.200 euro per il portale clienti.\n';
write(BOX, {
  'documenti/fattura.md': ORIGINAL,
  'documenti/vuota.md': '---\ntitle: Vuota\n---\n',
  'documenti/riservata.md': '---\nlabel: L3\n---\n\nContratto finto riservato.\n',
  'Workplan/piano.md': '# Piano\n\nRilascio a fine mese.\n',
  'progetto-admin/.git/HEAD': 'ref: refs/heads/main\n',
  'progetto-admin/src/a.ts': 'x\n',
});
const box: Project = { name: 'progetto', path: 'repos/progetto', absolute: BOX, label: 'L1' };
const other: Project = { name: 'altro', path: 'repos/altro', absolute: join(HOME, 'repos', 'altro'), label: 'L1' };
const KNOWLEDGE = { home: join(HOME, 'arianna'), rules: createLabelRules({ folders: [], sources: [] }) };
const ANONYMOUS = '# Fattura finta\n\nFattura al [cliente] di [importo] per il portale clienti.\n';

function fakeModel(requests: ChatRequest[], value: unknown = { text: ANONYMOUS }): LocalModel {
  return {
    chat(request) {
      requests.push(request);
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'stub', model: 'stub-model', durationMs: 1 });
    },
  };
}

function releaser(options: { check?: PasswordCheck; requests?: ChatRequest[]; clock?: { now: number }; checkPassword?: (password: string) => Promise<PasswordCheck> } = {}) {
  const requests = options.requests ?? [];
  const clock = options.clock;
  return createNoteReleaser({
    sql: db().sql,
    model: () => fakeModel(requests),
    projects: () => [box, other],
    knowledge: KNOWLEDGE,
    checkPassword: options.checkPassword ?? ((password) => Promise.resolve(options.check ?? (password === 'giusta-e-lunga' ? 'ok' : 'wrong'))),
    ...(clock === undefined ? {} : { now: () => clock.now }),
  });
}

const version = (path: string): string => readProjectNote([box, other], 'progetto', KNOWLEDGE, path).version;

async function counts(): Promise<{ approvals: number; changes: number }> {
  const [row] = await db().sql<{ approvals: number; changes: number }[]>`
    SELECT (SELECT count(*)::int FROM approvals WHERE kind = 'declassify') AS approvals, (SELECT count(*)::int FROM label_changes) AS changes`;
  return row ?? { approvals: -1, changes: -1 };
}

describe('the release of a Private note (D-187)', () => {
  let work: string;
  beforeEach(async () => {
    const conversation = await createConversation(db().sql, { mode: 'work', project: 'progetto', projects: ['progetto', 'altro'] });
    work = conversation.id;
  });

  it('lists the work conversations of the project only', async () => {
    const elsewhere = await createConversation(db().sql, { mode: 'work', project: 'altro', projects: ['progetto', 'altro'] });
    const privateOne = await createConversation(db().sql, { mode: 'private' });
    const ids = (await releaser().targets('progetto')).map((target) => target.id);
    assert.ok(ids.includes(work));
    assert.equal(ids.includes(elsewhere.id), false);
    assert.equal(ids.includes(privateOne.id), false);
  });

  it('proposes the anonymous version with the local model, through the gateway', async () => {
    const requests: ChatRequest[] = [];
    const outcome = await releaser({ requests }).propose('progetto', 'documenti/fattura.md');
    assert.deepEqual(outcome, { ok: true, text: ANONYMOUS, model: 'stub-model', version: version('documenti/fattura.md'), warnings: [] });
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.messages[0]?.content, ANONYMIZE_PROMPT);
    assert.deepEqual(JSON.parse(request.messages[1]?.content ?? ''), { note: ORIGINAL });
    const [logged] = await db().sql<{ locality: string; label: string; decision: string }[]>`
      SELECT locality, label, decision FROM gateway_log ORDER BY id DESC LIMIT 1`;
    assert.deepEqual({ ...logged }, { locality: 'local', label: 'L2', decision: 'allow' });
  });

  it('refuses a note that is not Private, and a Reserved one', async () => {
    const requests: ChatRequest[] = [];
    await assert.rejects(releaser({ requests }).propose('progetto', 'Workplan/piano.md'), (error) => error instanceof ReleaseError && error.code === 'not-private');
    await assert.rejects(releaser({ requests }).propose('progetto', 'documenti/riservata.md'), (error) => error instanceof ReleaseError && error.code === 'not-private');
    await assert.rejects(releaser({ requests }).propose('progetto', 'documenti/vuota.md'), (error) => error instanceof ReleaseError && error.code === 'invalid');
    assert.equal(requests.length, 0);
    await assert.rejects(
      releaser().release('progetto', { path: 'documenti/riservata.md', version: version('documenti/riservata.md'), text: 'Contratto', conversationId: work, password: 'giusta-e-lunga' }),
      (error) => error instanceof ReleaseError && error.code === 'not-private',
    );
  });

  it('lets the approved text out once, as an Interna message of the chosen conversation', async () => {
    const before = await counts();
    const released = await releaser().release('progetto', { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, conversationId: work, password: 'giusta-e-lunga' });
    assert.equal(released.conversationId, work);
    const [message] = await db().sql<{ label: string; body: string; role: string }[]>`SELECT label, body, role FROM messages WHERE id = ${released.messageId}`;
    assert.deepEqual({ ...message }, { label: 'L1', body: ANONYMOUS, role: 'user' });
    const [approval] = await db().sql<{ kind: string; state: string; decided_via: string; from: string; to: string }[]>`
      SELECT kind, state, decided_via, detail ->> 'from' AS from, detail ->> 'to' AS to FROM approvals WHERE id = ${released.approvalId}`;
    assert.deepEqual({ ...approval }, { kind: 'declassify', state: 'approved', decided_via: 'web', from: 'L2', to: 'L1' });
    const [change] = await db().sql<{ approval: string }[]>`SELECT approval_id::text AS approval FROM label_changes WHERE approval_id = ${released.approvalId}`;
    assert.equal(change?.approval, released.approvalId);
    const after = await counts();
    assert.deepEqual(after, { approvals: before.approvals + 1, changes: before.changes + 1 });
    const [event] = await db().sql<{ payload: Record<string, unknown> }[]>`SELECT payload FROM events WHERE kind = 'note.released' ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(event?.payload, { project: 'progetto', approvalId: released.approvalId, conversationId: work, messageId: released.messageId });
    // The note stays Private.
    assert.equal(readProjectNote([box, other], 'progetto', KNOWLEDGE, 'documenti/fattura.md').label, 'L2');
  });

  it('writes nothing with a wrong password, and locks after too many', async () => {
    const clock = { now: 1_000_000 };
    const release = releaser({ clock });
    const input = { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, conversationId: work, password: 'sbagliata' };
    const before = await counts();
    for (let i = 0; i < MAX_WRONG_PASSWORDS; i += 1) {
      await assert.rejects(release.release('progetto', input), (error) => error instanceof ReleaseError && error.code === 'wrong-password');
    }
    await assert.rejects(release.release('progetto', { ...input, password: 'giusta-e-lunga' }), (error) => error instanceof ReleaseError && error.code === 'locked');
    clock.now += 11 * 60_000;
    await release.release('progetto', { ...input, password: 'giusta-e-lunga' });
    assert.equal((await counts()).approvals, before.approvals + 1);
  });

  it('says when no master password is set', async () => {
    await assert.rejects(
      releaser({ check: 'unset' }).release('progetto', { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, conversationId: work, password: 'qualsiasi' }),
      (error) => error instanceof ReleaseError && error.code === 'no-password',
    );
  });

  it('refuses a conversation of another project, a private one, and a note changed since it was opened', async () => {
    const elsewhere = await createConversation(db().sql, { mode: 'work', project: 'altro', projects: ['progetto', 'altro'] });
    const privateOne = await createConversation(db().sql, { mode: 'private' });
    const base = { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, password: 'giusta-e-lunga' };
    const before = await counts();
    for (const conversationId of [elsewhere.id, privateOne.id, randomUUID(), 'non-un-id']) {
      await assert.rejects(releaser().release('progetto', { ...base, conversationId }), (error) => error instanceof ReleaseError && error.code === 'target');
    }
    await assert.rejects(releaser().release('progetto', { ...base, version: 'f'.repeat(64), conversationId: work }), (error) => error instanceof ReleaseError && error.code === 'changed');
    assert.deepEqual(await counts(), before);
  });

  it('rolls everything back when the work conversation refuses the text', async () => {
    const before = await counts();
    await assert.rejects(
      releaser().release('progetto', {
        path: 'documenti/fattura.md',
        version: version('documenti/fattura.md'),
        text: 'Pagare su IT60 X054 2811 1010 0000 0123 456',
        conversationId: work,
        password: 'giusta-e-lunga',
      }),
      (error) => error instanceof ChatError && error.code === 'scanner',
    );
    assert.deepEqual(await counts(), before);
  });

  it('releases to a conversation of a part, never to one archived, incognito or of a project with a longer name (one of the finances is never a work one)', async () => {
    const all = ['progetto', 'progetto:progetto-admin', 'altro', 'progetto-x'];
    const part = await createConversation(db().sql, { mode: 'work', project: 'progetto:progetto-admin', projects: all });
    const longer = await createConversation(db().sql, { mode: 'work', project: 'progetto-x', projects: all });
    const archived = await createConversation(db().sql, { mode: 'work', project: 'progetto', projects: all });
    await archiveConversation(db().sql, archived.id, true);
    const incognito = await createConversation(db().sql, { mode: 'work', project: 'progetto', projects: all, incognito: true });
    const refused = [longer.id, archived.id, incognito.id];
    const ids = (await releaser().targets('progetto')).map((target) => target.id);
    assert.ok(ids.includes(part.id));
    for (const id of refused) assert.equal(ids.includes(id), false);
    const base = { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, password: 'giusta-e-lunga' };
    for (const conversationId of refused) {
      await assert.rejects(releaser().release('progetto', { ...base, conversationId }), (error) => error instanceof ReleaseError && error.code === 'target');
    }
    const released = await releaser().release('progetto', { ...base, conversationId: part.id });
    assert.equal(released.conversationId, part.id);
  });

  it('checks one password at a time: requests in parallel do not get around the lock', async () => {
    let checks = 0;
    const release = releaser({
      checkPassword: async () => {
        checks += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'wrong';
      },
    });
    const input = { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, conversationId: work, password: 'sbagliata' };
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => release.release('progetto', input)));
    const codes = outcomes.map((outcome) => (outcome.status === 'rejected' && outcome.reason instanceof ReleaseError ? outcome.reason.code : 'other'));
    assert.equal(checks, 1);
    assert.deepEqual(codes.toSorted(), ['busy', 'busy', 'busy', 'busy', 'busy', 'wrong-password']);
  });

  it('answers over HTTP with the fields it allows and the code of a refusal in front', async () => {
    const live = await startLiveFeed(db().sql);
    const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0, projectContainers: () => [box, other], noteRelease: releaser() });
    const origin = `http://127.0.0.1:${String(server.port)}`;
    const call = (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }), ...(method === 'GET' ? {} : { origin }) };
      return new Promise((resolve, reject) => {
        const request = httpRequest(`${origin}${path}`, { method, agent: false, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
          });
        });
        request.on('error', reject);
        if (payload !== undefined) request.write(payload);
        request.end();
      });
    };
    try {
      const listed = await call('GET', '/api/browse/progetto/knowledge/release');
      assert.equal(listed.status, 200);
      assert.ok((listed.body.targets as { id: string }[]).some((target) => target.id === work));
      assert.equal((await call('GET', '/api/browse/sconosciuto/knowledge/release')).status, 404);
      const proposal = await call('POST', '/api/browse/progetto/knowledge/anonymize', { path: 'documenti/fattura.md' });
      assert.deepEqual(proposal.body, { text: ANONYMOUS, model: 'stub-model', version: version('documenti/fattura.md'), warnings: [] });
      assert.equal((await call('POST', '/api/browse/progetto/knowledge/anonymize', { path: 'documenti/fattura.md', label: 'L0' })).status, 400);
      const input = { path: 'documenti/fattura.md', version: version('documenti/fattura.md'), text: ANONYMOUS, conversationId: work };
      assert.equal((await call('POST', '/api/browse/progetto/knowledge/release', input)).status, 400);
      const wrong = await call('POST', '/api/browse/progetto/knowledge/release', { ...input, password: 'sbagliata' });
      assert.equal(wrong.status, 403);
      assert.match(String(wrong.body.error), /^wrong-password: /);
      assert.equal(JSON.stringify(wrong.body).includes('sbagliata'), false);
      const done = await call('POST', '/api/browse/progetto/knowledge/release', { ...input, password: 'giusta-e-lunga' });
      assert.equal(done.status, 201);
      assert.equal(done.body.conversationId, work);
    } finally {
      await server.close();
      await live.close();
    }
  });
});
