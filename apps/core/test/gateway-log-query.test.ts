// «Registro del gateway» (D-296): the filters of the address, and the page readable from the phone.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GATEWAY_LOG_PAGE, GatewayLogQueryError, parseGatewayLogQuery } from '../src/gateway-log.ts';
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
