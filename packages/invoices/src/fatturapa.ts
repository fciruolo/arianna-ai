// FatturaPA (format 1.2, FPR12 and FPA12) read into invoices (D-310): one
// Invoice for each FatturaElettronicaBody, with the header's seller and
// buyer. Only the fields Arianna shows and the deadlines need are read;
// errors name the field, never its value.
import { createHash } from 'node:crypto';

import { InvoiceReadError } from './errors.ts';
import type { Day, Invoice, InvoiceLine, InvoiceParty, InvoicePayment, VatSummary } from './types.ts';
import { childOf, childrenOf, decodeXmlBytes, parseXml, textOf, type XmlNode } from './xml.ts';

/** Bodies of one file (a batch of invoices to the same buyer). */
export const MAX_BODIES = 200;
/** Lines of one invoice. */
export const MAX_LINES = 5000;
/** Instalments of one invoice. */
export const MAX_PAYMENTS = 100;
export const MAX_NAME = 200;
export const MAX_DESCRIPTION = 1000;
export const MAX_NUMBER = 20;

function bad(field: string): InvoiceReadError {
  return new InvoiceReadError('bad-field', `${field} is missing or not valid`);
}

/** Collapses whitespace and control characters to single spaces, trimmed and cut to `max`. */
export function oneLine(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this removes
  return raw.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, max).trim();
}

function required(node: XmlNode | undefined, name: string, field: string, max: number): string {
  const value = oneLine(textOf(node?.[name]) ?? '', max);
  if (value === '') throw bad(field);
  return value;
}

function optional(node: XmlNode | undefined, name: string, max: number): string | null {
  const value = oneLine(textOf(node?.[name]) ?? '', max);
  return value === '' ? null : value;
}

const DECIMAL = /^(-?)(\d{1,15})(?:\.(\d{1,8}))?$/;

/** A FatturaPA amount (a dot, up to 8 places) in integer cents, rounded half away from zero. */
export function toCents(raw: string, field: string): number {
  const match = DECIMAL.exec(raw.trim());
  if (match === null) throw bad(field);
  const [, sign = '', whole = '0', fraction = ''] = match;
  const padded = fraction.padEnd(3, '0');
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw bad(field);
  return sign === '-' && cents !== 0 ? -cents : cents;
}

function amount(node: XmlNode | undefined, name: string, field: string): number {
  return toCents(textOf(node?.[name]) ?? '', field);
}

function decimalText(node: XmlNode | undefined, name: string, field: string, required: boolean): string | null {
  const raw = (textOf(node?.[name]) ?? '').trim();
  if (raw === '' && !required) return null;
  if (!DECIMAL.test(raw)) throw bad(field);
  return raw;
}

/** AliquotaIVA as `22.00`: from 0 to 100, two places. */
export function vatRate(raw: string, field: string): string {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (match === null) throw bad(field);
  const value = Number(`${match[1] ?? '0'}.${match[2] ?? '0'}`);
  if (value > 100) throw bad(field);
  return value.toFixed(2);
}

const NATURE = /^N[1-7](\.[1-6])?$/;

function nature(node: XmlNode | undefined, field: string): string | null {
  const value = optional(node, 'Natura', 10);
  if (value !== null && !NATURE.test(value)) throw bad(field);
  return value;
}

