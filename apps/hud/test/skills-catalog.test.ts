// "Skill" in Impostazioni → Agenti (D-161): addresses, buttons, summaries, licenses, errors.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  filterSkills,
  otherFilesText,
  shouldPollSkills,
  skillChangesText,
  skillLicenseText,
  skillRefusalText,
  skillsErrorText,
  sourceBlocked,
  sourceButtonText,
  sourceLicenseText,
  sourceUrlProblem,
  withoutSkill,
  withSkill,
  type SkillSource,
  type SkillSummary,
} from '../src/lib/skills-catalog.ts';

const version = { commit: 'a'.repeat(40), committedAt: '2026-10-01T10:00:00Z', fetchedAt: '2026-10-10T08:00:00Z', skills: 20, rejected: 0 };
const none = { added: 0, removed: 0, changed: 0, addedSlugs: [], removedSlugs: [], changedSlugs: [] };

function source(overrides: Partial<SkillSource> = {}): SkillSource {
  return { id: 'acme/skills', page: 'https://github.com/acme/skills', readOnly: false, license: null, adopted: null, pending: null, job: null, ...overrides };
}

describe('sources', () => {
  it('accepts only https://github.com/<owner>/<repo>', () => {
    assert.equal(sourceUrlProblem('https://github.com/anthropics/skills'), undefined);
    assert.equal(sourceUrlProblem(' https://github.com/vercel-labs/skills.git '), undefined);
    for (const bad of ['', 'http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a', 'git@github.com:a/b.git']) {
      assert.notEqual(sourceUrlProblem(bad), undefined, bad);
    }
  });

  it('names the button and says why it waits', () => {
    assert.equal(sourceButtonText(source()), 'Scarica');
    assert.equal(sourceButtonText(source({ adopted: { ...version, adoptedAt: null } })), 'Aggiorna');
    assert.equal(sourceButtonText(source({ job: { status: 'running', phase: 'download', startedAt: '', finishedAt: null, outcome: null, error: null } })), 'Scarico…');
    assert.equal(sourceBlocked(source()), undefined);
    assert.match(sourceBlocked(source({ pending: { ...version, diff: none } })) ?? '', /usa o scarta/);
    assert.match(sourceBlocked(source({ readOnly: true })) ?? '', /Open Design/);
    assert.equal(shouldPollSkills({ sources: [source(), source({ job: { status: 'running', phase: 'index', startedAt: '', finishedAt: null, outcome: null, error: null } })], suggestions: [] }), true);
    assert.equal(shouldPollSkills({ sources: [source()], suggestions: [] }), false);
  });

  it('says changes and licenses in Italian', () => {
    assert.equal(skillChangesText({ ...none, added: 3, changed: 1 }), '3 nuove, 1 cambiata, 0 tolte');
    assert.equal(sourceLicenseText(source({ license: { name: 'MIT', file: 'LICENSE' } })), 'licenza MIT');
    assert.match(sourceLicenseText(source({ license: { name: null, file: null } })), /quella di ciascuna skill/);
    assert.equal(skillLicenseText('see skills/docx/LICENSE.txt'), 'vedi skills/docx/LICENSE.txt');
    assert.match(skillLicenseText(null), /i diritti restano agli autori/);
    assert.equal(otherFilesText(0), undefined);
    assert.match(otherFilesText(59) ?? '', /^59 altri file .*mai scaricati né eseguiti$/);
  });
});

describe('skills', () => {
  const skills: SkillSummary[] = [
    { id: 'anthropics/skills/pdf', source: 'anthropics/skills', slug: 'pdf', name: 'pdf', description: 'Fill and read PDF forms', license: 'Proprietary', otherFiles: 10 },
    { id: 'mattpocock/skills/tdd', source: 'mattpocock/skills', slug: 'tdd', name: 'tdd', description: 'Test-driven development', license: 'MIT', otherFiles: 0 },
  ];

  it('filters on name, id, description and license', () => {
    assert.deepEqual(filterSkills(skills, 'mit').map((item) => item.slug), ['tdd']);
    assert.deepEqual(filterSkills(skills, 'anthropics pdf').map((item) => item.slug), ['pdf']);
    assert.equal(filterSkills(skills, '  ').length, 2);
  });

  it('adds a skill once, at the end, and removes it', () => {
    assert.deepEqual(withSkill(['a/b/c'], 'a/b/d'), ['a/b/c', 'a/b/d']);
    assert.deepEqual(withSkill(['a/b/c'], 'a/b/c'), ['a/b/c']);
    assert.deepEqual(withoutSkill(['a/b/c', 'a/b/d'], 'a/b/c'), ['a/b/d']);
  });

  it('says why an agent takes no skills', () => {
    assert.equal(skillRefusalText(null), undefined);
    assert.match(skillRefusalText('Arianna reads no skills: third-party text is never an instruction to her') ?? '', /^Arianna non riceve skill/);
    assert.match(skillRefusalText('the card of this agent closes untrusted_content: it reads no third-party text') ?? '', /untrusted_content chiuso/);
    assert.match(skillRefusalText(undefined) ?? '', /non conosce questo agente/);
  });

  it('turns the refusals of the core into Italian', () => {
    assert.equal(skillsErrorText(new ApiError(409, 'this source is already followed')), 'Questa sorgente c’è già.');
    assert.match(skillsErrorText(new ApiError(400, 'the address must be https://github.com/<owner>/<repo>')), /^Solo https/);
    assert.match(skillsErrorText(new ApiError(404, 'not found')), /riavvialo/);
  });
});
