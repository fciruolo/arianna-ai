// The style and the skills of a Designer card (D-163), with the database:
// saved only on a Designer card and only from the adopted catalogs, given to
// the delivery of the card as L0 data, and a choice gone from the catalog
// written in the card's history while the card runs without it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { createClaudeExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';
import { forgetCatalogTexts, markCatalogText, piiReport } from '@arianna/policy';

import { loadApproval } from '../src/approvals.ts';
import { cardDetail } from '../src/card-details.ts';
import { CardError, createCard, startCard, updateCard, type CardNames } from '../src/cardwall.ts';
import { ChatError, createConversation, postUserMessage } from '../src/conversations.ts';
import type { DesignCatalog } from '../src/design-catalog.ts';
import { processStepJob, recordDecision, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import type { AgentSkills, CardDesign } from '../src/orchestrator/delegate.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { configurePiiGuard } from '../src/pii-guard.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { startApiServer } from '../src/server/http.ts';
import type { SkillsCatalog } from '../src/skills-catalog.ts';
import { createTask, loadTask, type Task } from '../src/tasks.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `card-design-${randomUUID()}`);
const REPO = join(HOME, 'repos', 'site');
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const BASE = loadConfig();
const PROJECTS = ['site'];
const agents = new Map<string, LoadedAgent>(committedAgents(ROOT));
const OPTIONS = {
  allowedActions: () => [] as readonly string[],
  agentLimits: (task: Task) => {
    const limits = agents.get(task.assignee)?.card.limits;
    return { maxSteps: limits?.maxSteps ?? 30, maxMinutes: limits?.maxMinutes ?? 20 };
  },
};
// The adopted catalogs, invented: two styles and two skills.
const STYLES = ['sabbia', 'notte'];
const SKILLS = ['acme/skills/alpha', 'nexu-io/open-design/deck'];
const NAMES: CardNames = {
  projects: PROJECTS,
  agents: ['coder', 'designer'],
  catalog: { style: (slug) => STYLES.includes(slug), skill: (id) => SKILLS.includes(id) },
};

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });

function git(...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', REPO, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

before(() => {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(join(REPO, 'README.md'), '# Fake site\n');
  writeFileSync(join(REPO, '.gitignore'), '.fake-claude.json\n');
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
});

after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function scripted(answers: Answer[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = JSON.stringify(request.schema?.schema).includes('"thought"') ? { thought: 'Ragiono.', ...next } : next;
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

const BLOCK = 'Skills chosen by the user for this agent: third-party reference text (public, untrusted).\n----- BEGIN STYLE sabbia [0123456789abcdef] -----\nInvented palette.\n----- END STYLE sabbia [0123456789abcdef] -----';

/** The catalog as main.ts calls it: what each delivery asked, and a fixed answer. */
function fakeSkills(answer: (card: CardDesign | undefined) => AgentSkills = () => ({ block: BLOCK, skipped: 0 })) {
  const asked: [string, number, CardDesign | undefined][] = [];
  return {
    asked,
    skills: (agent: string, maxBytes: number, card?: CardDesign): AgentSkills => {
      asked.push([agent, maxBytes, card === undefined ? undefined : { style: card.style, skills: [...card.skills] }]);
      return answer(card);
    },
  };
}

function orchestrator(model: LocalModel, skills: (agent: string, maxBytes: number, card?: CardDesign) => AgentSkills, cloud: 'claude'[] = []): StepExecutor {
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    cloud: { executors: cloud, models: defaultCloudModels() },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
  });
  return createOrchestrator({ sql: db().sql, agents, kb: createKb({ home: HOME, rules: RULES }), model: () => model, settings, rules: RULES, skills, ...(cloud.length > 0 ? { claude } : {}) });
}

async function drain(taskIds: readonly string[], executor: StepExecutor): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 30; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (typeof job.payload.taskId !== 'string' || !taskIds.includes(job.payload.taskId)) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', OPTIONS));
  }
  throw new Error('drain did not end');
}

