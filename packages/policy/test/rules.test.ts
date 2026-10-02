import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLabelRules,
  labelForKbPage,
  labelForPath,
  labelForSource,
  PolicyError,
  type Label,
  type LabelRules,
} from '../src/index.ts';

const notALabel = (value: unknown): Label => value as Label;

const RULES: LabelRules = createLabelRules({
  folders: [
    { path: 'kb/public', label: 'L0' },
    { path: 'kb/work', label: 'L1' },
    { path: 'kb/private', label: 'L2' },
    { path: 'kb/private/shared', label: 'L1' },
    { path: 'data/vault', label: 'L3' },
  ],
  sources: [
    { name: 'web', label: 'L0' },
    { name: 'mail', label: 'L2' },
  ],
});

test('a file takes the label of the folder rule that contains it', () => {
  assert.equal(labelForPath(RULES, 'kb/public/readme.md'), 'L0');
  assert.equal(labelForPath(RULES, 'kb/work/notes/today.md'), 'L1');
  assert.equal(labelForPath(RULES, 'data/vault/keys.age'), 'L3');
  assert.equal(labelForPath(RULES, 'kb/public'), 'L0');
});

test('default-deny: a file outside every rule is L2', () => {
  assert.equal(labelForPath(RULES, 'notes.md'), 'L2');
  assert.equal(labelForPath(RULES, 'kb/other/page.md'), 'L2');
  assert.equal(labelForPath(createLabelRules({ folders: [], sources: [] }), 'kb/public/a.md'), 'L2');
});

test('a rule matches whole path segments, not name prefixes', () => {
  assert.equal(labelForPath(RULES, 'kb/publicity/a.md'), 'L2');
  assert.equal(labelForPath(RULES, 'kb/pub/a.md'), 'L2');
});

test('the most specific rule wins, also when it lowers the label', () => {
  assert.equal(labelForPath(RULES, 'kb/private/shared/plan.md'), 'L1');
  assert.equal(labelForPath(RULES, 'kb/private/sharedx/plan.md'), 'L2');
  assert.equal(labelForPath(RULES, 'kb/private/invoice.md'), 'L2');
});

test('rule order in the file does not matter', () => {
  const reversed = createLabelRules({
    folders: [
      { path: 'kb/private/shared', label: 'L1' },
      { path: 'kb/private', label: 'L2' },
    ],
    sources: [],
  });
  assert.equal(labelForPath(reversed, 'kb/private/shared/plan.md'), 'L1');
  assert.equal(labelForPath(reversed, 'kb/private/invoice.md'), 'L2');
});

test('equivalent spellings of a path get the same label', () => {
  assert.equal(labelForPath(RULES, './kb/public/a.md'), 'L0');
  assert.equal(labelForPath(RULES, 'kb//public/./a.md'), 'L0');
  assert.equal(labelForPath(RULES, 'kb/public/'), 'L0');
});

test('a different letter case can only raise the label, never lower it', () => {
  // On a case-insensitive disk these name the vault: they must stay L3.
  assert.equal(labelForPath(RULES, 'Data/Vault/keys.age'), 'L3');
  assert.equal(labelForPath(RULES, 'DATA/vault/keys.age'), 'L3');
  // On a case-sensitive disk this is another folder: it must not inherit L0.
  assert.equal(labelForPath(RULES, 'KB/Public/a.md'), 'L2');
});

test('composed and decomposed Unicode names get the same label', () => {
  const rules = createLabelRules({ folders: [{ path: 'kb/caffè', label: 'L3' }], sources: [] });
  assert.equal(labelForPath(rules, 'kb/caffè/a.md'), 'L3');
  assert.equal(labelForPath(rules, 'kb/caffè/a.md'), 'L3');
});

test('a path with a ".." segment is rejected: after a symbolic link it may point anywhere', () => {
  // If kb/public/link pointed to data/vault/sub, this would be data/vault/x on disk.
  assert.throws(() => labelForPath(RULES, 'kb/public/link/../x'), PolicyError);
  assert.throws(() => labelForPath(RULES, 'kb/work/..'), PolicyError);
  assert.equal(labelForPath(RULES, 'kb/public/..x/a.md'), 'L0');
});

