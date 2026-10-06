// The routes of "Genera personaggio" (D-123) with a fake `claude` binary and a
// fake local model: never the real Claude. The gateway is the policy's check
// without the database (gateway_log is written by passGateway in the core).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { DATA_DIR, resolveHome, type SpriteModel } from '@arianna/config';
import { createClaudeExecutor, WORKTREES_DIR, type ChatRequest, type ClaudeExecutor, type LocalModel } from '@arianna/executors';
import { gatewayCheck, markLogged, secretMatcher, type Decision } from '@arianna/policy';

import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { decodePng } from '../src/png.ts';
import { startApiServer, type ApiServer } from '../src/server/http.ts';
import { createSpriteGenerator, SPRITE_LOCAL_ALIAS, SpriteError } from '../src/sprites/generate.ts';
import { EXAMPLES, REVIEW_PROMPT, SPRITE_PROMPT } from '../src/sprites/prompt.ts';
import { spriteSheet, type SpriteSpec } from '../src/sprites/spec.ts';

const REPO = resolveHome({});
const root = join(REPO, DATA_DIR, 'test-tmp', randomUUID());
const FAKE = join(import.meta.dirname, 'support', 'fake-claude-sprite.ts');
const EXAMPLE = SPRITE_PROMPT.split('\n').findLast((line) => line.startsWith('{"palette"')) ?? '';

let model: SpriteModel = 'sonnet';
let unavailable: string | undefined;
let launches = 0;
const decisions: Decision[] = [];
const localRequests: ChatRequest[] = [];
let localAnswer: unknown = JSON.parse(EXAMPLE);

const real = createClaudeExecutor({ enabled: ['claude'], home: root, command: { file: process.execPath, args: [FAKE] }, readable: [] });
// Counts the launches: a refused request must never start the binary.
const claude: ClaudeExecutor = {
  check: (launch) => real.check(launch),
  start: (options) => {
    launches += 1;
    return real.start(options);
  },
  resume: (options) => real.resume(options),
};
const localModel: LocalModel = {
  chat: (request) => {
    localRequests.push(request);
    return Promise.resolve({ text: JSON.stringify(localAnswer), value: localAnswer, finishReason: 'stop', endpoint: 'omlx', model: 'fake', durationMs: 1 });
  },
};

let server: ApiServer;
let origin: string;

function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = httpRequest(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end(data);
  });
}

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const agent = { name: 'grafico', description: 'Disegna grafici dai dati di lavoro.', prompt: 'Ricevi una tabella e proponi un grafico.' };

before(async () => {
  mkdirSync(root, { recursive: true });
  const sprites = createSpriteGenerator({
    model: () => model,
    unavailable: () => unavailable,
    claude,
    localModel: () => localModel,
    persona: (name) => (name === 'grafico' ? { tone: 'scherzoso', specialization: 'Grafici per riunioni.' } : undefined),
    gateway: (payload, context, target) => {
      const decision = gatewayCheck(payload, context, target, secretMatcher([]));
      // What passGateway does once the row is written: only then can the adapter spend it.
      if (decision.decision === 'allow') markLogged(decision);
      decisions.push(decision);
      return Promise.resolve(decision);
    },
    dataDir: root,
  });
  server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, sprites });
  origin = `http://127.0.0.1:${String(server.port)}`;
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  model = 'sonnet';
  unavailable = undefined;
  launches = 0;
  decisions.length = 0;
  localRequests.length = 0;
  localAnswer = JSON.parse(EXAMPLE);
});

