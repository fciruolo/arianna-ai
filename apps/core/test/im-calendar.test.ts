// The calendar of the IM (D-167 punto 3, P4d, D-169): the file calendario.md
// of the folder IM read and written by code, only its three fields changed,
// and the date of every new IM taken from it (seven days after the last one
// without it).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';
import { createLabelRules } from '@arianna/policy';

import { afterEnd, firstCalendarDate, ImCalendarError, newCalendarText, nextCalendarDate, parseCalendar, setCalendar, setEnd, weekdayOf } from '../src/im-calendar.ts';
import { addItemTo, closeImItem, createIm, finishImClosing, ImError, isLastIm, listIms, nextImPlan, readIm, readImCalendar, writeImCalendar, writeImEnd } from '../src/im.ts';

const THURSDAY_10 = { weekday: 4, time: '10:00', every: 1 };

describe('the calendar file', () => {
  it('reads the weekday with or without the accent, the time and every how many weeks', () => {
    assert.equal(weekdayOf('Lunedi'), 1);
    assert.equal(weekdayOf('GIOVEDÌ'), 4);
    assert.equal(weekdayOf('thursday'), null);
    assert.deepEqual(parseCalendar('---\ngiorno: giovedì\nora: "10:00"\nogni: 2\n---\n').calendar, { weekday: 4, time: '10:00', every: 2 });
    // "ogni" left out: every week.
    assert.deepEqual(parseCalendar('---\ngiorno: lunedì\nora: 15:30\n---\n').calendar, { weekday: 1, time: '15:30', every: 1 });
  });

  it('says which field is wrong', () => {
    assert.equal(parseCalendar('# Calendario\n').issue, 'intestazione');
    assert.equal(parseCalendar('---\ngiorno: festa\nora: 10:00\n---\n').issue, 'giorno');
    assert.equal(parseCalendar('---\ngiorno: lunedì\nora: 25:00\n---\n').issue, 'ora');
    assert.equal(parseCalendar('---\ngiorno: lunedì\nora: 10:00\nogni: 0\n---\n').issue, 'ogni');
    assert.equal(parseCalendar('---\ngiorno: lunedì\nora: 10:00\nogni: 13\n---\n').issue, 'ogni');
  });

  it('writes only its three fields, keeping the other lines and the line ends', () => {
    const text = '---\r\nlabel: L2\r\ngiorno: lunedì\r\nora: 09:00\r\n---\r\n\r\nNote a mano.\r\n';
    const changed = setCalendar(text, { weekday: 5, time: '11:30', every: 2 });
    assert.equal(changed, '---\r\ngiorno: venerdì\r\nora: 11:30\r\nogni: 2\r\nlabel: L2\r\n---\r\n\r\nNote a mano.\r\n');
    assert.deepEqual(parseCalendar(newCalendarText(THURSDAY_10)).calendar, THURSDAY_10);
    // A file without header gets one on top.
    assert.ok(setCalendar('Solo testo\n', THURSDAY_10).startsWith('---\ngiorno: giovedì\nora: 10:00\nogni: 1\n---\n\nSolo testo'));
    assert.throws(() => setCalendar('', { weekday: 7, time: '10:00', every: 1 }), ImCalendarError);
    assert.throws(() => newCalendarText({ weekday: 1, time: '9:00', every: 1 }), ImCalendarError);
  });
});

describe('the date of the next IM', () => {
  it('is the weekday of the calendar `every` weeks later, at its time', () => {
    assert.equal(nextCalendarDate('2026-10-15 10:00', THURSDAY_10), '2026-10-22 10:00');
    assert.equal(nextCalendarDate('2026-10-15 10:00', { ...THURSDAY_10, every: 2 }), '2026-10-29 10:00');
    // Thursday to Monday at 15:00: the Monday of the next week.
    assert.equal(nextCalendarDate('2026-10-15 10:00', { weekday: 1, time: '15:00', every: 1 }), '2026-10-19 15:00');
    assert.equal(nextCalendarDate('2026-10-15 10:00', { weekday: 1, time: '15:00', every: 2 }), '2026-10-26 15:00');
    // Monday to Tuesday or Sunday: the day of the next week, never the same week.
    assert.equal(nextCalendarDate('2026-10-12 10:00', { weekday: 2, time: '10:00', every: 1 }), '2026-10-20 10:00');
    assert.equal(nextCalendarDate('2026-10-12 10:00', { weekday: 0, time: '10:00', every: 2 }), '2026-11-01 10:00');
    // Across the end of the year.
    assert.equal(nextCalendarDate('2026-12-31 10:00', THURSDAY_10), '2027-01-07 10:00');
  });

  it('for the first IM, the first meeting not over yet', () => {
    // Saturday 10 October 2026.
    assert.equal(firstCalendarDate('2026-10-10 12:00', THURSDAY_10), '2026-10-15 10:00');
    assert.equal(firstCalendarDate('2026-10-15 09:00', THURSDAY_10), '2026-10-15 10:00');
    assert.equal(firstCalendarDate('2026-10-15 10:30', THURSDAY_10), '2026-10-22 10:00');
  });
});

