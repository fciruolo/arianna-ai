import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkGodPlan, overlaps, partName, planBlock, planOfAnswer, safePath, slugOf, withoutPlan } from '../src/god/plan.ts';
import { concurrencyFor, projection, projectReading } from '../src/god/quota.ts';
import { mergeCommandsOf, outsideFiles, reviewBrief, subtaskBrief, verdictOf } from '../src/god/work.ts';
import { pnpmEnv } from '../src/god/prepare.ts';

const plan = (subtasks: unknown[], title: unknown = 'Barra della quota'): string => JSON.stringify({ title, subtasks });
const subtask = (files: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ title: 'Parte', goal: 'Fai la parte, con i test.', files, blocked_by: [], ...extra });

test('the plan block of an answer: the last one, and the answer without it', () => {
  const body = 'Ecco il piano.\n\n```god-plan\n{"a": 1}\n```\n\nPoi:\n```god-plan\n{"b": 2}\n```\n';
  assert.equal(planBlock(body), '{"b": 2}');
  assert.equal(withoutPlan(body), 'Ecco il piano.\n\n\n\nPoi:');
  assert.equal(planBlock('niente piano'), undefined);
  assert.equal(planOfAnswer('niente piano'), undefined);
});

test('a plan: title, 1 to 6 subtasks with goal, own files and earlier dependencies', () => {
  const ok = checkGodPlan(plan([subtask(['apps/core/src/a.ts', './apps/core/test/a.test.ts']), subtask(['apps/hud/src/'], { blocked_by: [1, 1] })]));
  assert.ok(!('error' in ok));
  assert.deepEqual(ok.subtasks[0]?.files, ['apps/core/src/a.ts', 'apps/core/test/a.test.ts']);
  assert.deepEqual(ok.subtasks[1]?.blockedBy, [1]);
  assert.match((checkGodPlan('non json') as { error: string }).error, /JSON/);
  assert.match((checkGodPlan(plan([subtask(['a.ts'])], '')) as { error: string }).error, /titolo/);
  assert.match((checkGodPlan(plan([])) as { error: string }).error, /da 1 a 6/);
  assert.match((checkGodPlan(plan(Array.from({ length: 7 }, (_, i) => subtask([`f${String(i)}.ts`])))) as { error: string }).error, /da 1 a 6/);
  assert.match((checkGodPlan(plan([subtask([])])) as { error: string }).error, /file suoi/);
  assert.match((checkGodPlan(plan([subtask(['a.ts'], { goal: '' })])) as { error: string }).error, /obiettivo/);
  assert.match((checkGodPlan(plan([subtask(['a.ts'], { blocked_by: [1] })])) as { error: string }).error, /precedenti/);
  assert.match((checkGodPlan(plan([subtask(['a.ts']), subtask(['b.ts'], { blocked_by: [2] })])) as { error: string }).error, /precedenti/);
});

test('never two subtasks on the same files, nor on a shared document', () => {
  assert.match((checkGodPlan(plan([subtask(['apps/a.ts']), subtask(['apps/A.ts'])])) as { error: string }).error, /stessi file/);
  assert.match((checkGodPlan(plan([subtask(['apps/']), subtask(['apps/core/x.ts'])])) as { error: string }).error, /stessi file/);
  for (const shared of ['CHANGELOG.md', 'docs/HANDOFF.md', 'docs/DECISIONS.md', 'package.json', 'pnpm-lock.yaml', 'docs/']) {
    assert.match((checkGodPlan(plan([subtask([shared])])) as { error: string }).error, /condiviso/, shared);
  }
  assert.ok(!('error' in checkGodPlan(plan([subtask(['apps/core/package.json'])]))), 'a package.json of a package is not the root one');
});