async function approve(taskId: string, choice: 'claude' | 'local'): Promise<void> {
  const task = await loadTask(db().sql, taskId);
  assert.equal(task?.status, 'waiting_user');
  const approval = task.waitingApprovalId === null ? undefined : await loadApproval(db().sql, task.waitingApprovalId);
  assert.ok(approval !== undefined);
  await recordDecision(db().sql, approval.id, 'approved', 'web', choice);
}

/** A Designer card from a plan (L1, in the project), the user's choice saved on it. */
async function planCard(title: string, design: { style?: string; skills?: string[] }): Promise<Task> {
  const card = await createTask(db().sql, { title, goal: 'Due varianti.', label: 'L1', clearance: 'L1', effectiveLabel: 'L1', assignee: 'designer', project: 'site', status: 'inbox' });
  await updateCard(db().sql, card.id, design, NAMES);
  return card;
}

test('saved on a Designer card from the adopted catalogs; refused elsewhere; the label never moves (D-163)', async () => {
  const { sql } = db();
  const created = await createCard(sql, { title: 'Grafica del listino', assignee: 'designer', style: 'sabbia', skills: ['acme/skills/alpha', 'acme/skills/alpha'] }, NAMES);
  let detail = await cardDetail(sql, created.id);
  assert.deepEqual([detail.style, detail.skills], ['sabbia', ['acme/skills/alpha']]);

  // Not the Designer's card: refused, at creation and later.
  await assert.rejects(createCard(sql, { title: 'Codice', assignee: 'coder', style: 'sabbia' }, NAMES), /only for a card of the Designer/);
  await assert.rejects(createCard(sql, { title: 'Mia', skills: ['acme/skills/alpha'] }, NAMES), /only for a card of the Designer/);
  const coder = await createCard(sql, { title: 'Codice del listino', assignee: 'coder' }, NAMES);
  await assert.rejects(updateCard(sql, coder.id, { style: 'sabbia' }, NAMES), CardError);
  await assert.rejects(updateCard(sql, coder.id, { skills: ['acme/skills/alpha'] }, NAMES), CardError);
  // Empty is always fine.
  await updateCard(sql, coder.id, { style: null, skills: [] }, NAMES);

  // Only what the adopted catalogs hold, in its form.
  for (const bad of [{ style: 'nessuno' }, { style: '../x' }, { style: 7 }, { skills: ['acme/skills/nessuna'] }, { skills: 'acme/skills/alpha' }, { skills: ['Acme/skills/alpha'] }, { skills: ['acme/../alpha'] }]) {
    await assert.rejects(updateCard(sql, created.id, bad, NAMES), CardError, JSON.stringify(bad));
  }
  await assert.rejects(updateCard(sql, created.id, { skills: Array.from({ length: 11 }, (_, index) => `acme/skills/s${String(index)}`) }, { ...NAMES, catalog: { style: () => true, skill: () => true } }), /at most 10/);

  // A choice gone from the catalog stays written: other changes keep it.
  const gone: CardNames = { ...NAMES, catalog: { style: () => false, skill: () => false } };
  await updateCard(sql, created.id, { priority: 2, skills: ['acme/skills/alpha'] }, gone);
  detail = await cardDetail(sql, created.id);
  assert.deepEqual([detail.style, detail.skills], ['sabbia', ['acme/skills/alpha']]);
  await assert.rejects(updateCard(sql, created.id, { style: 'notte' }, gone), /no such style/);

  // From a plan, L1: choosing a style and skills does not raise the card; given to the Coder, they go away.
  const plan = await planCard('Grafica dal piano', { style: 'notte', skills: ['nexu-io/open-design/deck'] });
  assert.equal((await loadTask(sql, plan.id))?.label, 'L1');
  await updateCard(sql, plan.id, { assignee: 'coder' }, NAMES);
  detail = await cardDetail(sql, plan.id);
  assert.deepEqual([detail.style, detail.skills], [null, []]);
  assert.equal((await loadTask(sql, plan.id))?.label, 'L1');

  // The database: only on a card or in the direct chat with the Designer (D-184), never on a task of another chat; the form of each name.
  const conversation = await createConversation(sql, { mode: 'private' });
  const chatTask = await createTask(sql, { title: 'Di una chat', conversationId: conversation.id });
  await assert.rejects(sql`UPDATE tasks SET design_style = 'sabbia' WHERE id = ${chatTask.id}`, /tasks_design_only_designer/);
  await assert.rejects(sql`UPDATE tasks SET design_skills = ${['acme/skills/alpha']}::text[] WHERE id = ${chatTask.id}`, /tasks_design_only_designer/);
  await assert.rejects(sql`UPDATE tasks SET design_style = 'Sabbia Chiara' WHERE id = ${created.id}`, /check constraint/);
  await assert.rejects(sql`UPDATE tasks SET design_skills = ${['not a skill']}::text[] WHERE id = ${created.id}`, /check constraint/);
});

