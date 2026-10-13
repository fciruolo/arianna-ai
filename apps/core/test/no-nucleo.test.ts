import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// D-192: the texts the core writes for the user (titles of the system chats,
// failures) say «Arianna», never «nucleo». Code and comments are in English,
// so the word in a source of the core can only be a text for the user.
const SRC = join(import.meta.dirname, '..', 'src');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('no text of the core says «nucleo»', () => {
  const files = sources(SRC);
  assert.ok(files.length > 50, 'the scan reads the sources of the core');
  assert.deepEqual(
    files.filter((path) => /nucleo/i.test(readFileSync(path, 'utf8'))),
    [],
  );
});
