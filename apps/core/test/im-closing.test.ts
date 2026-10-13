// The IM between two meetings (D-167, tappa P4b): an item for the current or
// the next IM, the closing answers (done, in part, not done) carried to the
// next IM, the IM closed, the items of a card that arrived in "Fatto".
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import { addItemTo, cardStillOpen, closeImItem, currentIm, finishImClosing, ImError, listIms, markCardItems, readIm } from '../src/im.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `im-closing-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto-test');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const IM32 = '---\nim: 32\ndata: 2026-10-08 10:00\nstato: chiuso\n---\n\n## Lavori\n\n- [x] Pagamento — Parte 1\n';
const IM33 = [
  '---',
  'im: 33',
  'data: 2026-10-15 10:00',
  'chiamata: 2026-10-16 15:00',
  'stato: previsto',
  '---',
  '',
  '## Lavori',
  '',
  '- [/] Pagamento — Parte 2 #card-3f9a1c2e',
  '- [ ] Esportazione CSV',
  '- [ ] Fatture',
  '- [>] Tema scuro',
  '- [ ] Login #card-0a1b2c3d',
  '',
  '## Note',
  '',
].join('\n');

const PROJECTS: Project[] = [{ name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' }];
const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const ENV = { home: ARIANNA, rules: createLabelRules({ folders: [], sources: [] }) };
const P = 'progetto-test';

beforeEach(() => {
  rmSync(join(BOX, 'IM'), { recursive: true, force: true });
  // Fake data only.
  write(BOX, { 'IM/IM-32.md': IM32, 'IM/IM-33.md': IM33, 'parte/.git/HEAD': 'ref: refs/heads/main\n' });
});

const item = (number: number, title: string) => readIm(PROJECTS, P, ENV, number).items.find((candidate) => candidate.title === title);

describe('items between two meetings (D-167, P4b)', () => {
  it('the current IM is the first not closed whose meeting is not over, the moved call counting', () => {
    assert.equal(currentIm(PROJECTS, P, ENV, new Date(2026, 9, 14, 9, 0))?.number, 33);
    // After the date, before the moved call: still the current one.
    assert.equal(currentIm(PROJECTS, P, ENV, new Date(2026, 9, 15, 18, 0))?.number, 33);
    assert.equal(currentIm(PROJECTS, P, ENV, new Date(2026, 9, 16, 16, 0)), undefined);
  });

  it('"per il prossimo IM" creates the next IM seven days after the date, not after the call', () => {
    const im = addItemTo(PROJECTS, P, ENV, 'next', 'Fatture elettroniche', new Date(2026, 9, 14, 9, 0));
    assert.equal(im.number, 34);
    assert.equal(im.date, '2026-10-22 10:00');
    assert.deepEqual(im.items.map((entry) => entry.title), ['Fatture elettroniche']);
  });

  it('"per questo IM" adds to the current one; the same item twice is refused', () => {
    const im = addItemTo(PROJECTS, P, ENV, 'current', 'Pagina dei contratti', new Date(2026, 9, 14, 9, 0));
    assert.equal(im.number, 33);
    assert.ok(im.items.some((entry) => entry.title === 'Pagina dei contratti'));
    assert.throws(() => addItemTo(PROJECTS, P, ENV, 'current', 'pagina dei contratti', new Date(2026, 9, 14, 9, 0)), (error) => error instanceof ImError && error.code === 'invalid');
  });

  it('with every IM over, the item goes to a new IM after the last; without IM it is refused', () => {
    assert.equal(addItemTo(PROJECTS, P, ENV, 'next', 'Fatture', new Date(2026, 9, 20, 9, 0)).number, 34);
    rmSync(join(BOX, 'IM'), { recursive: true, force: true });
    assert.throws(() => addItemTo(PROJECTS, P, ENV, 'next', 'Fatture', new Date(2026, 9, 20, 9, 0)), (error) => error instanceof ImError && error.code === 'not-found');
  });

  it('closing: done, in part (Parte N+1 next), not done (postponed and copied), then the IM is closed', () => {
    const pagamento = item(33, 'Pagamento');
    const csv = item(33, 'Esportazione CSV');
    const fatture = item(33, 'Fatture');
    const login = item(33, 'Login');
    assert.ok(pagamento && csv && fatture && login);
    closeImItem(PROJECTS, P, ENV, 33, pagamento, 'part');
    closeImItem(PROJECTS, P, ENV, 33, csv, 'not-done');
    closeImItem(PROJECTS, P, ENV, 33, fatture, 'done');
    assert.equal(finishImClosing(PROJECTS, P, ENV, 33), false);
    closeImItem(PROJECTS, P, ENV, 33, login, 'done');
    assert.equal(finishImClosing(PROJECTS, P, ENV, 33), true);

    const closed = readIm(PROJECTS, P, ENV, 33);
    assert.equal(closed.status, 'chiuso');
    assert.deepEqual(closed.items.map((entry) => [entry.title, entry.state, entry.part]), [
      ['Pagamento', 'done', 2],
      ['Esportazione CSV', 'postponed', null],
      ['Fatture', 'done', null],
      ['Tema scuro', 'postponed', null],
      ['Login', 'done', null],
    ]);
    const next = readIm(PROJECTS, P, ENV, 34);
    assert.equal(next.date, '2026-10-22 10:00');
    assert.deepEqual(next.items.map((entry) => [entry.title, entry.state, entry.part, entry.card]), [
      ['Pagamento', 'todo', 3, '3f9a1c2e'],
      ['Esportazione CSV', 'todo', null, null],
      ['Tema scuro', 'todo', null, null],
    ]);
    // Only the touched lines changed in the closed IM.
    const text = readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8');
    assert.match(text, /chiamata: 2026-10-16 15:00\nstato: chiuso\n/);
    assert.match(text, /## Note\n/);
  });

  it('a first item without a part closed in part becomes Parte 1, and Parte 2 goes next', () => {
    closeImItem(PROJECTS, P, ENV, 33, item(33, 'Fatture') ?? assert.fail(), 'part');
    assert.equal(item(33, 'Fatture')?.part, 1);
    assert.equal(item(34, 'Fatture')?.part, 2);
  });

  it('an answer for an item changed by hand meanwhile is refused, nothing written', () => {
    const fatture = item(33, 'Fatture') ?? assert.fail();
    writeFileSync(join(BOX, 'IM', 'IM-33.md'), IM33.replace('- [ ] Fatture', '- [ ] Fatture del mese'));
    assert.throws(() => closeImItem(PROJECTS, P, ENV, 33, fatture, 'done'), (error) => error instanceof ImError && error.code === 'changed');
    assert.deepEqual(listIms(PROJECTS, P, ENV).map((im) => im.number), [32, 33]);
  });

  it('an item already done is not answered again', () => {
    const fatture = item(33, 'Fatture') ?? assert.fail();
    closeImItem(PROJECTS, P, ENV, 33, fatture, 'done');
    assert.throws(() => closeImItem(PROJECTS, P, ENV, 33, fatture, 'not-done'), (error) => error instanceof ImError && error.code === 'changed');
  });

  it('a private IM closed: its items carried raise the next IM to private, never an Interno file', () => {
    write(BOX, { 'IM/IM-33.md': IM33.replace('stato: previsto', 'stato: previsto\nlabel: L2') });
    closeImItem(PROJECTS, P, ENV, 33, item(33, 'Fatture') ?? assert.fail(), 'not-done');
    const next = readIm(PROJECTS, P, ENV, 34);
    assert.equal(next.label, 'L2');
    assert.match(readFileSync(join(BOX, 'IM', 'IM-34.md'), 'utf8'), /^---\nlabel: L2\nim: 34\n/);
  });

  it('an Interno IM closed into an existing private IM leaves it private', () => {
    write(BOX, { 'IM/IM-34.md': '---\nim: 34\nlabel: L2\ndata: 2026-10-22 10:00\nstato: previsto\n---\n\n## Lavori\n' });
    closeImItem(PROJECTS, P, ENV, 33, item(33, 'Fatture') ?? assert.fail(), 'not-done');
    assert.equal(readIm(PROJECTS, P, ENV, 34).label, 'L2');
  });

  it('in part: the next part keeps the card, which stays open while that part is', () => {
    closeImItem(PROJECTS, P, ENV, 33, item(33, 'Pagamento') ?? assert.fail(), 'part');
    assert.equal(cardStillOpen(PROJECTS, P, ENV, '3f9a1c2e'), true);
    assert.equal(cardStillOpen(PROJECTS, P, ENV, 'ffffffff'), false);
  });

  it('the IM after an old one is never in the past', () => {
    const late = new Date(2026, 11, 1, 9, 0);
    for (const title of ['Pagamento', 'Esportazione CSV', 'Fatture', 'Login']) closeImItem(PROJECTS, P, ENV, 33, item(33, title) ?? assert.fail(), 'done', late);
    assert.equal(finishImClosing(PROJECTS, P, ENV, 33, late), true);
    // Seven-day steps from 15 October: the first not over on 1 December is 3 December.
    assert.equal(readIm(PROJECTS, P, ENV, 34).date, '2026-12-03 10:00');
  });

  it('closing with nothing postponed still makes the next IM', () => {
    for (const title of ['Pagamento', 'Esportazione CSV', 'Fatture', 'Login']) closeImItem(PROJECTS, P, ENV, 33, item(33, title) ?? assert.fail(), 'done');
    write(BOX, { 'IM/IM-33.md': readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8').replace('- [>] Tema scuro', '- [-] Tema scuro') });
    assert.equal(finishImClosing(PROJECTS, P, ENV, 33, new Date(2026, 9, 16, 16, 0)), true);
    assert.deepEqual(readIm(PROJECTS, P, ENV, 34).items, []);
  });

  it('a card in "Fatto" checks its items in the IM not closed only', () => {
    write(BOX, { 'IM/IM-32.md': IM32.replace('stato: chiuso', 'stato: chiuso') + '- [ ] Vecchia #card-3f9a1c2e\n' });
    assert.deepEqual(markCardItems(PROJECTS, P, ENV, '3f9a1c2e'), [33]);
    assert.equal(item(33, 'Pagamento')?.state, 'done');
    assert.equal(item(33, 'Login')?.state, 'todo');
    assert.equal(item(32, 'Vecchia')?.state, 'todo');
    assert.deepEqual(markCardItems(PROJECTS, P, ENV, '3f9a1c2e'), []);
    assert.deepEqual(markCardItems(PROJECTS, P, ENV, 'not-hex!'), []);
  });
});
