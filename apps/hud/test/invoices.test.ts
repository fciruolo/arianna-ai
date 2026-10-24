import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  deadlineGroup,
  documentTypeText,
  groupDeadlines,
  importText,
  invoiceErrorText,
  invoiceFileProblem,
  paymentMethodText,
  vatRateText,
  type Deadline,
} from '../src/lib/invoices.ts';

// Invented deadlines of invented suppliers (D-310).
function deadline(id: string, dueOn: string | null, paidOn: string | null = null): Deadline {
  return { id, invoice: 'i', method: 'MP05', dueOn, amountCents: 100, paidOn, currency: 'EUR', documentType: 'TD01', number: '1', issuedOn: '2026-01-01', supplier: 'Ditta Finta', customer: 'Mario Finto' };
}

describe('invoices of the page Finanze', () => {
  it('names the common FatturaPA codes and keeps the others', () => {
    assert.equal(documentTypeText('TD04'), 'Nota di credito');
    assert.equal(documentTypeText('TD17'), 'Documento TD17');
    assert.equal(paymentMethodText('MP05'), 'bonifico');
    assert.equal(paymentMethodText('MP21'), 'MP21');
    assert.equal(vatRateText('22.00', null), '22%');
    assert.equal(vatRateText('5.50', null), '5,50%');
    assert.equal(vatRateText('0.00', 'N2.2'), '0% (N2.2)');
  });

  it('sends only .xml and .p7m files up to 10 MB', () => {
    assert.equal(invoiceFileProblem('IT01_00001.xml', 10), null);
    assert.equal(invoiceFileProblem('IT01_00001.XML.P7M', 10), null);
    assert.match(invoiceFileProblem('estratto.csv', 10) ?? '', /solo fatture elettroniche/);
    assert.equal(invoiceFileProblem('vuota.xml', 0), 'Il file è vuoto.');
    assert.match(invoiceFileProblem('grande.xml', 10 * 1024 * 1024 + 1) ?? '', /troppo grande/);
  });

  it('says in Italian what the core answered', () => {
    assert.match(invoiceErrorText(new ApiError(400, 'doctype', {})), /DOCTYPE/);
    assert.match(invoiceErrorText(new ApiError(400, 'bad-signature', {})), /firmato/);
    assert.match(invoiceErrorText(new ApiError(404, 'not-found', {})), /fattura/);
    assert.match(invoiceErrorText(new TypeError('fetch failed')), /non risponde/);
  });

  it('counts what an import did', () => {
    assert.equal(importText({ imported: [], duplicates: 1 }), 'Nessuna fattura nuova, 1 era già presente.');
    assert.equal(importText({ imported: [{} as never, {} as never], duplicates: 0 }), '2 fatture importate.');
  });

  it('groups open deadlines: past due, within 30 days, later, without a day', () => {
    const today = '2026-10-24';
    assert.equal(deadlineGroup('2026-10-23', today), 'overdue');
    assert.equal(deadlineGroup('2026-10-24', today), 'soon');
    assert.equal(deadlineGroup('2026-11-23', today), 'soon');
    assert.equal(deadlineGroup('2026-11-24', today), 'later');
    assert.equal(deadlineGroup(null, today), 'undated');
    const groups = groupDeadlines([deadline('a', '2026-10-01'), deadline('b', '2026-12-31'), deadline('c', null), deadline('d', '2026-10-02', '2026-10-02')], today);
    assert.deepEqual(groups.map((entry) => [entry.group, entry.items.map((item) => item.id)]), [['overdue', ['a']], ['later', ['b']], ['undated', ['c']]]);
  });
});
