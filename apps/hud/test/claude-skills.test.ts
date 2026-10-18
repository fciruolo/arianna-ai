// The card of the user's own skills of Claude Code (D-255): texts and labels.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { CLAUDE_SOURCE, claudeErrorText, cloudSkills, claudeLabelText, claudeSummaryText, importButtonText, isOwnSkill, rejectedText, skillOriginText, type ClaudeSkillsStatus } from '../src/lib/claude-skills.ts';

const skill = (slug: string, label: 'L1' | 'L2'): ClaudeSkillsStatus['skills'][number] => ({ id: `${CLAUDE_SOURCE}/${slug}`, slug, name: slug, description: '', license: null, otherFiles: 0, sha256: 'a'.repeat(64), label });

describe('the user own skills of Claude Code', () => {
  it('the button: «Importa» the first time, then «Aggiorna»', () => {
    assert.equal(importButtonText(null, false), 'Importa le mie skill');
    assert.equal(importButtonText({ imported: true, importedAt: null, skills: [], rejected: [] }, false), 'Aggiorna');
    assert.equal(importButtonText(null, true), 'Leggo la cartella…');
  });

  it('the summary counts the shareable ones', () => {
    assert.equal(claudeSummaryText({ imported: false, importedAt: null, skills: [], rejected: [] }), 'Non ancora importate.');
    assert.equal(claudeSummaryText({ imported: true, importedAt: null, skills: [skill('a', 'L2'), skill('b', 'L2')], rejected: [] }), '2 skill · tutte private');
    assert.equal(claudeSummaryText({ imported: true, importedAt: null, skills: [skill('a', 'L1'), skill('b', 'L2')], rejected: [] }), '2 skill · 1 condivisibili col cloud');
    assert.equal(claudeSummaryText({ imported: true, importedAt: null, skills: [], rejected: [] }), '0 skill · nessuna');
  });

  it('private and shareable said plainly; the origin replaces the license in the pickers', () => {
    assert.match(claudeLabelText('L2'), /^Privata: arriva solo agli agenti che lavorano su questo computer/);
    assert.match(claudeLabelText('L1'), /^Condivisibile/);
    assert.equal(isOwnSkill({ source: CLAUDE_SOURCE }), true);
    assert.equal(isOwnSkill({ source: 'anthropics/skills' }), false);
    assert.match(skillOriginText({ source: CLAUDE_SOURCE, license: 'MIT', label: 'L2' }), /privata/);
    assert.match(skillOriginText({ source: CLAUDE_SOURCE, license: null, label: 'L1' }), /condivisibile col cloud/);
    assert.equal(skillOriginText({ source: 'anthropics/skills', license: 'MIT', label: 'L0' }), 'MIT');
    // Absent label (an older core): private, the safe reading.
    assert.match(skillOriginText({ source: CLAUDE_SOURCE, license: null }), /privata/);
  });

  it('a Designer in the cloud is never offered a private skill of the user own', () => {
    const list = [
      { id: 'a', source: 'anthropics/skills', label: 'L0' },
      { id: 'b', source: CLAUDE_SOURCE, label: 'L2' },
      { id: 'c', source: CLAUDE_SOURCE, label: 'L1' },
      { id: 'd', source: CLAUDE_SOURCE },
    ];
    assert.deepEqual(cloudSkills(list).map((item) => item.id), ['a', 'c']);
  });

  it('the folders left out and the refusals, in Italian', () => {
    assert.equal(rejectedText({ path: 'collegata', reason: 'symbolic link' }), 'collegata: collegamento simbolico, non letto');
    assert.equal(rejectedText({ path: 'x', reason: 'no frontmatter' }), 'x: SKILL.md senza intestazione (name, description)');
    assert.equal(rejectedText({ path: 'x', reason: 'something new' }), 'x: non letta');
    assert.match(claudeErrorText(new ApiError(404, 'no skills folder in the configuration of Claude Code')), /Non trovo la cartella skills/);
    assert.match(claudeErrorText(new ApiError(400, 'the skills folder of Claude Code is a symbolic link: it is not read')), /collegamento simbolico/);
    assert.match(claudeErrorText(new ApiError(404, 'not found')), /riavviala/);
  });
});
