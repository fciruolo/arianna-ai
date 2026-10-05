import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { canPreview, codeFence, creditsByMessage, hasCredit, languageOf } from '../src/lib/delegations.ts';
import { CHANGE_TEXT, costText, creditText, durationText, filesTitle, previewErrorText, runnerText } from '../src/lib/italian.ts';
import { parseMarkdown } from '../src/lib/markdown.ts';
import type { MessageCredit } from '../src/lib/types.ts';

const CODER: MessageCredit = {
  messageId: '12',
  delegationId: '3',
  agent: 'coder',
  executor: 'claude',
  alias: 'sonnet',
  model: 'claude-sonnet-4-5',
  durationMs: 125_000,
  cost: null,
  repo: 'site',
  files: [
    { path: 'README.md', change: 'modified' },
    { path: 'old.txt', change: 'deleted' },
  ],
};

test('credits are looked up by message; only cloud answers have one (D-082)', () => {
  const credits = creditsByMessage([CODER, { ...CODER, messageId: '20', delegationId: null, agent: null, files: null }]);
  assert.equal(credits.get('12')?.delegationId, '3');
  assert.equal(credits.get('20')?.agent, null);
  assert.equal(credits.get('99'), undefined);
  assert.equal(hasCredit({ role: 'assistant', agent: 'coder', model: null }), true);
  assert.equal(hasCredit({ role: 'assistant', agent: null, model: 'opus' }), true);
  assert.equal(hasCredit({ role: 'assistant', agent: null, model: null }), false);
  assert.equal(hasCredit({ role: 'user', agent: null, model: null }), false);
});

test('a deleted file has no preview; the others do', () => {
  assert.equal(canPreview({ path: 'a.ts', change: 'added' }), true);
  assert.equal(canPreview({ path: 'a.ts', change: 'renamed', from: 'b.ts' }), true);
  assert.equal(canPreview({ path: 'a.ts', change: 'deleted' }), false);
});

test('the language of the code block comes from the extension, or none', () => {
  assert.equal(languageOf('src/app.ts'), 'ts');
  assert.equal(languageOf('docs/README.MD'), 'markdown');
  assert.equal(languageOf('Makefile'), '');
  assert.equal(languageOf('.gitignore'), '');
  assert.equal(languageOf('weird.ext'), '');
});

test('a file is one code block whatever it holds: backticks and Markdown stay text', () => {
  const text = '# Title\n```js\nalert(1)\n```\n````\n[link](javascript:alert(1))\n<script>x</script>';
  const blocks = parseMarkdown(codeFence(text, 'notes.md'));
  assert.equal(blocks.length, 1);
  const [block] = blocks;
  assert.ok(block?.kind === 'code');
  assert.equal(block.lang, 'markdown');
  assert.equal(block.text, text);
  const plain = parseMarkdown(codeFence('a\n', 'x'));
  assert.ok(plain[0]?.kind === 'code' && plain[0].text === 'a' && plain[0].lang === null);
});

test('the credit line says who, on what, how long, and what it cost', () => {
  assert.equal(creditText(CODER), 'Coder · Claude Code / Claude Sonnet (claude-sonnet-4-5) · 2 min 5 s');
  assert.equal(
    creditText({ ...CODER, agent: null, alias: 'opus', model: null, durationMs: 4_000, cost: 0.25 }),
    'Risposta diretta · Claude Code / Claude Opus · 4 s · 0,25 €',
  );
  assert.equal(runnerText({ executor: null, alias: null, model: null }), 'cloud');
  assert.equal(runnerText({ executor: 'claude', alias: 'sonnet', model: 'sonnet' }), 'Claude Code / Claude Sonnet');
  assert.equal(durationText(null), undefined);
  assert.equal(durationText(59_400), '59 s');
  assert.equal(durationText(120_000), '2 min');
  assert.equal(durationText(3_780_000), '1 h 3 min');
  assert.equal(costText(0), undefined);
  assert.equal(costText(null), undefined);
  assert.equal(filesTitle(1), 'File modificato (1)');
  assert.equal(filesTitle(3), 'File modificati (3)');
  assert.deepEqual(Object.values(CHANGE_TEXT), ['aggiunto', 'modificato', 'cancellato', 'rinominato']);
});

test('why a preview is not shown, in Italian', () => {
  assert.match(previewErrorText(new ApiError(410, 'the file is no longer there')), /non c’è più/);
  assert.match(previewErrorText(new ApiError(413, 'the file is larger than 256 KiB')), /256 KiB/);
  assert.match(previewErrorText(new ApiError(415, 'not a text file')), /UTF-8/);
  assert.match(previewErrorText(new ApiError(403, 'the project site is no longer among the approved projects')), /non è più fra quelli approvati/);
  assert.match(previewErrorText(new ApiError(403, 'the file leads out of the project')), /esce dal progetto/);
  assert.match(previewErrorText(new ApiError(404, 'no such file')), /non è fra quelli della delega/);
  assert.match(previewErrorText(new ApiError(409, 'the conversation is archived: restore it to see the files')), /ripristinala/);
  assert.match(previewErrorText(new TypeError('fetch failed')), /non risponde/);
});
