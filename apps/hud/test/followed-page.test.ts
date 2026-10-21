// «Seguiti» (D-272): the rows of the catalogs, from the statuses the page reads, and the links.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentSource, AgentsStatus } from '../src/lib/agents-catalog.ts';
import { CATALOG_PLACES, catalogRows, OPEN_DESIGN_PLACE } from '../src/lib/followed-page.ts';
import { groupOf } from '../src/lib/nav-groups.ts';
import { FOLLOWED_PATH, isFollowedPath } from '../src/lib/route.ts';
import type { SkillSource, SkillsStatus } from '../src/lib/skills-catalog.ts';

const version = (committedAt: string | null) => ({ commit: 'a'.repeat(40), committedAt, fetchedAt: '2026-10-20T10:00:00Z', skills: 3, rejected: 0 });
const diff = { added: 0, removed: 0, changed: 0, addedSlugs: [], changedSlugs: [], removedSlugs: [] };

const skill = (overrides: Partial<SkillSource>): SkillSource => ({ id: 'anthropics/skills', page: 'https://github.com/anthropics/skills', readOnly: false, license: null, adopted: null, pending: null, job: null, ...overrides });

const agent = (overrides: Partial<AgentSource>): AgentSource => ({
  id: 'msitarzewski/agency-agents',
  page: 'https://github.com/msitarzewski/agency-agents',
  license: null,
  adopted: null,
  pending: null,
  job: null,
  queued: false,
  queueError: null,
  ...overrides,
});

const agentVersion = (committedAt: string) => ({ commit: 'b'.repeat(40), committedAt, fetchedAt: committedAt, roles: 10, divisions: 2, rejected: 0, bytes: 1 });

describe('the catalogs on the page «Seguiti»', () => {
  it('lists skills then agents, with the version in use and the one waiting', () => {
    const skills: SkillsStatus = {
      sources: [
        skill({ id: 'nexu-io/open-design', readOnly: true }),
        skill({ adopted: { ...version('2026-10-02T10:00:00Z'), adoptedAt: null }, pending: { ...version('2026-10-20T10:00:00Z'), diff } }),
      ],
      suggestions: [],
    };
    const agents: AgentsStatus = {
      sources: [
        agent({ queued: true }),
        agent({ id: 'a/b', page: 'https://github.com/a/b', adopted: { ...agentVersion('2026-10-03T10:00:00Z'), adoptedAt: null }, job: { status: 'running', phase: 'download', startedAt: 'x', finishedAt: null, outcome: null, error: null } }),
      ],
      suggestions: [],
      ignored: [],
      limits: { sources: 2, maxSources: 100, bytes: 0, maxBytes: 1 },
    };
    const rows = catalogRows(skills, agents);
    assert.deepEqual(
      rows.map((row) => [row.kind, row.id]),
      [
        ['skills', 'anthropics/skills'],
        ['agents', 'msitarzewski/agency-agents'],
        ['agents', 'a/b'],
      ],
    );
    assert.equal(rows[0]?.inUse, 'in uso la versione del 2 ottobre 2026');
    assert.equal(rows[0].pending, 'in attesa la versione del 20 ottobre 2026');
    assert.equal(rows[1]?.inUse, 'non ancora scaricata');
    assert.equal(rows[1].pending, null);
    assert.equal(rows[1].job, 'in coda per il download');
    assert.equal(rows[2]?.job, 'download in corso');
  });

  it('a status that did not load gives no rows, a version without a date says so', () => {
    assert.deepEqual(catalogRows(null, null), []);
    const rows = catalogRows({ sources: [skill({ adopted: { ...version(null), adoptedAt: null }, job: { status: 'failed', phase: null, startedAt: 'x', finishedAt: 'y', outcome: null, error: 'x' } })], suggestions: [] }, null);
    assert.equal(rows[0]?.inUse, 'in uso la versione scaricata');
    assert.equal(rows[0].job, 'ultimo download non riuscito');
  });

  it('a version waiting with no date says so', () => {
    const rows = catalogRows({ sources: [skill({ adopted: { ...version('2026-10-02T10:00:00Z'), adoptedAt: null }, pending: { ...version(null), diff } })], suggestions: [] }, null);
    assert.equal(rows[0]?.pending, 'in attesa la versione scaricata');
  });

  it('links to the sections of the settings and has its own address in the system group', () => {
    assert.equal(CATALOG_PLACES.skills.path, '/impostazioni/skill-e-stili');
    assert.equal(CATALOG_PLACES.agents.path, '/impostazioni/catalogo-agenti');
    assert.equal(OPEN_DESIGN_PLACE.path, '/impostazioni/skill-e-stili');
    assert.equal(FOLLOWED_PATH, '/seguiti');
    assert.equal(isFollowedPath('/seguiti/'), true);
    assert.equal(isFollowedPath('/seguiti/x'), false);
    assert.equal(groupOf('followed'), 'system');
  });
});
