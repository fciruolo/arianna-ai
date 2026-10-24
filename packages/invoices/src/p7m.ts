// A signed FatturaPA (.xml.p7m, CAdES): a CMS envelope around the XML (D-310).
// This module only recognizes the envelope, in DER or in base64 as some
// senders write it; the core takes the XML out with the system's openssl.
import { InvoiceReadError } from './errors.ts';
import { MAX_INVOICE_BYTES } from './xml.ts';

export type InvoiceFileKind = 'xml' | 'p7m';

function isDer(bytes: Uint8Array): boolean {
  // A SEQUENCE (0x30) with a long or indefinite length, as every CMS SignedData of an invoice has.
  return bytes.length > 16 && bytes[0] === 0x30 && (bytes[1] === 0x80 || (bytes[1] !== undefined && bytes[1] >= 0x81 && bytes[1] <= 0x84));
}

function looksLikeXml(bytes: Uint8Array): boolean {
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (start < bytes.length && (bytes[start] === 0x20 || bytes[start] === 0x09 || bytes[start] === 0x0a || bytes[start] === 0x0d)) start += 1;
  return bytes[start] === 0x3c;
}

/** The DER of a base64 envelope (with or without PEM lines), or null. */
function fromBase64(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length > Math.ceil((MAX_INVOICE_BYTES * 4) / 3) + 4096) return null;
  const text = new TextDecoder('latin1').decode(bytes).replace(/-----(BEGIN|END) [A-Z0-9 ]{1,40}-----/g, '').replace(/\s+/g, '');
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const der = new Uint8Array(Buffer.from(text, 'base64'));
  return isDer(der) ? der : null;
}

/** What the file is, from its bytes (not its name): an XML or a signed envelope. */
export function invoiceFileKind(bytes: Uint8Array): InvoiceFileKind {
  if (bytes.length > MAX_INVOICE_BYTES) throw new InvoiceReadError('too-large', 'The file is larger than 10 MiB');
  if (looksLikeXml(bytes)) return 'xml';
  if (isDer(bytes) || fromBase64(bytes) !== null) return 'p7m';
  throw new InvoiceReadError('not-xml', 'Neither an XML nor a signed file');
}

/** The DER envelope of a signed file, for `openssl cms -verify -noverify -inform DER`. */
export function envelopeDer(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX_INVOICE_BYTES) throw new InvoiceReadError('too-large', 'The file is larger than 10 MiB');
  if (isDer(bytes)) return bytes;
  const der = fromBase64(bytes);
  if (der === null) throw new InvoiceReadError('bad-signature', 'Not a signed envelope');
  return der;
}
