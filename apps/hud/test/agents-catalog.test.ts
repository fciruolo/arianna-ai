// «Catalogo agenti» in the settings (D-079): buttons, queue, license, changes, filters, errors, and the rows of the common list.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  agentJobErrorText,
  agentLicenseText,
  agentsErrorText,
  agentSourceBlocked,
  agentSourceButtonText,
  agentSourceSummaryText,
  catalogPresetOf,
  divisionCounts,
  limitsText,
  filterRoles,
  roleChangesText,
  roleCardName,
  roleLicenseText,
  rolesText,
  roleUnlicensed,
  shouldPollAgents,
  spaceText,
  type AgentRoleSummary,
  type AgentSource,
  type AgentsStatus,
} from '../src/lib/agents-catalog.ts';
import { ApiError } from '../src/lib/api.ts';
import { resolveSection, hrefOf, SETTINGS_INDEX } from '../src/lib/settings-index.ts';
import { agentSourceRow, skillSourceRow } from '../src/lib/source-list.ts';
import type { SkillSource } from '../src/lib/skills-catalog.ts';

const version = { commit: 'a'.repeat(40), committedAt: '2026-10-04T10:00:00Z', fetchedAt: '2026-10-10T08:00:00Z', roles: 231, divisions: 18, rejected: 2, bytes: 3_000_000 };
const none = { added: 0, removed: 0, changed: 0, addedSlugs: [], removedSlugs: [], changedSlugs: [] };
const running = { status: 'running' as const, phase: 'download' as const, startedAt: '2026-10-13T09:00:00Z', finishedAt: null, outcome: null, error: null };

function source(overrides: Partial<AgentSource> = {}): AgentSource {
  return { id: 'acme/agents', page: 'https://github.com/acme/agents', license: null, adopted: null, pending: null, job: null, queued: false, queueError: null, ...overrides };
}

function status(sources: AgentSource[]): AgentsStatus {
  return { sources, suggestions: [], ignored: [], limits: { sources: sources.length, maxSources: 100, bytes: 0, maxBytes: 512 * 1024 * 1024 } };
}

const roles: AgentRoleSummary[] = [
  { id: 'acme/agents/code-reviewer', source: 'acme/agents', slug: 'code-reviewer', division: 'engineering', name: 'Code Reviewer', description: 'Reviews invented code.', emoji: null, license: 'MIT', licenseFile: 'LICENSE' },
  { id: 'acme/agents/frontend', source: 'acme/agents', slug: 'frontend', division: 'engineering', name: 'Frontend Developer', description: 'Builds pages.', emoji: null, license: 'MIT', licenseFile: 'LICENSE' },
  { id: 'studio/legal/contract-reviewer', source: 'studio/legal', slug: 'contract-reviewer', division: 'legale', name: 'Revisore dei contratti', description: 'Legge contratti inventati.', emoji: null, license: null, licenseFile: null },
];

