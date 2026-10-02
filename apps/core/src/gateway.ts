import {
  declassify,
  gatewayCheck,
  isAtMost,
  isTarget,
  localityOf,
  payloadText,
  PolicyError,
  scanText,
  sha256Hex,
  targetName,
  type Context,
  type Decision,
  type Label,
  type Labeled,
  type Target,
} from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { loadApproval } from './approvals.ts';
import type { Sql } from './db/client.ts';

export interface GatewayMeta {
  taskId?: string;
  runId?: string;
  /** Short description of what leaves; stored only for allowed payloads up to L1. */
  summary?: string;
}

/** Text forms of a payload; undefined when a fragment has none. */
function textsOf(payload: readonly Labeled<unknown>[]): readonly string[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const texts: string[] = [];
  for (const fragment of payload) {
    const text = payloadText((fragment as Partial<Labeled<unknown>> | null)?.value);
    if (text === undefined) return undefined;
    texts.push(text);
  }
  return texts;
}

/** Bytes and sha256 of the texts. */
function measure(texts: readonly string[]): { bytes: number; sha256: string } {
  return {
    bytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0),
    sha256: sha256Hex(JSON.stringify(texts)),
  };
}

/**
 * The gateway as callers use it: decides, then writes the decision to
 * gateway_log, allowed or blocked. Send only after this resolves with `allow`,
 * and send `decision.texts`: if the log cannot be written it rejects, and
 * nothing must leave. A target that is not a valid target has no row to go in
 * (target_kind is unknown): the block is returned without one.
 */
export async function passGateway(
  sql: Sql,
  payload: readonly Labeled<unknown>[],
  context: Context,
  target: Target,
  meta: GatewayMeta = {},
): Promise<Decision> {
  // Every value the vault revealed in this process is checked, local targets included.
  const decision = gatewayCheck(payload, context, target, knownSecrets);
  if (!isTarget(target)) return decision;

  // Allowed: the texts that will be sent. Blocked: what was offered, for the record.
  // A blocked secret leaves no hash: a guessable value could be found from it.
  const texts = decision.decision === 'allow' ? decision.texts : decision.rule === 'secret' ? undefined : textsOf(payload);
  const measured = texts === undefined ? undefined : measure(texts);
  // The summary is free text from the caller: kept only when it could have left itself.
  const summary =
    meta.summary !== undefined &&
    decision.decision === 'allow' &&
    isAtMost(decision.label, 'L1') &&
    scanText(meta.summary).length === 0 &&
    knownSecrets.find(meta.summary).length === 0
      ? meta.summary
      : null;
  await sql`
    INSERT INTO gateway_log (
      task_id, run_id, target_kind, target, locality, label, decision, rule, reason,
      bytes_out, payload_sha256, summary
    ) VALUES (
      ${meta.taskId ?? null}, ${meta.runId ?? null}, ${target.kind}, ${targetName(target)},
      ${localityOf(target)}, ${decision.label}::privacy_label, ${decision.decision}, ${decision.rule},
      ${decision.reason}, ${measured?.bytes ?? null}, ${measured?.sha256 ?? null}, ${summary}
    )`;
  return decision;
}

/**
 * Lowers the label of `item` with an approval decided by the user, and records
 * the change in label_changes in the same transaction. Throws if the approval
 * does not cover this exact text and these labels; the database checks it again.
 */
export async function applyDeclassify<T>(sql: Sql, item: Labeled<T>, to: Label, approvalId: string): Promise<Labeled<T>> {
  return sql.begin(async (tx) => {
    const approval = await loadApproval(tx, approvalId);
    if (approval === undefined) throw new PolicyError(`declassify: approval ${approvalId} does not exist`);
    const { item: lowered, change } = declassify(item, to, approval);
    await tx`
      INSERT INTO label_changes (subject, from_label, to_label, approval_id)
      VALUES (${change.subject}, ${change.from}::privacy_label, ${change.to}::privacy_label, ${change.approvalId})`;
    return lowered;
  });
}