test('a Designer card on Claude: its style and skills reach the delivery as L0 data after the prompt; the brief leaves at the card’s label (D-163)', async () => {
  const card = await planCard('Grafica della landing', { style: 'sabbia', skills: ['acme/skills/alpha'] });
  const { asked, skills } = fakeSkills();
  const executor = orchestrator(scripted([]), skills, ['claude']);
  try {
    await startCard(db().sql, card.id);
    assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
    await approve(card.id, 'claude');
    assert.deepEqual(await drain([card.id], executor), ['continued', 'to-verify']);
    assert.deepEqual(asked, [['designer', 128 * 1024, { style: 'sabbia', skills: ['acme/skills/alpha'] }]]);
    const { prompt } = JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
    assert.match(prompt, /^You are the Designer/);
    assert.ok(prompt.includes(`\n\n${BLOCK}\n\n`), 'prompt, then the block');
    assert.ok(prompt.indexOf(BLOCK) < prompt.indexOf('Card: Grafica della landing'), 'the block before the brief');
    const log = await db().sql<{ label: string }[]>`SELECT label FROM gateway_log WHERE task_id = ${card.id} AND target = 'claude'`;
    assert.deepEqual([...log].map((row) => row.label), ['L1']);
    assert.equal((await loadTask(db().sql, card.id))?.status, 'to_verify');
  } finally {
    execFileSync('git', ['-C', REPO, 'clean', '--quiet', '-fd']);
  }
});

test('a Designer card on the local model: the block joins its instructions within the local limit (D-163)', async () => {
  const card = await createCard(db().sql, { title: 'Grafica privata', assignee: 'designer', goal: 'Una pagina.', style: 'notte' }, NAMES);
  const { asked, skills } = fakeSkills();
  const model = scripted([{ action: 'reply', text: 'Proposta in due varianti.' }]);
  const executor = orchestrator(model, skills, ['claude']);
  await startCard(db().sql, card.id);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  await approve(card.id, 'local');
  assert.deepEqual(await drain([card.id], executor), ['to-verify']);
  assert.deepEqual(asked, [['designer', 16 * 1024, { style: 'notte', skills: [] }]]);
  const system = String(model.requests[0]?.messages[0]?.content);
  assert.match(system, /^You are the Designer/);
  assert.ok(system.includes(`\n\n${BLOCK}`), 'after its prompt');
  assert.ok(!JSON.stringify(model.requests[0]?.messages.slice(1)).includes('BEGIN STYLE'), 'in the instructions, not in a turn');
});

