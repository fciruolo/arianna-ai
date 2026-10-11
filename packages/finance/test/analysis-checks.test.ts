import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkBudgets,
  findDuplicates,
  findRecurring,
  findUnusual,
  runChecks,
  type CategorizedTransaction,
} from '../src/index.ts';

let counter = 0;
const tx = (booked: string, description: string, amount: number, extra: Partial<CategorizedTransaction> = {}): CategorizedTransaction => ({
  account: 'conto-finto',
  booked,
  value: null,
  description,
  amount,
  currency: 'EUR',
  balance: null,
  fingerprint: 'fp-' + String(++counter),
  category: null,
  by: null,
  ...extra,
});

const streaming = (booked: string, amount = -999): CategorizedTransaction =>
  tx(booked, 'SDD STREAMING BETA MANDATO IT99ZZZ' + String(counter) + '000', amount, { category: 'abbonamenti' });

// --- recurring -------------------------------------------------------------

test('a monthly charge on the 31st follows the month ends and flags a new price', () => {
  const rows = ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30'].map((day) => streaming(day));
  rows.push(streaming('2025-05-31', -1199));
  const [alert, ...rest] = findRecurring(rows);
  assert.equal(rest.length, 0);
  assert.ok(alert);
  assert.equal(alert.cadence, 'monthly');
  assert.equal(alert.direction, 'out');
  assert.equal(alert.merchant, 'streaming beta');
  assert.deepEqual(alert.fingerprints, rows.map((row) => row.fingerprint));
  assert.equal(alert.amount, 999);
  assert.equal(alert.lastAmount, 1199);
  assert.equal(alert.amountChanged, true);
  assert.equal(alert.nextExpected, '2025-06-30');
});

test('a monthly charge in a leap year, moved to the next working day, keeps its price', () => {
  const rows = ['2024-01-29', '2024-02-29', '2024-04-01', '2024-04-29'].map((day) => streaming(day));
  const [alert] = findRecurring(rows);
  assert.equal(alert?.cadence, 'monthly');
  assert.equal(alert.amountChanged, false);
  assert.equal(alert.nextExpected, '2024-05-29');
});

test('weekly and yearly schedules and recurring income are recognized', () => {
  const gym = ['2025-09-01', '2025-09-08', '2025-09-15', '2025-09-23'].map((day) => tx(day, 'POS PALESTRA ZETA', -1500));
  const insurance = ['2022-03-10', '2023-03-12', '2024-03-09'].map((day) => tx(day, 'ADDEBITO ASSICURAZIONE ETA', -32000));
  const salary = ['2025-07-27', '2025-08-27', '2025-09-26'].map((day) => tx(day, 'BONIFICO DA DITTA FINTA SRL STIPENDIO', 210000));
  const alerts = findRecurring([...gym, ...insurance, ...salary]);
  const byMerchant = new Map(alerts.map((alert) => [alert.merchant, alert]));
  assert.equal(byMerchant.get('palestra zeta')?.cadence, 'weekly');
  assert.equal(byMerchant.get('assicurazione eta')?.cadence, 'yearly');
  assert.equal(byMerchant.get('assicurazione eta')?.nextExpected, '2025-03-10');
  const income = byMerchant.get('ditta finta srl stipendio');
  assert.equal(income?.direction, 'in');
  assert.equal(income.amount, 210000);
});

test('irregular shopping, too few occurrences and unsteady amounts are not recurring', () => {
  const shopping = [
    tx('2025-09-02', 'POS SUPERMERCATO ALFA', -4210),
    tx('2025-09-05', 'POS SUPERMERCATO ALFA', -1890),
    tx('2025-09-17', 'POS SUPERMERCATO ALFA', -6020),
    tx('2025-10-11', 'POS SUPERMERCATO ALFA', -3300),
  ];
  const twice = [streaming('2025-01-15'), streaming('2025-02-15')];
  const unsteady = ['2025-01-10', '2025-02-10', '2025-03-10', '2025-04-10'].map((day, index) =>
    tx(day, 'POS RISTORANTE KAPPA', -(1000 + index * 2000)),
  );
  assert.deepEqual(findRecurring([...shopping, ...twice, ...unsteady]), []);
  assert.deepEqual(findRecurring([]), []);
});

test('after a gap only the latest regular run counts', () => {
  const rows = ['2025-01-05', '2025-02-05', '2025-04-05', '2025-05-05', '2025-06-05'].map((day) => streaming(day));
  const [alert] = findRecurring(rows);
  assert.deepEqual(alert?.fingerprints, rows.slice(2).map((row) => row.fingerprint));
});

