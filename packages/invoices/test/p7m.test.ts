import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { InvoiceReadError, envelopeDer, invoiceFileKind } from '../src/index.ts';

// A fake invoice signed with a throwaway self-signed certificate («Firma Finta»), whose key was never kept.
const FOLDER = join(import.meta.dirname, '..', '..', '..', 'kb', 'private', 'finanze', 'fatture');
const signed = new Uint8Array(readFileSync(join(FOLDER, 'IT12345678901_00002.xml.p7m')));

describe('signed envelopes', () => {
  it('tells an XML from a signed file by its bytes', () => {
    assert.equal(invoiceFileKind(new Uint8Array(readFileSync(join(FOLDER, 'IT12345678901_00001.xml')))), 'xml');
    assert.equal(invoiceFileKind(new TextEncoder().encode('\n  <a/>')), 'xml');
    assert.equal(invoiceFileKind(signed), 'p7m');
  });

  it('takes the DER as it is, and out of base64 with or without PEM lines', () => {
    assert.equal(envelopeDer(signed), signed);
    const base64 = Buffer.from(signed).toString('base64');
    assert.deepEqual(envelopeDer(new TextEncoder().encode(base64)), signed);
    const pem = `-----BEGIN PKCS7-----\n${base64.replace(/(.{64})/g, '$1\n')}\n-----END PKCS7-----\n`;
    assert.equal(invoiceFileKind(new TextEncoder().encode(pem)), 'p7m');
    assert.deepEqual(envelopeDer(new TextEncoder().encode(pem)), signed);
  });

  it('refuses what is neither', () => {
    assert.throws(() => invoiceFileKind(new TextEncoder().encode('Data;Importo')), (error: unknown) => error instanceof InvoiceReadError && error.code === 'not-xml');
    assert.throws(() => envelopeDer(new TextEncoder().encode('bm90IGEgc2lnbmF0dXJl')), (error: unknown) => error instanceof InvoiceReadError && error.code === 'bad-signature');
  });

  it('refuses a file larger than 10 MiB', () => {
    assert.throws(() => invoiceFileKind(new Uint8Array(10 * 1024 * 1024 + 1)), (error: unknown) => error instanceof InvoiceReadError && error.code === 'too-large');
  });
});
