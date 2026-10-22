// The charts of "Finanze" (I-18, D-183): scales, ticks, bars and the balance
// line, computed without a library. Numbers invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { balanceLine, categoryBars, CHART_FONT, dayNumber, labelShown, labelStep, monthBars, niceCeil, niceDomain, PHONE_CHART_WIDTH, phoneFrame, sampleLabels, scale, ticks, type Frame } from '../src/lib/finance-charts.ts';

const FRAME: Frame = { width: 400, height: 200, left: 40, right: 10, top: 10, bottom: 30 };

test('round upper bounds for the axes', () => {
  assert.equal(niceCeil(0), 0);
  assert.equal(niceCeil(87), 100);
  assert.equal(niceCeil(120), 200);
  assert.equal(niceCeil(210), 250);
  assert.equal(niceCeil(260), 500);
  assert.equal(niceCeil(1000), 1000);
});

test('the domain holds zero and every value', () => {
  assert.deepEqual(niceDomain([120, 40]), [0, 200]);
  assert.deepEqual(niceDomain([-30, 80]), [-50, 100]);
  assert.deepEqual(niceDomain([]), [0, 1]);
  assert.deepEqual(ticks([0, 200]), [0, 50, 100, 150, 200]);
});

test('a linear scale', () => {
  const y = scale([0, 100], [200, 0]);
  assert.equal(y(0), 200);
  assert.equal(y(50), 100);
  assert.equal(scale([5, 5], [10, 20])(5), 10);
});

test('two bars per month, from the zero line, the taller for the larger amount', () => {
  const { bars, domain } = monthBars(
    [
      { month: '2026-09', income: 200000, expenses: 150000, net: 50000, count: 30 },
      { month: '2026-10', income: 0, expenses: 50000, net: -50000, count: 8 },
    ],
    FRAME,
  );
  assert.deepEqual(domain, [0, 200000]);
  assert.equal(bars.length, 2);
  const [september, october] = bars;
  assert.ok(september !== undefined && october !== undefined);
  assert.equal(september.income.y + september.income.height, FRAME.height - FRAME.bottom);
  assert.equal(september.income.y, FRAME.top);
  assert.ok(september.income.height > september.expenses.height);
  assert.equal(october.income.height, 0);
  assert.ok(october.center > september.center);
});

test('categories: expenses only, largest first, the rest together', () => {
  const bars = categoryBars(
    [
      { category: 'a', expenses: 1000, income: 0, count: 1 },
      { category: 'b', expenses: 3000, income: 0, count: 1 },
      { category: null, expenses: 500, income: 0, count: 1 },
      { category: 'c', expenses: 0, income: 9000, count: 1 },
      { category: 'd', expenses: 500, income: 0, count: 1 },
    ],
    2,
  );
  assert.deepEqual(
    bars.map((bar) => [bar.category, bar.expenses, bar.share]),
    [
      ['b', 3000, 60],
      ['a', 1000, 20],
      ['', 1000, 20],
    ],
  );
  assert.equal(bars[0]?.percent, 100);
  assert.deepEqual(categoryBars([]), []);
});

test('the balance line goes left to right and up with the balance', () => {
  const { points, path } = balanceLine(
    [
      { day: '2026-10-01', balance: 100000, source: 'bank' },
      { day: '2026-10-11', balance: 50000, source: 'computed' },
      { day: '2026-10-21', balance: 150000, source: 'bank' },
    ],
    FRAME,
  );
  assert.equal(points[0]?.x, FRAME.left);
  assert.equal(points[2]?.x, FRAME.width - FRAME.right);
  assert.ok((points.at(1)?.y ?? 0) > (points.at(0)?.y ?? 0));
  assert.ok(path.startsWith('M40 '));
  assert.equal(path.split('L').length, 3);
  assert.equal(dayNumber('1970-01-02'), 1);
  const single = balanceLine([{ day: '2026-10-01', balance: 100, source: 'bank' }], FRAME);
  assert.equal(single.points.length, 1);
});

test('a few labels from a long series, first and last included', () => {
  assert.deepEqual(sampleLabels([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(sampleLabels([1, 2, 3, 4, 5, 6, 7, 8, 9], 3), [1, 5, 9]);
});

test('on the phone a chart is drawn as wide as the screen, its labels readable (D-294)', () => {
  const wide = { width: 640, height: 220, left: 56, right: 8, top: 12, bottom: 28 };
  const phone = phoneFrame(wide, { left: 46, right: 4, height: 200 });
  assert.deepEqual(phone, { width: PHONE_CHART_WIDTH, height: 200, left: 46, right: 4, top: 12, bottom: 28 });
  assert.deepEqual(phoneFrame(wide, { left: 50 }), { ...wide, width: PHONE_CHART_WIDTH, left: 50 });
  // A label of 12 units on a screen about as wide as the frame stays about 12 px.
  assert.deepEqual(CHART_FONT, { wide: 11, phone: 12 });
});

test('fewer labels when they do not fit: one every labelStep (D-294)', () => {
  // Twelve months in 270 units, 30 each: one in two.
  assert.equal(labelStep(12, 270, 30), 2);
  // Six months fit.
  assert.equal(labelStep(6, 270, 30), 1);
  // Twenty-four months: one in three.
  assert.equal(labelStep(24, 270, 30), 3);
  assert.equal(labelStep(0, 270, 30), 1);
  assert.equal(labelStep(12, 0, 30), 1);
  assert.equal(labelStep(12, Number.NaN, 30), 1);
  assert.deepEqual(
    [0, 1, 2, 3, 4].filter((index) => labelShown(index, 2)),
    [0, 2, 4],
  );
  assert.deepEqual(
    [0, 1, 2].filter((index) => labelShown(index, 1)),
    [0, 1, 2],
  );
});
