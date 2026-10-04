import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DATA_DIR, resolveHome } from '@arianna/config';

import { cloneId, deleteClone, encodeWav, listClones, parseClone, removeLeftovers, saveClone } from '../src/voice/clones.ts';

const ROOT = join(resolveHome({}), DATA_DIR, 'test-tmp', randomUUID());
mkdirSync(ROOT, { recursive: true });
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const pcm = (seconds: number): string => Buffer.alloc(Math.round(seconds * 16_000) * 2).toString('base64');
const valid = { name: 'Voce di prova', text: 'Ciao, questa è una frase di prova.', pcm16: pcm(8), consent: true };

test('parseClone: a name, the text, 5 to 30 s of audio and the consent (D-069)', () => {
  const parsed = parseClone({ ...valid, name: '  Voce di prova ' });
  assert.equal(parsed.name, 'Voce di prova');
  assert.equal(parsed.pcm16.length, 8 * 16_000 * 2);
  const bad: Record<string, unknown>[] = [
    { ...valid, consent: false },
    { ...valid, consent: 'yes' },
    { name: valid.name, text: valid.text, pcm16: valid.pcm16 },
    { ...valid, name: '' },
    { ...valid, name: 'x'.repeat(41) },
    { ...valid, name: 'a\nb' },
    { ...valid, text: '' },
    { ...valid, text: 'a\u0000b' },
    { ...valid, pcm16: pcm(4) },
    { ...valid, pcm16: pcm(31) },
    { ...valid, pcm16: 'not base64!' },
    { ...valid, extra: 1 },
  ];
  for (const body of bad) assert.throws(() => parseClone(body), { name: 'CloneError' }, JSON.stringify(body).slice(0, 80));
});

test('cloneId: lower case ascii from the name, free among the taken ones', () => {
  assert.equal(cloneId('Moglie', []), 'moglie');
  assert.equal(cloneId('Jarvis è qui!', []), 'jarvis_e_qui');
  assert.equal(cloneId('Moglie', ['moglie']), 'moglie_2');
  assert.equal(cloneId('Moglie', ['moglie', 'moglie_2']), 'moglie_3');
  assert.equal(cloneId('42', []), 'voce');
  assert.match(cloneId('x'.repeat(80), []), /^[a-z][a-z0-9_]{1,40}$/);
  // Cut at 30 characters, never ending with an underscore.
  assert.equal(cloneId(`${'a'.repeat(29)} b`, []), 'a'.repeat(29));
});

test('saveClone, listClones and deleteClone: private files, whole voices only', () => {
  const dir = join(ROOT, 'voices');
  const saved = saveClone(dir, parseClone(valid), new Date('2026-10-04T10:00:00Z'));
  assert.deepEqual(saved, { id: 'voce_di_prova', name: 'Voce di prova', createdAt: '2026-10-04T10:00:00.000Z', seconds: 8 });
  const folder = join(dir, saved.id);
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  assert.equal(statSync(join(folder, 'reference.wav')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(folder, 'reference.wav')).subarray(0, 4).toString(), 'RIFF');
  assert.equal(readFileSync(join(folder, 'reference.txt'), 'utf8'), `${valid.text}\n`);
  assert.equal((JSON.parse(readFileSync(join(folder, 'voice.json'), 'utf8')) as { label: string }).label, 'L2');
  // A second voice with the same name gets its own id.
  assert.equal(saveClone(dir, parseClone(valid)).id, 'voce_di_prova_2');
  // An incomplete folder, a link and a bad name are not voices.
  mkdirSync(join(dir, 'incompleta'));
  writeFileSync(join(dir, 'incompleta', 'reference.wav'), 'x');
  symlinkSync(folder, join(dir, 'collegata'));
  mkdirSync(join(dir, 'Maiuscola'));
  assert.deepEqual(
    listClones(dir).map(({ id }) => id),
    ['voce_di_prova', 'voce_di_prova_2'],
  );
  assert.equal(deleteClone(dir, 'voce_di_prova_2'), true);
  assert.equal(existsSync(join(dir, 'voce_di_prova_2')), false);
  assert.equal(deleteClone(dir, 'voce_di_prova_2'), false);
  // A link is never followed: the folder it points to stays.
  assert.equal(deleteClone(dir, 'collegata'), false);
  assert.equal(existsSync(folder), true);
  assert.throws(() => deleteClone(dir, '../voce_di_prova'), { name: 'CloneError' });
  assert.deepEqual(listClones(join(ROOT, 'missing')), []);
});

test('half-written voices are removed; a linked voices folder is refused', () => {
  const dir = join(ROOT, 'leftovers');
  mkdirSync(join(dir, '.new-moglie-123'), { recursive: true });
  writeFileSync(join(dir, '.new-moglie-123', 'reference.wav'), 'campione');
  mkdirSync(join(ROOT, 'elsewhere'));
  symlinkSync(join(ROOT, 'elsewhere'), join(dir, '.new-link-1'));
  assert.equal(removeLeftovers(dir), 1);
  assert.equal(existsSync(join(dir, '.new-moglie-123')), false);
  // The link is not a leftover of ours: what it points to stays.
  assert.equal(existsSync(join(ROOT, 'elsewhere')), true);
  // A new voice also clears them.
  mkdirSync(join(dir, '.new-anna-9'));
  saveClone(dir, parseClone(valid));
  assert.equal(existsSync(join(dir, '.new-anna-9')), false);
  symlinkSync(join(ROOT, 'elsewhere'), join(ROOT, 'linked-voices'));
  assert.throws(() => saveClone(join(ROOT, 'linked-voices'), parseClone(valid)), { name: 'CloneError' });
});

test('encodeWav: a 16-bit mono header', () => {
  const wav = encodeWav(Buffer.from([1, 0, 255, 127]), 16_000);
  assert.equal(wav.length, 48);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(40), 4);
});
