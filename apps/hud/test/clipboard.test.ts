import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyText } from '../src/lib/clipboard.ts';
import { COPY_TEXT } from '../src/lib/italian.ts';

test('copyText writes the exact text of the block', async () => {
  const written: string[] = [];
  const text = '  const a = 1;\n\tb();\n';
  const clipboard = {
    writeText: (value: string): Promise<void> => {
      written.push(value);
      return Promise.resolve();
    },
  };
  assert.equal(await copyText(text, clipboard), 'copied');
  assert.deepEqual(written, [text]);
  assert.equal(COPY_TEXT.copied, 'Copiato');
});

test('copyText without a clipboard (not a secure context) or refused says it is not available', async () => {
  assert.equal(await copyText('x', undefined), 'unavailable');
  assert.equal(await copyText('x', {} as never), 'unavailable');
  assert.equal(await copyText('x', { writeText: () => Promise.reject(new Error('NotAllowedError')) }), 'unavailable');
  assert.equal(COPY_TEXT.unavailable, 'Copia non disponibile');
});