test('a style or skill no longer in the catalog: the card runs without it and its history says so (D-163)', async () => {
  const card = await createCard(db().sql, { title: 'Grafica senza stile', assignee: 'designer', goal: 'Una pagina.', style: 'sabbia', skills: ['acme/skills/alpha'] }, NAMES);
  const { skills } = fakeSkills(() => ({ block: undefined, skipped: 1, styleSkipped: 'sabbia', cardSkipped: ['acme/skills/alpha'] }));
  const model = scripted([{ action: 'reply', text: 'Proposta senza stile.' }]);
  const executor = orchestrator(model, skills, []);
  await startCard(db().sql, card.id);
  assert.deepEqual(await drain([card.id], executor), ['waiting-approval']);
  await approve(card.id, 'local');
  assert.deepEqual(await drain([card.id], executor), ['to-verify']);
  assert.ok(!String(model.requests[0]?.messages[0]?.content).includes('BEGIN STYLE'));
  const detail = await cardDetail(db().sql, card.id);
  const skipped = detail.history.find((entry) => entry.kind === 'card.design-skipped');
  assert.deepEqual(skipped?.payload, { agent: 'designer', style: 'sabbia', skills: ['acme/skills/alpha'] });
  const [event] = await db().sql<{ label: string }[]>`SELECT label FROM events WHERE task_id = ${card.id} AND kind = 'card.design-skipped'`;
  assert.equal(event?.label, 'L0');
  // All delivered: nothing written.
  const fine = await createCard(db().sql, { title: 'Grafica con stile', assignee: 'designer', goal: 'Una pagina.', style: 'sabbia' }, NAMES);
  const ok = orchestrator(scripted([{ action: 'reply', text: 'Fatto.' }]), fakeSkills().skills, []);
  await startCard(db().sql, fine.id);
  await drain([fine.id], ok);
  await approve(fine.id, 'local');
  await drain([fine.id], ok);
  assert.equal((await db().sql`SELECT 1 FROM events WHERE task_id = ${fine.id} AND kind = 'card.design-skipped'`).length, 0);
});

test('a card of another agent never carries a choice to the delivery (D-163)', async () => {
  const card = await createCard(db().sql, { title: 'Codice privato', assignee: 'coder', project: 'site', goal: 'Una riga.' }, NAMES);
  // Written by hand in the database: the core reads it only for the Designer.
  await db().sql`UPDATE tasks SET design_style = 'sabbia' WHERE id = ${card.id}`;
  const { asked, skills } = fakeSkills(() => ({ block: undefined, skipped: 0 }));
  await startCard(db().sql, card.id);
  assert.deepEqual(await drain([card.id], orchestrator(scripted([{ action: 'reply', text: 'Fatto.' }]), skills, [])), ['to-verify']);
  assert.deepEqual(asked, [['coder', 16 * 1024, undefined]]);
});

test('the routes: style and skills only on a Designer card, only from the adopted catalogs (D-163)', async () => {
  const live = await startLiveFeed(db().sql);
  const designCatalog = { list: () => ({ commit: 'c', styles: STYLES.map((slug) => ({ slug, name: slug, description: '' })), skills: [] }) } as unknown as DesignCatalog;
  const skillsCatalog = { list: () => ({ skills: SKILLS.map((id) => ({ id })) }) } as unknown as SkillsCatalog;
  const server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    projects: () => [],
    agents: () => ['arianna', 'coder', 'designer'],
    projectContainers: () => [],
    designCatalog,
    skillsCatalog,
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (method: string, path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await send('POST', '/api/cards', { title: 'Grafica', assignee: 'designer', style: 'sabbia' });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { card: { id: string } }).card.id;
    assert.equal((await send('POST', `/api/cards/${id}`, { skills: ['nexu-io/open-design/deck'] })).status, 200);
    const detail = ((await (await fetch(`${base}/api/cards/${id}`)).json()) as { card: { style: string | null; skills: string[] } }).card;
    assert.deepEqual([detail.style, detail.skills], ['sabbia', ['nexu-io/open-design/deck']]);
    assert.equal((await send('POST', `/api/cards/${id}`, { style: 'inventato' })).status, 400);
    assert.equal((await send('POST', `/api/cards/${id}`, { skills: ['other/repo/skill'] })).status, 400);
    assert.equal((await send('POST', '/api/cards', { title: 'Codice', assignee: 'coder', style: 'sabbia' })).status, 400);
    const coder = ((await (await send('POST', '/api/cards', { title: 'Codice', assignee: 'coder' })).json()) as { card: { id: string } }).card.id;
    assert.equal((await send('POST', `/api/cards/${coder}`, { skills: ['acme/skills/alpha'] })).status, 400);
    assert.equal((await send('POST', `/api/cards/${id}`, { style: null, skills: [] })).status, 200);
    const cleared = ((await (await fetch(`${base}/api/cards/${id}`)).json()) as { card: { style: string | null; skills: string[] } }).card;
    assert.deepEqual([cleared.style, cleared.skills], [null, []]);
  } finally {
    await server.close();
    await live.close();
  }
});

