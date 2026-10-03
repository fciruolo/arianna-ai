// Subject of the `gateway` eval group: the real gatewayCheck and declassify.
import {
  checkProject,
  checkWorkspace,
  contentHash,
  createContext,
  createLabelRules,
  declassify,
  derive,
  gatewayCheck,
  secretMatcher,
  type Context,
  type DeclassifyApproval,
  type Label,
  type Labeled,
  type Target,
  type WorkspaceDecision,
  type WorkspaceEntry,
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
 * `secrets` are values the vault has revealed (task 1.14); fake ones only.
 */
interface GatewayInput {
  payload: FragmentInput[];
  context: ContextInput;
  target: Target;
  secrets?: { ref: string; value: string }[];
  declassify?: { to: Label; approval: { kind: string; state: string; from: string; to: string; sha256: string } };
}

/**
 * The pre-flight check of a cloud worktree (task 1.6). Without `rules`, the
 * repository folder `repos` is L1 and `repos/site/private` is L2.
 */
interface WorkspaceInput {
  workspace: {
    repo: string;
    allowlist: string[];
    entries: WorkspaceEntry[];
    rules?: { path: string; label: Label }[];
  };
}

/** The pre-flight check of an approved project folder (D-058): its label, its entries. */
interface ProjectInput {
  project: {
    label: Label;
    entries: WorkspaceEntry[];
  };
}

const WORKSPACE_RULES = [
  { path: 'repos', label: 'L1' as const },
  { path: 'repos/site/private', label: 'L2' as const },
];

export type GatewayOutcome =
  | { decision: 'allow'; rule: string }
  | { decision: 'block'; rule: string; next: string; findings?: string[] }
  | { declassify: 'refused' };

/** What a workspace case returns: the rule and the kinds of findings, never the paths. */
export type WorkspaceOutcome =
  | { decision: 'allow'; rule: 'workspace' }
  | { decision: 'block'; rule: 'not-allowlisted' | 'workspace-scan'; findings?: string[] };

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

function outcomeOf(decision: WorkspaceDecision): WorkspaceOutcome {
  if (decision.decision === 'allow') return { decision: 'allow', rule: decision.rule };
  return decision.findings.length === 0
    ? { decision: 'block', rule: decision.rule }
    : { decision: 'block', rule: decision.rule, findings: [...new Set(decision.findings.map((finding) => finding.kind))] };
}

function evaluateWorkspace(input: WorkspaceInput['workspace']): WorkspaceOutcome {
  const rules = createLabelRules({ folders: input.rules ?? WORKSPACE_RULES, sources: [] });
  return outcomeOf(checkWorkspace({ repo: input.repo, allowlist: input.allowlist, entries: input.entries, rules }));
}

export function evaluateGateway(raw: unknown): GatewayOutcome | WorkspaceOutcome {
  if (typeof raw === 'object' && raw !== null && 'workspace' in raw) return evaluateWorkspace((raw as WorkspaceInput).workspace);
  if (typeof raw === 'object' && raw !== null && 'project' in raw) {
    const { label, entries } = (raw as ProjectInput).project;
    return outcomeOf(checkProject({ label, entries }));
  }
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

  const secrets = secretMatcher(input.secrets ?? []);
  const decision = gatewayCheck(payload, toContext(input.context), input.target, secrets);
  if (decision.decision === 'allow') return { decision: 'allow', rule: decision.rule };
  const outcome = { decision: 'block' as const, rule: decision.rule, next: decision.next };
  return decision.findings === undefined
    ? outcome
    : { ...outcome, findings: [...new Set(decision.findings.map((finding) => finding.kind))] };
}
