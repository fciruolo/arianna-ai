// "Esporta in CLAUDE.md e AGENTS.md" (I-14 R3, D-176): the preview, the
// files written only when new or Arianna's, the user's own left alone.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Project, ProjectRules } from '@arianna/config';

import { planRulesExport, writeRulesExport, type ExportPlan } from '../src/rules-export.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup(parts: string[] | null): { root: string; home: string; project: Project } {
  const root = mkdtempSync(join(tmpdir(), 'arianna-rules-export-'));
  roots.push(root);
  const home = join(root, 'home');
  const absolute = join(root, 'sito');
  mkdirSync(home);
  if (parts === null) mkdirSync(join(absolute, '.git'), { recursive: true });
  else for (const part of parts) mkdirSync(join(absolute, part, '.git'), { recursive: true });
  return { root, home, project: { name: 'sito', path: 'repos/sito', absolute, label: 'L1' } };
}

const RULES: ProjectRules = { template: 'Commenti in inglese.', projects: { sito: 'Commenti in inglese.\nUsa pnpm, mai npm.' } };
const TEXT = 'Commenti in inglese.\nUsa pnpm, mai npm.\n';

/** The preview, as the page shows it and sends it back. */
function preview(home: string, project: Project, rules: ProjectRules): ExportPlan {
  const plan = planRulesExport({ home }, project, rules);
  assert.ok(plan !== undefined);
  return plan;
}

function ledgerOf(home: string): Record<string, string> {
  return JSON.parse(readFileSync(join(home, 'data', 'rules-export.json'), 'utf8')) as Record<string, string>;
}