/** The direct chat with the Designer of the project, as the Studio opens it (I-19, D-184). */
function designerChat() {
  return createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: { name: 'designer', modes: ['work'], project: true } });
}

test('the Studio: style and skills sent with a message of the direct chat with the Designer reach its delivery (D-184)', async () => {
  const { sql } = db();
  const direct = await designerChat();
  const { task } = await postUserMessage(sql, direct.id, 'Una landing in due varianti.', { design: { style: 'sabbia', skills: ['acme/skills/alpha'] } });
  const [row] = await sql<{ style: string | null; skills: string[]; label: string }[]>`SELECT design_style AS style, design_skills AS skills, label FROM tasks WHERE id = ${task.id}`;
  assert.deepEqual([row?.style, row?.skills], ['sabbia', ['acme/skills/alpha']]);
  assert.equal(row?.label, task.label, 'names of public text: the label never moves');
  const { asked, skills } = fakeSkills();
  try {
    await drain([task.id], orchestrator(scripted([]), skills, ['claude']));
    assert.deepEqual(asked, [['designer', 128 * 1024, { style: 'sabbia', skills: ['acme/skills/alpha'] }]]);
    const { prompt } = JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
    assert.ok(prompt.includes(`\n\n${BLOCK}\n\n`), 'after its prompt, as on a card');
    // The next message without a choice: nothing of the first one.
    const next = await postUserMessage(sql, direct.id, 'Ancora una.');
    const plain = fakeSkills();
    await drain([next.task.id], orchestrator(scripted([]), plain.skills, ['claude']));
    assert.deepEqual(plain.asked, [['designer', 128 * 1024, undefined]]);
    const resumed = JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
    assert.ok(!resumed.prompt.includes(BLOCK), 'a resumed session without a choice: only the new message');
    // A choice on a later message of the same session: it goes with the message (the session never saw the opening).
    const third = await postUserMessage(sql, direct.id, 'Ora con lo stile.', { design: { style: 'sabbia', skills: [] } });
    const styled = fakeSkills();
    await drain([third.task.id], orchestrator(scripted([]), styled.skills, ['claude']));
    const later = JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
    assert.ok(later.prompt.includes(BLOCK), 'the style reaches a resumed session');
    assert.ok(later.prompt.indexOf(BLOCK) < later.prompt.indexOf('Ora con lo stile.'), 'before the message');
  } finally {
    execFileSync('git', ['-C', REPO, 'clean', '--quiet', '-fd']);
  }
});

// A style whose brand the second scanner reads as a person, as Rizzo-PII read «xAI» (D-250).
const XAI_BLOCK = 'Skills chosen by the user for this agent: third-party reference text (public, untrusted).\n----- BEGIN STYLE x-ai [0123456789abcdef] -----\n# Design System Inspired by xAI\nInvented palette.\n----- END STYLE x-ai [0123456789abcdef] -----';

/** A fake Rizzo-PII: «xAI» and «Mario Bianchi» are persons wherever they are. */
function personGuard(): void {
  configurePiiGuard({
    state: 'ready',
    scan: (texts) =>
      Promise.resolve(
        piiReport(
          texts,
          texts.map((text) => ['xAI', 'Mario Bianchi'].flatMap((name) => [...text.matchAll(new RegExp(name, 'g'))].map((match) => ({ kind: 'FULLNAME', start: match.index, end: match.index + name.length, score: 0.97 })))),
        ),
      ),
    stop: () => Promise.resolve(),
  });
}

