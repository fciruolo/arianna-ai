// Lowering a label (docs/PRIVACY-POLICY-SPEC.md, rule 3): only with the user's
// approval of the exact text, identified by its sha256. Pure: the core loads
// the approval and writes the returned change to label_changes.
import type { Labeled } from './context.ts';
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
 * What an approval request for declassifying `item` to `to` stores in
 * `approvals.detail`: the exact text shown to the user, its sha256 and both labels.
 */
export function declassifyRequest(item: Labeled<unknown>, to: Label): { text: string; sha256: string; from: Label; to: Label } {
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
 * current label to `to`. The new item's source names the approval.
 */
export function declassify<T>(item: Labeled<T>, to: Label, approval: DeclassifyApproval): { item: Labeled<T>; change: LabelChange } {
  const request = declassifyRequest(item, to);
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
