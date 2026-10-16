import {
  declassify,
  gatewayCheck,
  isAtMost,
  isTarget,
  localityOf,
  markLogged,
  payloadText,
  piiUnavailable,
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
import { seriesNamesOfSource } from '@arianna/agents';
import { knownSecrets } from '@arianna/vault';

import { loadApproval } from './approvals.ts';
import type { Queryable, Sql } from './db/client.ts';
import { piiCheckOf } from './pii-guard.ts';

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

/**
 * For the second scanner, by position: the names that are no persons in that
 * fragment alone, whole or a piece inside a whole occurrence (D-227). The pieces of the characters and of who is who
 * (`character:…`, D-214, D-217) every name of the series; every other fragment
 * the names worn now (`worn`, D-217), so that an answer that called an agent
 * «Carla» can go on in a brief, while «Carla Bianchi», or «Pam» when nobody
 * wears Pam, is still a person.
 */
export function fragmentNamesOf(payload: readonly Labeled<unknown>[], worn: readonly string[] = wornNames()): (readonly string[] | undefined)[] {
  return payload.map((fragment) => {
    const item = fragment as Partial<Labeled<unknown>> | null;
    return seriesNamesOfSource(item?.source, item?.value) ?? (worn.length === 0 ? undefined : worn);
  });
}

// The names of the people of the series worn now (D-217), set by main.ts; none until then.
let wornNames: () => readonly string[] = () => [];

/**
 * What tells the gateway the names worn now (D-217): an answer of an agent
 * calls another by its character's name («ne parlo con Carla»), and that answer
 * may go on in a later brief. Those names, whole (or a piece inside a whole
 * occurrence, D-227) and only while worn, are no
 * person for the second scanner in any fragment; a longer name («Carla
 * Bianchi») or a name no agent wears is still a person.
 */
export function configureWornNames(read: () => readonly string[]): void {
  wornNames = read;
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
  // First without the second scanner: when another rule decides, apps/guard is not
  // even started. Only an exit that every other rule lets go asks it (D-113).
  let decision = gatewayCheck(payload, context, target, knownSecrets, piiUnavailable('off'));
  if (decision.decision === 'block' && decision.rule === 'pii-unavailable') {
    const texts = textsOf(payload);
    if (texts !== undefined) decision = gatewayCheck(payload, context, target, knownSecrets, await piiCheckOf(texts, fragmentNamesOf(payload)));
  }
  if (!isTarget(target)) return decision;

  // Allowed: the texts that will be sent. Blocked: what was offered, for the record.
  // A blocked secret leaves no hash: a guessable value could be found from it.
  // Nor does a personal datum the second scanner found (a short sentence with a
  // name can be guessed the same way), nor invalid input, decided before the checks.
  const unmeasured = decision.decision === 'block' && (decision.rule === 'secret' || decision.rule === 'pii' || decision.rule === 'invalid-input');
  const texts = decision.decision === 'allow' ? decision.texts : unmeasured ? undefined : textsOf(payload);
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
  // Only now can an adapter spend it: the row is written.
  if (decision.decision === 'allow') markLogged(decision);
  return decision;
}

/**
 * Lowers the label of `item` with an approval decided by the user, and records
 * the change in label_changes in the same transaction. Throws if the approval
 * does not cover this exact text and these labels; the database checks it again.
 */
export async function applyDeclassify<T>(sql: Sql, item: Labeled<T>, to: Label, approvalId: string, context: Context): Promise<Labeled<T>> {
  return sql.begin((tx) => applyDeclassifyIn(tx, item, to, approvalId, context));
}

/** `applyDeclassify` inside a transaction the caller holds, with what the lowered text is for. */
export async function applyDeclassifyIn<T>(tx: Queryable, item: Labeled<T>, to: Label, approvalId: string, context: Context): Promise<Labeled<T>> {
  const approval = await loadApproval(tx, approvalId);
  if (approval === undefined) throw new PolicyError(`declassify: approval ${approvalId} does not exist`);
  const { item: lowered, change } = declassify(item, to, approval, context);
  await tx`
    INSERT INTO label_changes (subject, from_label, to_label, approval_id)
    VALUES (${change.subject}, ${change.from}::privacy_label, ${change.to}::privacy_label, ${change.approvalId})`;
  return lowered;
}
