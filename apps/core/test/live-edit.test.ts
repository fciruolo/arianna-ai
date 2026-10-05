// Live changes of the Coder (D-117, second stage): path, privacy and size filters, and the pieces under the pg_notify limit.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { Secret } from '@arianna/vault';

import { parseEdit } from '../src/live.ts';
import { editNotices, liveEditFailure, liveEditOf, MAX_EDIT_BYTES, MAX_EDIT_PIECES, projectPath } from '../src/live-edit.ts';
import { MAX_NOTICE_BYTES } from '../src/reply.ts';

const ROOT = '/projects/site';
const edit = (filePath: string, parts: { before: string; after: string }[], tool: 'Edit' | 'MultiEdit' | 'Write' = 'Edit') => ({ type: 'edit' as const, tool, filePath, parts });

describe('projectPath', () => {
  it('gives the path relative to the project, for absolute and relative paths inside it', () => {
    assert.equal(projectPath(ROOT, '/projects/site/src/a.ts'), 'src/a.ts');
    assert.equal(projectPath(ROOT, 'docs/b.md'), 'docs/b.md');
    assert.equal(projectPath(ROOT, '/projects/site/./src/../c.ts'), 'c.ts');
    assert.equal(projectPath(ROOT, '/projects/site/..x/d.ts'), '..x/d.ts');
    assert.equal(projectPath(ROOT, '/projects/site/.github/e.yml'), '.github/e.yml');
  });

  it('refuses the root, a path outside the project, under .git in any case, or with control characters', () => {
    assert.equal(projectPath(ROOT, '/projects/site'), undefined);
    assert.equal(projectPath(ROOT, '/projects/other/a.ts'), undefined);
    assert.equal(projectPath(ROOT, '/projects/site-2/a.ts'), undefined);
    assert.equal(projectPath(ROOT, '../a.ts'), undefined);
    assert.equal(projectPath(ROOT, '/etc/passwd'), undefined);
    assert.equal(projectPath(ROOT, '/projects/site/.git/config'), undefined);
    assert.equal(projectPath(ROOT, '/projects/site/.GIT/hooks/pre-commit'), undefined);
    assert.equal(projectPath(ROOT, 'vendor/lib/.git/config'), undefined);
    assert.equal(projectPath(ROOT, 'a\nb.ts'), undefined);
    assert.equal(projectPath(ROOT, ''), undefined);
    assert.equal(projectPath(ROOT, `${'a'.repeat(1025)}.ts`), undefined);
  });
});

describe('liveEditOf', () => {
  it('turns an Edit into the diff lines with the label given', () => {
    const shown = liveEditOf(edit('/projects/site/README.md', [{ before: '# Site\n', after: '# Site\nHello.\n' }]), { root: ROOT, label: 'L1' });
    assert.deepEqual(shown, { path: 'README.md', tool: 'Edit', label: 'L1', added: 1, removed: 0, lines: ' # Site\n+Hello.' });
  });

  it('puts a gap between the parts of a MultiEdit, and shows a Write as all added', () => {
    const multi = liveEditOf(edit('a.ts', [{ before: 'a\n', after: 'b\n' }, { before: 'c\n', after: '' }], 'MultiEdit'), { root: ROOT, label: 'L0' });
    assert.equal(multi?.lines, '-a\n+b\n@\n-c');
    assert.deepEqual([multi.added, multi.removed], [1, 2]);
    const write = liveEditOf(edit('new.md', [{ before: '', after: '# New\n\nText.\n' }], 'Write'), { root: ROOT, label: 'L1' });
    assert.deepEqual([write?.tool, write?.added, write?.removed, write?.lines], ['Write', 3, 0, '+# New\n+\n+Text.']);
  });

  it('shows nothing above L1, outside the project or under .git', () => {
    const parts = [{ before: 'a', after: 'b' }];
    assert.equal(liveEditOf(edit('a.ts', parts), { root: ROOT, label: 'L2' }), undefined);
    assert.equal(liveEditOf(edit('a.ts', parts), { root: ROOT, label: 'L3' }), undefined);
    assert.equal(liveEditOf(edit('/elsewhere/a.ts', parts), { root: ROOT, label: 'L1' }), undefined);
    assert.equal(liveEditOf(edit('.git/config', parts), { root: ROOT, label: 'L1' }), undefined);
  });

  it('a change over the size limit is shown by its path only', () => {
    const big = 'x'.repeat(MAX_EDIT_BYTES / 2);
    assert.deepEqual(liveEditOf(edit('a.ts', [{ before: big, after: `${big}y` }]), { root: ROOT, label: 'L1' }), {
      path: 'a.ts',
      tool: 'Edit',
      label: 'L1',
      added: 0,
      removed: 0,
      lines: '',
      error: 'too-large',
    });
    // At the limit it is still shown.
    assert.equal(liveEditOf(edit('a.ts', [{ before: big, after: big.slice(1) + 'y' }]), { root: ROOT, label: 'L1' })?.error, undefined);
  });

  it('never carries a value of the vault: the text is refused, a path holding one is not shown', () => {
    const value = new Secret('vault://live-edit-test', `segreto-${randomUUID()}`).reveal();
    const refused = liveEditOf(edit('config.ts', [{ before: 'a', after: `token = "${value}"` }]), { root: ROOT, label: 'L1' });
    assert.deepEqual([refused?.error, refused?.lines], ['refused', '']);
    assert.ok(!JSON.stringify(refused).includes(value));
    assert.equal(liveEditOf(edit(`${value}.ts`, [{ before: 'a', after: 'b' }]), { root: ROOT, label: 'L1' }), undefined);
    assert.equal(liveEditOf(edit('clean.ts', [{ before: 'a', after: 'b' }]), { root: ROOT, label: 'L1' })?.error, undefined);
  });
});

