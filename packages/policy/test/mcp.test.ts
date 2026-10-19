import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isMcpKbPath, MCP_CEILING, mcpClearance, type Label } from '../src/index.ts';

test('isMcpKbPath: pages of kb/ outside the projects', () => {
  for (const path of ['kb/work/router.md', 'kb/inbox/nota.md', 'kb/archivio/work/vecchia.md', 'kb/progettini/a.md']) assert.equal(isMcpKbPath(path), true, path);
});

test('isMcpKbPath: never the knowledge of a project, in any case, nor anything outside kb/', () => {
  for (const path of [
    'kb/progetti/cliente/Workplan/piano.md',
    'kb/Progetti/cliente/Workplan/piano.md',
    'KB/PROGETTI/cliente/a.md',
    'kb/archivio/progetti/cliente/a.md',
    'kb/Archivio/Progetti/cliente/a.md',
    'kb/progetti',
    'projects/cliente/Workplan/a.md',
    'arianna/SPEC.md',
    '../kb/work/a.md',
    '',
    undefined,
    7,
  ]) {
    assert.equal(isMcpKbPath(path), false, String(path));
  }
});

test('the MCP ceiling is L1, the ceiling of every cloud executor', () => {
  assert.equal(MCP_CEILING, 'L1');
});

test('mcpClearance: the lowest of task and card, when both are within L1', () => {
  assert.equal(mcpClearance('L1', 'L1'), 'L1');
  assert.equal(mcpClearance('L0', 'L1'), 'L0');
  assert.equal(mcpClearance('L1', 'L0'), 'L0');
  assert.equal(mcpClearance('L0', 'L0'), 'L0');
});

test('mcpClearance: never above L1, whatever the task or the card', () => {
  assert.equal(mcpClearance('L2', 'L2'), 'L1');
  assert.equal(mcpClearance('L2', 'L1'), 'L1');
  assert.equal(mcpClearance('L1', 'L2'), 'L1');
  assert.equal(mcpClearance('L3', 'L3'), 'L1');
  assert.equal(mcpClearance('L2', 'L0'), 'L0');
});

test('mcpClearance: a value that is not a label admits L0 only', () => {
  for (const bad of [undefined, null, '', 'l1', 'L9', 2, {}]) {
    assert.equal(mcpClearance(bad as Label, 'L1'), 'L0', JSON.stringify(bad));
    assert.equal(mcpClearance('L1', bad as Label), 'L0', JSON.stringify(bad));
  }
});
