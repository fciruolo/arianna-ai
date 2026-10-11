import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ruleItems, withAudience } from '../src/lib/rule-audience.ts';

const TEXT = '# Stile\n- TypeScript strict\n- [solo Claude Code] Usa i subagenti\n  con un livello\n1. [Solo codex] Test prima\n\nParagrafo.';

test('ruleItems: the top-level items, each with who reads it, the mark left out (D-181)', () => {
  assert.deepEqual(ruleItems(TEXT), [
    { line: 1, text: 'TypeScript strict', audience: 'both' },
    { line: 2, text: 'Usa i subagenti', audience: 'claude' },
    { line: 4, text: 'Test prima', audience: 'codex' },
    { line: 6, text: 'Paragrafo.', audience: 'both' },
  ]);
  assert.deepEqual(ruleItems('Una regola per riga.\n    - rientrata: va con quella sopra\n## Titolo'), [{ line: 0, text: 'Una regola per riga.', audience: 'both' }]);
  assert.equal(withAudience('Usa pnpm, mai npm.', 0, 'codex'), '[solo Codex] Usa pnpm, mai npm.');
});

test('withAudience: writes, changes and removes the mark of one item, nothing else (D-181)', () => {
  const codex = withAudience(TEXT, 1, 'codex');
  assert.equal(codex.split('\n')[1], '- [solo Codex] TypeScript strict');
  assert.equal(withAudience(codex, 1, 'claude').split('\n')[1], '- [solo Claude Code] TypeScript strict');
  assert.equal(withAudience(TEXT, 4, 'both').split('\n')[4], '1. Test prima');
  assert.equal(withAudience(TEXT, 0, 'codex'), TEXT, 'a heading is not a rule');
  assert.equal(withAudience(TEXT, 2, 'claude'), TEXT, 'the same audience changes nothing');
});

test('ruleItems: sub-items belong to their rule, CRLF lines are read, code blocks are not rules (D-181)', () => {
  assert.deepEqual(ruleItems('- [solo Claude Code] Subagenti\n  - un livello\n- Per tutti').map((item) => item.line), [0, 2]);
  assert.deepEqual(ruleItems('- A\r\n- [solo Codex] B').map((item) => [item.text, item.audience]), [['A', 'both'], ['B', 'codex']]);
  assert.deepEqual(ruleItems('```\n- [solo Codex] esempio\n```\n- vera'), [{ line: 3, text: 'vera', audience: 'both' }]);
  assert.equal(withAudience('- A\r\n- B', 0, 'codex'), '- [solo Codex] A\r\n- B');
});
