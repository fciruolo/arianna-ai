import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendPage,
  askerText,
  bytesText,
  destinationOptions,
  EMPTY_FILTERS,
  emptyText,
  filtersActive,
  isPrivateOut,
  originText,
  periodProblem,
  queryOf,
  rowLine,
  ruleText,
  targetText,
  timeText,
  type GatewayLogEntry,
} from '../src/lib/gateway-log.ts';
import { GATEWAY_LOG_PATH, isGatewayLogPath } from '../src/lib/route.ts';

const NOW = new Date(2026, 9, 23, 18, 0);

function entry(overrides: Partial<GatewayLogEntry> = {}): GatewayLogEntry {
  return {
    id: '7',
    ts: new Date(2026, 9, 23, 9, 41).toISOString(),
    targetKind: 'executor',
    target: 'claude',
    locality: 'cloud',
    label: 'L1',
    decision: 'allow',
    rule: 'cloud',
    bytes: 640,
    agent: 'coder',
    model: 'sonnet',
    conversation: null,
    card: null,
    ...overrides,
  };
}

test('a row in one line, as the example of D-296', () => {
  assert.equal(rowLine(entry(), NOW), '09:41 · Claude · Coder · Interno · ammessa · 640 byte');
  assert.equal(rowLine(entry({ decision: 'block', bytes: null, label: 'L2', rule: 'pii' }), NOW), '09:41 · Claude · Coder · Privato · bloccata');
});

test('time: the hour today, the day before it otherwise, the year when it is another', () => {
  assert.equal(timeText(new Date(2026, 9, 23, 9, 41).toISOString(), NOW), '09:41');
  assert.match(timeText(new Date(2026, 9, 21, 7, 5).toISOString(), NOW), /^21 ott 07:05$/);
  assert.match(timeText(new Date(2025, 0, 2, 7, 5).toISOString(), NOW), /2025/);
});

test('targets and rules in Italian; an unknown code is shown as it is', () => {
  assert.equal(targetText('executor', 'codex'), 'Codex');
  assert.equal(targetText('channel', 'push'), 'Notifiche push');
  assert.equal(targetText('web', 'web-form'), 'Browser · modulo inviato da te');
  assert.equal(targetText('link', 'link-video'), 'Video di YouTube');
  assert.equal(targetText('executor', 'nuovo'), 'nuovo');
  assert.equal(targetText('other', 'other'), 'Altro');
  assert.match(ruleText('pii'), /dati personali/);
  assert.equal(ruleText('nuova-regola'), 'Regola «nuova-regola».');
});

test('who asked and from where', () => {
  assert.equal(askerText({ agent: null }), 'Arianna (sistema)');
  assert.equal(askerText({ agent: 'local-chat' }), 'Modello locale');
  assert.equal(originText({ conversation: { id: 'c', title: 'Riordino', open: true }, card: null }), 'Riordino');
  assert.equal(originText({ conversation: { id: 'c', title: null, open: true }, card: null }), 'Conversazione senza titolo');
  assert.equal(originText({ conversation: { id: 'c', title: null, open: false }, card: null }), 'Conversazione cancellata');
  assert.equal(originText({ conversation: null, card: { id: 't', title: 'Preventivo' } }), 'Card «Preventivo»');
  assert.equal(originText({ conversation: null, card: null }), null);
});

test('sizes', () => {
  assert.equal(bytesText(null), 'non misurata');
  assert.equal(bytesText(900), '900 byte');
  assert.equal(bytesText(2048), '2 KB');
  assert.equal(bytesText(3 * 1024 * 1024), '3 MB');
});

test('the address: filters, local midnights with «Al» included, the cursor', () => {
  assert.equal(queryOf(EMPTY_FILTERS), '');
  const query = new URLSearchParams(queryOf({ decision: 'block', destination: 'executor/claude', label: 'L2', from: '2026-10-20', to: '2026-10-21' }, '42', 50).slice(1));
  assert.equal(query.get('decision'), 'block');
  assert.equal(query.get('kind'), 'executor');
  assert.equal(query.get('target'), 'claude');
  assert.equal(query.get('label'), 'L2');
  assert.equal(query.get('from'), new Date(2026, 9, 20).toISOString());
  assert.equal(query.get('to'), new Date(2026, 9, 22).toISOString());
  assert.equal(query.get('before'), '42');
  assert.equal(query.get('limit'), '50');
  // A whole kind, without a target; a day that is not a day is no filter.
  const kind = new URLSearchParams(queryOf({ ...EMPTY_FILTERS, destination: 'channel', from: 'ieri' }).slice(1));
  assert.equal(kind.get('kind'), 'channel');
  assert.equal(kind.has('target'), false);
  assert.equal(kind.has('from'), false);
  assert.equal(queryOf(EMPTY_FILTERS, null), '');
});

test('active filters and a period backwards', () => {
  assert.equal(filtersActive(EMPTY_FILTERS), 0);
  assert.equal(filtersActive({ ...EMPTY_FILTERS, decision: 'allow', from: '2026-10-01' }), 2);
  assert.equal(periodProblem({ from: '2026-10-02', to: '2026-10-01' }) !== null, true);
  assert.equal(periodProblem({ from: '2026-10-01', to: '2026-10-01' }), null);
  assert.equal(periodProblem({ from: '', to: '2026-10-01' }), null);
});

test('«Carica altre» never repeats a row', () => {
  const shown = [entry({ id: '9' }), entry({ id: '8' })];
  assert.deepEqual(appendPage(shown, [entry({ id: '8' }), entry({ id: '7' })]).map((item) => item.id), ['9', '8', '7']);
});

test('the empty page says whether filters hide the rows', () => {
  assert.match(emptyText(EMPTY_FILTERS).title, /Ancora nessuna/);
  assert.match(emptyText({ ...EMPTY_FILTERS, label: 'L3' }).title, /con questi filtri/);
});

test('the choices of «Destinazione» by kind, telling apart targets that read the same', () => {
  const groups = destinationOptions([
    { kind: 'executor', target: 'claude' },
    { kind: 'web', target: 'web-resource-public' },
    { kind: 'web', target: 'web-resource-user' },
    { kind: 'other', target: 'x' },
  ]);
  assert.deepEqual(groups.map((group) => group.group), ['Modelli', 'Web e browser']);
  assert.deepEqual(groups[0]?.options.map((option) => option.value), ['executor', 'executor/claude']);
  const web = groups[1]?.options.map((option) => option.text) ?? [];
  assert.equal(new Set(web).size, web.length);
});

test('a private exit to the cloud is marked; a link or a block is not', () => {
  assert.equal(isPrivateOut(entry({ label: 'L2', targetKind: 'web', target: 'web-session' })), true);
  assert.equal(isPrivateOut(entry({ label: 'L2', targetKind: 'link', target: 'link-click' })), false);
  assert.equal(isPrivateOut(entry({ label: 'L2', decision: 'block' })), false);
  assert.equal(isPrivateOut(entry({ label: 'L2', locality: 'local' })), false);
  assert.equal(isPrivateOut(entry()), false);
});

test('the address of the page', () => {
  assert.equal(isGatewayLogPath(GATEWAY_LOG_PATH), true);
  assert.equal(isGatewayLogPath(`${GATEWAY_LOG_PATH}/`), true);
  assert.equal(isGatewayLogPath('/registro'), false);
});
