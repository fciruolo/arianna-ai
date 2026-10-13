import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// D-192: the chat calls the core «Arianna»; the word «nucleo» never reaches the user.
const SRC = join(import.meta.dirname, '..', 'src');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|vue)$/.test(name)) out.push(path);
  }
  return out;
}

test('no text of the chat says «nucleo»', () => {
  const offenders = sources(SRC).filter((path) => /nucleo/i.test(readFileSync(path, 'utf8')));
  assert.ok(sources(SRC).length > 50, 'the scan reads the sources of the chat');
  assert.deepEqual(offenders, []);
});
