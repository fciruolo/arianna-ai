// The tab "IM" of "Progetti" (I-11 tappa P4d, D-169): pure helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  afterEnd,
  amountInput,
  billingErrorText,
  billingText,
  calendarText,
  chosenTotal,
  dayText,
  invoiceable,
  moneyText,
  parseAmount,
  priceSourceText,
  todayInput,
  totalsText,
  type ImBillingRow,
} from '../src/lib/im-billing.ts';

test('amounts are read the Italian way, in cents', () => {
  assert.equal(parseAmount('450'), 45_000);
  assert.equal(parseAmount('450,5'), 45_050);
  assert.equal(parseAmount('1.234,56 €'), 123_456);
  assert.equal(parseAmount('1234.56'), 123_456);
  assert.equal(parseAmount('1.500'), 150_000);
  assert.equal(parseAmount('  '), null);
  for (const wrong of ['-10', '10,555', 'dieci', '1,2,3', '10.5.5', '1.000.000,01']) assert.equal(parseAmount(wrong), undefined, wrong);
  assert.equal(amountInput(45_000), '450');
  assert.equal(amountInput(45_050), '450,50');
  assert.equal(amountInput(null), '');
});

test('amounts and totals are written the Italian way', () => {
  assert.equal(moneyText(45_000, 'EUR'), '450,00 €');
  assert.equal(moneyText(123_456_789, 'EUR'), '1.234.567,89 €');
  assert.equal(moneyText(5, 'USD'), '0,05 $');
  assert.equal(moneyText(100, 'SEK'), '1,00 SEK');
  assert.equal(totalsText([]), '—');
  assert.equal(totalsText([{ currency: 'EUR', cents: 160_000 }, { currency: 'USD', cents: 30_000 }]), '1.600,00 € · 300,00 $');
});

test('the calendar and the days in words', () => {
  assert.equal(calendarText({ weekday: 4, time: '10:00', every: 1 }), 'ogni giovedì alle 10:00');
  assert.equal(calendarText({ weekday: 1, time: '15:00', every: 2 }), 'ogni 2 settimane, il lunedì alle 15:00');
  assert.equal(dayText('2026-10-31'), '31/10/2026');
  assert.equal(todayInput(new Date(2026, 0, 5)), '2026-01-05');
});

const row = (number: number, state: ImBillingRow['state'], amountCents: number | null, currency = 'EUR'): ImBillingRow => ({
  number,
  date: '2026-10-15 10:00',
  call: null,
  status: state === 'open' ? 'previsto' : 'chiuso',
  label: 'L1',
  path: `IM/IM-${String(number)}.md`,
  counts: { todo: 0, doing: 0, done: 1, postponed: 0, cancelled: 0 },
  amountCents,
  currency,
  overrideCents: null,
  notBilled: state === 'not-billed',
  closedCents: state === 'open' ? null : amountCents,
  invoice: null,
  state,
});

test('only the IM to invoice can be chosen, and their total needs one currency', () => {
  const rows = [row(1, 'to-invoice', 40_000), row(2, 'to-invoice', 45_000), row(3, 'not-billed', null), row(4, 'open', 45_000), row(5, 'to-invoice', 10_000, 'USD')];
  assert.deepEqual(invoiceable(rows).map((item) => item.number), [1, 2, 5]);
  assert.deepEqual(chosenTotal(rows, new Set([1, 2])), { currency: 'EUR', cents: 85_000 });
  assert.equal(chosenTotal(rows, new Set([1, 5])), undefined);
  assert.equal(chosenTotal(rows, new Set()), undefined);
  assert.equal(priceSourceText(rows[0] as ImBillingRow), 'fissato alla chiusura');
  assert.equal(priceSourceText(rows[3] as ImBillingRow), 'prezzo di oggi, si fissa alla chiusura');
  assert.equal(priceSourceText({ state: 'to-invoice', overrideCents: 1, closedCents: 2, amountCents: 1 }), 'prezzo di questo IM');
  assert.equal(priceSourceText({ state: 'open', overrideCents: null, closedCents: null, amountCents: null }), 'manca il prezzo del progetto');
  assert.equal(billingText({ state: 'invoiced', invoice: { id: 'x', number: '12/2026' } }), 'In fattura 12/2026');
  assert.equal(billingText({ state: 'paid', invoice: { id: 'x', number: '12/2026' } }), 'Pagato · fattura 12/2026');
  assert.equal(billingText({ state: 'not-billed', invoice: null }), 'Non fatturato');
});

test('the errors of the core in Italian', () => {
  assert.equal(billingErrorText(new ApiError(409, 'another invoice has this number')), 'C’è già una fattura con questo numero.');
  assert.equal(billingErrorText(new ApiError(409, 'IM-3 is not closed')), 'In una fattura vanno solo IM chiusi.');
  assert.match(billingErrorText(new ApiError(404, 'not found')), /non c’è più/);
});

test('an IM after the last day of the IM is pointed out', () => {
  assert.equal(afterEnd('2026-12-10 10:00', '2026-12-03'), true);
  assert.equal(afterEnd('2026-12-03 10:00', '2026-12-03'), false);
  assert.equal(afterEnd(null, '2026-12-03'), false);
  assert.equal(afterEnd('2026-12-10 10:00', null), false);
  assert.equal(billingErrorText(new ApiError(409, 'the IM of the project have ended')), 'Gli IM del progetto sono terminati: c’è una data di fine nel calendario.');
});
