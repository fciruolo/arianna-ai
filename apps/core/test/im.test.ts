// The IM of a project (D-167, tappa P4a): the files IM-<n>.md of the folder
// IM, listed with their counts, changed only while the file is the one the
// user saw, the next IM seven days later, never through a link.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import { addImItem, createIm, ImError, listIms, readIm, setImItemState } from '../src/im.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `im-${randomUUID()}`);
const BOX = join(HOME, 'repos', 'progetto-test');
const EMPTY = join(HOME, 'repos', 'vuoto');
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const IM32 = '---\nim: 32\ndata: 2026-10-08 10:00\nstato: chiuso\n---\n\n# IM-32\n\n## Lavori\n\n- [x] Pagamento — Parte 1\n- [>] Esportazione CSV\n- [-] Tema scuro\n\n## Report\n\nFatto il pagamento.\n';
const IM33 = '---\nim: 33\ndata: 2026-10-15 10:00\nchiamata: 2026-10-16 10:00\nstato: previsto\n---\n\n# IM-33\n\n## Lavori\n\n- [/] Pagamento — Parte 2\n- [ ] Fatture\n\n## Note\n\nLibere.\n';
// Fake data only.
write(BOX, {
  'IM/IM-32.md': IM32,
  'IM/IM-33.md': IM33,
  'IM/riunione-di-avvio.md': '# Non è un IM\n',
  'IM/IM-034.md': '---\nim: 34\n---\n',
  'progetto-test-admin/.git/HEAD': 'ref: refs/heads/main\n',
});
write(EMPTY, { 'parte/.git/HEAD': 'ref: refs/heads/main\n', 'Workplan/piano.md': '# Piano\n' });
const OUTSIDE = join(HOME, 'fuori');
write(OUTSIDE, { 'IM-40.md': '---\nim: 40\ndata: 2026-11-12 10:00\n---\n\n## Lavori\n\n- [ ] Fuori dal progetto\n' });
symlinkSync(join(OUTSIDE, 'IM-40.md'), join(BOX, 'IM', 'IM-40.md'));

const PROJECTS: Project[] = [
  { name: 'progetto-test', path: 'repos/progetto-test', absolute: BOX, label: 'L1' },
  { name: 'vuoto', path: 'repos/vuoto', absolute: EMPTY, label: 'L1' },
];
const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const ENV = { home: ARIANNA, rules: createLabelRules({ folders: [], sources: [] }) };

