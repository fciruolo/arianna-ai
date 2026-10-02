import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createContext, recordRead, sha256Hex, type Labeled, type Target } from '@arianna/policy';

import { decideApproval, loadApproval, requestDeclassify } from '../src/approvals.ts';
import { applyDeclassify, passGateway } from '../src/gateway.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();

const CLAUDE: Target = { kind: 'executor', id: 'claude', locality: 'cloud' };
const LOCAL_MODEL: Target = { kind: 'executor', id: 'omlx', locality: 'local' };
const SHA = 'a'.repeat(64);

interface LogRow {
  target_kind: string;
  target: string;
  locality: string;
  label: string;
  decision: string;
  rule: string;
  reason: string;
  bytes_out: number | null;
  payload_sha256: string | null;
  summary: string | null;
}

async function lastLog(): Promise<LogRow> {
  const [row] = await db().sql<LogRow[]>`
    SELECT target_kind, target, locality, label, decision, rule, reason, bytes_out, payload_sha256, summary
    FROM gateway_log ORDER BY id DESC LIMIT 1`;
  if (row === undefined) throw new Error('gateway_log is empty');
  return row;
}

test('an allowed exit writes one log row, with size and hash but no content', async () => {
  const payload: Labeled<string>[] = [{ value: 'Fix the flaky router test.', label: 'L1', source: 'test' }];
  const decision = await passGateway(db().sql, payload, createContext('L1'), CLAUDE, { summary: 'brief for task 1.7' });
  assert.equal(decision.decision, 'allow');
  const row = await lastLog();
  assert.deepEqual({ ...row, payload_sha256: row.payload_sha256?.length }, {
    target_kind: 'executor',
    target: 'claude',
    locality: 'cloud',
    label: 'L1',
    decision: 'allow',
    rule: 'cloud',
    reason: 'L1 to a cloud target, scan clean',
    bytes_out: 26,
    payload_sha256: 64,
    summary: 'brief for task 1.7',
  });
});

test('a blocked exit is logged too, without the summary', async () => {
  const payload: Labeled<string>[] = [{ value: 'fake private note', label: 'L2', source: 'kb/private/a.md' }];
  const decision = await passGateway(db().sql, payload, createContext('L1'), CLAUDE, { summary: 'would leak' });
  assert.equal(decision.decision, 'block');
  const row = await lastLog();
  assert.equal(row.decision, 'block');
  assert.equal(row.rule, 'cloud-label');
  assert.equal(row.label, 'L2');
  assert.equal(row.summary, null);
});

test('a scanner block names the kind of match, never the matched text', async () => {
  const iban = 'IT60X0542811101000000123456';
  await passGateway(db().sql, [{ value: `pay ${iban}`, label: 'L1', source: 'test' }], createContext('L1'), CLAUDE);
  const row = await lastLog();
  assert.equal(row.rule, 'scanner');
  assert.equal(JSON.stringify(row).includes(iban), false);
});

test('a forged context is blocked and logged', async () => {
  const forged = { clearance: 'L1', effective: 'L0' } as ReturnType<typeof createContext>;
  const decision = await passGateway(db().sql, [{ value: 'x', label: 'L1', source: 'test' }], forged, CLAUDE);
  assert.equal(decision.rule, 'invalid-input');
  assert.equal((await lastLog()).rule, 'invalid-input');
});

test('the database refuses log rows the policy would never allow', async () => {
  const { sql } = db();
  const row = (label: string, decision: string, locality: string, summary: string | null) => sql`
    INSERT INTO gateway_log (target_kind, target, locality, label, decision, rule, reason, summary)
    VALUES ('executor', 'claude', ${locality}, ${label}::privacy_label, ${decision}, 'test', 'test', ${summary})`;
  await assert.rejects(row('L2', 'allow', 'cloud', null), /gateway_log_cloud_up_to_l1/);
  await assert.rejects(row('L3', 'allow', 'local', null), /gateway_log_no_secret_out/);
  await assert.rejects(row('L2', 'allow', 'local', 'content'), /gateway_log_summary_only_l1/);
  await assert.rejects(row('L1', 'block', 'cloud', 'content'), /gateway_log_summary_only_l1/);
  await row('L2', 'allow', 'local', null);
  await row('L2', 'block', 'cloud', null);
});