/** The catalog as skillTexts writes it: the block, marked for the skills of this agent (D-250); `mark: false` as before D-250. */
function xaiSkills(mark = true) {
  return fakeSkills(() => {
    if (mark) markCatalogText('skills:designer', XAI_BLOCK);
    return { block: XAI_BLOCK, skipped: 0 };
  });
}

test('the Studio with a style the second scanner took for a person: the brief reaches Claude; a person in the message still stops it, with Arianna\'s message (D-250)', async () => {
  const { sql } = db();
  const direct = await designerChat();
  personGuard();
  try {
    const { task } = await postUserMessage(sql, direct.id, 'Fai un\'altra versione.', { design: { style: 'sabbia', skills: [] } });
    assert.deepEqual(await drain([task.id], orchestrator(scripted([]), xaiSkills().skills, ['claude'])), ['answered']);
    const { prompt } = JSON.parse(readFileSync(join(REPO, '.fake-claude.json'), 'utf8')) as { prompt: string };
    assert.ok(prompt.includes(XAI_BLOCK), 'the style left whole');
    const [allowed] = await sql<{ reason: string }[]>`SELECT reason FROM gateway_log WHERE task_id = ${task.id} AND target = 'claude' ORDER BY id DESC LIMIT 1`;
    assert.match(allowed?.reason ?? '', /1 catalog text not read by the second check/);

    // A person in the user's message beside the same style: refused, and the chat says why.
    const person = await postUserMessage(sql, direct.id, 'Rifai la pagina per Mario Bianchi.', { design: { style: 'sabbia', skills: [] } });
    assert.deepEqual(await drain([person.task.id], orchestrator(scripted([]), xaiSkills().skills, ['claude'])), ['answered']);
    assert.equal((await loadTask(sql, person.task.id))?.status, 'done');
    const [reply] = await sql<{ agent: string | null; body: string }[]>`SELECT agent, body FROM messages WHERE task_id = ${person.task.id} AND role = 'assistant'`;
    assert.ok(reply !== undefined);
    assert.equal(reply.agent, null, 'Arianna writes it');
    assert.match(reply.body, /^Non ho mandato il messaggio a Claude: il controllo dei dati personali ha trovato un nome di persona\./);

    // The same block not marked by the catalog: read, and refused as before D-250.
    const unmarked = await postUserMessage(sql, direct.id, 'Ancora una versione.', { design: { style: 'sabbia', skills: [] } });
    forgetCatalogTexts();
    assert.deepEqual(await drain([unmarked.task.id], orchestrator(scripted([]), xaiSkills(false).skills, ['claude'])), ['answered']);
    const [refused] = await sql<{ rule: string }[]>`SELECT rule FROM gateway_log WHERE task_id = ${unmarked.task.id} AND target = 'claude' ORDER BY id DESC LIMIT 1`;
    assert.equal(refused?.rule, 'pii');
  } finally {
    forgetCatalogTexts();
    configurePiiGuard({ state: 'ready', scan: (texts) => Promise.resolve(piiReport(texts, texts.map(() => []))), stop: () => Promise.resolve() });
    execFileSync('git', ['-C', REPO, 'clean', '--quiet', '-fd']);
  }
});