describe('a source', () => {
  it('says Scarica the first time, then Aggiorna; what runs or waits in the queue', () => {
    assert.equal(agentSourceButtonText(source()), 'Scarica');
    assert.equal(agentSourceButtonText(source({ adopted: { ...version, adoptedAt: null } })), 'Aggiorna');
    assert.equal(agentSourceButtonText(source({ job: running })), 'Scarico…');
    assert.equal(agentSourceButtonText(source({ queued: true })), 'In coda…');
    assert.equal(agentSourceBlocked(source()), undefined);
    assert.match(agentSourceBlocked(source({ queued: true })) ?? '', /coda/);
    assert.match(agentSourceBlocked(source({ pending: { ...version, diff: none } })) ?? '', /usa o scarta/);
  });

  it('polls while a download runs or waits, not otherwise', () => {
    assert.equal(shouldPollAgents(null), false);
    assert.equal(shouldPollAgents(status([source()])), false);
    assert.equal(shouldPollAgents(status([source({ job: running })])), true);
    assert.equal(shouldPollAgents(status([source({ queued: true })])), true);
  });

  it('before the first download says the license is not known yet, without a warning; without one at the root, a warning', () => {
    assert.deepEqual(agentLicenseText(source()), { text: 'licenza: si saprà al primo download', warn: false });
    assert.deepEqual(agentLicenseText(source({ license: { name: 'MIT', file: 'LICENSE' } })), { text: 'licenza MIT', warn: false });
    assert.equal(agentLicenseText(source({ license: { name: null, file: null } })).warn, true);
  });

  it('sums up roles, divisions and day, never the commit; the changes as the preview says them', () => {
    assert.equal(agentSourceSummaryText(source()), 'non ancora scaricata');
    const text = agentSourceSummaryText(source({ adopted: { ...version, adoptedAt: null } }));
    assert.match(text, /^231 ruoli in 18 divisioni · versione del /);
    assert.doesNotMatch(text, /aaaa/);
    assert.equal(roleChangesText({ ...none, added: 12, changed: 3, removed: 1 }), '+12 ruoli, 3 modificati, 1 tolto');
    assert.equal(roleChangesText({ ...none, added: 1 }), '+1 ruolo, 0 modificati, 0 tolti');
    assert.equal(spaceText(13_002_000, 512 * 1024 * 1024), '12,4 MiB su 512 MiB');
    // One is singular, every count (D-079, prova della tappa 2).
    assert.equal(limitsText({ sources: 1, maxSources: 100, bytes: 0, maxBytes: 512 * 1024 * 1024 }), '1 raccolta su 100 · spazio 0 MiB su 512 MiB');
    assert.equal(limitsText({ sources: 3, maxSources: 100, bytes: 0, maxBytes: 512 * 1024 * 1024 }), '3 raccolte su 100 · spazio 0 MiB su 512 MiB');
    assert.equal(rolesText(1, 1), '1 ruolo in 1 divisione');
    assert.equal(rolesText(259, 16), '259 ruoli in 16 divisioni');
    assert.match(agentSourceSummaryText(source({ adopted: { ...version, roles: 1, divisions: 1, adoptedAt: null } })), /^1 ruolo in 1 divisione · /);
    assert.match(agentSourceRow(source({ pending: { ...version, roles: 1, divisions: 1, diff: none } })).pending?.title ?? '', /, 1 ruolo in 1 divisione$/);
    // The day of a version is the day of its commit, never of the download or of the adoption.
    const dated = agentSourceSummaryText(source({ adopted: { ...version, committedAt: '2026-10-07T09:00:00Z', fetchedAt: '2026-10-13T12:00:00Z', adoptedAt: '2026-10-13T12:05:00Z' } }));
    assert.match(dated, /versione del 7 ottobre 2026$/);
  });
});

describe('the rows of the list', () => {
  it('a version waiting: title, changes, warning on the agents already made, details only after the first', () => {
    const first = agentSourceRow(source({ pending: { ...version, diff: { ...none, added: 231, addedSlugs: ['a'] } } }));
    assert.match(first.pending?.title ?? '', /^Scaricata: .*, 231 ruoli in 18 divisioni$/);
    assert.equal(first.pending?.warn, undefined);
    assert.deepEqual(first.pending?.details, []);
    const next = agentSourceRow(
      source({ adopted: { ...version, adoptedAt: null }, license: { name: 'MIT', file: 'LICENSE' }, pending: { ...version, diff: { ...none, added: 12, changed: 3, removed: 1, changedSlugs: ['revisore-contratti'] } } }),
    );
    assert.equal(next.pending?.changes, '+12 ruoli, 3 modificati, 1 tolto');
    assert.match(next.pending.warn ?? '', /non cambiano/);
    assert.deepEqual(next.pending.details.map((group) => group.label), ['Nuovi', 'Modificati', 'Tolti']);
    assert.match(next.pending.rejected ?? '', /^2 file scartati/);
  });

  it('a queued source says so; a failed download says why, the space too', () => {
    assert.match(agentSourceRow(source({ queued: true })).progress?.text ?? '', /^In coda/);
    assert.match(agentSourceRow(source({ job: { ...running, status: 'failed', phase: null, error: 'the catalog of agents would take 600 MiB, more than 512 MiB' } })).failure ?? '', /spazio massimo/);
    assert.match(agentJobErrorText('the gateway did not let the request out: no'), /gateway/);
    assert.match(agentSourceRow(source({ queueError: 'Prima usa o scarta la versione scaricata.' })).failure ?? '', /^Non è partita dalla coda/);
  });

  it('the skills keep their texts in the common list', () => {
    const skill: SkillSource = { id: 'acme/skills', page: 'https://github.com/acme/skills', readOnly: false, license: null, adopted: null, pending: null, job: null };
    const row = skillSourceRow(skill);
    assert.deepEqual(row.button, { text: 'Scarica', primary: true });
    assert.equal(row.note, undefined);
    const skillVersion = { commit: 'b'.repeat(40), committedAt: '2026-10-01T10:00:00Z', fetchedAt: '2026-10-10T08:00:00Z', skills: 20, rejected: 3 };
    assert.equal(skillSourceRow({ ...skill, job: running }).progress?.text, 'Scarico da GitHub solo i testi delle skill e le licenze…');
    assert.equal(skillSourceRow({ ...skill, job: { ...running, phase: 'index' } }).progress?.text, 'Leggo nomi e descrizioni…');
    assert.deepEqual(skillSourceRow({ ...skill, job: { ...running, status: 'done', phase: null, outcome: 'unchanged' } }).progress, { text: 'Nessuna novità: la versione in uso è la più recente.', ok: true });
    assert.match(skillSourceRow({ ...skill, job: { ...running, status: 'failed', phase: null, error: 'the gateway did not let the request out: no' } }).failure ?? '', /gateway/);
    const first = skillSourceRow({ ...skill, pending: { ...skillVersion, diff: { ...none, added: 20, addedSlugs: ['a'] } } });
    assert.match(first.pending?.title ?? '', /^Scaricata: .*, 20 skill$/);
    assert.match(first.pending?.rejected ?? '', /^3 file scartati/);
    assert.deepEqual(first.pending?.details, []);
    const next = skillSourceRow({ ...skill, adopted: { ...skillVersion, adoptedAt: null }, pending: { ...skillVersion, diff: { ...none, changed: 1, changedSlugs: ['alpha'] } } });
    assert.match(next.pending?.title ?? '', /^Versione nuova: /);
    assert.equal(next.pending?.changes, '0 nuove, 1 cambiata, 0 tolte');
    assert.deepEqual(next.pending.details.map((group) => group.label), ['Nuove', 'Cambiate', 'Tolte']);
    assert.equal(next.pending.warn, undefined);
    const design = skillSourceRow({ ...skill, id: 'nexu-io/open-design', readOnly: true });
    assert.equal(design.button, undefined);
    assert.match(design.readOnlyText ?? '', /Open Design/);
  });
});