test('the gateway log is append-only', async () => {
  const { sql, owner } = db();
  for (const statement of ["UPDATE gateway_log SET decision = 'allow'", 'DELETE FROM gateway_log', 'TRUNCATE gateway_log']) {
    // The role of the core lacks the privilege; the owner, who has it, meets the trigger.
    await assert.rejects(sql.unsafe(statement), /permission denied/);
    await assert.rejects(owner.unsafe(statement), /append-only/);
  }
});

test('declassify: request, approval from the chat, change recorded, then the brief leaves', async () => {
  const { sql } = db();
  const brief: Labeled<string> = { value: 'Write tests for the fake invoice parser.', label: 'L2', source: 'model:orchestrator' };
  const request = await requestDeclassify(sql, brief, 'L1');
  assert.equal(request.state, 'pending');
  assert.equal(request.detail.text, brief.value);
  await assert.rejects(applyDeclassify(sql, brief, 'L1', request.id), /is pending/);

  await decideApproval(sql, request.id, 'approved', 'web');
  const lowered = await applyDeclassify(sql, brief, 'L1', request.id);
  assert.equal(lowered.label, 'L1');

  const [change] = await sql<{ subject: string; from_label: string; to_label: string; approval_id: string }[]>`
    SELECT subject, from_label, to_label, approval_id::text FROM label_changes ORDER BY id DESC LIMIT 1`;
  assert.deepEqual({ ...change }, {
    subject: `content:${String(request.detail.sha256)}`,
    from_label: 'L2',
    to_label: 'L1',
    approval_id: request.id,
  });
  const decision = await passGateway(sql, [lowered], createContext('L1'), CLAUDE);
  assert.equal(decision.decision, 'allow');
});

test('declassify: a rejected approval or an edited text changes nothing', async () => {
  const { sql } = db();
  const brief: Labeled<string> = { value: 'Refactor the fake parser.', label: 'L2', source: 'test' };
  const rejected = await requestDeclassify(sql, brief, 'L1');
  await decideApproval(sql, rejected.id, 'rejected', 'web');
  await assert.rejects(applyDeclassify(sql, brief, 'L1', rejected.id), /is rejected/);

  const approved = await requestDeclassify(sql, brief, 'L1');
  await decideApproval(sql, approved.id, 'approved', 'web');
  await assert.rejects(applyDeclassify(sql, { ...brief, value: `${brief.value} And the clients.` }, 'L1', approved.id), /different text/);
  await assert.rejects(applyDeclassify(sql, brief, 'L1', '00000000-0000-4000-8000-000000000000'), /does not exist/);
});

test('approvals are decided once and their content cannot change', async () => {
  const { sql, owner } = db();
  const request = await requestDeclassify(sql, { value: 'fake', label: 'L2', source: 'test' }, 'L1');
  await decideApproval(sql, request.id, 'approved', 'web');
  await assert.rejects(decideApproval(sql, request.id, 'rejected', 'web'), /already decided/);
  await assert.rejects(sql`UPDATE approvals SET state = 'rejected' WHERE id = ${request.id}`, /already approved/);
  await assert.rejects(sql`DELETE FROM approvals`, /permission denied/);
  await assert.rejects(owner`DELETE FROM approvals`, /append-only/);

  const pending = await requestDeclassify(sql, { value: 'other', label: 'L2', source: 'test' }, 'L1');
  await assert.rejects(sql`UPDATE approvals SET detail = '{"sha256":"x"}' WHERE id = ${pending.id}`, /only the decision/);
  assert.equal((await loadApproval(sql, pending.id))?.state, 'pending');
});

test('the database refuses approvals that do not describe a valid declassification', async () => {
  const { sql } = db();
  const insert = (detail: object) => sql`
    INSERT INTO approvals (kind, action, detail) VALUES ('declassify', 'declassify', ${sql.json(detail as Record<string, string>)})`;
  const text = 'fake brief';
  const sha256 = sha256Hex(text);
  await assert.rejects(insert({ text, sha256, from: 'L3', to: 'L1' }), /approvals_declassify_detail/);
  await assert.rejects(insert({ text, sha256, from: 'L1', to: 'L1' }), /approvals_declassify_detail/);
  await assert.rejects(insert({ text, sha256: SHA, from: 'L2', to: 'L1' }), /approvals_declassify_detail/);
  await assert.rejects(insert({ sha256, from: 'L2', to: 'L1' }), /approvals_declassify_detail/);
  await assert.rejects(insert({ text, sha256, to: 'L1' }), /approvals_declassify_detail/);
  await assert.rejects(insert({ text, sha256, from: 'L2' }), /approvals_declassify_detail/);
  await insert({ text, sha256, from: 'L2', to: 'L0' });
  await assert.rejects(
    sql`INSERT INTO approvals (kind, action, detail, state) VALUES ('action', 'send', '{}', 'approved')`,
    /approvals_decided_at/,
  );
});

