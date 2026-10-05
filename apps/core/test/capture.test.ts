import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import { createContext, type LabelRules } from '@arianna/policy';

import { CaptureError, captureNote, checkCaptureUrl, localTimestamp, MAX_CAPTURE_BYTES, slugOf, type CaptureInput } from '../src/capture.ts';
import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { createKb, parsePage } from '../src/orchestrator/kb.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// No rule for kb/inbox: L2 by default-deny, as in config/labels.toml.
const RULES = parseLabelRules(`
[[folder]]
path = "kb/work"
label = "L1"
`);
const NOW = new Date(2026, 9, 5, 8, 12, 44);

function home(): string {
  const dir = join(scratch, randomUUID());
  mkdirSync(join(dir, 'kb'), { recursive: true });
  return dir;
}

function capture(dir: string, extra: Partial<CaptureInput> = {}): { path: string; label: string } {
  return captureNote({ home: dir, rules: RULES, text: 'Comprare il pane', kind: 'thought', source: { channel: 'cli', id: 'test' }, now: NOW, ...extra });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CaptureError) return error.code;
    throw error;
  }
  return 'ok';
}

describe('captureNote', () => {
  it('writes a new L2 note under kb/inbox, header from the code, text in the body', () => {
    const dir = home();
    const note = capture(dir, { url: 'https://example.org/a?b=1', title: 'Pane: "integrale" # forno', kind: 'link' });
    assert.equal(note.path, 'kb/inbox/2026-10-05-081244-pane-integrale-forno.md');
    assert.equal(note.label, 'L2');
    const text = readFileSync(join(dir, note.path), 'utf8');
    assert.equal(
      text,
      [
        '---',
        'label: L2',
        'source: capture:cli:test',
        `captured_at: ${localTimestamp(NOW)}`,
        'kind: link',
        'status: new',
        'url: https://example.org/a?b=1',
        'title: "Pane: \\"integrale\\" # forno"',
        '---',
        '',
        'Comprare il pane',
        '',
      ].join('\n'),
    );
    assert.equal(statSync(join(dir, note.path)).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'kb/inbox')).mode & 0o777, 0o700);
  });

  it('stays L2 when the capture comes from a work conversation (L1)', () => {
    const dir = home();
    assert.equal(capture(dir, { from: 'L1' }).label, 'L2');
    assert.equal(capture(dir, { from: 'L0' }).label, 'L2');
  });

  it('is refused when a folder rule labels kb/inbox L3, and passes with an L2 rule', () => {
    const l3: LabelRules = parseLabelRules('[[folder]]\npath = "kb/inbox"\nlabel = "L3"\n');
    const l2: LabelRules = parseLabelRules('[[folder]]\npath = "kb/inbox"\nlabel = "L2"\n');
    const dir = home();
    assert.equal(code(() => capture(dir, { rules: l3 })), 'not-allowed');
    assert.equal(existsSync(join(dir, 'kb/inbox')), false);
    assert.equal(code(() => capture(dir, { rules: l2 })), 'ok');
  });

  it('two captures in the same second give two files, never an overwrite', () => {
    const dir = home();
    const first = capture(dir);
    const second = capture(dir);
    assert.notEqual(first.path, second.path);
    assert.equal(second.path, 'kb/inbox/2026-10-05-081244-comprare-il-pane-2.md');
    assert.equal(readdirSync(join(dir, 'kb/inbox')).length, 2);
  });

  it('leaves an existing file with the same name untouched', () => {
    const dir = home();
    mkdirSync(join(dir, 'kb/inbox'));
    const existing = join(dir, 'kb/inbox/2026-10-05-081244-comprare-il-pane.md');
    writeFileSync(existing, 'mine');
    const note = capture(dir);
    assert.equal(readFileSync(existing, 'utf8'), 'mine');
    assert.notEqual(note.path, 'kb/inbox/2026-10-05-081244-comprare-il-pane.md');
  });

  it('refuses a link in place of kb/inbox, accepts a real folder', () => {
    const dir = home();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'kb/inbox'));
    assert.equal(code(() => capture(dir)), 'unavailable');
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal(code(() => capture(home())), 'ok');
  });

  it('refuses without a kb/ folder, and never follows a link in place of kb/', () => {
    const dir = join(scratch, randomUUID());
    mkdirSync(dir);
    assert.equal(code(() => capture(dir)), 'unavailable');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'kb'));
    assert.equal(code(() => capture(dir)), 'unavailable');
    assert.deepEqual(readdirSync(elsewhere), []);
  });

  it('never writes through a link in place of the note', () => {
    const dir = home();
    mkdirSync(join(dir, 'kb/inbox'));
    const target = join(dir, 'target.md');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(dir, 'kb/inbox/2026-10-05-081244-comprare-il-pane.md'));
    const note = capture(dir);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    assert.equal(lstatSync(join(dir, note.path)).isFile(), true);
  });

  it('a header in the text does not lower the label: it stays in the body', () => {
    const dir = home();
    const note = capture(dir, { text: '---\nlabel: L0\n---\nnon privato' });
    const page = parsePage(readFileSync(join(dir, note.path), 'utf8'));
    assert.deepEqual(page.header.labels, ['L2']);
    assert.match(page.body, /^---\nlabel: L0\n---\nnon privato/);
    // And the KB reads the note as L2.
    assert.equal(createKb({ home: dir, rules: RULES }).read(note.path, createContext('L2', 'L2')).label, 'L2');
  });

  it('accepts only http(s) URLs', () => {
    assert.equal(checkCaptureUrl('https://example.org'), 'https://example.org/');
    assert.equal(checkCaptureUrl('http://example.org/x'), 'http://example.org/x');
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.org', 'non un url', 'https://a.example/\nlabel: L0']) {
      assert.equal(code(() => checkCaptureUrl(url)), 'invalid', url);
    }
    assert.equal(code(() => capture(home(), { url: 'javascript:alert(1)' })), 'invalid');
    assert.equal(code(() => capture(home(), { kind: 'link' })), 'invalid');
  });

  it('refuses a text over the limit and an empty one, accepts one at the limit', () => {
    assert.equal(code(() => capture(home(), { text: 'a'.repeat(MAX_CAPTURE_BYTES + 1) })), 'too-large');
    assert.equal(code(() => capture(home(), { text: ' \n ' })), 'invalid');
    assert.equal(code(() => capture(home(), { text: 'a'.repeat(MAX_CAPTURE_BYTES) })), 'ok');
  });

  it('refuses a title on more than one line, which would reach the header', () => {
    assert.equal(code(() => capture(home(), { title: 'a\nlabel: L0' })), 'invalid');
    assert.equal(code(() => capture(home(), { title: 'a label: L0' })), 'invalid');
    assert.equal(code(() => capture(home(), { title: 'a label: L0' })), 'invalid');
    assert.equal(code(() => capture(home(), { title: 'una riga' })), 'ok');
  });

  it('a title is read back without the quotes it is written with', () => {
    const dir = home();
    const note = capture(dir, { title: 'Pane: "integrale" # forno' });
    assert.equal(parsePage(readFileSync(join(dir, note.path), 'utf8')).header.title, 'Pane: "integrale" # forno');
    assert.equal(createKb({ home: dir, rules: RULES }).read(note.path, createContext('L2', 'L2')).title, 'Pane: "integrale" # forno');
  });

  it('an url or a title saying "label" keeps the note L2, not L3', () => {
    const dir = home();
    const note = capture(dir, { kind: 'link', url: 'https://x.it/label?label=L0', title: 'label: L0' });
    const page = parsePage(readFileSync(join(dir, note.path), 'utf8'));
    assert.deepEqual(page.header.labels, ['L2']);
    assert.equal(createKb({ home: dir, rules: RULES }).read(note.path, createContext('L2', 'L2')).label, 'L2');
  });

  it('refuses an unknown kind or source', () => {
    assert.equal(code(() => capture(home(), { kind: 'pdf' as 'note' })), 'invalid');
    assert.equal(code(() => capture(home(), { source: { channel: 'cli', id: 'x\nlabel: L0' } })), 'invalid');
  });

  it('names the file with an ASCII slug', () => {
    assert.equal(slugOf("Càparra dell'affitto!"), 'caparra-dell-affitto');
    assert.equal(slugOf('日本語'), 'nota');
    assert.equal(slugOf('a'.repeat(100)).length, 40);
  });

  it('kb.search finds the note with clearance L2, not with L1', () => {
    const dir = home();
    capture(dir, { text: 'Idea: ombrellone per il balcone' });
    const kb = createKb({ home: dir, rules: RULES });
    assert.equal(kb.search('ombrellone', createContext('L2', 'L2')).hits.length, 1);
    const work = kb.search('ombrellone', createContext('L1', 'L1'));
    assert.equal(work.hits.length, 0);
    assert.equal(work.skippedAbove, true);
  });
});