// --- unusual ---------------------------------------------------------------

test('an expense far above the median of the merchant is unusual', () => {
  const history = [-4000, -4500, -5000, -4200].map((amount, index) => tx('2025-0' + String(index + 1) + '-10', 'POS SUPERMERCATO ALFA', amount));
  const big = tx('2025-06-10', 'POS SUPERMERCATO ALFA', -30000);
  const normal = tx('2025-06-12', 'POS SUPERMERCATO ALFA', -12000);
  const alerts = findUnusual([...history, big, normal]);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    kind: 'unusual',
    fingerprint: big.fingerprint,
    account: 'conto-finto',
    merchant: 'supermercato alfa',
    category: null,
    amount: 30000,
    basis: 'merchant',
    median: 4500,
    historyCount: 5,
    ratioPercent: 667,
  });
});

test('a small excess, income and rows without enough history are not unusual', () => {
  const coffees = [-150, -150, -150].map((amount) => tx('2025-06-01', 'BAR GAMMA', amount));
  const pricey = tx('2025-06-02', 'BAR GAMMA', -1200);
  const refund = tx('2025-06-03', 'BAR GAMMA', 90000);
  const lonely = tx('2025-06-04', 'ELETTRONICA THETA', -90000);
  assert.deepEqual(findUnusual([...coffees, pricey, refund, lonely]), []);
});

test('without merchant history the category is the reference, and from limits the checked rows', () => {
  const home = ['FERRAMENTA IOTA', 'FERRAMENTA IOTA', 'COLORIFICIO LAMBDA', 'MOBILI MU', 'MOBILI MU'].map((name, index) =>
    tx('2025-0' + String(index + 1) + '-01', name, -5000, { category: 'casa' }),
  );
  const tv = tx('2025-07-20', 'ELETTRONICA THETA', -60000, { category: 'casa' });
  const [alert] = findUnusual([...home, tv]);
  assert.equal(alert?.basis, 'category');
  assert.equal(alert.median, 5000);
  assert.equal(alert.fingerprint, tv.fingerprint);
  assert.deepEqual(findUnusual([...home, tv], { from: '2025-08-01' }), []);
  assert.deepEqual(findUnusual([...home, tv], { ratioPercent: 1500 }), []);
});

// --- duplicates ------------------------------------------------------------

test('an extra charge of a subscription is a possible duplicate, the schedule is kept', () => {
  const rows = ['2025-07-05', '2025-08-05', '2025-09-05', '2025-10-05'].map((day) => streaming(day));
  const extra = streaming('2025-10-06');
  const recurring = findRecurring([...rows, extra]);
  assert.equal(recurring.length, 1);
  assert.equal(recurring[0]?.fingerprints.includes(extra.fingerprint), false);
  const alerts = findDuplicates([...rows, extra]);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    kind: 'duplicate',
    account: 'conto-finto',
    merchant: 'streaming beta',
    amount: 999,
    fingerprints: [rows[3]?.fingerprint, extra.fingerprint],
    firstDay: '2025-10-05',
    lastDay: '2025-10-06',
    recurring: true,
  });
});

test('the same purchase booked twice with the same bank text is a possible duplicate', () => {
  const text = 'PAGAMENTO POS NEGOZIO OMICRON CARTA ****1234 DEL 03/10 ORE 18:42';
  const first = tx('2025-10-03', text, -4999);
  const second = tx('2025-10-04', text, -4999);
  const alerts = findDuplicates([first, second]);
  assert.deepEqual(alerts.map((alert) => alert.fingerprints), [[first.fingerprint, second.fingerprint]]);
  assert.equal(alerts[0]?.recurring, false);
});

test('legitimate repeated expenses are not flagged', () => {
  const coffees = [tx('2025-10-03', 'POS BAR GAMMA DEL 03/10', -150), tx('2025-10-03', 'POS BAR GAMMA DEL 03/10', -150)];
  const shopping = [tx('2025-10-03', 'POS SUPERMERCATO ALFA DEL 03/10', -4500), tx('2025-10-04', 'POS SUPERMERCATO ALFA DEL 04/10', -4500)];
  const twoTimes = [tx('2025-10-03', 'POS NEGOZIO PI ORE 10:15', -2500), tx('2025-10-03', 'POS NEGOZIO PI ORE 18:40', -2500)];
  const far = [tx('2025-10-01', 'POS NEGOZIO RHO', -2500), tx('2025-10-06', 'POS NEGOZIO RHO', -2500)];
  const same = tx('2025-10-03', 'POS NEGOZIO SIGMA', -8000);
  const income = [tx('2025-10-03', 'RIMBORSO TAU', 2000), tx('2025-10-03', 'RIMBORSO TAU', 2000)];
  const otherAccount = [tx('2025-10-03', 'POS NEGOZIO UPSILON', -3000), tx('2025-10-03', 'POS NEGOZIO UPSILON', -3000, { account: 'carta-finta' })];
  assert.deepEqual(findDuplicates([...coffees, ...shopping, ...twoTimes, ...far, same, { ...same }, ...income, ...otherAccount]), []);
});

