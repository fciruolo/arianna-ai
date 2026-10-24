// FatturaPA invoices (D-310): reading of the XML and recognition of the signed envelope, pure.
export type { Day, Invoice, InvoiceLine, InvoiceParty, InvoicePayment, VatSummary } from './types.ts';
export { InvoiceReadError } from './errors.ts';
export type { InvoiceErrorCode } from './errors.ts';
export { MAX_INVOICE_BYTES, decodeEntities, decodeXmlBytes, parseXml } from './xml.ts';
export { MAX_BODIES, MAX_DESCRIPTION, MAX_LINES, MAX_NAME, MAX_NUMBER, MAX_PAYMENTS, invoiceFingerprint, isDay, oneLine, readInvoiceXml, toCents, vatRate } from './fatturapa.ts';
export { envelopeDer, invoiceFileKind } from './p7m.ts';
export type { InvoiceFileKind } from './p7m.ts';