describe('POST /api/characters/generate', () => {
  it('says which model draws and what leaves', async () => {
    const { status, json } = await get('/api/characters/generate');
    assert.equal(status, 200);
    assert.deepEqual(json, { model: 'sonnet', available: true, reason: null, sends: ['name', 'description', 'prompt', 'tone', 'specialization', 'hint'] });
  });

  it('Claude draws: the brief passes the gateway at L1, the answer becomes a 112×128 sheet, the folder is removed', async () => {
    const { status, json } = await post('/api/characters/generate', { ...agent, hint: 'felpa gialla' });
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.model, 'sonnet');
    assert.equal(json.label, 'L1');
    assert.equal(json.rows, 4);
    const image = decodePng(Buffer.from(String(json.png), 'base64'), 128);
    assert.deepEqual([image.width, image.height], [112, 128]);
    assert.equal(launches, 2, 'a drawing, then its review (D-132)');
    assert.equal(decisions.length, 2);
    const [decision, review] = decisions;
    assert.ok(decision?.decision === 'allow');
    assert.equal(decision.label, 'L1');
    assert.equal(decision.texts[0], SPRITE_PROMPT);
    assert.ok(decision.texts.includes('Tone: scherzoso'));
    assert.ok(decision.texts.includes('User hint: felpa gialla'));
    assert.ok(review?.decision === 'allow');
    assert.equal(review.label, 'L1', 'the first drawing is output of L1 texts');
    assert.equal(review.texts[0], SPRITE_PROMPT);
    assert.ok(review.texts.includes(REVIEW_PROMPT));
    assert.ok(review.texts.some((text) => text.startsWith('Your first drawing:\n{"palette"') && text.includes('row  front')));
    assert.ok(review.texts.includes('The automatic check found:\n- nothing'), 'the example has nothing to fix');
    const worktrees = join(root, WORKTREES_DIR);
    assert.deepEqual(existsSync(worktrees) ? readdirSync(worktrees) : [], [], 'the empty folder is gone');
  });

  it('a drawing in a code fence is read; text that is not JSON is a 502 with the reason', async () => {
    assert.equal((await post('/api/characters/generate', { ...agent, hint: 'scenario-fenced' })).status, 200);
    const broken = await post('/api/characters/generate', { ...agent, hint: 'scenario-broken' });
    assert.equal(broken.status, 502);
    assert.equal(broken.json.code, 'bad-reply');
    assert.match(String(broken.json.error), /not JSON/);
  });

  it('an answer that is not valid is asked again once, with what the check said', async () => {
    launches = 0;
    decisions.length = 0;
    assert.equal((await post('/api/characters/generate', { ...agent, hint: 'scenario-broken' })).status, 502);
    assert.equal(launches, 2, 'two tries, no review of nothing');
    const again = decisions[1];
    assert.ok(again?.decision === 'allow');
    assert.ok(again.texts.includes('Your previous answer was refused, answer again following the schema. The check said:\n- the answer is not JSON'));
  });

  it('a review that fails keeps the first drawing', async () => {
    for (const hint of ['scenario-reviewbroken', 'scenario-reviewquota']) {
      const { status, json } = await post('/api/characters/generate', { ...agent, hint });
      assert.equal(status, 200, `${hint}: ${JSON.stringify(json)}`);
      assert.equal(json.rows, 4);
    }
  });

  it('a quota refusal is a 429 with the time it resets', async () => {
    const { status, json } = await post('/api/characters/generate', { ...agent, hint: 'scenario-quota' });
    assert.equal(status, 429);
    assert.equal(json.code, 'quota');
    assert.equal(json.resetsAt, new Date(1_790_979_600 * 1000).toISOString());
  });

  it('personal data in the hint is refused before the gateway, and the binary never starts', async () => {
    const { status, json } = await post('/api/characters/generate', { ...agent, hint: 'colori come IT60X0542811101000000123456' });
    assert.equal(status, 400);
    assert.match(String(json.error), /^hint looks like personal data/);
    assert.doesNotMatch(JSON.stringify(json), /IT60/);
    assert.equal(launches, 0);
    assert.equal(decisions.length, 0);
  });

  it('a field outside the request is refused', async () => {
    const { status } = await post('/api/characters/generate', { ...agent, model: 'opus' });
    assert.equal(status, 400);
    assert.equal(launches, 0);
  });

  it('a model that cannot draw is a 409 with the reason, never another model', async () => {
    unavailable = 'claude is not on in [cloud] executors';
    const { status, json } = await post('/api/characters/generate', agent);
    assert.equal(status, 409);
    assert.equal(json.error, 'claude is not on in [cloud] executors');
    assert.equal(launches + localRequests.length, 0);
  });

  it('the local model draws with the schema, after the gateway towards the local target', async () => {
    model = 'local';
    const { status, json } = await post('/api/characters/generate', agent);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.model, 'local');
    assert.equal(launches, 0);
    assert.equal(localRequests.length, 2, 'a drawing and its review');
    const request = localRequests[0];
    assert.equal(request?.model, SPRITE_LOCAL_ALIAS);
    assert.equal(request.schema?.name, 'sprite');
    assert.equal(request.messages[0]?.content, SPRITE_PROMPT);
    assert.match(request.messages[1]?.content ?? '', /Agent name: grafico/);
    assert.equal(decisions[0]?.decision, 'allow');
  });

  it('one drawing at a time: a second request while the first runs is busy', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LocalModel = {
      chat: async () => {
        await gate;
        return { text: EXAMPLE, value: JSON.parse(EXAMPLE) as unknown, finishReason: 'stop', endpoint: 'omlx', model: 'fake', durationMs: 1 };
      },
    };
    const service = createSpriteGenerator({
      model: () => 'local',
      unavailable: () => undefined,
      localModel: () => slow,
      persona: () => undefined,
      gateway: (payload, context, target) => {
        const decision = gatewayCheck(payload, context, target, secretMatcher([]));
        if (decision.decision === 'allow') markLogged(decision);
        return Promise.resolve(decision);
      },
      dataDir: root,
    });
    const first = service.generate(agent);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.generate(agent), (error: unknown) => error instanceof SpriteError && error.code === 'busy');
    release();
    assert.equal((await first).model, 'local');
    assert.equal((await service.generate(agent)).rows, 4, 'free again once the first is done');
  });

  it('a drawing of the local model that breaks the rules is a 502', async () => {
    model = 'local';
    localAnswer = { ...(JSON.parse(EXAMPLE) as Record<string, unknown>), extra: true };
    const { status, json } = await post('/api/characters/generate', agent);
    assert.equal(status, 502);
    assert.match(String(json.error), /not in the schema/);
  });

  it('the review is kept unless it looks worse than the first drawing (D-132)', async () => {
    const good = EXAMPLES[1]?.spec;
    assert.ok(good !== undefined);
    const worse: SpriteSpec = { ...good, palette: { ...good.palette, o: '#c0c0c0' } };
    const run = async (answers: SpriteSpec[]): Promise<Buffer> => {
      const queue = [...answers];
      const service = createSpriteGenerator({
        model: () => 'local',
        unavailable: () => undefined,
        localModel: () => ({
          chat: () => {
            const value = queue.shift();
            return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', endpoint: 'omlx', model: 'fake', durationMs: 1 });
          },
        }),
        persona: () => undefined,
        gateway: (payload, context, target) => {
          const decision = gatewayCheck(payload, context, target, secretMatcher([]));
          if (decision.decision === 'allow') markLogged(decision);
          return Promise.resolve(decision);
        },
        dataDir: root,
      });
      return (await service.generate(agent)).png;
    };
    assert.deepEqual(await run([good, worse]), spriteSheet(good).png, 'a worse review is dropped');
    assert.deepEqual(await run([worse, good]), spriteSheet(good).png, 'a better review wins');
  });

  it('a review the gateway blocks keeps the first drawing; an unexpected error or a page that left is not hidden', async () => {
    const good = EXAMPLES[1]?.spec;
    assert.ok(good !== undefined);
    const service = (chat: LocalModel['chat'], gateway: (calls: number) => Decision | undefined = () => undefined) => {
      let calls = 0;
      return createSpriteGenerator({
        model: () => 'local',
        unavailable: () => undefined,
        localModel: () => ({ chat }),
        persona: () => undefined,
        gateway: (payload, context, target) => {
          calls += 1;
          const decision = gateway(calls) ?? gatewayCheck(payload, context, target, secretMatcher([]));
          if (decision.decision === 'allow') markLogged(decision);
          return Promise.resolve(decision);
        },
        dataDir: root,
      });
    };
    const answer = () => Promise.resolve({ text: JSON.stringify(good), value: good, finishReason: 'stop' as const, endpoint: 'omlx', model: 'fake', durationMs: 1 });
    const blocked = service(answer, (calls) => (calls === 2 ? { decision: 'block', reason: 'test', findings: [] } as unknown as Decision : undefined));
    assert.deepEqual((await blocked.generate(agent)).png, spriteSheet(good).png);

    let calls = 0;
    const broken = service(() => {
      calls += 1;
      return calls === 1 ? answer() : Promise.reject(new TypeError('a bug'));
    });
    await assert.rejects(broken.generate(agent), TypeError);

    const controller = new AbortController();
    let asked = 0;
    const leaving = service(() => {
      asked += 1;
      controller.abort();
      return answer();
    });
    await assert.rejects(leaving.generate(agent, controller.signal), (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(asked, 1, 'no review once the page left');
  });
});