/** A calendar day `YYYY-MM-DD` that exists. */
export function isDay(value: string): value is Day {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function day(node: XmlNode | undefined, name: string, field: string): Day {
  const value = (textOf(node?.[name]) ?? '').trim();
  if (!isDay(value)) throw bad(field);
  return value;
}

function party(header: XmlNode | undefined, role: 'CedentePrestatore' | 'CessionarioCommittente'): InvoiceParty {
  const data = childOf(childOf(header, role), 'DatiAnagrafici');
  if (data === undefined) throw bad(role);
  const id = childOf(data, 'IdFiscaleIVA');
  let vat: string | null = null;
  if (id !== undefined) {
    const country = required(id, 'IdPaese', `${role}.IdPaese`, 2).toUpperCase();
    const code = required(id, 'IdCodice', `${role}.IdCodice`, 28).replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !/^[A-Z0-9]{1,28}$/.test(code)) throw bad(`${role}.IdFiscaleIVA`);
    vat = `${country}${code}`;
  }
  const taxCodeRaw = optional(data, 'CodiceFiscale', 16);
  const taxCode = taxCodeRaw === null ? null : taxCodeRaw.replace(/\s/g, '').toUpperCase();
  if (taxCode !== null && !/^[A-Z0-9]{11,16}$/.test(taxCode)) throw bad(`${role}.CodiceFiscale`);
  const registry = childOf(data, 'Anagrafica');
  const company = optional(registry, 'Denominazione', MAX_NAME);
  const person = [optional(registry, 'Nome', MAX_NAME), optional(registry, 'Cognome', MAX_NAME)].filter((part) => part !== null).join(' ');
  const name = oneLine(company ?? person, MAX_NAME);
  if (name === '') throw bad(`${role}.Anagrafica`);
  if (vat === null && taxCode === null) throw bad(`${role}.IdFiscaleIVA`);
  return { name, vat, taxCode };
}

function lines(goods: XmlNode | undefined): InvoiceLine[] {
  const rows = childrenOf(goods, 'DettaglioLinee');
  if (rows.length > MAX_LINES) throw new InvoiceReadError('too-many', `More than ${String(MAX_LINES)} lines`);
  return rows.map((row) => {
    const numberText = (textOf(row['NumeroLinea']) ?? '').trim();
    if (!/^\d{1,4}$/.test(numberText)) throw bad('DettaglioLinee.NumeroLinea');
    return {
      number: Number(numberText),
      description: required(row, 'Descrizione', 'DettaglioLinee.Descrizione', MAX_DESCRIPTION),
      quantity: decimalText(row, 'Quantita', 'DettaglioLinee.Quantita', false),
      unitPrice: decimalText(row, 'PrezzoUnitario', 'DettaglioLinee.PrezzoUnitario', true) ?? '0',
      totalCents: amount(row, 'PrezzoTotale', 'DettaglioLinee.PrezzoTotale'),
      vatRate: vatRate(textOf(row['AliquotaIVA']) ?? '', 'DettaglioLinee.AliquotaIVA'),
      nature: nature(row, 'DettaglioLinee.Natura'),
    };
  });
}

function summary(goods: XmlNode | undefined): VatSummary[] {
  const rows = childrenOf(goods, 'DatiRiepilogo');
  if (rows.length === 0) throw bad('DatiRiepilogo');
  if (rows.length > MAX_LINES) throw new InvoiceReadError('too-many', `More than ${String(MAX_LINES)} VAT rows`);
  return rows.map((row) => ({
    vatRate: vatRate(textOf(row['AliquotaIVA']) ?? '', 'DatiRiepilogo.AliquotaIVA'),
    nature: nature(row, 'DatiRiepilogo.Natura'),
    taxableCents: amount(row, 'ImponibileImporto', 'DatiRiepilogo.ImponibileImporto'),
    vatCents: amount(row, 'Imposta', 'DatiRiepilogo.Imposta'),
  }));
}

function payments(body: XmlNode): InvoicePayment[] {
  const out: InvoicePayment[] = [];
  for (const block of childrenOf(body, 'DatiPagamento')) {
    for (const row of childrenOf(block, 'DettaglioPagamento')) {
      const method = required(row, 'ModalitaPagamento', 'DettaglioPagamento.ModalitaPagamento', 4).toUpperCase();
      if (!/^MP\d{2}$/.test(method)) throw bad('DettaglioPagamento.ModalitaPagamento');
      const dueRaw = (textOf(row['DataScadenzaPagamento']) ?? '').trim();
      if (dueRaw !== '' && !isDay(dueRaw)) throw bad('DettaglioPagamento.DataScadenzaPagamento');
      out.push({ method, dueOn: dueRaw === '' ? null : dueRaw, amountCents: amount(row, 'ImportoPagamento', 'DettaglioPagamento.ImportoPagamento') });
      if (out.length > MAX_PAYMENTS) throw new InvoiceReadError('too-many', `More than ${String(MAX_PAYMENTS)} instalments`);
    }
  }
  return out;
}

