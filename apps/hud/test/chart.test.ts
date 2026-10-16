import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bandCenters, bars, chartSummary, colorOf, formatValue, linePoints, pieSlices, scaleY, shareText, shortLabel, valueAxis } from '../src/lib/chart.ts';

test('the axis starts at zero or below, with nice ticks; a flat series still has a span', () => {
  assert.deepEqual(valueAxis([238.15, 164, 71]), { min: 0, max: 300, ticks: [0, 100, 200, 300] });
  const negative = valueAxis([-30, 40]);
  assert.ok(negative.min <= -30 && negative.max >= 40 && negative.ticks.includes(0));
  assert.deepEqual(valueAxis([0, 0]), { min: 0, max: 1, ticks: [0, 0.5, 1] });
  assert.equal(scaleY(0, { min: 0, max: 100 }, 10, 110), 110);
  assert.equal(scaleY(100, { min: 0, max: 100 }, 10, 110), 10);
});

test('bars stay inside their band, a negative one hangs under zero', () => {
  const box = { left: 0, right: 300, top: 0, bottom: 100 };
  const list = bars({ labels: ['a', 'b', 'c'], series: [{ name: 's', values: [10, -5, 20] }] }, { min: -10, max: 20 }, box);
  assert.equal(list.length, 3);
  for (const bar of list) assert.ok(bar.x >= 0 && bar.x + bar.width <= 300 && bar.y >= 0 && bar.y + bar.height <= 100);
  const negative = list[1];
  const zero = scaleY(0, { min: -10, max: 20 }, 0, 100);
  assert.ok(negative !== undefined && negative.y === zero && negative.height > 0);
  assert.deepEqual(bandCenters(2, 0, 100), [25, 75]);
  assert.equal(linePoints([0, 10], { min: 0, max: 10 }, { left: 0, right: 100, top: 0, bottom: 50 }), '25.0,50.0 75.0,0.0');
});

test('the slices of a pie share the circle; one slice is the whole circle; nothing for a zero total', () => {
  const slices = pieSlices([1, 1, 2], 50, 50, 40);
  assert.deepEqual(slices.map((slice) => slice.share), [0.25, 0.25, 0.5]);
  assert.ok(slices.every((slice) => slice.path.startsWith('M 50 50')));
  const whole = pieSlices([0, 5], 50, 50, 40);
  assert.equal(whole.length, 1);
  assert.match(whole[0]?.path ?? '', /A 40 40 0 1 1/);
  assert.deepEqual(pieSlices([0, 0], 50, 50, 40), []);
  assert.deepEqual(pieSlices([-1, 0], 50, 50, 40), []);
});

test('numbers, shares and labels as an Italian reader reads them', () => {
  assert.equal(formatValue(12345.5, '€'), '12.345,5 €');
  assert.equal(formatValue(12, ''), '12');
  assert.match(formatValue(1_500_000, '€', true), /Mln|mln|M/);
  assert.equal(shareText(0.384), '38 %');
  assert.equal(shareText(0.054), '5,4 %');
  assert.equal(shortLabel('Casa e bollette', 8), 'Casa e …');
  assert.equal(shortLabel('Spesa', 8), 'Spesa');
  assert.notEqual(colorOf(0), colorOf(1));
  assert.match(chartSummary({ kind: 'pie', title: 'Spesa', unit: '€', labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] }), /torta.*2 voci.*1 serie/);
});