test('weekly occurrences are never duplicates of each other, even with a wide window', () => {
  const gym = ['2025-09-01', '2025-09-08', '2025-09-15', '2025-09-22'].map((day) => tx(day, 'POS PALESTRA ZETA', -1500));
  assert.deepEqual(findDuplicates(gym, { windowDays: 7 }), []);
});

// --- budgets ---------------------------------------------------------------

test('budgets over the limit or near it are reported with the numbers', () => {
  const rows = [
    tx('2025-10-02', 'POS SUPERMERCATO ALFA', -30000, { category: 'spesa' }),
    tx('2025-10-20', 'POS SUPERMERCATO ALFA', -16000, { category: 'spesa' }),
    tx('2025-10-21', 'RIMBORSO SUPERMERCATO ALFA', 1000, { category: 'spesa' }),
    tx('2025-10-05', 'POS BAR GAMMA', -8200, { category: 'bar' }),
    tx('2025-10-06', 'POS CINEMA PHI', -2000, { category: 'svago' }),
    tx('2025-09-30', 'POS SUPERMERCATO ALFA', -99999, { category: 'spesa' }),
  ];
  const alerts = checkBudgets(
    rows,
    [
      { category: 'spesa', monthly: 40000 },
      { category: 'bar', monthly: 10000 },
      { category: 'svago', monthly: 10000 },
    ],
    '2025-10',
  );
  assert.deepEqual(
    alerts.map(({ category, spent, limit, percent, state, fingerprints }) => ({ category, spent, limit, percent, state, count: fingerprints.length })),
    [
      { category: 'spesa', spent: 45000, limit: 40000, percent: 112, state: 'over', count: 3 },
      { category: 'bar', spent: 8200, limit: 10000, percent: 82, state: 'near', count: 1 },
    ],
  );
});

test('budgets: a month without movements, exactly at the limit, 29 February and invalid limits', () => {
  assert.deepEqual(checkBudgets([], [{ category: 'spesa', monthly: 40000 }], '2025-10'), []);
  const exact = checkBudgets([tx('2025-10-01', 'POS ALFA', -40000, { category: 'spesa' })], [{ category: 'spesa', monthly: 40000 }], '2025-10');
  assert.deepEqual(exact.map((alert) => [alert.state, alert.percent]), [['near', 100]]);
  const leap = checkBudgets([tx('2024-02-29', 'POS ALFA', -50000, { category: 'spesa' })], [{ category: 'spesa', monthly: 40000 }], '2024-02');
  assert.equal(leap[0]?.state, 'over');
  assert.throws(() => checkBudgets([], [{ category: 'spesa', monthly: 0 }], '2025-10'), RangeError);
  assert.throws(() => checkBudgets([], [{ category: 'spesa', monthly: 10.5 }], '2025-10'), RangeError);
});

// --- all together ----------------------------------------------------------

test('runChecks gathers the alerts of the month and no ready-made text', () => {
  const rows = [
    ...['2025-07-05', '2025-08-05', '2025-09-05'].map((day) => streaming(day)),
    streaming('2025-10-05', -1199),
    tx('2025-10-03', 'POS NEGOZIO OMICRON DEL 03/10', -4999, { category: 'spesa' }),
    tx('2025-10-03', 'POS NEGOZIO OMICRON DEL 03/10', -4999, { category: 'spesa' }),
  ];
  const alerts = runChecks(rows, { month: '2025-10', budgets: [{ category: 'spesa', monthly: 9000 }] });
  assert.deepEqual(alerts.map((alert) => alert.kind), ['duplicate', 'budget', 'recurring']);
  for (const alert of alerts) {
    for (const value of Object.values(alert)) {
      if (typeof value === 'string') assert.doesNotMatch(value, /\d+[.,]\d{2}|€|eur/i);
    }
  }
  assert.deepEqual(runChecks(rows, { month: '2026-01' }), []);
});
