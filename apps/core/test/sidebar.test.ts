// The backend of the new left bar (D-089) that needs no database: folding and
// snippets of the search, messages saved once in kb/inbox, the source line
// kept by the organizer, and what the chat says about the installation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseConfig, parseLabelRules, resolveHome } from '@arianna/config';

import { captureNote, CaptureError } from '../src/capture.ts';
import { installationInfo, installationMode, readVersion } from '../src/installation.ts';
import { keptCaptureFields, listNotes } from '../src/notes.ts';
import { composeOrganized } from '../src/organize.ts';
import { AlreadySavedError, captureMessage, findSavedNote, savedMessageNotes } from '../src/saved-messages.ts';
import { checkQuery, foldText, likePattern, MAX_SNIPPET, SearchError, snippetAround } from '../src/search.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function home(): string {
  const dir = join(scratch, randomUUID());
  mkdirSync(join(dir, 'kb', 'inbox'), { recursive: true });
  return dir;
}

const RULES = parseLabelRules('');

describe('the query of the search', () => {
  it('folds case and the common accents one character for one', () => {
    assert.equal(foldText('Perché CAFFÈ Città'), 'perche caffe citta');
    const text = 'Già 🎉 Ünïcode';
    assert.equal(foldText(text).length, text.length);
  });

  it('is 2-200 characters on one line, else a fixed refusal that does not quote it', () => {
    assert.equal(checkQuery('  Caparra   Affitto '), 'caparra affitto');
    assert.equal(checkQuery('ab'), 'ab');
    for (const bad of ['', ' a ', 'x'.repeat(201), 'a\u0007b', 42, undefined]) {
      assert.throws(() => checkQuery(bad), (error: unknown) => error instanceof SearchError && !error.message.includes('a\u0007b'));
    }
  });

  it('takes %, _ and the backslash literally in the LIKE pattern', () => {
    assert.equal(likePattern('100%_x\\y'), '%100\\%\\_x\\\\y%');
    assert.equal(likePattern('ab'), '%ab%');
  });

  it('cuts a snippet of at most 160 characters around the first match, with its highlight', () => {
    const body = `${'a '.repeat(200)}la Caparra è di 500 euro${' b'.repeat(200)}`;
    const { snippet, highlight } = snippetAround(body, 'caparra');
    assert.ok(snippet.length <= MAX_SNIPPET);
    assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
    assert.ok(highlight !== null);
    assert.equal(snippet.slice(highlight.start, highlight.start + highlight.length), 'Caparra');
    const short = snippetAround('Una riga\n\ncon   spazi', 'spazi');
    assert.equal(short.snippet, 'Una riga con spazi');
    assert.deepEqual(snippetAround('niente', 'altro').highlight, null);
  });
});

