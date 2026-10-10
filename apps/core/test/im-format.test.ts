// The format of an IM (D-167): header, items with the Obsidian Tasks
// checkboxes, `— Parte N` and `#card-<8 hex>`; changes touch only their lines.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addDays, addItem, dayAndTime, ImFormatError, imFileName, imNumberOf, isImDate, longDate, newImText, parseIm, reportOf, setItemState, setReport } from '../src/im-format.ts';

const IM32 = [
  '---',
  'im: 32',
  'data: 2026-10-08 10:00',
  'chiamata: 2026-10-09 15:30',
  'stato: chiuso',
  '---',
  '',
  '# IM-32 · giovedì 8 ottobre 2026, 10:00',
  '',
  '## Lavori',
  '',
  '- [x] Pagamento con carta — Parte 1 #card-3F9A1C2E',
  '- [/] Pagina dei contratti',
  '- [>] Esportazione degli ordini in CSV',
  '- [-] Tema scuro',
  '- [ ] Fatture',
  '- [?] Voce di un altro plugin',
  '',
  '## Report',
  '',
  '- [ ] non è una voce: è nel report',
  '',
  '## Note',
  '',
  'Appunti liberi.',
  '',
].join('\n');

describe('IM format (D-167)', () => {
  it('reads the header and the items with their states, parts and cards', () => {
    const im = parseIm(IM32);
    assert.equal(im.number, 32);
    assert.equal(im.date, '2026-10-08 10:00');
    assert.equal(im.call, '2026-10-09 15:30');
    assert.equal(im.status, 'chiuso');
    assert.deepEqual(
      im.items.map(({ state, title, part, card }) => [state, title, part, card]),
      [
        ['done', 'Pagamento con carta', 1, '3f9a1c2e'],
        ['doing', 'Pagina dei contratti', null, null],
        ['postponed', 'Esportazione degli ordini in CSV', null, null],
        ['cancelled', 'Tema scuro', null, null],
        ['todo', 'Fatture', null, null],
      ],
    );
    assert.equal(im.items[0]?.line, 12);
  });

  it('ignores checkboxes outside "## Lavori" and unknown marks', () => {
    const im = parseIm(IM32);
    assert.ok(!im.items.some((item) => item.title.includes('report') || item.title.includes('plugin')));
  });

  it('falls back on a missing or wrong header', () => {
    const im = parseIm('# solo testo\n\n## Lavori\n- [ ] Una voce\n');
    assert.equal(im.number, null);
    assert.equal(im.date, null);
    assert.equal(im.status, 'previsto');
    assert.equal(im.items.length, 1);
    assert.equal(parseIm('---\nim: zero\ndata: 2026-02-30 10:00\nstato: boh\n---\n').date, null);
  });

  it('keeps the line ends of a CRLF file: a change touches only its line', () => {
    const crlf = IM32.replace(/\n/g, '\r\n');
    const changed = setItemState(crlf, 13, 'done');
    assert.equal(changed, crlf.replace('- [/] Pagina dei contratti', '- [x] Pagina dei contratti'));
    const added = addItem(crlf, { title: 'Fatture elettroniche' });
    assert.ok(!/[^\r]\n/.test(added));
    assert.match(added, /- \[\?\] Voce di un altro plugin\r\n- \[ \] Fatture elettroniche\r\n\r\n## Report/);
  });

  it('a heading inside a code block does not close "## Lavori"', () => {
    const fence = '`'.repeat(3);
    const text = ['## Lavori', '', '- [ ] Uno', fence, '## non è una sezione', fence, '- [ ] Due', '', '## Note', ''].join('\n');
    assert.deepEqual(parseIm(text).items.map((item) => item.title), ['Uno', 'Due']);
    assert.match(addItem(text, { title: 'Tre' }), /- \[ \] Due\n- \[ \] Tre\n\n## Note/);
  });

  it('changes only the checkbox of one item', () => {
    const changed = setItemState(IM32, 13, 'done');
    const before = IM32.split('\n');
    const after = changed.split('\n');
    assert.equal(after[12], '- [x] Pagina dei contratti');
    assert.deepEqual(after.filter((_line, index) => index !== 12), before.filter((_line, index) => index !== 12));
    assert.equal(setItemState(IM32, 12, 'todo').split('\n')[11], '- [ ] Pagamento con carta — Parte 1 #card-3F9A1C2E');
  });

  it('refuses a line that is not an item', () => {
    assert.throws(() => setItemState(IM32, 8, 'done'), /no item/);
    assert.throws(() => setItemState(IM32, 21, 'done'), /no item/);
    assert.throws(() => setItemState(IM32, 17, 'done'), /no item/);
  });

  it('adds an item at the end of "## Lavori", before the blank line', () => {
    const changed = addItem(IM32, { title: 'Fatture elettroniche', part: 2, card: '0a1b2c3d' });
    const lines = changed.split('\n');
    assert.equal(lines[17], '- [ ] Fatture elettroniche — Parte 2 #card-0a1b2c3d');
    assert.equal(lines[18], '');
    assert.equal(lines[19], '## Report');
    assert.equal(parseIm(changed).items.at(-1)?.title, 'Fatture elettroniche');
  });

  it('adds the section when it is missing, before the other sections', () => {
    const changed = addItem('---\nim: 3\n---\n\n# IM-3\n\n## Note\n\nCiao\n', { title: 'Login' });
    assert.match(changed, /# IM-3\n\n## Lavori\n\n- \[ \] Login\n\n## Note/);
    assert.match(addItem('# IM-4\n', { title: 'Login' }), /# IM-4\n\n## Lavori\n\n- \[ \] Login\n$/);
  });

  it('adds the first item of an empty section', () => {
    const empty = newImText(33, '2026-10-15 10:00');
    const changed = addItem(empty, { title: 'Fatture' });
    assert.match(changed, /## Lavori\n\n- \[ \] Fatture\n\n## Report/);
  });

  it('a card is the first 8 hex digits of its id: a number stays in the title', () => {
    assert.deepEqual(parseIm('## Lavori\n- [ ] Login #card-41\n').items.map(({ title, card }) => [title, card]), [['Login #card-41', null]]);
    assert.throws(() => addItem(IM32, { title: 'Login', card: '41' }), /8 hex/);
  });

  it('refuses a title of more lines or empty', () => {
    assert.throws(() => addItem(IM32, { title: 'uno\ndue' }), /one line/);
    assert.throws(() => addItem(IM32, { title: '   ' }), /one line/);
  });

  it('writes a new IM that reads back', () => {
    const text = newImText(33, '2026-10-15 10:00', [{ title: 'Pagamento con carta', part: 2 }, { title: 'Fatture' }]);
    assert.match(text, /^---\nim: 33\ndata: 2026-10-15 10:00\nstato: previsto\n---\n\n# IM-33 · giovedì 15 ottobre 2026, 10:00\n/);
    const im = parseIm(text);
    assert.equal(im.number, 33);
    assert.deepEqual(im.items.map((item) => [item.title, item.part]), [['Pagamento con carta', 2], ['Fatture', null]]);
  });

  it('counts the next IM seven days after the date, across months and the time change', () => {
    assert.equal(addDays('2026-10-22 10:00', 7), '2026-10-29 10:00');
    assert.equal(addDays('2026-12-29 09:30', 7), '2027-01-05 09:30');
    assert.equal(longDate('2026-10-15 10:00'), 'giovedì 15 ottobre 2026, 10:00');
  });

  it('names the files by number', () => {
    assert.equal(imNumberOf('IM-32.md'), 32);
    assert.equal(imNumberOf('im-100.MD'), 100);
    assert.equal(imNumberOf('IM-032.md'), null);
    assert.equal(imNumberOf('IM-32 bis.md'), null);
    assert.equal(imFileName(7), 'IM-7.md');
    assert.ok(isImDate('2026-10-15 23:59'));
    assert.ok(!isImDate('2026-10-15 24:00'));
  });
});

describe('the section Report (D-167, P4c)', () => {
  const BASE = ['---', 'im: 33', 'data: 2026-10-15 10:00', 'stato: previsto', '---', '', '# IM-33', '', '## Lavori', '', '- [x] Fatture', '', '## Report', '', '## Note', '', '- Libere.', ''].join('\n');

  it('writes the report in the empty section, touching no other line, and reads it back', () => {
    const text = setReport(BASE, '### Fatto in questo IM\n\n- Le fatture finte.');
    assert.equal(reportOf(text), '### Fatto in questo IM\n\n- Le fatture finte.');
    assert.equal(parseIm(text).report, '### Fatto in questo IM\n\n- Le fatture finte.');
    const before = BASE.split('\n');
    const after = text.split('\n');
    assert.deepEqual(after.slice(0, 13), before.slice(0, 13));
    assert.deepEqual(after.slice(-4), ['## Note', '', '- Libere.', '']);
    assert.equal(reportOf(BASE), '');
  });

  it('replaces only the body of an existing report', () => {
    const once = setReport(BASE, 'Primo testo.');
    const twice = setReport(once, 'Secondo testo.');
    assert.equal(reportOf(twice), 'Secondo testo.');
    assert.equal(twice, setReport(BASE, 'Secondo testo.'));
    assert.equal(reportOf(setReport(twice, '')), '');
  });

  it('adds the section before ## Note when it is missing, or at the end', () => {
    const without = BASE.replace('## Report\n\n', '');
    const text = setReport(without, 'Il report.');
    assert.ok(text.includes('- [x] Fatture\n\n## Report\n\nIl report.\n\n## Note'));
    const bare = '---\nim: 1\n---\n\n## Lavori\n\n- [ ] Voce\n';
    assert.equal(setReport(bare, 'Fine.'), '---\nim: 1\n---\n\n## Lavori\n\n- [ ] Voce\n\n## Report\n\nFine.\n');
  });

  it('keeps CRLF line ends and a report section at the end of the file', () => {
    const crlf = BASE.replace('## Note\n\n- Libere.\n', '').replace(/\n/g, '\r\n');
    const text = setReport(crlf, 'Riga uno\nRiga due');
    assert.ok(!/[^\r]\n/.test(text), 'every line end is CRLF');
    assert.ok(text.endsWith('## Report\r\n\r\nRiga uno\r\nRiga due\r\n'));
    assert.equal(reportOf(text), 'Riga uno\nRiga due');
  });

  it('a heading inside a fence of the old report does not end the section', () => {
    const fenced = BASE.replace('## Report\n', '## Report\n\n```\n## non è una sezione\n```\n');
    assert.equal(reportOf(setReport(fenced, 'Nuovo.')), 'Nuovo.');
    assert.ok(setReport(fenced, 'Nuovo.').includes('## Note\n\n- Libere.'));
  });

  it('refuses a report with a heading of level 1 or 2 or a fence, which would break the file', () => {
    assert.throws(() => setReport(BASE, '## Note finte'), ImFormatError);
    assert.throws(() => setReport(BASE, '# Titolo'), ImFormatError);
    assert.throws(() => setReport(BASE, '```\ncodice\n```'), ImFormatError);
    assert.equal(reportOf(setReport(BASE, '### Va bene')), '### Va bene');
  });

  it('dayAndTime is the long date without the year', () => {
    assert.equal(dayAndTime('2026-10-15 10:00'), 'giovedì 15 ottobre, 10:00');
  });
});