describe('IM of a project (D-167)', () => {
  it('lists the IM files by number with counts; other notes, zero-padded names and links are not IM', () => {
    const ims = listIms(PROJECTS, 'progetto-test', ENV);
    assert.deepEqual(
      ims.map(({ number, date, call, status, label, path }) => [number, date, call, status, label, path]),
      [
        [32, '2026-10-08 10:00', null, 'chiuso', 'L1', 'IM/IM-32.md'],
        [33, '2026-10-15 10:00', '2026-10-16 10:00', 'previsto', 'L1', 'IM/IM-33.md'],
      ],
    );
    assert.deepEqual(ims[0]?.counts, { todo: 0, doing: 0, done: 1, postponed: 1, cancelled: 1 });
  });

  it('a project without the folder IM has no IM, and no folder is created by reading', () => {
    assert.deepEqual(listIms(PROJECTS, 'vuoto', ENV), []);
    assert.equal(existsSync(join(EMPTY, 'IM')), false);
  });

  it('a header label raises the IM above its folder', () => {
    write(BOX, { 'IM/IM-50.md': '---\nim: 50\nlabel: L2\n---\n' });
    try {
      assert.equal(readIm(PROJECTS, 'progetto-test', ENV, 50).label, 'L2');
    } finally {
      rmSync(join(BOX, 'IM', 'IM-50.md'));
    }
  });

  it('a header that is not closed is L3, as in the tab Conoscenza', () => {
    write(BOX, { 'IM/IM-51.md': '---\nim: 51\nlabel: L2\n\n## Lavori\n- [ ] Voce\n' });
    try {
      assert.equal(readIm(PROJECTS, 'progetto-test', ENV, 51).label, 'L3');
    } finally {
      rmSync(join(BOX, 'IM', 'IM-51.md'));
    }
  });

  it('an IM too large is left out of the list, the others stay', () => {
    write(BOX, { 'IM/IM-52.md': `---\nim: 52\n---\n${'x'.repeat(200_001)}` });
    try {
      assert.deepEqual(listIms(PROJECTS, 'progetto-test', ENV).map((im) => im.number), [32, 33]);
      assert.throws(() => readIm(PROJECTS, 'progetto-test', ENV, 52), (error) => error instanceof ImError && error.code === 'refused');
    } finally {
      rmSync(join(BOX, 'IM', 'IM-52.md'));
    }
  });

  it('changes the state of one item when the version matches, and refuses a stale one', () => {
    const im = readIm(PROJECTS, 'progetto-test', ENV, 33);
    const fatture = im.items.find((item) => item.title === 'Fatture');
    assert.ok(fatture !== undefined);
    const changed = setImItemState(PROJECTS, 'progetto-test', ENV, 33, fatture.line, 'doing', im.version);
    assert.equal(changed.items.find((item) => item.title === 'Fatture')?.state, 'doing');
    assert.notEqual(changed.version, im.version);
    assert.equal(readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8'), IM33.replace('- [ ] Fatture', '- [/] Fatture'));
    assert.throws(() => setImItemState(PROJECTS, 'progetto-test', ENV, 33, fatture.line, 'done', im.version), (error) => error instanceof ImError && error.code === 'changed');
  });

  it('refuses a line that is not an item, without writing', () => {
    const im = readIm(PROJECTS, 'progetto-test', ENV, 33);
    const before = readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8');
    assert.throws(() => setImItemState(PROJECTS, 'progetto-test', ENV, 33, 1, 'done', im.version), (error) => error instanceof ImError && error.code === 'invalid');
    assert.equal(readFileSync(join(BOX, 'IM', 'IM-33.md'), 'utf8'), before);
  });

  it('adds an item, keeping the mode of the file', () => {
    const file = join(BOX, 'IM', 'IM-32.md');
    const mode = statSync(file).mode & 0o777;
    const im = readIm(PROJECTS, 'progetto-test', ENV, 32);
    const changed = addImItem(PROJECTS, 'progetto-test', ENV, 32, 'Fatture elettroniche', im.version);
    assert.equal(changed.items.at(-1)?.title, 'Fatture elettroniche');
    assert.equal(statSync(file).mode & 0o777, mode);
    assert.throws(() => addImItem(PROJECTS, 'progetto-test', ENV, 32, 'due\nrighe', changed.version), (error) => error instanceof ImError && error.code === 'invalid');
  });

  it('an IM that is a link is not found, not followed', () => {
    assert.throws(() => readIm(PROJECTS, 'progetto-test', ENV, 40), (error) => error instanceof ImError && error.code === 'not-found');
  });

  it('creates the next IM seven days after the last date, whatever the moved call', () => {
    const im = createIm(PROJECTS, 'progetto-test', ENV);
    assert.equal(im.number, 34);
    assert.equal(im.date, '2026-10-22 10:00');
    assert.equal(im.status, 'previsto');
    assert.deepEqual(im.items, []);
    assert.ok(existsSync(join(BOX, 'IM', 'IM-34.md')));
  });

  it('the first IM of a project needs its date, and creates the folder IM', () => {
    assert.throws(() => createIm(PROJECTS, 'vuoto', ENV), (error) => error instanceof ImError && error.code === 'invalid');
    assert.throws(() => createIm(PROJECTS, 'vuoto', ENV, '2026-13-01 10:00'), (error) => error instanceof ImError && error.code === 'invalid');
    const im = createIm(PROJECTS, 'vuoto', ENV, '2026-10-15 09:30');
    assert.equal(im.number, 1);
    assert.equal(im.path, 'IM/IM-1.md');
    assert.equal(listIms(PROJECTS, 'vuoto', ENV).length, 1);
  });
});
