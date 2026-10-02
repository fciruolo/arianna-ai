// Subject of the `gateway` eval group: the real gatewayCheck and declassify.
import {
  contentHash,
  createContext,
  declassify,
  derive,
  gatewayCheck,
  type Context,
  type DeclassifyApproval,
  type Label,
  type Labeled,
  type Target,
} from '@arianna/policy';

/**
 * A payload fragment. `derivedFrom` lists the labels of the inputs a model read
 * to write it: its label is then the taint of those inputs, not `label`.
 */
interface FragmentInput {
  value: unknown;
  label?: unknown;
  derivedFrom?: unknown[];
}

/** `forged: true` passes a look-alike object instead of a context made by the policy. */
interface ContextInput {
  clearance: Label;
  effective?: Label;
  forged?: boolean;
}

/**
 * `{ payload, context, target }` checks the payload. With `declassify`, the
 * single fragment is first declassified with the given approval; its `sha256`
 * is `"exact"` for the hash of that fragment or any other string for a wrong one.
 */
interface GatewayInput {
  payload: FragmentInput[];
  context: ContextInput;
  target: Target;
  declassify?: { to: Label; approval: { kind: string; state: string; from: string; to: string; sha256: string } };
}

export type GatewayOutcome =
  | { decision: 'allow'; rule: string }
  | { decision: 'block'; rule: string; next: string; findings?: string[] }
  | { declassify: 'refused' };

function toFragment(input: FragmentInput): Labeled<unknown> {
  const label = Array.isArray(input.derivedFrom)
    ? derive(input.derivedFrom.map((from) => ({ value: null, label: from as Label, source: 'eval' })))
    : (input.label as Label);
  return { value: input.value, label, source: 'eval' };
}

function toContext(input: ContextInput): Context {
  if (input.forged === true) return { clearance: input.clearance, effective: input.effective ?? 'L0' };
  return createContext(input.clearance, input.effective);
}

export function evaluateGateway(raw: unknown): GatewayOutcome {
  const input = raw as GatewayInput;
  if (!Array.isArray(input.payload)) throw new Error('"payload" must be a list');
  let payload = input.payload.map(toFragment);

  if (input.declassify !== undefined) {
    const [item] = payload;
    if (item === undefined || payload.length !== 1) throw new Error('declassify takes exactly one fragment');
    const { approval: spec, to } = input.declassify;
    const approval: DeclassifyApproval = {
      id: 'eval-approval',
      kind: spec.kind,
      state: spec.state,
      detail: { sha256: spec.sha256 === 'exact' ? contentHash(item.value) : spec.sha256, from: spec.from, to: spec.to },
    };
    try {
      payload = [declassify(item, to, approval).item];
    } catch {
      return { declassify: 'refused' };
    }
  }

  const decision = gatewayCheck(payload, toContext(input.context), input.target);
  if (decision.decision === 'allow') return { decision: 'allow', rule: decision.rule };
  const outcome = { decision: 'block' as const, rule: decision.rule, next: decision.next };
  return decision.findings === undefined
    ? outcome
    : { ...outcome, findings: [...new Set(decision.findings.map((finding) => finding.kind))] };
}
