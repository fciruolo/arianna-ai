// The diary of the works (I-15, D-147), against the fake binaries of
// @arianna/executors: at the end of each work of the Coder on a project, on
// Claude or Codex, delegated by Arianna or in the direct chat, ended well,
// failed or stopped, the core writes an entry in Workplan/diario of the
// project's knowledge. Only what already left for the cloud; never in an
// incognito conversation; an error of the diary never fails the work.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome, type Project } from '@arianna/config';
import { createClaudeExecutor, createCodexExecutor, type ChatRequest, type LocalModel } from '@arianna/executors';

import { createConversation, postUserMessage, setConversationModel } from '../src/conversations.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { loadDelegations } from '../src/orchestrator/delegations.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { loadTask } from '../src/tasks.ts';
import { diaryDay } from '../src/work-diary.ts';
import { committedAgents } from '../test/support/committed-agents.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const ROOT = resolveHome({});
const HOME = join(ROOT, 'data', 'test-tmp', `work-diary-${randomUUID()}`);
const FIXTURES = join(ROOT, 'packages', 'executors', 'test', 'fixtures');
const RULES = parseLabelRules('[[folder]]\npath = "repos"\nlabel = "L1"\n');
const OPTIONS = { allowedActions: () => [] as readonly string[], agentLimits: () => ({ maxSteps: 30, maxMinutes: 20 }) };
const BASE = loadConfig();
const SECRET = `ghp_${'a'.repeat(36)}`;