describe('rules export (D-176)', () => {
  it('previews and writes both files in a single-part project, and remembers them outside the project', () => {
    const { home, project } = setup(null);
    const plan = preview(home, project, RULES);
    assert.deepEqual(plan, {
      text: TEXT,
      files: [
        { path: 'CLAUDE.md', status: 'new' },
        { path: 'AGENTS.md', status: 'new' },
      ],
      contents: { 'CLAUDE.md': TEXT, 'AGENTS.md': TEXT },
    });
    const outcome = writeRulesExport({ home }, project, RULES, plan);
    assert.deepEqual(outcome, { ok: true, files: [{ path: 'CLAUDE.md', status: 'written' }, { path: 'AGENTS.md', status: 'written' }] });
    assert.equal(readFileSync(join(project.absolute, 'CLAUDE.md'), 'utf8'), TEXT);
    assert.equal(readFileSync(join(project.absolute, 'AGENTS.md'), 'utf8'), TEXT);
    // No trace in the files nor temporary files left: the ledger is in data/ of the home, keyed by project name.
    assert.deepEqual(readdirSync(project.absolute).sort(), ['.git', 'AGENTS.md', 'CLAUDE.md']);
    assert.deepEqual(Object.keys(ledgerOf(home)).sort(), ['sito/AGENTS.md', 'sito/CLAUDE.md']);
    assert.equal(planRulesExport({ home }, project, RULES)?.files[0]?.status, 'same');
  });

  it('an item marked for one executor goes only in its file; a file with nothing for it is not written (D-181)', () => {
    const { home, project } = setup(null);
    const marked: ProjectRules = { projects: { sito: '- Per tutti\n- [solo Claude Code] Usa i subagenti\n- [solo Codex] Patch piccole' } };
    const plan = preview(home, project, marked);
    assert.deepEqual(plan.contents, { 'CLAUDE.md': '- Per tutti\n- Usa i subagenti\n', 'AGENTS.md': '- Per tutti\n- Patch piccole\n' });
    assert.deepEqual(writeRulesExport({ home }, project, marked, plan), { ok: true, files: [{ path: 'CLAUDE.md', status: 'written' }, { path: 'AGENTS.md', status: 'written' }] });
    assert.equal(readFileSync(join(project.absolute, 'AGENTS.md'), 'utf8'), '- Per tutti\n- Patch piccole\n');
    assert.equal(planRulesExport({ home }, project, marked)?.files.every((file) => file.status === 'same'), true);
    // Now every rule is for Codex: the CLAUDE.md Arianna wrote goes, with its line of the ledger.
    const onlyCodex: ProjectRules = { projects: { sito: '- [solo Codex] Patch piccole' } };
    const stale = preview(home, project, onlyCodex);
    assert.deepEqual(stale.files, [{ path: 'CLAUDE.md', status: 'stale' }, { path: 'AGENTS.md', status: 'arianna' }]);
    assert.deepEqual(writeRulesExport({ home }, project, onlyCodex, stale), { ok: true, files: [{ path: 'CLAUDE.md', status: 'removed' }, { path: 'AGENTS.md', status: 'written' }] });
    assert.deepEqual(readdirSync(project.absolute).sort(), ['.git', 'AGENTS.md']);
    assert.deepEqual(Object.keys(ledgerOf(home)), ['sito/AGENTS.md']);
    assert.deepEqual(preview(home, project, onlyCodex).files, [{ path: 'AGENTS.md', status: 'same' }]);
  });

  it('a file of the user with no rule for its executor is listed and never removed (D-181)', () => {
    const { home, project } = setup(null);
    writeFileSync(join(project.absolute, 'CLAUDE.md'), 'Mie regole.\n');
    const onlyCodex: ProjectRules = { projects: { sito: '- [solo Codex] Patch piccole' } };
    const plan = preview(home, project, onlyCodex);
    assert.deepEqual(plan.files, [{ path: 'CLAUDE.md', status: 'foreign' }, { path: 'AGENTS.md', status: 'new' }]);
    writeRulesExport({ home }, project, onlyCodex, plan);
    assert.equal(readFileSync(join(project.absolute, 'CLAUDE.md'), 'utf8'), 'Mie regole.\n');
  });

  it('replaces a file Arianna wrote with the new rules', () => {
    const { home, project } = setup(null);
    writeRulesExport({ home }, project, RULES, preview(home, project, RULES));
    const changed: ProjectRules = { projects: { sito: 'Usa yarn.' } };
    const plan = preview(home, project, changed);
    assert.deepEqual(plan.files.map((file) => file.status), ['arianna', 'arianna']);
    assert.equal(writeRulesExport({ home }, project, changed, plan).ok, true);
    assert.equal(readFileSync(join(project.absolute, 'CLAUDE.md'), 'utf8'), 'Usa yarn.\n');
  });

  it('never touches a file of the user, nor one Arianna wrote and the user changed', () => {
    const { home, project } = setup(null);
    writeFileSync(join(project.absolute, 'CLAUDE.md'), '# Mie regole\n');
    writeRulesExport({ home }, project, RULES, preview(home, project, RULES));
    assert.equal(readFileSync(join(project.absolute, 'CLAUDE.md'), 'utf8'), '# Mie regole\n');
    writeFileSync(join(project.absolute, 'AGENTS.md'), `${TEXT}Una riga mia.\n`);
    const changed: ProjectRules = { projects: { sito: 'Usa yarn.' } };
    const outcome = writeRulesExport({ home }, project, changed, preview(home, project, changed));
    assert.deepEqual(outcome, { ok: true, files: [{ path: 'CLAUDE.md', status: 'foreign' }, { path: 'AGENTS.md', status: 'foreign' }] });
    assert.equal(readFileSync(join(project.absolute, 'AGENTS.md'), 'utf8'), `${TEXT}Una riga mia.\n`);
  });

  it('never writes through a link nor over a folder', () => {
    const { root, home, project } = setup(null);
    const outside = join(root, 'fuori.md');
    writeFileSync(outside, 'fuori\n');
    symlinkSync(outside, join(project.absolute, 'CLAUDE.md'));
    mkdirSync(join(project.absolute, 'AGENTS.md'));
    const plan = preview(home, project, RULES);
    assert.deepEqual(plan.files.map((file) => file.status), ['foreign', 'foreign']);
    assert.deepEqual(writeRulesExport({ home }, project, RULES, plan), { ok: true, files: [{ path: 'CLAUDE.md', status: 'foreign' }, { path: 'AGENTS.md', status: 'foreign' }] });
    assert.equal(readFileSync(outside, 'utf8'), 'fuori\n');
  });

  it('writes in every part of a container, never in the container nor in a part that is a link', () => {
    const { root, home, project } = setup(['sito-admin', 'sito-client']);
    mkdirSync(join(root, 'altrove', '.git'), { recursive: true });
    symlinkSync(join(root, 'altrove'), join(project.absolute, 'sito-link'));
    const plan = preview(home, project, RULES);
    assert.deepEqual(plan.files.map((file) => file.path), ['sito-admin/CLAUDE.md', 'sito-admin/AGENTS.md', 'sito-client/CLAUDE.md', 'sito-client/AGENTS.md']);
    writeRulesExport({ home }, project, RULES, plan);
    assert.equal(readFileSync(join(project.absolute, 'sito-client', 'AGENTS.md'), 'utf8'), TEXT);
    assert.throws(() => readFileSync(join(project.absolute, 'CLAUDE.md')));
    assert.deepEqual(readdirSync(join(root, 'altrove')), ['.git']);
  });

  it('writes nothing when the rules or the files changed after the preview', () => {
    const { home, project } = setup(['sito-admin']);
    const plan = preview(home, project, RULES);
    assert.deepEqual(writeRulesExport({ home }, project, RULES, { ...plan, text: 'Vecchie regole.\n' }), { ok: false, reason: 'changed' });
    // A part added after the preview: its files were never shown.
    mkdirSync(join(project.absolute, 'sito-client', '.git'), { recursive: true });
    assert.deepEqual(writeRulesExport({ home }, project, RULES, plan), { ok: false, reason: 'files-changed' });
    assert.throws(() => readFileSync(join(project.absolute, 'sito-admin', 'CLAUDE.md')));
  });

  it('refuses a project without rules', () => {
    const { home, project } = setup(null);
    assert.equal(planRulesExport({ home }, project, { projects: {} }), undefined);
    assert.equal(planRulesExport({ home }, project, { template: 'x', projects: { sito: '  ' } }), undefined);
    assert.deepEqual(writeRulesExport({ home }, project, { projects: {} }, { text: TEXT, files: [] }), { ok: false, reason: 'no-rules' });
  });

  it('a ledger that does not read is empty: the files there are the user’s', () => {
    const { home, project } = setup(null);
    writeRulesExport({ home }, project, RULES, preview(home, project, RULES));
    writeFileSync(join(home, 'data', 'rules-export.json'), '{rotto');
    assert.deepEqual(preview(home, project, { projects: { sito: 'Usa yarn.' } }).files.map((file) => file.status), ['foreign', 'foreign']);
  });

  it('a write that fails halfway keeps the files already written as Arianna’s', { skip: process.getuid?.() === 0 }, () => {
    const { home, project } = setup(['sito-admin', 'sito-client']);
    const plan = preview(home, project, RULES);
    chmodSync(join(project.absolute, 'sito-client'), 0o555);
    try {
      assert.throws(() => writeRulesExport({ home }, project, RULES, plan));
    } finally {
      chmodSync(join(project.absolute, 'sito-client'), 0o755);
    }
    assert.equal(readFileSync(join(project.absolute, 'sito-admin', 'CLAUDE.md'), 'utf8'), TEXT);
    const changed: ProjectRules = { projects: { sito: 'Usa yarn.' } };
    assert.deepEqual(preview(home, project, changed).files.map((file) => file.status), ['arianna', 'arianna', 'new', 'new']);
    assert.deepEqual(readdirSync(join(project.absolute, 'sito-client')), ['.git']);
  });
});