test('a declassification is decided only from the web chat, which can show its text', async () => {
  const { sql } = db();
  const request = await requestDeclassify(sql, { value: 'fake text for the card', label: 'L2', source: 'test' }, 'L1');
  await assert.rejects(decideApproval(sql, request.id, 'approved', 'telegram'), /approvals_declassify_via_web/);
  await assert.rejects(decideApproval(sql, request.id, 'rejected', 'phone'), /approvals_declassify_via_web/);
  assert.equal((await decideApproval(sql, request.id, 'approved', 'web')).state, 'approved');
  const [action] = await sql<{ id: string }[]>`
    INSERT INTO approvals (kind, action, detail) VALUES ('action', 'send-reminder', '{}') RETURNING id::text`;
  assert.equal((await decideApproval(sql, String(action?.id), 'approved', 'telegram')).decidedVia, 'telegram');
});

test('an approval lets its text out once', async () => {
  const { sql } = db();
  const brief: Labeled<string> = { value: 'Fake brief, used once.', label: 'L2', source: 'test' };
  const request = await requestDeclassify(sql, brief, 'L1');
  await decideApproval(sql, request.id, 'approved', 'web');
  await applyDeclassify(sql, brief, 'L1', request.id);
  await assert.rejects(applyDeclassify(sql, brief, 'L1', request.id), /label_changes_approval_used_once/);
});

test('a summary with a scanner match is not stored', async () => {
  const payload: Labeled<string>[] = [{ value: 'Fix the test.', label: 'L1', source: 'test' }];
  await passGateway(db().sql, payload, createContext('L1'), CLAUDE, { summary: 'refund IT60X0542811101000000123456' });
  const row = await lastLog();
  assert.equal(row.decision, 'allow');
  assert.equal(row.summary, null);
});

test('the database refuses a lowering without a matching approved approval; raising needs none', async () => {
  const { sql, owner } = db();
  const insert = (subject: string, from: string, to: string, approval: string | null) => sql`
    INSERT INTO label_changes (subject, from_label, to_label, approval_id)
    VALUES (${subject}, ${from}::privacy_label, ${to}::privacy_label, ${approval})`;
  await insert('document:1', 'L1', 'L2', null);
  // The trigger runs before the CHECK constraint, which stays as a second guard.
  await assert.rejects(insert('document:1', 'L2', 'L1', null), /not covered/);
  await assert.rejects(insert('document:1', 'L2', 'L2', null), /label_changes_is_a_change/);

  const brief: Labeled<string> = { value: 'fake brief', label: 'L2', source: 'test' };
  const request = await requestDeclassify(sql, brief, 'L1');
  const subject = `content:${String(request.detail.sha256)}`;
  await assert.rejects(insert(subject, 'L2', 'L1', request.id), /not covered/);
  await decideApproval(sql, request.id, 'approved', 'web');
  await assert.rejects(insert(`content:${SHA}`, 'L2', 'L1', request.id), /not covered/);
  await assert.rejects(insert(subject, 'L2', 'L0', request.id), /not covered/);
  await insert(subject, 'L2', 'L1', request.id);
  await assert.rejects(sql`DELETE FROM label_changes`, /permission denied/);
  await assert.rejects(owner`DELETE FROM label_changes`, /append-only/);
});

test('local exits are logged as local, and a contaminated run is refused the cloud', async () => {
  const contaminated = recordRead(createContext('L2'), 'L2').context;
  const payload: Labeled<string>[] = [{ value: 'fake', label: 'L2', source: 'test' }];
  assert.equal((await passGateway(db().sql, payload, contaminated, LOCAL_MODEL)).decision, 'allow');
  assert.equal((await lastLog()).locality, 'local');
  const l1: Labeled<string>[] = [{ value: 'fake', label: 'L1', source: 'test' }];
  assert.equal((await passGateway(db().sql, l1, contaminated, CLAUDE)).rule, 'contaminated');
});
