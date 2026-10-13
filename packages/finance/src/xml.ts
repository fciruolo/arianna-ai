// A restricted XML reader for the few parts of an .xlsx we read (D-183):
// elements, attributes, text, CDATA, comments and the five XML entities plus
// numeric character references. A DOCTYPE is refused, so there are no custom
// entities and no entity expansion. Namespace prefixes are dropped from names.
import { FinanceImportError } from './table.ts';

export type XmlEvent =
  | { type: 'open'; name: string; attrs: Readonly<Record<string, string>>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function bad(message: string): FinanceImportError {
  return new FinanceImportError('bad-xml', message);
}

/** Replaces the XML entities of a text or attribute value. */
export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]{1,10});/g, (_whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw bad('Invalid character reference');
      }
      return String.fromCodePoint(code);
    }
    const value = NAMED_ENTITIES[name];
    if (value === undefined) throw bad('Unknown XML entity');
    return value;
  });
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/** The longest tag read, attributes included: past it the part is refused (bad-xml), so no tag costs more than this. */
export const MAX_TAG_CHARS = 64 * 1024;

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** `name="value"` or `name='value'` separated by spaces, read in one pass (no regular expression to backtrack). */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = 0;
  for (;;) {
    while (isSpace(source[i])) i += 1;
    if (i >= source.length) return attrs;
    const nameStart = i;
    while (i < source.length && !isSpace(source[i]) && source[i] !== '=' && source[i] !== '/' && source[i] !== '>') i += 1;
    if (i === nameStart) throw bad('Malformed attribute');
    const name = source.slice(nameStart, i);
    while (isSpace(source[i])) i += 1;
    if (source[i] !== '=') throw bad('Malformed attribute');
    i += 1;
    while (isSpace(source[i])) i += 1;
    const quote = source[i];
    if (quote !== '"' && quote !== "'") throw bad('Malformed attribute');
    const close = source.indexOf(quote, i + 1);
    if (close === -1) throw bad('Malformed attribute');
    const value = source.slice(i + 1, close);
    i = close + 1;
    // Attributes are separated by spaces: `a="1"b="2"` is not XML.
    if (i < source.length && !isSpace(source[i])) throw bad('Malformed attribute');
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    attrs[localName(name)] = decodeEntities(value);
  }
}

/** The `>` that closes the tag, skipping quoted attribute values (they may hold `>`); a tag longer than MAX_TAG_CHARS is refused. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  const limit = Math.min(xml.length, from + MAX_TAG_CHARS);
  for (let j = from; j < limit; j += 1) {
    const char = xml[j];
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return j;
    } else if (char === '<') {
      throw bad('Unclosed tag');
    }
  }
  if (limit < xml.length) throw bad('A tag is too long');
  throw bad('Unclosed tag');
}

/** The events of the document, in order. Throws on anything outside the subset. */
export function* xmlEvents(xml: string): Generator<XmlEvent> {
  let i = 0;
  const depth: string[] = [];
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail.trim() !== '') yield { type: 'text', text: decodeEntities(tail) };
      break;
    }
    if (lt > i) yield { type: 'text', text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw bad('Unclosed processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw bad('Unclosed comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw bad('Unclosed CDATA');
      yield { type: 'text', text: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw bad('DOCTYPE and declarations are not allowed');
    const gt = tagEnd(xml, lt + 1);
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const name = localName(body.slice(1).trim());
      if (depth.pop() !== name) throw bad('Mismatched closing tag');
      yield { type: 'close', name };
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^[^\s/>]+/.exec(inner);
    if (nameMatch === null) throw bad('Empty tag');
    const name = localName(nameMatch[0]);
    const attrs = parseAttributes(inner.slice(nameMatch[0].length));
    if (!selfClosing) depth.push(name);
    yield { type: 'open', name, attrs, selfClosing };
  }
  if (depth.length > 0) throw bad('Unclosed element');
}