describe('roles', () => {
  it('filters by words, division and source; counts the divisions', () => {
    assert.deepEqual(filterRoles(roles, 'code reviewer').map((role) => role.slug), ['code-reviewer']);
    assert.deepEqual(filterRoles(roles, '', 'engineering').map((role) => role.slug), ['code-reviewer', 'frontend']);
    assert.deepEqual(filterRoles(roles, '', '', 'studio/legal').map((role) => role.slug), ['contract-reviewer']);
    assert.deepEqual(filterRoles(roles, 'contratti', 'engineering'), []);
    assert.equal(roleLicenseText({ license: 'MIT', licenseFile: 'LICENSE' }), 'licenza MIT');
    // A license file whose license is not recognised by name is still a license, never «senza licenza».
    assert.equal(roleLicenseText({ license: null, licenseFile: 'LICENSE.md' }), 'licenza in LICENSE.md della raccolta');
    assert.equal(roleLicenseText({ license: null, licenseFile: null }), 'senza licenza alla radice della raccolta');
    assert.deepEqual(divisionCounts(roles), [
      { division: 'engineering', count: 2 },
      { division: 'legale', count: 1 },
    ]);
  });
});

describe('a new agent from a role', () => {
  it('starts from the preset of the division, the slug as name within 40 characters, and asks only without a license', () => {
    assert.equal(catalogPresetOf('engineering'), 'code');
    assert.equal(catalogPresetOf('testing'), 'code');
    for (const division of ['marketing', 'legale', 'general', '__proto__']) assert.equal(catalogPresetOf(division), 'answer', division);
    assert.equal(roleCardName('code-reviewer'), 'code-reviewer');
    assert.equal(roleCardName('engineering-autonomous-optimization-architect-of-everything'), 'engineering-autonomous-optimization-arch');
    assert.equal(roleCardName(`${'a'.repeat(39)}-b`), 'a'.repeat(39));
    assert.equal(roleUnlicensed({ license: null, licenseFile: null }), true);
    assert.equal(roleUnlicensed({ license: null, licenseFile: 'LICENSE.md' }), false);
    assert.equal(roleUnlicensed({ license: 'MIT', licenseFile: 'LICENSE' }), false);
  });
});

describe('errors and the section', () => {
  it('turns the refusals of the core into Italian', () => {
    assert.match(agentsErrorText(new ApiError(409, 'this source already waits for its download')), /già in coda/);
    assert.match(agentsErrorText(new ApiError(400, 'at most 100 sources')), /100/);
    assert.match(agentsErrorText(new ApiError(404, 'not found')), /non ha il catalogo agenti/);
  });

  it('«Catalogo agenti» comes right after «Skill e stili»', () => {
    const items = SETTINGS_INDEX.flatMap((group) => group.items);
    const at = items.findIndex((item) => item.id === 'skills');
    assert.equal(items[at + 1]?.id, 'agents-catalog');
    assert.equal(hrefOf(resolveSection('catalogo-agenti').item), '/impostazioni/catalogo-agenti');
  });
});
