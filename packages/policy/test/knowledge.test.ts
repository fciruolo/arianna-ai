import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkCoderNote, isCoderNotePath } from '../src/index.ts';

const skip = (reason: string) => ({ decision: 'skip', reason });

describe('checkCoderNote (D-166)', () => {
  it('an L1 or L0 note in a management folder is given', () => {
    assert.deepEqual(checkCoderNote({ path: 'Workplan/piano.md', label: 'L1' }), { decision: 'allow', label: 'L1' });
    assert.deepEqual(checkCoderNote({ path: 'IM/2026/riunione.MD', label: 'L0', link: false }), { decision: 'allow', label: 'L0' });
  });

  it('a note above L1 stays local, and a missing or unknown label counts as L2', () => {
    assert.deepEqual(checkCoderNote({ path: 'Workplan/fattura.md', label: 'L2' }), skip('label'));
    assert.deepEqual(checkCoderNote({ path: 'documenti/contratto.md', label: 'L3' }), skip('label'));
    assert.deepEqual(checkCoderNote({ path: 'Workplan/x.md', label: undefined }), skip('label'));
    assert.deepEqual(checkCoderNote({ path: 'Workplan/x.md', label: 'l1' }), skip('label'));
  });

  it('a link is never given', () => {
    assert.deepEqual(checkCoderNote({ path: 'Workplan/x.md', label: 'L1', link: true }), skip('link'));
  });

  it('an instruction file of an agent is never given, whatever its case', () => {
    for (const name of ['CLAUDE.md', 'claude.local.md', 'AGENTS.md', 'Agents.Override.md', 'GEMINI.md']) {
      assert.deepEqual(checkCoderNote({ path: `Workplan/${name}`, label: 'L1' }), skip('instructions'), name);
    }
    assert.deepEqual(checkCoderNote({ path: 'Workplan/claude-notes.md', label: 'L1' }), { decision: 'allow', label: 'L1' });
  });

  it('a secret name on the way is never given', () => {
    assert.deepEqual(checkCoderNote({ path: 'Workplan/credentials/x.md', label: 'L1' }), skip('secret'));
  });

  it('only plain relative markdown paths inside a folder', () => {
    for (const path of ['piano.md', '/abs/Workplan/x.md', 'Workplan/../documenti/x.md', 'Workplan/./x.md', 'Workplan//x.md', '.claude/x.md', 'Workplan/.hidden.md', 'Workplan/x.txt', 'Workplan\\x.md', 'Workplan/a\nb.md', 'a/b/c/d/e/f/g/h/i.md', '', 42, null]) {
      assert.deepEqual(checkCoderNote({ path, label: 'L1' }), skip('path'), String(path));
      assert.equal(isCoderNotePath(path), false, String(path));
    }
    assert.equal(isCoderNotePath('Workplan/2026/settembre/piano.md'), true);
  });
});