/** The key of an invoice: who issued it, what it is, its number and day. */
export function invoiceFingerprint(supplier: InvoiceParty, documentType: string, number: string, issuedOn: Day): string {
  // readInvoiceXml refuses a supplier with neither: the name is only for a caller that builds its own party.
  const who = supplier.vat ?? supplier.taxCode ?? supplier.name.toLowerCase();
  return createHash('sha256').update(`fatturapa\n${who}\n${documentType}\n${number.toUpperCase()}\n${issuedOn}`).digest('hex');
}

function body(node: XmlNode, format: Invoice['format'], supplier: InvoiceParty, customer: InvoiceParty): Invoice {
  const document = childOf(childOf(node, 'DatiGenerali'), 'DatiGeneraliDocumento');
  if (document === undefined) throw bad('DatiGeneraliDocumento');
  const documentType = required(document, 'TipoDocumento', 'TipoDocumento', 4).toUpperCase();
  if (!/^TD\d{2}$/.test(documentType)) throw bad('TipoDocumento');
  const currency = required(document, 'Divisa', 'Divisa', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('Divisa');
  const issuedOn = day(document, 'Data', 'Data');
  const number = required(document, 'Numero', 'Numero', MAX_NUMBER);
  const totalRaw = (textOf(document['ImportoTotaleDocumento']) ?? '').trim();
  const totalCents = totalRaw === '' ? null : toCents(totalRaw, 'ImportoTotaleDocumento');
  const goods = childOf(node, 'DatiBeniServizi');
  const vatSummary = summary(goods);
  return {
    format,
    supplier,
    customer,
    documentType,
    currency,
    issuedOn,
    number,
    totalCents,
    taxableCents: vatSummary.reduce((sum, row) => sum + row.taxableCents, 0),
    vatCents: vatSummary.reduce((sum, row) => sum + row.vatCents, 0),
    lines: lines(goods),
    vatSummary,
    payments: payments(node),
    fingerprint: invoiceFingerprint(supplier, documentType, number, issuedOn),
  };
}

/** Reads the invoices of a FatturaPA XML file (not signed: the core opens a .p7m with openssl, apps/core/src/invoices.ts). */
export function readInvoiceXml(bytes: Uint8Array): Invoice[] {
  const parsed = parseXml(decodeXmlBytes(bytes));
  const rootName = Object.keys(parsed).find((key) => !key.startsWith('@_') && !key.startsWith('#'));
  const root = rootName === undefined ? undefined : childOf(parsed, rootName);
  if (rootName === 'FatturaElettronicaSemplificata') throw new InvoiceReadError('unsupported', 'The simplified invoice (FSM10) is not read');
  if (rootName !== 'FatturaElettronica' || root === undefined) throw new InvoiceReadError('not-fatturapa', 'The root is not FatturaElettronica');
  const version = (textOf(root['@_versione']) ?? '').trim().toUpperCase();
  if (version !== 'FPR12' && version !== 'FPA12') throw new InvoiceReadError('unsupported', 'Unknown FatturaPA version');
  const header = childOf(root, 'FatturaElettronicaHeader');
  if (header === undefined) throw bad('FatturaElettronicaHeader');
  const supplier = party(header, 'CedentePrestatore');
  const customer = party(header, 'CessionarioCommittente');
  const bodies = childrenOf(root, 'FatturaElettronicaBody');
  if (bodies.length === 0) throw bad('FatturaElettronicaBody');
  if (bodies.length > MAX_BODIES) throw new InvoiceReadError('too-many', `More than ${String(MAX_BODIES)} invoices in one file`);
  return bodies.map((node) => body(node, version, supplier, customer));
}