describe('editNotices', () => {
  const base = { editId: 'e1', conversationId: 'c1', taskId: 't1', step: 2, path: 'src/a.ts', tool: 'Edit' as const, label: 'L1' as const, added: 1, removed: 1 };

  it('cuts the lines in pieces under the pg_notify limit that join back to the text, each one parsed by the live feed', () => {
    const text = Array.from({ length: 3000 }, (_, index) => `+riga è ${String(index)} "\\"`).join('\n');
    const notices = editNotices(base, text);
    assert.ok(notices.length > 1);
    for (const notice of notices) assert.ok(Buffer.byteLength(notice) <= MAX_NOTICE_BYTES);
    const parsed = notices.map((notice) => parseEdit(notice));
    assert.ok(parsed.every((item) => item !== undefined && item.total === notices.length));
    assert.equal(parsed.map((item) => item?.text).join(''), text);
    assert.deepEqual(parsed.map((item) => item?.seq), [...notices.keys()]);
  });

  it('a change that would take more pieces than the chat keeps is sent as too large, by its path only', () => {
    const notices = editNotices(base, `+${'x'.repeat(MAX_NOTICE_BYTES * (MAX_EDIT_PIECES + 1))}`);
    assert.equal(notices.length, 1);
    assert.deepEqual(parseEdit(notices[0] ?? ''), { ...base, error: 'too-large', seq: 0, total: 1, text: '' });
    // Below the limit the pieces carry the text, with no error.
    const within = editNotices(base, `+${'x'.repeat(MAX_NOTICE_BYTES * 2)}`).map((notice) => parseEdit(notice));
    assert.ok(within.length > 1 && within.length <= MAX_EDIT_PIECES);
    assert.ok(within.every((item) => item !== undefined && item.error === undefined));
  });

  it('the log of a failed change says the class and code of the error, never its message', () => {
    const error = Object.assign(new Error('payload "+secret line of a file"'), { code: '22023' });
    assert.equal(liveEditFailure(error), 'live edit not sent: Error (22023)');
    assert.equal(liveEditFailure('text of a file'), 'live edit not sent: string');
  });

  it('an empty change is one notice, and the feed drops a malformed one', () => {
    const [only, ...rest] = editNotices({ ...base, error: 'too-large' }, '');
    assert.equal(rest.length, 0);
    assert.deepEqual(parseEdit(only ?? ''), { ...base, error: 'too-large', seq: 0, total: 1, text: '' });
    const good = JSON.parse(only ?? '{}') as Record<string, unknown>;
    assert.equal(parseEdit(JSON.stringify({ ...good, label: 'L2' })), undefined);
    assert.equal(parseEdit(JSON.stringify({ ...good, tool: 'Bash' })), undefined);
    assert.equal(parseEdit(JSON.stringify({ ...good, seq: 1 })), undefined);
    assert.equal(parseEdit(JSON.stringify({ ...good, error: 'other' })), undefined);
    assert.equal(parseEdit('not json'), undefined);
  });
});
