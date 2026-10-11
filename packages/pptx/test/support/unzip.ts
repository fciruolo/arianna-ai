// A minimal zip reader for the tests: walks the central directory, reads each
// local header and inflates the entry, checking sizes and CRC on the way.
import assert from 'node:assert/strict';
import { crc32, inflateRawSync } from 'node:zlib';

export interface UnzippedEntry {
  name: string;
  data: Buffer;
  method: number;
  dosTime: number;
  dosDate: number;
}

export function unzip(file: Buffer): Map<string, UnzippedEntry> {
  const end = file.length - 22;
  assert.equal(file.readUInt32LE(end), 0x06054b50, 'end of central directory');
  const count = file.readUInt16LE(end + 10);
  assert.equal(file.readUInt16LE(end + 8), count);
  const size = file.readUInt32LE(end + 12);
  const start = file.readUInt32LE(end + 16);
  assert.equal(start + size, end, 'central directory ends where the end record starts');

  const entries = new Map<string, UnzippedEntry>();
  let at = start;
  for (let i = 0; i < count; i++) {
    assert.equal(file.readUInt32LE(at), 0x02014b50, 'central directory header');
    const method = file.readUInt16LE(at + 10);
    const dosTime = file.readUInt16LE(at + 12);
    const dosDate = file.readUInt16LE(at + 14);
    const crc = file.readUInt32LE(at + 16);
    const compressedSize = file.readUInt32LE(at + 20);
    const plainSize = file.readUInt32LE(at + 24);
    const nameLength = file.readUInt16LE(at + 28);
    const extraLength = file.readUInt16LE(at + 30);
    const commentLength = file.readUInt16LE(at + 32);
    const offset = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;

    assert.equal(file.readUInt32LE(offset), 0x04034b50, `local header of ${name}`);
    assert.equal(file.readUInt16LE(offset + 8), method, `method of ${name}`);
    assert.equal(file.readUInt32LE(offset + 14), crc, `local CRC of ${name}`);
    assert.equal(file.readUInt32LE(offset + 18), compressedSize, `local size of ${name}`);
    const localName = file.readUInt16LE(offset + 26);
    const localExtra = file.readUInt16LE(offset + 28);
    assert.equal(file.subarray(offset + 30, offset + 30 + localName).toString('utf8'), name);
    const dataStart = offset + 30 + localName + localExtra;
    const raw = file.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, plainSize, `size of ${name}`);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    assert.equal(entries.has(name), false, `duplicate entry ${name}`);
    entries.set(name, { name, data, method, dosTime, dosDate });
  }
  assert.equal(at, end, 'central directory fully read');
  return entries;
}

/**
 * A basic well-formedness check: tags balance, attributes are quoted, entity
 * references are known, no raw `<` or `&` in text. Not a full XML parser.
 */
export function assertWellFormedXml(xml: string, where: string): void {
  let rest = xml.replace(/^<\?xml [^?]*\?>\s*/, '');
  const stack: string[] = [];
  const entity = /^&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/;
  let roots = 0;
  while (rest.length > 0) {
    if (rest.startsWith('<')) {
      const tag = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)>/.exec(rest);
      assert.ok(tag, `${where}: bad tag at "${rest.slice(0, 40)}"`);
      const [whole, closing, name, attributes, selfClosing] = tag;
      assert.ok(name !== undefined && attributes !== undefined);
      for (const value of attributes.matchAll(/="([^"]*)"/g)) checkText(value[1] ?? '', entity, where);
      if (closing === '/') {
        assert.equal(stack.pop(), name, `${where}: unbalanced </${name}>`);
      } else if (selfClosing !== '/') {
        if (stack.length === 0) roots++;
        stack.push(name);
      } else if (stack.length === 0) {
        roots++;
      }
      rest = rest.slice(whole.length);
    } else {
      const next = rest.indexOf('<');
      const text = next === -1 ? rest : rest.slice(0, next);
      if (stack.length === 0) assert.equal(text.trim(), '', `${where}: text outside the root`);
      checkText(text, entity, where);
      rest = next === -1 ? '' : rest.slice(next);
    }
  }
  assert.deepEqual(stack, [], `${where}: unclosed elements`);
  assert.equal(roots, 1, `${where}: exactly one root element`);
}

function checkText(text: string, entity: RegExp, where: string): void {
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    assert.ok(entity.test(text.slice(i)), `${where}: bad entity at "${text.slice(i, i + 12)}"`);
  }
  assert.ok(!text.includes('<'), `${where}: raw < in text`);
}
