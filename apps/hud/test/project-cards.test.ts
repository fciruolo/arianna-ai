// The projects as cards (D-191, after the user's trial): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ImBillingRow, ImInvoice, ImOverview } from '../src/lib/im-billing.ts';
import { cardMoneyText, overdueShortText, partsText, projectCardIm, projectInitials, sortProjectCards } from '../src/lib/project-cards.ts';

const row = (number: number, change: Partial<ImBillingRow> = {}): ImBillingRow => ({
  number,
  date: `2026-10-${String(number).padStart(2, '0')} 10:00`,
  call: null,
  status: 'chiuso',
  label: 'L1',
  path: `IM/IM-${String(number)}.md`,
  counts: { todo: 0, doing: 0, done: 1, postponed: 0, cancelled: 0 },
  amountCents: 45000,
  currency: 'EUR',
  overrideCents: null,
  notBilled: false,
  closedCents: 45000,
  invoice: null,
  state: 'to-invoice',
  ...change,
});

const invoice = (change: Partial<ImInvoice> = {}): ImInvoice => ({
  id: 'a',
  number: 'T-1/2026',
  issuedOn: '2026-09-12',
  paidOn: null,
  currency: 'EUR',
  note: null,
  ims: [1],
  totalCents: 45000,
  documentCents: 54900,
  dueOn: null,
  due: '2026-10-09',
  createdAt: '2026-09-12T10:00:00Z',
  ...change,
});

const overview = (change: Partial<ImOverview> = {}): ImOverview => ({
  calendar: { calendar: { weekday: 4, time: '10:00', every: 1 }, issue: null, end: null, exists: true, path: 'IM/calendario.md', version: 'v1' },
  price: { amountCents: 45000, currency: 'EUR' },
  ims: [row(1, { state: 'invoiced' }), row(8), row(15, { status: 'previsto', closedCents: null, state: 'open' })],
  invoices: [invoice({ id: 'late' }), invoice({ id: 'paid', paidOn: '2026-09-30', due: '2026-09-20' }), invoice({ id: 'old', paidOn: '2025-12-30', due: '2025-12-20' })],
  totals: { toInvoice: [{ currency: 'EUR', cents: 45000 }], invoiced: [], paid: [] },
  ...change,
});

test('a card reads calendar, next IM and the three numbers from the IM of its project', () => {
  const card = projectCardIm(overview(), '2026-10-12', 2026);
  assert.equal(card.calendar, 'IM ogni giovedì alle 10:00');
  assert.equal(card.next, 'IM-15 · gio 15 ott');
  assert.deepEqual(card.money, {
    currency: 'EUR',
    toInvoice: [{ currency: 'EUR', cents: 45000 }],
    awaiting: [{ currency: 'EUR', cents: 54900 }],
    overdue: 1,
    // The one paid in 2025 does not count in 2026.
    paid: [{ currency: 'EUR', cents: 54900 }],
  });
});

test('a card without calendar, without IM open, with nothing past due', () => {
  const card = projectCardIm(
    overview({ calendar: { calendar: null, issue: null, end: null, exists: false, path: 'IM/calendario.md', version: '' }, ims: [row(1)], invoices: [invoice({ due: '2026-10-30' })] }),
    '2026-10-12',
    2026,
  );
  assert.equal(card.calendar, null);
  assert.equal(card.next, null);
  assert.ok(card.money);
  assert.equal(card.money.overdue, 0);
  assert.deepEqual(card.money.paid, []);
});

test('a project with no IM and no invoice has no numbers, only the guide', () => {
  const card = projectCardIm(overview({ ims: [], invoices: [], price: null, totals: { toInvoice: [], invoiced: [], paid: [] } }), '2026-10-12', 2026);
  assert.equal(card.money, null);
  // An invoice alone is enough for the numbers.
  assert.notEqual(projectCardIm(overview({ ims: [] }), '2026-10-12', 2026).money, null);
});

test('the money of a card, rounded, "0 €" when there is nothing', () => {
  assert.equal(cardMoneyText([{ currency: 'EUR', cents: 154900 }], 'EUR'), '1.549 €');
  assert.equal(cardMoneyText([{ currency: 'EUR', cents: 45000 }, { currency: 'USD', cents: 1000 }], 'EUR'), '450 € · 10 $');
  assert.equal(cardMoneyText([], 'EUR'), '0 €');
  assert.equal(cardMoneyText([{ currency: 'USD', cents: 0 }], 'GBP'), '0 £');
  assert.equal(overdueShortText(1), '1 scaduta');
  assert.equal(overdueShortText(3), '3 scadute');
});

test('the parts and the letters of a card', () => {
  assert.equal(partsText({ single: true, parts: [] }), null);
  assert.equal(partsText({ single: false, parts: [] }), 'nessuna parte con git');
  assert.equal(partsText({ single: false, parts: ['a:x'] }), '1 parte');
  assert.equal(partsText({ single: false, parts: ['a:x', 'a:y'] }), '2 parti');
  assert.equal(projectInitials('progetto-test'), 'PT');
  assert.equal(projectInitials('demo'), 'DE');
});

test('the cards: past due first, then by name; not read yet counts as none past due', () => {
  const list = [{ name: 'zeta' }, { name: 'Alfa' }, { name: 'beta' }, { name: 'gamma' }];
  assert.deepEqual(
    sortProjectCards(list, new Map([['zeta', 2], ['beta', 0]])).map((item) => item.name),
    ['zeta', 'Alfa', 'beta', 'gamma'],
  );
  assert.deepEqual(
    sortProjectCards(list, new Map()).map((item) => item.name),
    ['Alfa', 'beta', 'gamma', 'zeta'],
  );
});
