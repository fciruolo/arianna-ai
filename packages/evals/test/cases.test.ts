import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { CaseFileError, GROUPS, loadCases, parseCases, runTier } from '../src/index.ts';

const LINE = '{"id":"a","input":1,"expect":2,"tags":["x"]}';

test('JSONL is parsed one case per line, blank lines ignored', () => {
  const cases = parseCases(`${LINE}\n\n${LINE.replace('"a"', '"b"')}\n`, 'f.jsonl');
  assert.deepEqual(cases, [
    { id: 'a', input: 1, expect: 2, tags: ['x'] },
    { id: 'b', input: 1, expect: 2, tags: ['x'] },
  ]);
});

test('malformed cases are rejected with file and line', () => {
  assert.throws(() => parseCases(`${LINE}\nnot json\n`, 'f.jsonl'), /f\.jsonl:2/);
  assert.throws(() => parseCases('{"input":1,"expect":2,"tags":[]}', 'f.jsonl'), CaseFileError);
  assert.throws(() => parseCases('{"id":"a","expect":2,"tags":[]}', 'f.jsonl'), CaseFileError);
  assert.throws(() => parseCases('{"id":"a","input":1,"tags":[]}', 'f.jsonl'), CaseFileError);
  assert.throws(() => parseCases('{"id":"a","input":1,"expect":2}', 'f.jsonl'), CaseFileError);
  assert.throws(() => parseCases(LINE.replace('}', ',"extra":1}'), 'f.jsonl'), CaseFileError);
});

test('a missing group folder has no cases', () => {
  assert.deepEqual(loadCases(join(resolveHome({}), 'evals', 'no-such-group')), []);
});

test('the committed deterministic cases load and pass', async () => {
  const evalsDir = join(resolveHome({}), 'evals');
  const report = await runTier('deterministic', GROUPS, (group) => loadCases(join(evalsDir, group)));
  assert.equal(report.ok, true);
  const gateway = report.groups.find((group) => group.name === 'gateway');
  assert.equal(gateway?.status, 'passed');
});

test('every group folder under evals/ belongs to a registered group', () => {
  const folders = readdirSync(join(resolveHome({}), 'evals'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const known = GROUPS.map((group) => group.name);
  assert.deepEqual(folders.filter((folder) => !known.includes(folder)), []);
});