const claude = createClaudeExecutor({ enabled: ['claude'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-claude.ts')] }, home: ROOT, killGraceMs: 200 });
const codex = createCodexExecutor({ enabled: ['codex'], command: { file: process.execPath, args: [join(FIXTURES, 'fake-codex.ts')] }, home: ROOT, killGraceMs: 200, modelName: (model) => `gpt-6-${model}` });
const loaded = committedAgents(ROOT);

function gitIn(repo: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
}

/** A git repository with one commit; what the fake binaries write is ignored. */
function repository(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# Sito finto\n');
  writeFileSync(join(dir, '.gitignore'), '.fake-claude.json\n.fake-codex.json\n');
  gitIn(dir, 'init', '--quiet', '--initial-branch=main');
  gitIn(dir, 'add', '--all');
  gitIn(dir, 'commit', '--quiet', '--message', 'fixture');
}

function restore(dir: string): void {
  gitIn(dir, 'checkout', '--quiet', '--', '.');
  gitIn(dir, 'clean', '--quiet', '-fd');
}

const SITE = join(HOME, 'repos', 'site');
const BOX = join(HOME, 'repos', 'cantiere');

before(() => {
  mkdirSync(join(HOME, 'kb'), { recursive: true });
  repository(SITE);
  repository(join(HOME, 'repos', 'rotto'));
  // A container with a part and a private note (fake data only): the diary goes in its Workplan, never in the part.
  repository(join(BOX, 'cantiere-sito'));
  mkdirSync(join(BOX, 'documenti'), { recursive: true });
  writeFileSync(join(BOX, 'documenti', 'compenso.md'), '# Compenso finto: 4242 euro\n');
  // kb/progetti/rotto is a link out: its diary can never be written.
  mkdirSync(join(HOME, 'fuori'), { recursive: true });
  mkdirSync(join(HOME, 'kb', 'progetti'), { recursive: true });
  symlinkSync(join(HOME, 'fuori'), join(HOME, 'kb', 'progetti', 'rotto'));
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
      const value = { thought: 'Ragiono.', ...next };
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
}

const PROJECTS = ['site', 'cantiere', 'rotto'];

/** The orchestrator; `scenario` is the first line of the Coder's prompt, which picks what the fake binary does. */
function orchestrator(answers: Answer[], executors: ('claude' | 'codex')[], scenario?: string): StepExecutor {
  const coder = loaded.get('coder');
  assert.ok(coder !== undefined);
  const agents = new Map<string, LoadedAgent>(loaded);
  const model = scripted(answers);
  if (scenario !== undefined) agents.set('coder', { card: coder.card, prompt: `scenario: ${scenario}\nYou are the Coder.` });
  const settings = () => ({
    ...BASE,
    home: HOME,
    paths: { data: join(HOME, 'data') },
    server: { host: '127.0.0.1', port: 7420 },
    cloud: { executors, models: defaultCloudModels() },
    projects: PROJECTS.map((name): Project => ({ name, path: `repos/${name}`, absolute: join(HOME, 'repos', name), label: 'L1' })),
  });
  return createOrchestrator({
    sql: db().sql,
    agents,
    kb: createKb({ home: HOME, rules: RULES }),
    model: () => model,
    settings,
    rules: RULES,
    claude,
    codex,
  });
}

async function drain(taskId: string, executor: StepExecutor, options = OPTIONS): Promise<string[]> {
  const queue = createJobQueue(db().sql);
  const results: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'test-worker');
    if (job === undefined) return results;
    if (job.payload.taskId !== taskId) {
      await completeJob(db().sql, job.id, 'test-worker');
      continue;
    }
    results.push(await processStepJob(db().sql, executor, job, 'test-worker', options));
  }
  throw new Error('drain did not end');
}

const delegate = (brief: string): Answer => ({ action: 'call', tool: 'task.delegate', arguments: { agent: 'coder', reason: 'per il passo nel progetto', brief } });
const REPLY: Answer = { action: 'reply', text: 'Fatto.' };

/** The day file of the diary of a project. */
function diaryOf(root: string): string {
  return join(root, 'Workplan', 'diario', `${diaryDay(new Date())}.md`);
}

/** The latest entry of a day file. */
function lastEntry(file: string): string {
  const text = readFileSync(file, 'utf8');
  return text.slice(text.lastIndexOf('\n## '));
}

const SITE_DIARY = diaryOf(join(HOME, 'kb', 'progetti', 'site'));

test('a delegation on Claude that ends well: an entry with request, files, report and link, in kb/progetti of a one-git project', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Aggiungi una riga al README, il codice privato è nel mio quaderno.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator([delegate('Add a line to README.md saying hello.'), REPLY], ['claude'], 'edit-files')), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.equal(delegation?.status, 'ok');
    const text = readFileSync(SITE_DIARY, 'utf8');
    assert.match(text, /^---\nlabel: L1\nsource: diary:site\n[\s\S]*kind: diary\nproject: site\n/);
    const entry = lastEntry(SITE_DIARY);
    assert.match(entry, /^\n## \d\d:\d\d · Coder · Claude Sonnet( \([^)]+\))? · riuscito\n/);
    assert.match(entry, /- Parte: tutto il progetto\n/);
    assert.match(entry, new RegExp(`- Conversazione: \\[apri in Arianna\\]\\(http://127\\.0\\.0\\.1:7420/c/${conversation.id}\\)`));
    assert.match(entry, /- Etichetta: L1\n/);
    assert.match(entry, /```text\nAdd a line to README\.md saying hello\.\n```/);
    assert.match(entry, /- `README\.md` \(modificato\)\n- `docs\/hello\.md` \(aggiunto\)/);
    assert.match(entry, /### Riassunto di Coder\n\n```text\ndone\n```/);
    // What did not go to the cloud is not in it: the user's message to Arianna.
    assert.doesNotMatch(text, /quaderno/);
    // Never in the code of the project.
    assert.ok(!existsSync(join(SITE, 'Workplan')));
  } finally {
    restore(SITE);
  }
});

test('a delegation on Claude that fails: an entry that says so, with the request that left', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Prova.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator([delegate('Fail on purpose.'), REPLY], ['claude'], 'error')), ['continued', 'continued', 'answered']);
    const [delegation] = await loadDelegations(db().sql, task.id);
    assert.equal(delegation?.status, 'failed');
    const entry = lastEntry(SITE_DIARY);
    assert.match(entry, /· Coder · Claude Sonnet[^\n]* · non riuscito\n/);
    assert.match(entry, /- Esito: non riuscito \(claude: [a-z-]+\)/);
    assert.match(entry, /```text\nFail on purpose\.\n```/);
    assert.doesNotMatch(entry, /Riassunto/);
  } finally {
    restore(SITE);
  }
});

test('on Codex, ended well and failed: an entry each, with the executor and the model', async () => {
  for (const [scenario, outcome, brief] of [
    ['ok', 'riuscito', 'Look at the README on Codex.'],
    ['error', 'non riuscito', 'Fail on Codex.'],
  ] as const) {
    const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
    const { task } = await postUserMessage(db().sql, conversation.id, 'Prova su Codex.');
    try {
      assert.deepEqual(await drain(task.id, orchestrator([delegate(brief), REPLY], ['codex'], scenario)), ['continued', 'continued', 'answered']);
      const [delegation] = await loadDelegations(db().sql, task.id);
      assert.equal(delegation?.executor, 'codex');
      const entry = lastEntry(SITE_DIARY);
      assert.match(entry, new RegExp(`· Coder · Codex Sol · ${outcome}\\n`));
      assert.ok(entry.includes(brief));
    } finally {
      restore(SITE);
    }
  }
});

test('the direct chat with the Coder: each answer is an entry, with the message of the user as the request', async () => {
  const direct = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, agent: { name: 'coder', modes: ['work'], project: true } });
  await setConversationModel(db().sql, direct.id, 'sol', ['sol', 'sonnet']);
  try {
    const { task } = await postUserMessage(db().sql, direct.id, 'Messaggio diretto al Coder.');
    assert.deepEqual(await drain(task.id, orchestrator([], ['claude', 'codex'])), ['answered']);
    const entry = lastEntry(SITE_DIARY);
    assert.match(entry, /· Coder · Codex Sol · riuscito\n/);
    assert.match(entry, /```text\nMessaggio diretto al Coder\.\n```/);
    assert.ok(entry.includes(`/c/${direct.id})`));
  } finally {
    restore(SITE);
  }
});