test('case folding covers letters that expand, and rule lengths are compared folded', () => {
  const rules = createLabelRules({
    folders: [
      { path: 'kb/straße', label: 'L3' },
      { path: 'kb/ﬀ', label: 'L3' },
    ],
    sources: [],
  });
  assert.equal(labelForPath(rules, 'kb/STRASSE/a.md'), 'L3');
  assert.equal(labelForPath(rules, 'kb/ff/a.md'), 'L3');
  // U+0130 folds to two characters: the nested rule must still be the more specific one.
  const nested = createLabelRules({
    folders: [
      { path: 'kb/İİİ', label: 'L3' },
      { path: 'kb/iii/x', label: 'L0' },
    ],
    sources: [],
  });
  assert.equal(labelForPath(nested, 'kb/iii/x/a.md'), 'L0');
});

test('paths outside home cannot be labeled', () => {
  assert.throws(() => labelForPath(RULES, '/etc/passwd'), PolicyError);
  assert.throws(() => labelForPath(RULES, '../outside.md'), PolicyError);
  assert.throws(() => labelForPath(RULES, 'kb/../../outside.md'), PolicyError);
  assert.throws(() => labelForPath(RULES, ''), PolicyError);
});

test('a KB page header can raise the folder label, never lower it', () => {
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', 'L2'), 'L2');
  assert.equal(labelForKbPage(RULES, 'kb/private/a.md', 'L0'), 'L2');
  assert.equal(labelForKbPage(RULES, 'kb/work/a.md', 'L1'), 'L1');
});

test('a KB page without a header keeps the folder label', () => {
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', undefined), 'L0');
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', null), 'L0');
  assert.equal(labelForKbPage(RULES, 'notes/a.md', undefined), 'L2');
});

test('a KB page header that is not a valid label counts as L3, never lower', () => {
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', 'l3'), 'L3');
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', 'L3 '), 'L3');
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', 'l0'), 'L3');
  assert.equal(labelForKbPage(RULES, 'kb/public/a.md', ''), 'L3');
});

test('a source takes the label of its rule; an unknown source is L2', () => {
  assert.equal(labelForSource(RULES, 'web'), 'L0');
  assert.equal(labelForSource(RULES, 'mail'), 'L2');
  assert.equal(labelForSource(RULES, 'telegram'), 'L2');
  assert.equal(labelForSource(RULES, 'Web'), 'L2');
});

test('rules with absolute, escaping or empty paths are rejected', () => {
  const folder = (path: string) => () =>
    createLabelRules({ folders: [{ path, label: 'L1' }], sources: [] });
  assert.throws(folder('/kb/public'), PolicyError);
  assert.throws(folder('../kb'), PolicyError);
  assert.throws(folder('kb/../..'), PolicyError);
  assert.throws(folder(''), PolicyError);
});

test('a rule for the whole home folder is rejected: it would switch off default-deny', () => {
  assert.throws(() => createLabelRules({ folders: [{ path: '.', label: 'L0' }], sources: [] }), PolicyError);
  assert.throws(() => createLabelRules({ folders: [{ path: 'kb/..', label: 'L0' }], sources: [] }), PolicyError);
});

test('duplicate rules are rejected, also when they differ only in spelling or case', () => {
  const folders = (a: string, b: string) => () =>
    createLabelRules({
      folders: [
        { path: a, label: 'L1' },
        { path: b, label: 'L2' },
      ],
      sources: [],
    });
  assert.throws(folders('kb/work', 'kb/work'), PolicyError);
  assert.throws(folders('kb/work', './kb/work/'), PolicyError);
  assert.throws(folders('kb/work', 'KB/Work'), PolicyError);
  assert.doesNotThrow(folders('kb/work', 'kb/work/drafts'));
  assert.throws(
    () =>
      createLabelRules({
        folders: [],
        sources: [
          { name: 'web', label: 'L0' },
          { name: 'web', label: 'L1' },
        ],
      }),
    PolicyError,
  );
});

test('rules with an invalid label or an empty source name are rejected', () => {
  assert.throws(
    () => createLabelRules({ folders: [{ path: 'kb', label: notALabel('l1') }], sources: [] }),
    PolicyError,
  );
  assert.throws(
    () => createLabelRules({ folders: [], sources: [{ name: 'web', label: notALabel(undefined) }] }),
    PolicyError,
  );
  assert.throws(() => createLabelRules({ folders: [], sources: [{ name: '', label: 'L0' }] }), PolicyError);
});
