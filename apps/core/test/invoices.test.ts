import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { FinanceError } from '../src/finance-format.ts';
import { opensslEnvelope, readInvoiceFile } from '../src/invoices.ts';
import { findOpenssl } from '../src/remote-cert.ts';

// The fake invoices of the development knowledge base (D-310).
const FOLDER = join(import.meta.dirname, '..', '..', '..', 'kb', 'private', 'finanze', 'fatture');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FOLDER, name)));
const openssl = findOpenssl();
const noOpenssl = openssl === 'openssl' && !existsSync('/usr/bin/openssl') ? 'no openssl on this machine' : false;
const never = (): Promise<Uint8Array> => Promise.reject(new Error('openssl must not run for an XML'));

describe('readInvoiceFile', () => {
  it('reads an XML without openssl', async () => {
    const read = await readInvoiceFile(fixture('IT12345678901_00001.xml'), never);
    assert.equal(read.signed, false);
    assert.equal(read.invoices[0]?.number, '2026/0042');
  });

  it('opens a signed file with the system openssl, also when it comes in base64', { skip: noOpenssl }, async () => {
    const signed = fixture('IT12345678901_00002.xml.p7m');
    const read = await readInvoiceFile(signed, opensslEnvelope(openssl));
    assert.equal(read.signed, true);
    assert.equal(read.invoices[0]?.number, '2026/0043');
    assert.deepEqual(read.invoices[0].payments.map((payment) => payment.dueOn), ['2026-10-31']);
    const base64 = await readInvoiceFile(new TextEncoder().encode(Buffer.from(signed).toString('base64')), opensslEnvelope(openssl));
    assert.equal(base64.invoices[0]?.fingerprint, read.invoices[0].fingerprint);
  });

  it('answers bad-signature when openssl cannot open the envelope, and never quotes it', { skip: noOpenssl }, async () => {
    const signed = fixture('IT12345678901_00002.xml.p7m');
    const broken = signed.slice(0, signed.length - 200);
    await assert.rejects(readInvoiceFile(broken, opensslEnvelope(openssl)), (error: unknown) =>
      error instanceof FinanceError && error.code === 'bad-signature' && error.status === 400 && error.message === 'The signed file could not be opened');
  });

  it('answers bad-signature when openssl is missing', async () => {
    await assert.rejects(readInvoiceFile(fixture('IT12345678901_00002.xml.p7m'), opensslEnvelope('/nonexistent/openssl')), (error: unknown) =>
      error instanceof FinanceError && error.code === 'bad-signature');
  });

  it('turns reading errors into the codes of the API (413 for a large file)', async () => {
    await assert.rejects(readInvoiceFile(new TextEncoder().encode('<!DOCTYPE x><x/>'), never), (error: unknown) =>
      error instanceof FinanceError && error.code === 'doctype' && error.status === 400);
    await assert.rejects(readInvoiceFile(new Uint8Array(10 * 1024 * 1024 + 1), never), (error: unknown) =>
      error instanceof FinanceError && error.code === 'too-large' && error.status === 413);
  });
});
