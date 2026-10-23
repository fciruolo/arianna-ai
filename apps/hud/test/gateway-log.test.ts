import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendPage,
  askerText,
  bytesText,
  copyOfText,
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
  TEXT_FROM_MAC,
  TEXT_GONE,
  textNotice,
  textSizeText,
  textStateNotice,
  timeText,
  verifiedText,
  appendGroups,
  exitText,
  groupCounts,
  groupDecision,
  groupHeadline,
  runQuery,
  whatText,
  type GatewayLogEntry,
  type GatewayLogGroup,
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
    runId: null,
    what: null,
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

test('«Cosa è uscito» (D-297): no text asked for a block, a local target, a private exit or from the phone', () => {
  assert.equal(textNotice(entry(), false), null);
  assert.equal(textNotice(entry(), true), TEXT_FROM_MAC);
  assert.equal(textNotice(entry({ decision: 'block', label: 'L2' }), false), 'Fermata: conteneva un dato Privato. Non è uscito nulla e il testo non si conserva.');
  assert.match(textNotice(entry({ decision: 'block', label: 'L3' }), true) ?? '', /^Fermata: conteneva un dato Segreto\./);
  assert.match(textNotice(entry({ decision: 'block', label: 'L1', rule: 'scanner' }), false) ?? '', /^Fermata: non è uscito nulla/);
  assert.match(textNotice(entry({ locality: 'local' }), false) ?? '', /^Destinazione sul Mac/);
  assert.match(textNotice(entry({ label: 'L2', targetKind: 'link', target: 'link-click' }), false) ?? '', /^Uscita Privata/);
});

test('what the core answered, in words; the text itself is never a notice', () => {
  assert.equal(textStateNotice({ state: 'text', label: 'L1' }), null);
  assert.equal(textStateNotice({ state: 'gone', label: 'L1' }), TEXT_GONE);
  assert.equal(textStateNotice({ state: 'gone', label: 'L1' }), 'Testo non più disponibile (conversazione eliminata o oltre 30 giorni).');
  assert.match(textStateNotice({ state: 'blocked', label: 'L2' }) ?? '', /Privato/);
  assert.match(textStateNotice({ state: 'none', label: 'L0' }) ?? '', /^Testo non salvato/);
});

test('size, parts, cut and the sha256 check of the text', () => {
  const first = { text: 'Istruzioni', bytes: 10, truncated: false };
  const parts = [first, { text: 'a', bytes: 2 * 1024 * 1024, truncated: true }];
  assert.equal(textSizeText({ parts: [first], bytes: 10 }), '10 byte');
  assert.equal(textSizeText({ parts, bytes: 10 + 2 * 1024 * 1024 }), '2 MB in 2 parti · troncato a 1 MB');
  assert.equal(copyOfText(parts), 'Istruzioni\n\na');
  assert.match(verifiedText(true), /^Coincide/);
  assert.match(verifiedText(false), /^Non coincide/);
  assert.match(verifiedText(null), /^Troncato/);
});

test('«Cosa era» (D-297): the kind of each exit in Italian, with its subject from the Mac', () => {
  assert.equal(whatText(entry({ what: 'brief' })), 'Istruzioni iniziali');
  assert.equal(whatText(entry({ what: 'mcp-kb-search' })), 'Ricerca nella KB');
  assert.equal(whatText(entry({ what: 'mcp-kb-read-denied' })), 'Accesso negato (Lettura nota)');
  assert.equal(whatText(entry({ what: null })), 'Claude');
  assert.equal(whatText(entry({ what: 'sconosciuto' })), 'Uscita');
  assert.equal(exitText(entry({ what: 'mcp-kb-read' }), 'kb/note/a.md'), 'Lettura nota · kb/note/a.md');
  assert.equal(exitText(entry({ what: 'mcp-kb-read-denied' }), 'kb/private/b.md'), 'Accesso negato a kb/private/b.md');
  assert.equal(exitText(entry({ what: 'mcp-skill' }), undefined), 'Skill');
  assert.equal(exitText(entry({ what: 'mcp-web-page' }), ''), 'Pagina web');
});

function group(overrides: Partial<GatewayLogGroup> = {}): GatewayLogGroup {
  return { entry: entry({ runId: 'r1' }), count: 20, allowed: 16, blocked: 4, bytes: 48 * 1024, firstTs: entry().ts, targets: 1, label: 'L2', privateOut: 0, cloud: 20, headline: { targetKind: 'executor', target: 'claude', locality: 'cloud' }, ...overrides };
}

test('one line per request: the counts of the group, its outcome, its pages', () => {
  assert.equal(groupCounts(group()), '20 uscite · 16 ammesse · 4 bloccate · 48 KB');
  assert.equal(groupCounts(group({ count: 1, allowed: 1, blocked: 0, bytes: null })), '1 uscita · 1 ammessa · 0 bloccate');
  assert.equal(groupDecision(group()), 'con blocchi');
  assert.equal(groupDecision(group({ blocked: 0 })), 'ammesse');
  assert.equal(groupDecision(group({ allowed: 0 })), 'bloccate');
  const first = group({ entry: entry({ id: '9', runId: 'r1' }) });
  const second = group({ entry: entry({ id: '5', runId: 'r2' }) });
  assert.deepEqual(appendGroups([first], [first, second]).map((item) => item.entry.id), ['9', '5']);
  assert.equal(runQuery('r1'), '?run=r1&limit=100');
  assert.equal(runQuery('r1', '42'), '?before=42&run=r1&limit=100');
  // The filters of the page but the outcome: the exits its counts count.
  assert.equal(runQuery('r1', null, { ...EMPTY_FILTERS, decision: 'block', label: 'L1' }), '?label=L1&run=r1&limit=100');
  assert.equal(queryOf({ ...EMPTY_FILTERS, decision: 'block' }, null, undefined, true), '?group=run&decision=block');
});

test('a line with exits to the cloud never reads «sul Mac»: its cloud target leads', () => {
  assert.deepEqual(groupHeadline(group({ targets: 2, cloud: 16, count: 17 })), { target: 'Claude e altre', place: 'fuori dal Mac (16 di 17)' });
  assert.deepEqual(groupHeadline(group()), { target: 'Claude', place: 'fuori dal Mac' });
  assert.deepEqual(groupHeadline(group({ cloud: 0, count: 2, headline: { targetKind: 'executor', target: 'local', locality: 'local' } })), { target: 'Modello locale', place: 'sul Mac' });
  assert.equal(whatText(entry({ what: 'project-note' })), 'Nota del progetto');
  assert.equal(exitText(entry({ what: 'project-note' }), 'note/architettura.md'), 'Nota del progetto · note/architettura.md');
});
