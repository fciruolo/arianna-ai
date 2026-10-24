// Lowering a label (docs/PRIVACY-POLICY-SPEC.md, rule 3): only with the user's
// approval of the exact text, identified by its sha256. Pure: the core loads
// the approval and writes the returned change to label_changes.
import { isContext, isFinanceContext, isFinanceSource, isMacSource, type Context, type Labeled } from './context.ts';
import { PolicyError } from './errors.ts';
import { isAtMost, isLabel, labelOrDefault, type Label } from './labels.ts';
import { payloadText, sha256Hex } from './payload.ts';

/** The fields of an `approvals` row that declassify relies on. */
export interface DeclassifyApproval {
  id: string;
  kind: string;
  state: string;
  /** For declassify: sha256 of the exact text, its label and the label approved. */
  detail: { sha256?: unknown; from?: unknown; to?: unknown };
}

/** A row for `label_changes`. */
export interface LabelChange {
  /** `content:<sha256>`. */
  subject: string;
  from: Label;
  to: Label;
  approvalId: string;
}

/**
 * Throws when `context` was not made by the policy, or has read finance data
 * (D-183): nothing written in it is declassified, not even with the user's
 * approval. `declassifyRequest` and `declassify` call it on their context.
 */
export function assertDeclassifiable(context: Context): void {
  if (!isContext(context)) throw new PolicyError('declassify: the context was not created by the policy');
  if (isFinanceContext(context)) throw new PolicyError('declassify: the context has read finance data, which never leaves this machine');
}

/**
 * What an approval request for declassifying `item` to `to` stores in
 * `approvals.detail`: the exact text shown to the user, its sha256 and both labels.
 * `context` is the conversation or task the text was written in. Finance data
 * (`finance:*` source) and what the core read from the Mac (`mac:*`, D-314) are never declassified, nor is anything of a context
 * that has read finance data or was not made by the policy.
 */
export function declassifyRequest(item: Labeled<unknown>, to: Label, context: Context): { text: string; sha256: string; from: Label; to: Label } {
  if (isFinanceSource(item.source)) throw new PolicyError('declassify: finance data never leaves this machine');
  // A file of the Mac as read by the core (D-314) is never lowered: its names and contents stay on this machine.
  if (isMacSource(item.source)) throw new PolicyError('declassify: what is read from the Mac never leaves this machine');
  assertDeclassifiable(context);
  const from = labelOrDefault(item.label);
  const text = payloadText(item.value);
  if (text === undefined) throw new PolicyError('declassify: the value is not text or plain JSON');
  if (!isLabel(to)) throw new PolicyError(`declassify: invalid label ${JSON.stringify(to)}`);
  if (from === 'L3') throw new PolicyError('declassify: L3 is never declassified, use a vault:// reference');
  if (isAtMost(from, to)) throw new PolicyError(`declassify: ${to} is not below ${from}`);
  return { text, sha256: sha256Hex(text), from, to };
}

/**
 * Returns the item with the lower label and the change to record. Throws
 * unless the approval is an approved declassify for this exact value, from its
 * current label to `to`. The new item's source names the approval. Finance
 * data, a context that has read it and a forged context throw as in `declassifyRequest`.
 */
export function declassify<T>(item: Labeled<T>, to: Label, approval: DeclassifyApproval, context: Context): { item: Labeled<T>; change: LabelChange } {
  const request = declassifyRequest(item, to, context);
  if (approval.kind !== 'declassify') throw new PolicyError(`declassify: approval ${approval.id} is not a declassify approval`);
  if (approval.state !== 'approved') throw new PolicyError(`declassify: approval ${approval.id} is ${approval.state}`);
  const { detail } = approval;
  if (detail.sha256 !== request.sha256) throw new PolicyError(`declassify: approval ${approval.id} is for a different text`);
  if (detail.from !== request.from || detail.to !== request.to) {
    throw new PolicyError(`declassify: approval ${approval.id} does not cover ${request.from} -> ${request.to}`);
  }
  return {
    item: { value: item.value, label: to, source: `declassified:${approval.id}` },
    change: { subject: `content:${request.sha256}`, from: request.from, to, approvalId: approval.id },
  };
}