test('a brief the gateway refused never reaches the diary: the entry says it did not leave', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Usa il token.');
  assert.deepEqual(await drain(task.id, orchestrator([delegate(`Use the token ${SECRET} in the config.`), REPLY], ['claude'])), ['continued', 'continued', 'answered']);
  const [delegation] = await loadDelegations(db().sql, task.id);
  assert.equal(delegation?.status, 'failed');
  const entry = lastEntry(SITE_DIARY);
  assert.match(entry, /· non riuscito\n/);
  assert.match(entry, /il gateway ha fermato la richiesta/);
  assert.match(entry, /Non è uscita/);
  assert.ok(!readFileSync(SITE_DIARY, 'utf8').includes(SECRET));
});

test('a part of a container: the entry goes in the Workplan of the container, made by the code, never in the part', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'cantiere:cantiere-sito', projects: ['cantiere:cantiere-sito'] });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Aggiungi una riga.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator([delegate('Add a line.'), REPLY], ['claude'])), ['continued', 'continued', 'answered']);
    const file = diaryOf(BOX);
    const entry = lastEntry(file);
    assert.match(entry, /- Parte: `cantiere-sito`\n/);
    assert.match(readFileSync(file, 'utf8'), /^---\nlabel: L1\n/);
    // Nothing of the private folder, and nothing in the part.
    assert.doesNotMatch(readFileSync(file, 'utf8'), /4242/);
    assert.ok(!existsSync(join(BOX, 'cantiere-sito', 'Workplan')));
  } finally {
    restore(join(BOX, 'cantiere-sito'));
  }
});

test('an incognito conversation leaves no entry (D-136)', async () => {
  const before = readFileSync(SITE_DIARY, 'utf8');
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS, incognito: true });
  const { task } = await postUserMessage(db().sql, conversation.id, 'In incognito.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator([delegate('Incognito work.'), REPLY], ['claude'])), ['continued', 'continued', 'answered']);
    assert.equal((await loadDelegations(db().sql, task.id))[0]?.status, 'ok');
    assert.equal(readFileSync(SITE_DIARY, 'utf8'), before);
  } finally {
    restore(SITE);
  }
});

test('a diary that cannot be written does not fail the work', async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args.join(' ')));
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'rotto', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Prova.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator([delegate('Work on rotto.'), REPLY], ['claude'])), ['continued', 'continued', 'answered']);
    assert.equal((await loadDelegations(db().sql, task.id))[0]?.status, 'ok');
    assert.equal((await loadTask(db().sql, task.id))?.status, 'done');
    assert.deepEqual(errors, ['work diary not written: refused']);
    assert.ok(!existsSync(join(HOME, 'fuori', 'Workplan')));
  } finally {
    restore(join(HOME, 'repos', 'rotto'));
  }
});

test('a run that changed the git configuration: an entry that says so, without reading the folder with git', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Prova.');
  try {
    assert.deepEqual(await drain(task.id, orchestrator([delegate('Touch the config.'), REPLY], ['claude'], 'git-config')), ['continued', 'continued', 'answered']);
    assert.equal((await loadDelegations(db().sql, task.id))[0]?.status, 'failed');
    const entry = lastEntry(SITE_DIARY);
    assert.match(entry, /· non riuscito\n/);
    assert.match(entry, /configurazione git del progetto/);
    assert.match(entry, /### File cambiati\n\nNon letti\./);
    assert.doesNotMatch(entry, /Riassunto/);
  } finally {
    // The scenario rewrote the configuration of the repository: the next tests start from a new one.
    rmSync(SITE, { recursive: true, force: true });
    repository(SITE);
  }
});

test('a work stopped at the time cap of the task: an entry that says it was stopped', async () => {
  const conversation = await createConversation(db().sql, { mode: 'work', project: 'site', projects: PROJECTS });
  const { task } = await postUserMessage(db().sql, conversation.id, 'Lavoro lungo.');
  try {
    const results = await drain(task.id, orchestrator([delegate('A long work.'), REPLY], ['claude'], 'hang'), { ...OPTIONS, agentLimits: () => ({ maxSteps: 30, maxMinutes: 0.03 }) });
    assert.equal(results.at(-1), 'limit');
    const entry = lastEntry(SITE_DIARY);
    assert.match(entry, /· fermato\n/);
    assert.match(entry, /- Esito: fermato \(limite di tempo del compito\)/);
    assert.match(entry, /```text\nA long work\.\n```/);
  } finally {
    restore(SITE);
  }
});