test('a path a subtask may own: relative, no .., no .git, no wildcards', () => {
  assert.equal(safePath('apps/core/src/x.ts'), 'apps/core/src/x.ts');
  assert.equal(safePath('./docs/mockups/'), 'docs/mockups/');
  for (const bad of ['/etc/passwd', '../x', 'a/../b', '.git/config', 'a/.GIT/x', 'a\\b', 'src/*.ts', '', 3]) assert.equal(safePath(bad), undefined, String(bad));
  assert.equal(overlaps('a/', 'a/b'), true);
  assert.equal(overlaps('a/b', 'a/bc'), false);
});

test('the folder of a subtask: a number and a slug of its title', () => {
  assert.equal(slugOf('Barra della quota: più chiara!'), 'barra-della-quota-piu-chiara');
  assert.equal(slugOf('???'), 'lavoro');
  assert.equal(partName(7, 'Pagina GOD'), 'g007-pagina-god');
  assert.match(partName(999, 'x'.repeat(80)), /^g999-x{30}$/);
  assert.throws(() => partName(1000, 'x'), RangeError);
});

test('the quota: the fullest window projected to its reset sets how many subtasks at once', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  // Five hours, two and a half gone, 30% used: 60% at the reset.
  const half = { window: 'five_hour', utilization: 0.3, resetsAt: new Date('2026-10-11T14:30:00Z') };
  assert.ok(Math.abs((projectReading(half, now) ?? 0) - 0.6) < 1e-9);
  assert.equal(projectReading({ ...half, window: 'unknown' }, now), undefined);
  assert.equal(projectReading({ ...half, resetsAt: new Date('2026-10-11T11:00:00Z') }, now), undefined, 'a reset already past');
  const week = { window: 'seven_day', utilization: 0.1, resetsAt: new Date('2026-10-15T12:00:00Z') };
  assert.ok(Math.abs((projection([half, week], now) ?? 0) - 0.6) < 1e-9);
  assert.equal(projection([], now), undefined);
  assert.equal(concurrencyFor(undefined), 2);
  assert.equal(concurrencyFor(0.3), 4);
  assert.equal(concurrencyFor(0.5), 2);
  assert.equal(concurrencyFor(1), 2);
  assert.equal(concurrencyFor(1.2), 1);
});

test('the messages of the subtask: the Coder\'s brief, the Reviewer\'s, the verdict, the files outside', () => {
  const row = { position: 2, title: 'Pagina', goal: 'Fai la pagina.', files: ['apps/hud/src/P.vue', 'apps/hud/test/'], part: 'g002-pagina' };
  const brief = subtaskBrief({ title: 'Piano' }, row, 3);
  assert.match(brief, /Sottocompito 2 di 3 del piano «Piano»/);
  assert.match(brief, /- apps\/hud\/src\/P\.vue/);
  assert.match(brief, /ramo god\/g002-pagina/);
  assert.match(brief, /Non fare commit/);
  assert.match(reviewBrief(row, false), /ESITO: approvato/);
  assert.match(reviewBrief(row, true), /di nuovo/);
  assert.equal(verdictOf('ESITO: approvato\nniente'), 'ok');
  assert.equal(verdictOf('Esito: Da correggere\n- x'), 'changes');
  assert.equal(verdictOf('boh'), 'unknown');
  assert.equal(verdictOf(undefined), 'unknown');
  assert.deepEqual(outsideFiles(row.files, ['apps/hud/src/P.vue', 'apps/hud/test/p.test.ts', 'apps/core/src/x.ts']), ['apps/core/src/x.ts']);
  assert.deepEqual(mergeCommandsOf('g002-pagina'), ['git fetch repos/arianna/g002-pagina god/g002-pagina', 'git merge --no-ff FETCH_HEAD']);
});

test('pnpm in a new clone sees the path and the home, nothing of the core', () => {
  const env = pnpmEnv({ PATH: '/bin', HOME: '/utente/x', ARIANNA_HOME: '/secret', PGPASSWORD: 'x', SOPS_AGE_KEY: 'y' });
  assert.deepEqual(env, { CI: '1', PATH: '/bin', HOME: '/utente/x' });
});
