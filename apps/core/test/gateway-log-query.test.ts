// «Registro del gateway» (D-296): the filters of the address, and the page readable from the phone.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cutUtf8, KEPT_PART_BYTES, keptParts, subjectOf, whatOf } from '../src/gateway.ts';
import { GATEWAY_LOG_PAGE, gatewayLogId, GatewayLogQueryError, parseGatewayLogQuery } from '../src/gateway-log.ts';
import { MCP_EXIT_CODES, mcpSubject } from '../src/mcp/tools.ts';
import { localOnly } from '../src/server/remote.ts';

const parse = (query: string): ReturnType<typeof parseGatewayLogQuery> => parseGatewayLogQuery(new URLSearchParams(query));

test('no parameter is the first page with the default size', () => {
  assert.deepEqual(parse(''), { limit: GATEWAY_LOG_PAGE });
  assert.deepEqual(parse('decision=&label='), { limit: GATEWAY_LOG_PAGE });
});

test('every filter is read', () => {
  const query = parse('decision=block&kind=executor&target=claude&label=L1&from=2026-10-20T00:00:00.000Z&to=2026-10-21&before=42&limit=20');
  assert.equal(query.decision, 'block');
  assert.equal(query.kind, 'executor');
  assert.equal(query.target, 'claude');
  assert.equal(query.label, 'L1');
  assert.equal(query.from?.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(query.to?.toISOString(), '2026-10-21T00:00:00.000Z');
  assert.equal(query.before, '42');
  assert.equal(query.limit, 20);
});

test('anything unknown is refused', () => {
  for (const query of ['decision=yes', 'kind=mail', 'target=a b', 'target=Claude', 'label=L9', 'from=domani', 'from=2026-13-45', 'to=2026-10-01&from=2026-10-02', 'before=-1', 'before=0', 'before=9999999999999999999', 'limit=0', 'limit=500', 'limit=1.5', 'q=testo']) {
    assert.throws(() => parse(query), GatewayLogQueryError, query);
  }
});

test('the page is readable from the phone: only metadata, no setting of the exits', () => {
  assert.equal(localOnly('/api/gateway/log'), false);
});

test('«Cosa è uscito» (D-297): the text is read only from the Mac, the list stays readable from the phone', () => {
  for (const path of ['/api/gateway/log/1/text', '/api/gateway/log/123456789/text', '/api/gateway/log/x/text']) assert.equal(localOnly(path), true, path);
  for (const path of ['/api/gateway/log', '/api/gateway/log/1']) assert.equal(localOnly(path), false, path);
});

test('an id of the log: digits only, within a bigint', () => {
  assert.equal(gatewayLogId('42'), '42');
  for (const raw of ['', '0', '-1', '01', '1.5', 'abc', '9999999999999999999', '1;DROP']) assert.equal(gatewayLogId(raw), undefined, raw);
});

test('the parts kept: the UTF-8 that leaves, in order, cut at 1 MiB on a character boundary', () => {
  assert.equal(keptParts(undefined), null);
  assert.equal(keptParts([]), null);
  const kept = JSON.parse(keptParts(['uno', 'è€\u0000']) ?? '[]') as { b: string; n: number }[];
  assert.deepEqual(kept.map((part) => Buffer.from(part.b, 'base64').toString('utf8')), ['uno', 'è€\u0000']);
  assert.deepEqual(kept.map((part) => part.n), [3, 6]);
  const big = `${'a'.repeat(KEPT_PART_BYTES - 2)}€`;
  const [cut] = JSON.parse(keptParts([big]) ?? '[]') as { b: string; n: number }[];
  assert.equal(Buffer.from(cut?.b ?? '', 'base64').toString('utf8'), 'a'.repeat(KEPT_PART_BYTES - 2));
  assert.equal(cut?.n, KEPT_PART_BYTES + 1);
  assert.deepEqual(cutUtf8(Buffer.from('aé'), 2), Buffer.from('a'));
  assert.deepEqual(cutUtf8(Buffer.from('aé'), 3), Buffer.from('aé'));
});

test('«Cosa era» (D-297): a closed code, a subject of one line', () => {
  assert.equal(whatOf('mcp-kb-read'), 'mcp-kb-read');
  for (const raw of [undefined, '', 'Brief', 'a b', 'x'.repeat(49)]) assert.equal(whatOf(raw), null, String(raw));
  assert.equal(subjectOf(undefined), null);
  assert.equal(subjectOf('  \n '), null);
  assert.equal(subjectOf('kb/a.md'), 'kb/a.md');
  assert.equal(subjectOf('a\nb\u0000c'), 'a b c');
  assert.equal(Array.from(subjectOf('é'.repeat(600)) ?? '').length, 500);
});

test('the code and the subject of each tool of the MCP server, from its arguments alone', () => {
  for (const code of Object.values(MCP_EXIT_CODES)) assert.equal(whatOf(code), code);
  assert.equal(mcpSubject('list_skills', {}), undefined);
  assert.equal(mcpSubject('get_skill', { id: 'catalog/x' }), 'catalog/x');
  assert.equal(mcpSubject('kb_search', { query: 'fatture' }), 'fatture');
  assert.equal(mcpSubject('kb_read', { path: ' kb/a.md ' }), 'kb/a.md');
  assert.equal(mcpSubject('web_fetch', { url: 'https://www.example.com/pagina?q=1' }), 'example.com');
  assert.equal(mcpSubject('web_fetch', { url: 'non un indirizzo' }), undefined);
});

test('groups and the rows of a run', () => {
  const run = '0a5f3e1c-1111-4222-8333-000000000000';
  assert.equal(parse('group=run').group, 'run');
  assert.equal(parse(`run=${run}`).run, run);
  for (const query of ['group=task', 'run=abc', `group=run&run=${run}`]) assert.throws(() => parse(query), GatewayLogQueryError, query);
  assert.equal(localOnly(`/api/gateway/log/run/${run}/subjects`), true);
});
