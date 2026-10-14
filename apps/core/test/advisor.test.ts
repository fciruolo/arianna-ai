import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import { adviceOf, readAdvisorSettings, STATUS_MAX_AGE_MS, STATUS_MAX_BYTES, weeklyPercent, writeAdvisorSettings } from '../src/orchestrator/advisor.ts';

const base = resolve('data/test-tmp');
await mkdir(base, { recursive: true });
const dir = await mkdtemp(join(base, 'advisor-'));
after(() => rm(dir, { recursive: true, force: true }));

const NOW = new Date('2026-10-14T11:10:00Z');

async function status(body: unknown): Promise<string> {
  const file = join(dir, `status-${String(Math.random()).slice(2)}.json`);
  await writeFile(file, JSON.stringify(body));
  return file;
}

function claude(limits: unknown[], updatedAt = '2026-10-14T11:08:46Z'): unknown {
  return { claude: { limits, plan: 'Max', spend: { used: 0 }, updatedAt }, codex: { limits: [{ label: 'Settimana', percent: 99, resetsAt: '2026-10-18T10:43:04Z' }] } };
}

const WEEK = { label: 'Settimana', percent: 55, resetsAt: '2026-10-17T14:00:00Z' };
const SESSION = { label: 'Sessione (5h)', percent: 97, resetsAt: '2026-10-14T13:40:00Z' };
const FABLE = { label: 'Settimana · Fable', percent: 99, resetsAt: '2026-10-17T14:00:00Z' };

test('the week of Claude is read, not the session, Fable or Codex', async () => {
  assert.equal(await weeklyPercent(await status(claude([SESSION, FABLE, WEEK])), NOW), 55);
  assert.equal(await weeklyPercent(await status(claude([{ ...WEEK, label: 'Week', percent: 91 }])), NOW), 91);
});

test('a missing, unreadable, stale or ended status says nothing', async () => {
  assert.equal(await weeklyPercent(undefined, NOW), undefined);
  assert.equal(await weeklyPercent(join(dir, 'missing.json'), NOW), undefined);
  const broken = join(dir, 'broken.json');
  await writeFile(broken, '{ not json');
  assert.equal(await weeklyPercent(broken, NOW), undefined);
  const old = new Date(NOW.getTime() - STATUS_MAX_AGE_MS - 1000).toISOString();
  assert.equal(await weeklyPercent(await status(claude([WEEK], old)), NOW), undefined);
  assert.equal(await weeklyPercent(await status(claude([{ ...WEEK, resetsAt: '2026-10-14T11:00:00Z' }])), NOW), undefined);
  assert.equal(await weeklyPercent(await status(claude([{ ...WEEK, percent: '55' }])), NOW), undefined);
  assert.equal(await weeklyPercent(await status(claude([SESSION])), NOW), undefined);
  assert.equal(await weeklyPercent(await status({ codex: {} }), NOW), undefined);
  assert.equal(await weeklyPercent(dir, NOW), undefined);
  const big = join(dir, 'big.json');
  await writeFile(big, JSON.stringify({ ...(claude([WEEK]) as object), pad: 'x'.repeat(STATUS_MAX_BYTES) }));
  assert.equal(await weeklyPercent(big, NOW), undefined);
});

test('only one difficulty alone is an opinion', () => {
  assert.equal(adviceOf('trivial'), 'trivial');
  assert.equal(adviceOf('  Hard.\n'), 'hard');
  assert.equal(adviceOf('critical!'), 'critical');
  assert.equal(adviceOf('it is hard'), undefined);
  assert.equal(adviceOf('easy'), undefined);
  assert.equal(adviceOf(''), undefined);
});

test('the path of the status file is kept, absolute only', async () => {
  const data = join(dir, 'data');
  assert.deepEqual(await readAdvisorSettings(data), {});
  const file = join(dir, 'status.json');
  await writeAdvisorSettings(data, { usageFile: file });
  assert.deepEqual(await readAdvisorSettings(data), { usageFile: file });
  await assert.rejects(writeAdvisorSettings(data, { usageFile: 'relative/status.json' }), TypeError);
  await writeAdvisorSettings(data, { usageFile: '  ' });
  assert.deepEqual(await readAdvisorSettings(data), {});
});
