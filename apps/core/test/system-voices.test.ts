import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseVoiceList, systemVoices } from '../src/voice/system-voices.ts';

const LISTING = [
  'Alice               it_IT    # Ciao! Mi chiamo Alice.',
  'Eddy (Italiano (Italia)) it_IT    # Ciao! Mi chiamo Eddy.',
  'Federica (Premium)  it_IT    # Ciao! Mi chiamo Federica.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  '',
].join('\n');

test('parseVoiceList: the names of say -v ? (D-290)', () => {
  assert.deepEqual(parseVoiceList(LISTING), ['Alice', 'Eddy (Italiano (Italia))', 'Federica (Premium)', 'Samantha']);
  assert.deepEqual(parseVoiceList('not a voice\n'), []);
});

test('systemVoices: read once, again at most once a minute, empty off macOS or when say fails', async () => {
  let clock = 0;
  let reads = 0;
  const readsSoFar = (): number => reads;
  const voices = systemVoices({
    available: true,
    now: () => clock,
    list: () => {
      reads += 1;
      return Promise.resolve(LISTING);
    },
  });
  await voices.refresh();
  assert.equal(reads, 1);
  assert.ok(voices.names().includes('Federica (Premium)'));
  clock = 59_000;
  voices.names();
  assert.equal(reads, 1);
  clock = 61_000;
  voices.names();
  await voices.refresh();
  assert.equal(readsSoFar(), 2);

  const off = systemVoices({ available: false, list: () => Promise.reject(new Error('never called')) });
  await off.refresh();
  assert.deepEqual(off.names(), []);

  const failing = systemVoices({ available: true, list: () => Promise.reject(new Error('say failed')) });
  await failing.refresh();
  assert.deepEqual(failing.names(), []);
});
