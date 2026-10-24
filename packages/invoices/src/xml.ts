// The XML of a FatturaPA file read with fast-xml-parser (D-310), with the
// options fixed here and nowhere else: a DOCTYPE or an entity declaration is
// refused before the parser sees the text, the parser expands no entity
// (processEntities: false) and our own decoder replaces only the five XML
// entities and numeric character references. Values stay strings (a VAT
// number keeps its leading zeros), namespace prefixes are dropped, and the
// attachments (Allegati, base64 files) are not parsed.
import { XMLParser, XMLValidator, type X2jOptions } from 'fast-xml-parser';

import { InvoiceReadError } from './errors.ts';

/** The largest file read, as finance statements (10 MiB): FatturaPA files sent through SdI stay under 5 MB. */
export const MAX_INVOICE_BYTES = 10 * 1024 * 1024;

/** Elements that repeat in a FatturaPA: always arrays, even with one item. */
const REPEATED = new Set(['FatturaElettronicaBody', 'DettaglioLinee', 'DatiRiepilogo', 'DatiPagamento', 'DettaglioPagamento', 'Causale']);

const PARSER_OPTIONS: X2jOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  allowBooleanAttributes: false,
  stopNodes: ['..Allegati'],
  maxNestedTags: 64,
  isArray: (tagName: string) => REPEATED.has(tagName),
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Replaces the five XML entities and numeric character references; any other entity is bad XML. */
export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]{0,10});?/g, (whole, name: string) => {
    if (!whole.endsWith(';')) throw new InvoiceReadError('bad-xml', 'An & that is not an entity');
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const digits = name.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^\d{1,7}$/).test(digits)) throw new InvoiceReadError('bad-xml', 'Invalid character reference');
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new InvoiceReadError('bad-xml', 'Invalid character reference');
      return String.fromCodePoint(code);
    }
    const value = NAMED_ENTITIES[name];
    if (value === undefined) throw new InvoiceReadError('bad-xml', 'Unknown XML entity');
    return value;
  });
}

const DECLARED_ENCODING = /^<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/;

/** The text of the file in the encoding its declaration names: UTF-8 (the default), ISO-8859-1, ISO-8859-15 or windows-1252. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length > MAX_INVOICE_BYTES) throw new InvoiceReadError('too-large', 'The file is larger than 10 MiB');
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
    throw new InvoiceReadError('not-xml', 'UTF-16 is not read');
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(start, start + 200));
  const declared = DECLARED_ENCODING.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  const encoding = declared === 'utf-8' || declared === 'utf8' ? 'utf-8'
    : declared === 'iso-8859-1' || declared === 'latin1' ? 'latin1'
    : declared === 'iso-8859-15' ? 'iso-8859-15'
    : declared === 'windows-1252' || declared === 'cp1252' ? 'windows-1252'
    : null;
  if (encoding === null) throw new InvoiceReadError('not-xml', 'Unknown encoding');
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start));
  } catch {
    throw new InvoiceReadError('not-xml', 'The text is not valid in its encoding');
  }
}

/** A parsed element: its children by local name, `@_` attributes, `#text` and `#cdata`. */
export type XmlNode = { readonly [name: string]: XmlValue };
export type XmlValue = string | XmlNode | readonly XmlValue[];

/** Parses the text of a FatturaPA file with the fixed options; the root element and its object. */
export function parseXml(text: string): XmlNode {
  if (!text.trimStart().startsWith('<')) throw new InvoiceReadError('not-xml', 'The file is not XML');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new InvoiceReadError('doctype', 'A DOCTYPE or an entity declaration');
  // Marked deprecated in favour of the separate package fast-xml-validator: still part of the
  // pinned 5.11.2, and kept so as not to add one more dependency for the same check (D-310).
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
  const valid = XMLValidator.validate(text, { allowBooleanAttributes: false });
  if (valid !== true) throw new InvoiceReadError('bad-xml', `Not well formed at line ${String(valid.err.line)}`);
  let parsed: unknown;
  try {
    const result: unknown = new XMLParser(PARSER_OPTIONS).parse(text);
    parsed = result;
  } catch {
    throw new InvoiceReadError('bad-xml', 'The parser refused the file');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new InvoiceReadError('bad-xml', 'No root element');
  return parsed as XmlNode;
}

/** The text of an element: decoded text, then CDATA as written; '' for an empty one. */
export function textOf(value: XmlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return decodeEntities(value);
  if (Array.isArray(value)) return undefined;
  const node = value as XmlNode;
  const text = node['#text'];
  const cdata = node['#cdata'];
  const parts: string[] = [];
  if (typeof text === 'string') parts.push(decodeEntities(text));
  if (typeof cdata === 'string') parts.push(cdata);
  else if (Array.isArray(cdata)) for (const part of cdata) if (typeof part === 'string') parts.push(part);
  return parts.join('');
}

/** A child element as an object (the first one if it repeats); undefined if absent or a bare text. */
export function childOf(node: XmlNode | undefined, name: string): XmlNode | undefined {
  const value = node?.[name];
  const first: XmlValue | undefined = Array.isArray(value) ? (value as readonly XmlValue[])[0] : value;
  return typeof first === 'object' && !Array.isArray(first) ? (first as XmlNode) : undefined;
}

/** The repeated children of an element. */
export function childrenOf(node: XmlNode | undefined, name: string): XmlNode[] {
  const value = node?.[name];
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => (typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as XmlNode) : { '#text': typeof item === 'string' ? item : '' }));
}