const HOME = join(resolveHome({}), 'data', 'test-tmp', `im-calendar-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function container(name: string, files: Record<string, string>): Project {
  const root = join(HOME, 'repos', name);
  // Fake data only.
  for (const [path, content] of Object.entries({ ...files, 'parte/.git/HEAD': 'ref: refs/heads/main\n' })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { name, path: `repos/${name}`, absolute: root, label: 'L1' };
}

const ARIANNA = join(HOME, 'arianna');
mkdirSync(join(ARIANNA, 'kb'), { recursive: true });
const ENV = { home: ARIANNA, rules: createLabelRules({ folders: [], sources: [] }) };
const IM = (number: number, date: string): string => `---\nim: ${String(number)}\ndata: ${date}\nstato: chiuso\n---\n\n## Lavori\n\n`;

describe('the calendar of a project', () => {
  it('is written in IM/calendario.md and gives the date of the next IM', () => {
    const project = container('alfa', { 'IM/IM-1.md': IM(1, '2026-10-15 10:00') });
    const projects = [project];
    const empty = readImCalendar(projects, 'alfa', ENV);
    assert.deepEqual([empty.calendar, empty.exists, empty.version], [null, false, '']);
    const written = writeImCalendar(projects, 'alfa', ENV, { weekday: 1, time: '15:00', every: 2 }, '');
    assert.deepEqual(written.calendar, { weekday: 1, time: '15:00', every: 2 });
    assert.equal(written.path, 'IM/calendario.md');
    assert.match(readFileSync(join(project.absolute, 'IM', 'calendario.md'), 'utf8'), /^---\ngiorno: lunedì\nora: 15:00\nogni: 2\n---/);
    // Written again only from the version the page saw.
    assert.throws(() => writeImCalendar(projects, 'alfa', ENV, THURSDAY_10, ''), (error) => error instanceof ImError && error.code === 'changed');
    assert.throws(() => writeImCalendar(projects, 'alfa', ENV, { ...THURSDAY_10, every: 0 }, written.version), (error) => error instanceof ImError && error.code === 'invalid');
    assert.equal(createIm(projects, 'alfa', ENV).date, '2026-10-26 15:00');
  });

  it('wrong or missing, the next IM is seven days after the last one', () => {
    const projects = [container('beta', { 'IM/IM-1.md': IM(1, '2026-10-15 10:00'), 'IM/calendario.md': '---\ngiorno: festa\nora: 10:00\n---\n' })];
    const view = readImCalendar(projects, 'beta', ENV);
    assert.deepEqual([view.calendar, view.issue, view.exists], [null, 'giorno', true]);
    assert.equal(createIm(projects, 'beta', ENV).date, '2026-10-22 10:00');
  });

  it('gives the date of the first IM, and skips the meetings already over', () => {
    const projects = [container('gamma', { 'IM/calendario.md': newCalendarText(THURSDAY_10) })];
    assert.equal(createIm(projects, 'gamma', ENV, undefined, new Date(2026, 9, 10, 12, 0)).date, '2026-10-15 10:00');
    const late = [container('delta', { 'IM/IM-1.md': IM(1, '2026-09-03 10:00'), 'IM/calendario.md': newCalendarText({ ...THURSDAY_10, every: 2 }) })];
    // Two weeks at a time from the last IM, to the first meeting not over.
    assert.equal(createIm(late, 'delta', ENV, undefined, new Date(2026, 9, 10, 12, 0)).date, '2026-10-15 10:00');
  });
});

describe('the last day of the IM (fine, D-169)', () => {
  it('is read with or without a calendar, and a wrong one is said', () => {
    assert.deepEqual(parseCalendar('---\nfine: 2026-12-03\n---\n'), { calendar: null, issue: null, end: '2026-12-03' });
    assert.deepEqual(parseCalendar('---\ngiorno: giovedì\nora: 10:00\nfine: 2026-12-03\n---\n'), { calendar: THURSDAY_10, issue: null, end: '2026-12-03' });
    assert.deepEqual(parseCalendar('---\ngiorno: giovedì\nora: 10:00\nfine: 2026-02-30\n---\n'), { calendar: THURSDAY_10, issue: 'fine', end: null });
    assert.equal(afterEnd('2026-12-03 10:00', '2026-12-03'), false);
    assert.equal(afterEnd('2026-12-10 10:00', '2026-12-03'), true);
    assert.equal(afterEnd('2026-12-10 10:00', null), false);
  });

  it('is written and taken away, the rest of the file as it was', () => {
    const text = newCalendarText(THURSDAY_10);
    const ended = setEnd(text, '2026-12-03');
    assert.deepEqual(parseCalendar(ended), { calendar: THURSDAY_10, issue: null, end: '2026-12-03' });
    assert.equal(setEnd(ended, null), text);
    assert.equal(setEnd('', '2026-12-03'), '---\nfine: 2026-12-03\n---\n');
    assert.throws(() => setEnd(text, '3 dicembre'), ImCalendarError);
  });

  it('stops new IM after it; the last IM closes without a next one, its open items cancelled', () => {
    const items = '---\nim: 40\ndata: 2026-12-03 10:00\nstato: previsto\n---\n\n## Lavori\n\n- [ ] Esportazione CSV\n- [ ] Pagamento\n- [>] Tema scuro\n- [x] Login\n';
    const projects = [container('omega', { 'IM/IM-40.md': items, 'IM/calendario.md': setEnd(newCalendarText(THURSDAY_10), '2026-12-03') })];
    const now = new Date(2026, 11, 3, 18, 0);
    assert.deepEqual(nextImPlan(projects, 'omega', ENV, now), { number: 41, date: '2026-12-10 10:00', ended: true });
    assert.equal(isLastIm(projects, 'omega', ENV, 40, now), true);
    assert.throws(() => createIm(projects, 'omega', ENV), (error) => error instanceof ImError && error.code === 'ended');
    assert.throws(() => addItemTo(projects, 'omega', ENV, 'next', 'Fatture', new Date(2026, 11, 1)), (error) => error instanceof ImError && error.code === 'ended');
    closeImItem(projects, 'omega', ENV, 40, { line: 9, title: 'Esportazione CSV', part: null }, 'not-done', now);
    closeImItem(projects, 'omega', ENV, 40, { line: 10, title: 'Pagamento', part: null }, 'part', now);
    assert.equal(finishImClosing(projects, 'omega', ENV, 40, now), true);
    const im = readIm(projects, 'omega', ENV, 40);
    assert.equal(im.status, 'chiuso');
    assert.deepEqual(im.items.map((item) => [item.title, item.state, item.part]), [['Esportazione CSV', 'cancelled', null], ['Pagamento', 'done', 1], ['Tema scuro', 'postponed', null], ['Login', 'done', null]]);
    assert.equal(listIms(projects, 'omega', ENV).length, 1);
    // The end taken away: the IM go on.
    const view = readImCalendar(projects, 'omega', ENV);
    writeImEnd(projects, 'omega', ENV, null, view.version);
    assert.equal(createIm(projects, 'omega', ENV).date, '2026-12-10 10:00');
  });

  it('an IM made before the end and falling after it does not receive the items left', () => {
    const items = '---\nim: 40\ndata: 2026-12-03 10:00\nstato: previsto\n---\n\n## Lavori\n\n- [ ] Esportazione CSV\n';
    const projects = [container('tau', { 'IM/IM-40.md': items, 'IM/IM-41.md': IM(41, '2026-12-10 10:00').replace('chiuso', 'previsto'), 'IM/calendario.md': setEnd(newCalendarText(THURSDAY_10), '2026-12-03') })];
    const now = new Date(2026, 11, 3, 18, 0);
    assert.equal(isLastIm(projects, 'tau', ENV, 40, now), true);
    closeImItem(projects, 'tau', ENV, 40, { line: 9, title: 'Esportazione CSV', part: null }, 'not-done', now);
    assert.equal(readIm(projects, 'tau', ENV, 40).items[0]?.state, 'cancelled');
    assert.deepEqual(readIm(projects, 'tau', ENV, 41).items, []);
  });

  it('is written in the file from the page, created when missing', () => {
    const projects = [container('sigma', { 'IM/IM-1.md': IM(1, '2026-10-15 10:00') })];
    assert.equal(writeImEnd(projects, 'sigma', ENV, null, '').exists, false);
    const view = writeImEnd(projects, 'sigma', ENV, '2026-10-15', '');
    assert.deepEqual([view.end, view.calendar, view.issue], ['2026-10-15', null, null]);
    assert.throws(() => createIm(projects, 'sigma', ENV), (error) => error instanceof ImError && error.code === 'ended');
  });
});
