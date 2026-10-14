// «Consumi» (D-093, idea 10): the period, the merge of runs and delegations,
// the totals, and the queries, which read metadata only. No database: a
// stand-in records the SQL and answers with made-up rows.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import type { Queryable, Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';
import { emptyCounts, loadUsage, mergeDelegations, parsePeriod, periodStart, totalsOf } from '../src/usage.ts';

test('the period: nothing gives 7 days, the three known ones pass, anything else is refused', () => {
  assert.equal(parsePeriod(null), '7d');
  assert.equal(parsePeriod(''), '7d');
  assert.equal(parsePeriod('today'), 'today');
  assert.equal(parsePeriod('30d'), '30d');
  assert.equal(parsePeriod('365d'), undefined);
  assert.equal(parsePeriod('7D'), undefined);
});

test('«oggi» starts at local midnight; 7 and 30 days go back from now', () => {
  const now = new Date(2026, 9, 14, 15, 30, 0);
  assert.equal(periodStart('today', now).getTime(), new Date(2026, 9, 14, 0, 0, 0).getTime());
  assert.equal(now.getTime() - periodStart('7d', now).getTime(), 7 * 86_400_000);
  assert.equal(now.getTime() - periodStart('30d', now).getTime(), 30 * 86_400_000);
});

test('delegations join the runs of the same executor and model; a pair that ran nothing gets its own row', () => {
  const merged = mergeDelegations(
    [
      { executor: 'local', model: 'qwen3.8-27b-4bit', locality: 'local', ...emptyCounts(), runs: 9, steps: 20 },
      { executor: 'claude', model: 'sonnet', locality: 'cloud', ...emptyCounts(), runs: 2, steps: 2 },
    ],
    [
      { executor: 'claude', model: 'sonnet', delegations: 2, failed: 1 },
      { executor: 'codex', model: 'codex', delegations: 1, failed: 0 },
      { executor: null, model: null, delegations: 2, failed: 0 },
    ],
  );
  assert.deepEqual(
    merged.map((row) => [row.executor, row.model, row.locality, row.runs, row.delegations, row.delegationsFailed]),
    [
      ['local', 'qwen3.8-27b-4bit', 'local', 9, 0, 0],
      ['claude', 'sonnet', 'cloud', 2, 2, 1],
      // Not routed yet: no locality, so never counted as cloud.
      ['unassigned', null, null, 0, 2, 0],
      ['codex', 'codex', 'cloud', 0, 1, 0],
    ],
  );
  // A model name that is not a delegation's does not match a null one.
  const apart = mergeDelegations([{ executor: 'claude', model: null, locality: 'cloud', ...emptyCounts(), runs: 1 }], [{ executor: 'claude', model: 'opus', delegations: 1, failed: 0 }]);
  assert.equal(apart.length, 2);
});

test('the totals count only allowed exits towards the cloud, and every refusal', () => {
  const totals = totalsOf(
    {
      models: [{ executor: 'local', model: 'm', locality: 'local', ...emptyCounts(), runs: 3, steps: 5, seconds: 12, delegations: 1, delegationsFailed: 0 }],
      agents: [],
      kinds: [],
      difficulties: [],
      exits: [
        { targetKind: 'executor', target: 'claude', locality: 'cloud', allowed: 2, blocked: 1, bytes: 900 },
        { targetKind: 'executor', target: 'local', locality: 'local', allowed: 7, blocked: 0, bytes: 100 },
      ],
      failures: [{ origin: 'local-model', code: 'local-model.unavailable', count: 2 }],
    },
    4,
  );
  assert.deepEqual(totals, { runs: 3, steps: 5, seconds: 12, delegations: 1, cloudExits: 2, blocked: 1, failures: 2, advice: 4 });
});

/** A stand-in of postgres.js: records every query and answers by the table it reads. */
function fakeSql(answers: Record<string, unknown[]>): { sql: Queryable; queries: string[] } {
  const queries: string[] = [];
  const answer = (text: string) => {
    queries.push(text);
    const table = Object.keys(answers).find((name) => text.includes(name));
    return Promise.resolve(table === undefined ? [] : answers[table]);
  };
  const tag = (strings: TemplateStringsArray) => answer(strings.join('$'));
  const sql = Object.assign(tag, { unsafe: (text: string) => answer(text) });
  return { sql: sql as unknown as Queryable, queries };
}

test('the report reads only counts, times and names: never a title, a brief, a text or an answer', async () => {
  const { sql, queries } = fakeSql({
    'FROM task_delegations': [{ executor: 'claude', model: 'sonnet', delegations: 1, failed: 0 }],
    'FROM router_decisions': [
      { difficulty: 'hard', decisions: 1, local: 0, cloud: 1, waits: 0 },
      { difficulty: 'trivial', decisions: 3, local: 3, cloud: 0, waits: 0 },
    ],
    'FROM events': [{ count: 2 }],
  });
  const report = await loadUsage(sql, 'today', new Date(2026, 9, 14, 10, 0, 0));
  assert.equal(report.period, 'today');
  assert.deepEqual(report.difficulties.map((row) => row.difficulty), ['trivial', 'hard']);
  assert.equal(report.totals.delegations, 1);
  assert.equal(report.totals.advice, 2);
  assert.equal(queries.length, 8);
  const all = queries.join('\n');
  for (const column of ['title', 'goal', 'brief', 'result', 'summary', 'reason', 'body', 'text', 'note', 'payload', 'candidates', 'session_ref', 'workspace', 'repo', 'details', 'files', 'label', 'effective_label']) {
    assert.doesNotMatch(all, new RegExp(`\\b${column}\\b`), column);
  }
  assert.doesNotMatch(all, /FROM (messages|conversations)\b/);
});

function get(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('GET /api/usage refuses an unknown period before the database, and answers a known one', async (t) => {
  const { sql, queries } = fakeSql({});
  const server = await startApiServer({ sql: sql as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await server.close();
  });
  const wrong = await get(server.port, '/api/usage?period=anno');
  assert.equal(wrong.status, 400);
  assert.deepEqual(queries, []);

  const week = await get(server.port, '/api/usage');
  assert.equal(week.status, 200);
  assert.equal(week.body.period, '7d');
  assert.deepEqual(week.body.models, []);
  assert.equal((week.body.totals as Record<string, number>).runs, 0);
});