describe('a message saved once in kb/inbox', () => {
  it('writes source: message:<id>, and a second save is refused with the name of the first note', () => {
    const dir = home();
    const first = captureMessage({ home: dir, rules: RULES, text: 'Risposta di Arianna', kind: 'note', messageId: '42' });
    const raw = readFileSync(join(dir, first.path), 'utf8');
    assert.match(raw, /^source: message:42$/m);
    assert.throws(
      () => captureMessage({ home: dir, rules: RULES, text: 'di nuovo', kind: 'note', messageId: '42' }),
      (error: unknown) => error instanceof AlreadySavedError && error.note === first.path.split('/').at(-1),
    );
    // Two saves back to back, as two requests would run them: one note only.
    const results = [0, 1].map(() => {
      try {
        return captureMessage({ home: dir, rules: RULES, text: 'gara', kind: 'note', messageId: '43' }).path;
      } catch (error) {
        return error instanceof AlreadySavedError ? 'refused' : 'other';
      }
    });
    assert.equal(results.filter((result) => result === 'refused').length, 1);
    assert.equal(readdirSync(join(dir, 'kb', 'inbox')).length, 2);
    assert.deepEqual([...savedMessageNotes(dir, RULES).keys()].sort(), ['42', '43']);
    assert.equal(savedMessageNotes(dir, RULES).get('42'), first.path.split('/').at(-1));
    // Another message, or a capture without one, is never taken for it.
    assert.equal(findSavedNote(dir, RULES, '4'), undefined);
    captureNote({ home: dir, rules: RULES, text: 'message:44 nel testo', kind: 'note', source: { channel: 'hud', id: 'x' } });
    assert.equal(findSavedNote(dir, RULES, '44'), undefined);
  });

  it('does not name a note above L2, and refuses an invalid id', () => {
    const dir = home();
    writeFileSync(join(dir, 'kb', 'inbox', '2026-10-05-segreta.md'), '---\nlabel: L3\nsource: message:7\n---\n\nsegreto\n');
    assert.throws(
      () => captureMessage({ home: dir, rules: RULES, text: 'x', kind: 'note', messageId: '7' }),
      (error: unknown) => error instanceof AlreadySavedError && error.note === null,
    );
    assert.throws(() => captureMessage({ home: dir, rules: RULES, text: 'x', kind: 'note', messageId: '0x1' }), CaptureError);
    // Saved, but not named; the listing still hides it.
    assert.deepEqual([...savedMessageNotes(dir, RULES)], [['7', null]]);
    assert.deepEqual(listNotes(dir, RULES, { limit: 10 }), { notes: [], hidden: 1 });
  });

  it('keeps the source line through the organizer, and only in the forms the code writes', () => {
    assert.equal(keptCaptureFields('---\nsource: message:42\n---\n').source, 'message:42');
    assert.equal(keptCaptureFields('---\nsource: capture:hud:abc\n---\n').source, 'capture:hud:abc');
    const dir = home();
    const saved = captureMessage({ home: dir, rules: RULES, text: 'Da riordinare', kind: 'note', messageId: '42' });
    const fields = { title: 'T', summary: 'S.', context: 'C.', tags: ['x'], kind: 'promemoria' as const };
    const { content } = composeOrganized({ raw: readFileSync(join(dir, saved.path), 'utf8'), label: 'L2', fields, related: [], model: 'local-large', now: new Date() });
    assert.match(content, /^source: message:42$/m);
    for (const bad of ['message:', 'message:0', 'message:12a', 'message:1 2', 'messages:1']) {
      assert.equal(keptCaptureFields(`---\nsource: ${bad}\n---\n`).source, undefined);
    }
  });
});

describe('the installation', () => {
  it('is development with the development passwords or the key, production only with neither', () => {
    assert.equal(installationMode(true, undefined), 'development');
    assert.equal(installationMode(true, 'production'), 'development');
    assert.equal(installationMode(false, 'development'), 'development');
    assert.equal(installationMode(false, undefined), 'production');
    assert.equal(installationMode(false, 'production'), 'production');
  });

  it('reads the short commit from .git without running git, and null when it cannot', () => {
    const sha = 'a'.repeat(40);
    const loose = join(scratch, randomUUID(), 'arianna-prod');
    mkdirSync(join(loose, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(loose, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(loose, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
    assert.deepEqual(installationInfo(loose, false, undefined), { mode: 'production', home: 'arianna-prod', version: 'aaaaaaa' });

    const packed = join(scratch, randomUUID());
    mkdirSync(join(packed, '.git'), { recursive: true });
    writeFileSync(join(packed, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(packed, '.git', 'packed-refs'), `# pack-refs\n${'b'.repeat(40)} refs/heads/main\n`);
    assert.equal(readVersion(packed), 'bbbbbbb');

    const detached = join(scratch, randomUUID());
    mkdirSync(join(detached, '.git'), { recursive: true });
    writeFileSync(join(detached, '.git', 'HEAD'), `${'c'.repeat(40)}\n`);
    assert.equal(readVersion(detached), 'ccccccc');

    const escaping = join(scratch, randomUUID());
    mkdirSync(join(escaping, '.git'), { recursive: true });
    writeFileSync(join(escaping, '.git', 'HEAD'), 'ref: refs/heads/../../secret\n');
    assert.equal(readVersion(escaping), null);
    assert.equal(readVersion(join(scratch, randomUUID())), null);
  });

  it('[installation] mode takes development or production only', () => {
    const base = '[paths]\ndata = "data"\n[database]\nhost = "127.0.0.1"\nport = 5432\nname = "a"\nuser = "arianna"\n';
    assert.equal(parseConfig(base, '/x').installation, undefined);
    assert.deepEqual(parseConfig(`${base}[installation]\nmode = "development"\n`, '/x').installation, { mode: 'development' });
    assert.throws(() => parseConfig(`${base}[installation]\nmode = "staging"\n`, '/x'), /installation\.mode/);
    assert.throws(() => parseConfig(`${base}[installation]\nother = 1\n`, '/x'), /unknown key/);
  });
});