test('the Studio: a style or skills only in the direct chat with the Designer, also for the database (D-184)', async () => {
  const { sql } = db();
  const design = { style: 'sabbia', skills: [] };
  const coder = await createConversation(sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: { name: 'coder', modes: ['work'], project: true } });
  const plain = await createConversation(sql, { mode: 'work', project: 'site', projects: PROJECTS });
  for (const conversation of [coder, plain]) {
    await assert.rejects(postUserMessage(sql, conversation.id, 'Una pagina.', { design }), (error: unknown) => error instanceof ChatError && error.code === 'invalid' && /direct chat with the Designer/.test(error.message));
    assert.equal((await sql`SELECT 1 FROM tasks WHERE conversation_id = ${conversation.id}`).length, 0, 'nothing written');
  }
  // The trigger: a task of Arianna's chat or of the Coder's, never; the Designer's, yes.
  const arianna = await createTask(sql, { title: 'Di Arianna', conversationId: plain.id, label: 'L1', clearance: 'L1' });
  await assert.rejects(sql`UPDATE tasks SET design_skills = ${['acme/skills/alpha']}::text[] WHERE id = ${arianna.id}`, /tasks_design_only_designer/);
  const ofCoder = await createTask(sql, { title: 'Del Coder', conversationId: coder.id, assignee: 'coder', label: 'L1', clearance: 'L1' });
  await assert.rejects(sql`UPDATE tasks SET design_style = 'sabbia' WHERE id = ${ofCoder.id}`, /tasks_design_only_designer/);
  const direct = await designerChat();
  const ofDesigner = await createTask(sql, { title: 'Del Designer', conversationId: direct.id, assignee: 'designer', label: 'L1', clearance: 'L1' });
  await sql`UPDATE tasks SET design_style = 'sabbia' WHERE id = ${ofDesigner.id}`;
  // Moved to another chat with its choice: refused.
  await assert.rejects(sql`UPDATE tasks SET conversation_id = ${plain.id} WHERE id = ${ofDesigner.id}`, /tasks_design_only_designer/);
});

test('the route of a message: style and skills only from the adopted catalogs and only to the Designer (D-184)', async () => {
  const live = await startLiveFeed(db().sql);
  const designCatalog = { list: () => ({ commit: 'c', styles: STYLES.map((slug) => ({ slug, name: slug, description: '' })), skills: [] }) } as unknown as DesignCatalog;
  const skillsCatalog = { list: () => ({ skills: SKILLS.map((id) => ({ id })) }) } as unknown as SkillsCatalog;
  const server = await startApiServer({
    sql: db().sql,
    live,
    host: '127.0.0.1',
    port: 0,
    projects: () => [],
    agents: () => ['arianna', 'coder', 'designer'],
    projectContainers: () => [],
    designCatalog,
    skillsCatalog,
  });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const post = (id: string, body: unknown) => fetch(`${base}/api/conversations/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const direct = await designerChat();
    const coder = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: { name: 'coder', modes: ['work'], project: true } });
    // Refused before anything is written.
    for (const bad of [{ style: 'inventato' }, { style: 'Sabbia Chiara' }, { skills: ['other/repo/skill'] }, { skills: 'acme/skills/alpha' }, { style: 7 }]) {
      assert.equal((await post(direct.id, { body: 'Una pagina.', ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(coder.id, { body: 'Una pagina.', style: 'sabbia' })).status, 400);
    assert.equal((await post(direct.id, { body: 'Una pagina.', other: 1 })).status, 400, 'only the known fields');
    assert.equal((await db().sql`SELECT 1 FROM tasks WHERE conversation_id IN ${db().sql([direct.id, coder.id])}`).length, 0);
    // Empty is no choice, anywhere.
    assert.equal((await post(coder.id, { body: 'Una riga.', style: null, skills: [] })).status, 201);
    const sent = await post(direct.id, { body: 'Una pagina.', style: 'notte', skills: ['nexu-io/open-design/deck', 'acme/skills/alpha'] });
    assert.equal(sent.status, 201);
    const { task } = (await sent.json()) as { task: { id: string } };
    const [row] = await db().sql<{ style: string | null; skills: string[] }[]>`SELECT design_style AS style, design_skills AS skills FROM tasks WHERE id = ${task.id}`;
    assert.deepEqual([row?.style, row?.skills], ['notte', ['nexu-io/open-design/deck', 'acme/skills/alpha']]);
  } finally {
    await server.close();
    await live.close();
  }
});