describe('POST /api/capture', () => {
  const dir = join(scratch, 'server-home');
  let server: ApiServer;
  let origin: string;

  before(async () => {
    mkdirSync(join(dir, 'kb'), { recursive: true });
    server = await startApiServer({
      // Unused by this route.
      sql: undefined as unknown as Sql,
      live: undefined as unknown as LiveFeed,
      host: '127.0.0.1',
      port: 0,
      capture: { home: dir, rules: RULES },
    });
    origin = `http://127.0.0.1:${String(server.port)}`;
  });
  after(async () => {
    await server.close();
  });

  const post = (body: unknown) =>
    fetch(`${origin}/api/capture`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });

  it('saves a note and answers with path and label, never the text', async () => {
    const response = await post({ text: 'Segreto da ricordare', kind: 'note' });
    assert.equal(response.status, 201);
    const raw = await response.text();
    assert.doesNotMatch(raw, /Segreto/);
    const body = JSON.parse(raw) as { path: string; label: string };
    assert.equal(body.label, 'L2');
    assert.match(body.path, /^kb\/inbox\/\d{4}-\d{2}-\d{2}-\d{6}-segreto-da-ricordare(-\d+)?\.md$/);
    const page = parsePage(readFileSync(join(dir, body.path), 'utf8'));
    assert.deepEqual(page.header.labels, ['L2']);
    assert.match(page.header.source ?? '', /^capture:hud:[0-9a-f-]{36}$/);
  });

  it('takes the label of the message saved (D-084): it only raises the note, L3 is refused', async () => {
    const work = await post({ text: 'Dal Coder', kind: 'note', title: 'Dal Coder', from: 'L1' });
    assert.equal(work.status, 201);
    const saved = (await work.json()) as { path: string; label: string };
    assert.equal(saved.label, 'L2');
    assert.deepEqual(parsePage(readFileSync(join(dir, saved.path), 'utf8')).header.labels, ['L2']);
    const before = readdirSync(join(dir, 'kb', 'inbox')).length;
    const secret = await post({ text: 'Molto riservato', kind: 'note', from: 'L3' });
    assert.equal(secret.status, 403);
    assert.doesNotMatch(await secret.text(), /riservato/);
    for (const from of ['L9', 3, null]) assert.equal((await post({ text: 'x', from })).status, 400, String(from));
    assert.equal(readdirSync(join(dir, 'kb', 'inbox')).length, before);
  });

  it('saves a link with its url', async () => {
    const response = await post({ text: 'https://example.org/', kind: 'link', url: 'https://example.org/' });
    assert.equal(response.status, 201);
  });

  it('refuses a body without text, an unknown kind, an unknown field and a non-http url', async () => {
    for (const body of [{}, { text: 42 }, { text: 'x', kind: 'pdf' }, { text: 'x', label: 'L0' }, { text: 'x', url: 'file:///etc/passwd' }, { text: '   ' }]) {
      const response = await post(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.doesNotMatch(await response.text(), /etc\/passwd/);
    }
  });

  it('refuses a text over the limit', async () => {
    const response = await post({ text: 'a'.repeat(MAX_CAPTURE_BYTES + 1) });
    assert.equal(response.status, 413);
    // Past the body limit too: the same message, which the chat shows as "La nota supera 64 KiB".
    const huge = await post({ text: '"'.repeat(2 * MAX_CAPTURE_BYTES) });
    assert.equal(huge.status, 413);
    assert.deepEqual(await huge.json(), { error: 'text is longer than 64 KiB' });
  });

  it('accepts a text at the limit even when JSON doubles it', async () => {
    const response = await post({ text: '"'.repeat(MAX_CAPTURE_BYTES) });
    assert.equal(response.status, 201);
  });
});
