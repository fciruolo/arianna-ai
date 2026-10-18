// The user's own skills of Claude Code in the catalog of skills (D-255): fake configuration folders in
// data/test-tmp, pointed at with CLAUDE_CONFIG_DIR; never the user's real folder.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { isCatalogFragment } from '@arianna/policy';

import { CLAUDE_SOURCE, claudeSkillsDir, createClaudeSkills, MAX_CLAUDE_SKILL_BYTES } from '../src/claude-skills.ts';
import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import type { SafetyReports } from '../src/safety-reports.ts';
import { startApiServer } from '../src/server/http.ts';
import { CatalogError } from '../src/git-catalog.ts';
import { skillsPart, USER_SKILLS_SOURCE, type AgentSkills } from '../src/orchestrator/delegate.ts';
import { createSkillsCatalog, eventSkillId, isPublicSkill, OWN_SKILLS_PREAMBLE, ownSkillRefusal, PRIVATE_SKILL_REASON } from '../src/skills-catalog.ts';
import type { LoadedAgent } from '@arianna/agents';
import type { Task } from '../src/tasks.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `claude-skills-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const MIT = 'MIT License\n\nCopyright (c) 2026 Invented Person\n\nPermission is hereby granted, free of charge, to any person\n';

function skill(name: string, description: string, body = 'Invented steps.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A fake configuration of Claude Code with its skills, and a data/catalogs beside it. */
function setup(files: Record<string, string>): { config: string; catalogs: string; env: NodeJS.ProcessEnv } {
  const base = join(scratch, randomUUID());
  const config = join(base, 'claude-config');
  mkdirSync(join(config, 'skills'), { recursive: true });
  write(join(config, 'skills'), files);
  const catalogs = join(base, 'data', 'catalogs');
  mkdirSync(catalogs, { recursive: true });
  return { config, catalogs, env: { CLAUDE_CONFIG_DIR: config } };
}

const STARTING: Record<string, string> = {
  'lettere/SKILL.md': skill('lettere', 'Writes invented letters.', 'Sign as Mario Bianchi, Via Finta 1.'),
  'lettere/LICENSE': MIT,
  'lettere/scripts/send.sh': 'echo never\n',
  'lettere/reference/notes.md': 'never copied\n',
  'Report_Fake/SKILL.md': skill('report', 'Makes fake reports.'),
  'nofront/SKILL.md': '# No frontmatter\n',
  'empty/README.md': 'no skill here\n',
  '.hidden/SKILL.md': skill('hidden', 'Not read.'),
  'odd name/SKILL.md': skill('odd', 'A space in the name.'),
  'README.md': 'a file at the root: ignored\n',
};

describe('the folder of the configuration of Claude Code', () => {
  it('CLAUDE_CONFIG_DIR when set and absolute, else .claude in the home', () => {
    assert.equal(claudeSkillsDir({ CLAUDE_CONFIG_DIR: join(scratch, 'cfg') }, join(scratch, 'home')), join(scratch, 'cfg', 'skills'));
    assert.equal(claudeSkillsDir({}, join(scratch, 'home')), join(scratch, 'home', '.claude', 'skills'));
    assert.equal(claudeSkillsDir({ CLAUDE_CONFIG_DIR: '' }, join(scratch, 'home')), join(scratch, 'home', '.claude', 'skills'));
    assert.throws(() => claudeSkillsDir({ CLAUDE_CONFIG_DIR: 'relative/dir' }, join(scratch, 'home')), (error: unknown) => error instanceof CatalogError && error.code === 'invalid');
    assert.throws(() => claudeSkillsDir({}, ''), CatalogError);
  });
});

describe('import, update and remove', () => {
  it('copies only each SKILL.md and its license, never scripts nor resources; prints no text', () => {
    const { catalogs, env } = setup(STARTING);
    const events: [string, Record<string, string | number>][] = [];
    const own = createClaudeSkills({ dir: catalogs, env, home: '/nowhere', onEvent: (kind, payload) => events.push([kind, payload]) });
    assert.equal(own.status().imported, false);
    const status = own.import();
    assert.equal(status.imported, true);
    assert.deepEqual(status.skills.map((item) => [item.id, item.label]), [
      [`${CLAUDE_SOURCE}/report-fake`, 'L2'],
      [`${CLAUDE_SOURCE}/lettere`, 'L2'],
    ]);
    const lettere = status.skills.find((item) => item.slug === 'lettere');
    assert.equal(lettere?.license, 'MIT');
    assert.equal(lettere.otherFiles, 2, 'the script and the note are counted');
    assert.deepEqual(status.rejected.map((item) => item.reason).sort(), ['no SKILL.md', 'no frontmatter', 'unusual characters in the name']);
    // On the disk: SKILL.md and LICENSE only.
    const files = join(catalogs, 'skills-claude', 'files');
    assert.deepEqual(readdirSync(join(files, 'lettere')).sort(), ['LICENSE', 'SKILL.md']);
    assert.deepEqual(readdirSync(join(files, 'report-fake')), ['SKILL.md']);
    assert.equal(existsSync(join(files, 'hidden')), false);
    // The events carry counts only.
    assert.deepEqual(events, [['skills-claude.imported', { skills: 2, rejected: 3 }]]);
    assert.equal(JSON.stringify(events).includes('Bianchi'), false);
  });

  it('refuses symbolic links: the skills folder, a skill folder, a SKILL.md', () => {
    const { config, catalogs, env } = setup({ 'vera/SKILL.md': skill('vera', 'Real folder.') });
    const outside = join(dirname(config), 'outside');
    write(outside, { 'SKILL.md': skill('fuori', 'Outside.'), 'linked/SKILL.md': skill('linked', 'Linked folder.') });
    symlinkSync(join(outside, 'linked'), join(config, 'skills', 'collegata'));
    mkdirSync(join(config, 'skills', 'file-collegato'));
    symlinkSync(join(outside, 'SKILL.md'), join(config, 'skills', 'file-collegato', 'SKILL.md'));
    const own = createClaudeSkills({ dir: catalogs, env, home: '/nowhere' });
    const status = own.import();
    assert.deepEqual(status.skills.map((item) => item.slug), ['vera']);
    assert.deepEqual(status.rejected.map((item) => `${item.path}: ${item.reason}`).sort(), ['collegata: symbolic link', 'file-collegato/SKILL.md: symbolic link']);
    // The skills folder itself a link: nothing read.
    const linked = setup({});
    rmSync(join(linked.config, 'skills'), { recursive: true });
    symlinkSync(join(config, 'skills'), join(linked.config, 'skills'));
    assert.throws(() => createClaudeSkills({ dir: linked.catalogs, env: linked.env, home: '/nowhere' }).import(), /symbolic link/);
  });

  it('refuses a missing folder and a SKILL.md too large; nothing is written then', () => {
    const missing = setup({});
    rmSync(join(missing.config, 'skills'), { recursive: true });
    assert.throws(() => createClaudeSkills({ dir: missing.catalogs, env: missing.env, home: '/nowhere' }).import(), (error: unknown) => error instanceof CatalogError && error.code === 'not-found');
    assert.equal(existsSync(join(missing.catalogs, 'skills-claude')), false);
    const large = setup({ 'grande/SKILL.md': skill('grande', 'Too large.', 'x'.repeat(MAX_CLAUDE_SKILL_BYTES)) });
    const status = createClaudeSkills({ dir: large.catalogs, env: large.env, home: '/nowhere' }).import();
    assert.deepEqual(status.skills, []);
    assert.match(status.rejected[0]?.reason ?? '', /larger than/);
  });

  it('«Aggiorna» reads the folder again; «Togli» deletes the copy and leaves the folder of Claude Code as it is', () => {
    const { config, catalogs, env } = setup(STARTING);
    const own = createClaudeSkills({ dir: catalogs, env, home: '/nowhere' });
    own.import();
    rmSync(join(config, 'skills', 'Report_Fake'), { recursive: true });
    write(join(config, 'skills'), { 'nuova/SKILL.md': skill('nuova', 'A new one.') });
    assert.deepEqual(own.import().skills.map((item) => item.slug), ['lettere', 'nuova']);
    assert.equal(existsSync(join(catalogs, 'skills-claude', 'files', 'report-fake')), false);
    const removed = own.remove();
    assert.equal(removed.imported, false);
    assert.equal(existsSync(join(catalogs, 'skills-claude')), false);
    assert.equal(readFileSync(join(config, 'skills', 'lettere', 'SKILL.md'), 'utf8').includes('Bianchi'), true, 'the source is untouched');
  });
});

describe('private until marked shareable, one by one', () => {
  it('L2 by default; L1 for the exact text marked; a changed text is private again', () => {
    const { config, catalogs, env } = setup(STARTING);
    const own = createClaudeSkills({ dir: catalogs, env, home: '/nowhere' });
    own.import();
    assert.equal(own.labelOf('lettere'), 'L2');
    const sha = (slug: string): string => own.status().skills.find((item) => item.slug === slug)?.sha256 ?? '';
    // Sharing names the text the user read: none, or another one, is refused.
    assert.throws(() => own.share('lettere', true), /changed since you read it/);
    assert.throws(() => own.share('lettere', true, 'f'.repeat(64)), (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
    assert.equal(own.labelOf('lettere'), 'L2');
    own.share('lettere', true, sha('lettere'));
    assert.equal(own.labelOf('lettere'), 'L1');
    assert.equal(own.labelOf('report-fake'), 'L2', 'one by one');
    own.import();
    assert.equal(own.labelOf('lettere'), 'L1', 'the same text keeps its mark');
    write(join(config, 'skills'), { 'lettere/SKILL.md': skill('lettere', 'Writes invented letters.', 'Changed text.') });
    own.import();
    assert.equal(own.labelOf('lettere'), 'L2', 'a changed text is private again');
    own.share('lettere', true, sha('lettere'));
    own.share('lettere', false);
    assert.equal(own.labelOf('lettere'), 'L2');
    assert.throws(() => own.share('nessuna', true, sha('lettere')), (error: unknown) => error instanceof CatalogError && error.code === 'not-found');
    assert.throws(() => own.share('lettere', 'yes'), CatalogError);
    assert.throws(() => own.share('../x', true), CatalogError);
  });

  it('a copy changed on the disk after the import is refused', () => {
    const { catalogs, env } = setup(STARTING);
    const own = createClaudeSkills({ dir: catalogs, env, home: '/nowhere' });
    own.import();
    writeFileSync(join(catalogs, 'skills-claude', 'files', 'lettere', 'SKILL.md'), skill('lettere', 'Tampered.'));
    assert.throws(() => own.read('lettere'), /changed on the disk/);
  });
});

describe('in the catalog of skills and in a delivery', () => {
  function catalog(): { catalogs: string; skills: ReturnType<typeof createSkillsCatalog> } {
    const { catalogs, env } = setup(STARTING);
    const skills = createSkillsCatalog({ dir: catalogs, gateway: () => Promise.resolve(), claudeConfig: { env, home: '/nowhere' }, assigned: () => [`${CLAUDE_SOURCE}/lettere`, `${CLAUDE_SOURCE}/report-fake`], refusal: () => null });
    skills.claude?.import();
    return { catalogs, skills };
  }

  it('listed with their label; no personal skill without claudeConfig', () => {
    const { skills } = catalog();
    assert.deepEqual(
      skills.list().skills.map((item) => [item.id, item.label]),
      [
        [`${CLAUDE_SOURCE}/lettere`, 'L2'],
        [`${CLAUDE_SOURCE}/report-fake`, 'L2'],
      ],
    );
    assert.equal(skills.labelOf(`${CLAUDE_SOURCE}/lettere`), 'L2');
    assert.equal(skills.labelOf('anthropics/skills/pdf'), 'L0');
    assert.equal(skills.text(`${CLAUDE_SOURCE}/lettere`).label, 'L2');
    const plain = createSkillsCatalog({ dir: join(scratch, 'plain'), gateway: () => Promise.resolve() });
    assert.equal(plain.claude, undefined);
    assert.throws(() => plain.text(`${CLAUDE_SOURCE}/lettere`), CatalogError);
  });

  it('the id of the source is never a repository to follow', () => {
    const { skills } = catalog();
    assert.throws(() => skills.add('https://github.com/local/claude-code'), (error: unknown) => error instanceof CatalogError && error.code === 'conflict');
  });

  it('a private skill never reaches a delivery up to L1; a shared one does, in its own block at L1, never marked as catalog text', () => {
    const { skills } = catalog();
    const cloud = skills.skillTexts('coder', [], undefined, undefined, 'L1');
    assert.equal(cloud.own, undefined);
    assert.equal(cloud.block, undefined);
    assert.deepEqual(cloud.skipped.map((item) => item.reason), [PRIVATE_SKILL_REASON, PRIVATE_SKILL_REASON]);
    // Without a ceiling: L0, nothing personal.
    assert.equal(skills.skillTexts('coder').own, undefined);
    skills.claude?.share('lettere', true, skills.claude.status().skills.find((item) => item.slug === 'lettere')?.sha256);
    const shared = skills.skillTexts('coder', [], undefined, undefined, 'L1');
    assert.equal(shared.own?.label, 'L1');
    assert.ok(shared.own.block.startsWith(OWN_SKILLS_PREAMBLE));
    assert.match(shared.own.block, /BEGIN USER SKILL local\/claude-code\/lettere/);
    assert.equal(shared.own.block.includes('Invented steps'), false);
    assert.equal(shared.block, undefined, 'the catalog block holds no personal skill');
    assert.equal(isCatalogFragment({ value: shared.own.block, label: 'L0', source: 'skills:coder' }), false, 'never exempt from the second check');
    // On this machine (ceiling L2): both, at L2.
    const local = skills.skillTexts('traduttore', [], undefined, undefined, 'L2');
    assert.equal(local.own?.label, 'L2');
    assert.equal(local.skipped.length, 0);
  });

  it('the events name the source of a personal skill, never its folder', () => {
    assert.equal(eventSkillId(`${CLAUDE_SOURCE}/lettere`), CLAUDE_SOURCE);
    assert.equal(eventSkillId('anthropics/skills/pdf'), 'anthropics/skills/pdf');
    const events: Record<string, string | number>[] = [];
    const { catalogs, env } = setup(STARTING);
    const skills = createSkillsCatalog({ dir: catalogs, gateway: () => Promise.resolve(), claudeConfig: { env, home: '/nowhere' }, assigned: () => [`${CLAUDE_SOURCE}/lettere`], onEvent: (kind, payload) => kind === 'skills.skipped' && events.push(payload) });
    skills.claude?.import();
    skills.skillTexts('coder', [], undefined, undefined, 'L1');
    assert.deepEqual(events, [{ agent: 'coder', skill: CLAUDE_SOURCE, reason: PRIVATE_SKILL_REASON }]);
  });

  it('isPublicSkill: only L0 goes to translations and safety reports', () => {
    assert.equal(isPublicSkill({ label: 'L0' }), true);
    assert.equal(isPublicSkill({ label: 'L1' }), false);
    assert.equal(isPublicSkill({ label: 'L2' }), false);
    const { skills } = catalog();
    assert.deepEqual(skills.list().skills.filter(isPublicSkill), []);
  });

  it('ownSkillRefusal: a skill above the ceiling of the agent is refused, the others are not', () => {
    assert.equal(ownSkillRefusal('L2', 'L1'), PRIVATE_SKILL_REASON);
    assert.equal(ownSkillRefusal('L1', 'L0'), 'above what this agent may read');
    assert.equal(ownSkillRefusal('L2', 'L2'), null);
    assert.equal(ownSkillRefusal('L1', 'L1'), null);
    assert.equal(ownSkillRefusal('L0', 'L0'), null);
    assert.equal(ownSkillRefusal(undefined, 'L0'), null);
  });
});

describe('skillsPart (delegate.ts)', () => {
  const agent = { card: { trifecta: { untrusted_content: true } } } as unknown as LoadedAgent;
  const task = { id: 't-1', assignee: 'coder', conversationId: null } as unknown as Task;
  const sql = undefined as unknown as Sql;
  const env = (skills: AgentSkills): Parameters<typeof skillsPart>[0] => ({ sql, skills: () => skills });

  it('the catalog block at L0 and the own block at its label, in a fragment of its own', async () => {
    const parts = await skillsPart(env({ block: 'catalog', own: { block: 'mine', label: 'L1' }, skipped: 0 }), { task, step: 1 }, agent, 'coder', 1000, 'L1');
    assert.deepEqual(parts, [
      { text: 'catalog', label: 'L0', source: 'skills:coder' },
      { text: 'mine', label: 'L1', source: `${USER_SKILLS_SOURCE}coder` },
    ]);
  });

  it('never an own block above the ceiling, whatever the catalog gives', async () => {
    const parts = await skillsPart(env({ block: undefined, own: { block: 'private', label: 'L2' }, skipped: 0 }), { task, step: 1 }, agent, 'coder', 1000, 'L1');
    assert.deepEqual(parts, []);
    const local = await skillsPart(env({ block: undefined, own: { block: 'private', label: 'L2' }, skipped: 0 }), { task, step: 1 }, agent, 'coder', 1000, 'L2');
    assert.deepEqual(local, [{ text: 'private', label: 'L2', source: `${USER_SKILLS_SOURCE}coder` }]);
  });

  it('the ceiling reaches the catalog', async () => {
    const seen: (string | undefined)[] = [];
    await skillsPart({ sql, skills: (_agent, _bytes, _card, ceiling) => (seen.push(ceiling), { block: undefined, skipped: 0 }) }, { task, step: 1 }, agent, 'coder', 1000, 'L1');
    assert.deepEqual(seen, ['L1']);
  });
});

describe('routes', () => {
  async function call(origin: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
      const request = httpRequest(`${origin}${path}`, { method, headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }

  it('import, share, remove; never a safety report (Opus) for a skill of the user own', async () => {
    const { catalogs, env } = setup(STARTING);
    const skills = createSkillsCatalog({ dir: catalogs, gateway: () => Promise.resolve(), claudeConfig: { env, home: '/nowhere' } });
    const never = (): never => assert.fail('a skill of the user own went to the safety reports');
    const safetyReports = { textView: never, ensureText: never, redoText: never } as unknown as SafetyReports;
    const api = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, skillsCatalog: skills, safetyReports });
    const origin = `http://127.0.0.1:${String(api.port)}`;
    try {
      assert.equal((await call(origin, 'GET', '/api/skills-catalog/claude')).body.imported, false);
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/claude/import', { extra: 1 })).status, 400);
      const imported = await call(origin, 'POST', '/api/skills-catalog/claude/import', {});
      assert.equal(imported.status, 200);
      assert.equal((imported.body.skills as unknown[]).length, 2);
      const id = encodeURIComponent(`${CLAUDE_SOURCE}/lettere`);
      const read = await call(origin, 'GET', `/api/skills-catalog/skill?id=${id}`);
      assert.equal(read.status, 200);
      assert.equal((read.body.skill as { label: string; safety?: unknown }).label, 'L2');
      assert.equal((read.body.skill as { safety?: unknown }).safety, undefined);
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/skill/safety', { id: `${CLAUDE_SOURCE}/lettere` })).status, 409);
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/claude/share', { skill: 'lettere', shared: 'yes' })).status, 400);
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/claude/share', { skill: 'nessuna', shared: true })).status, 404);
      const sha256 = (imported.body.skills as { slug: string; sha256: string }[]).find((item) => item.slug === 'lettere')?.sha256;
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/claude/share', { skill: 'lettere', shared: true })).status, 409, 'without the text read');
      const shared = await call(origin, 'POST', '/api/skills-catalog/claude/share', { skill: 'lettere', shared: true, sha256 });
      assert.equal((shared.body.skills as { slug: string; label: string }[]).find((item) => item.slug === 'lettere')?.label, 'L1');
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/skill/safety', { id: `${CLAUDE_SOURCE}/lettere` })).status, 409, 'shareable or not: no report');
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/sources', { url: 'https://github.com/local/claude-code' })).status, 409);
      assert.equal((await call(origin, 'POST', '/api/skills-catalog/claude/remove', {})).body.imported, false);
    } finally {
      await api.close();
    }
  });
});
