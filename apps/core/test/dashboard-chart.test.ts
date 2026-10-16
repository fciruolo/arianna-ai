import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkChart, CHART_LIMITS } from '../src/dashboard-chart.ts';

const good = {
  kind: 'bar',
  title: 'Spesa di ottobre',
  unit: '€',
  labels: ['Spesa', 'Casa', 'Ristoranti'],
  series: [{ name: 'Ottobre', values: [238.15, 164, 71] }],
};

test('a valid chart passes, its texts tidied', () => {
  const checked = checkChart({ ...good, title: '  Spesa   di ottobre ' });
  assert.ok(checked.ok);
  assert.equal(checked.chart.title, 'Spesa di ottobre');
  assert.deepEqual(checked.chart.series[0]?.values, [238.15, 164, 71]);
  // A line with two series, and a pie with one; an empty unit is allowed, a missing one is empty.
  assert.ok(checkChart({ ...good, kind: 'line', series: [good.series[0], { name: 'Settembre', values: [200, 160, 50] }] }).ok);
  assert.ok(checkChart({ ...good, kind: 'pie', unit: '' }).ok);
  const noUnit = checkChart({ kind: good.kind, title: good.title, labels: good.labels, series: good.series });
  assert.ok(noUnit.ok && noUnit.chart.unit === '');
});

test('anything outside the closed shape is refused', () => {
  const refused = (value: unknown, problem: string): void => {
    const checked = checkChart(value);
    assert.deepEqual(checked, { ok: false, problem }, JSON.stringify(value));
  };
  refused(null, 'not-object');
  refused([good], 'not-object');
  refused({ ...good, extra: 1 }, 'unknown-field');
  refused({ ...good, kind: 'scatter' }, 'kind');
  refused({ ...good, title: '' }, 'title');
  refused({ ...good, title: 'x'.repeat(CHART_LIMITS.title + 1) }, 'title');
  refused({ ...good, unit: 'x'.repeat(CHART_LIMITS.unit + 1) }, 'unit');
  refused({ ...good, labels: [] }, 'labels');
  refused({ ...good, labels: Array.from({ length: CHART_LIMITS.labels + 1 }, (_, i) => `L${String(i)}`) }, 'labels');
  refused({ ...good, labels: ['Spesa', '', 'Ristoranti'] }, 'labels');
  refused({ ...good, series: [] }, 'series');
  refused({ ...good, series: Array.from({ length: 5 }, (_, i) => ({ name: `S${String(i)}`, values: [1, 2, 3] })) }, 'series');
  refused({ ...good, series: [{ name: 'Ottobre', values: [1, 2] }] }, 'values');
  refused({ ...good, series: [{ name: 'Ottobre', values: [1, Number.NaN, 3] }] }, 'values');
  refused({ ...good, series: [{ name: 'Ottobre', values: [1, Number.POSITIVE_INFINITY, 3] }] }, 'values');
  refused({ ...good, series: [{ name: 'Ottobre', values: [1, '2', 3] }] }, 'values');
  refused({ ...good, series: [{ name: 'Ottobre', values: [1, 2e13, 3] }] }, 'values');
  refused({ ...good, series: [{ name: 'Ottobre', values: [1, 2, 3], color: 'red' }] }, 'unknown-field');
  refused({ ...good, series: [{ name: '', values: [1, 2, 3] }] }, 'series');
  // A pie: one series, nothing below zero, not all zero.
  refused({ ...good, kind: 'pie', series: [{ name: 'A', values: [1, -1, 3] }] }, 'pie');
  refused({ ...good, kind: 'pie', series: [{ name: 'A', values: [0, 0, 0] }] }, 'pie');
  refused({ ...good, kind: 'pie', series: [good.series[0], { name: 'B', values: [1, 1, 1] }] }, 'pie');
});
