// Subject of the `gateway` eval group: the real gatewayCheck and declassify.
import {
  checkCoderNote,
  checkProject,
  checkWorkspace,
  contentHash,
  createLabelRules,
  declassify,
  derive,
  deriveSource,
  fakePiiCheck,
  forgetCatalogTexts,
  gatewayCheck as gatewayCheckWithPii,
  isMcpKbPath,
  markCatalogText,
  mcpClearance,
  payloadText,
  recordRead,
  piiUnavailable,
  secretMatcher,
  type PiiCheck,
  type PiiEntity,
  type PiiUnavailableReason,
  type DeclassifyApproval,
  type Label,
  type Labeled,
  type Target,
  type WorkspaceDecision,
  type WorkspaceEntry,
  createContext,
  isAtMost,
  isLabel,
} from '@arianna/policy';

import { contextOf, type ContextInput } from './context-input.ts';

// The second scanner (D-113) finds nothing here: these evals are about the other rules (the gateway group has its own pii cases).
const gatewayCheck = (
  payload: Parameters<typeof gatewayCheckWithPii>[0],
  context: Parameters<typeof gatewayCheckWithPii>[1],
  target: Parameters<typeof gatewayCheckWithPii>[2],
  secrets: Parameters<typeof gatewayCheckWithPii>[3],
) => gatewayCheckWithPii(payload, context, target, secrets, fakePiiCheck(payload));

/**
 * A payload fragment. `derivedFrom` lists the labels of the inputs a model read
 * to write it, or `{ label, source }` for an input with its source: its label
 * and source are then the taint of those inputs, not `label` and `source`.
 * `source` defaults to `eval`; `finance:*` is finance data (D-183).
 */
interface FragmentInput {
  value: unknown;
  label?: unknown;
  source?: unknown;
  derivedFrom?: unknown[];
}

/** An input of `derivedFrom`: a label, or `{ label, source }` with no other key (a typo must fail the case, not be ignored). */
function derivedInput(from: unknown): Labeled<unknown> {
  if (typeof from === 'object' && from !== null && !Array.isArray(from)) {
    const input = from as Record<string, unknown>;
    const unknown = Object.keys(input).filter((key) => key !== 'label' && key !== 'source');
    if (unknown.length > 0) throw new Error(`"derivedFrom": unknown key(s) ${unknown.join(', ')}`);
    if (typeof input.source !== 'string') throw new Error('"derivedFrom": "source" must be a string');
    return { value: null, label: input.label as Label, source: input.source };
  }
  return { value: null, label: from as Label, source: 'eval' };
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
  /**
   * What the fake second scanner (D-113) answers: `found`, per fragment, the
   * values it takes for personal data (located in the fragment text), or
   * `unavailable` with its reason. Absent: nothing found.
   */
  pii?: { found: { kind: string; value: string }[][] } | { unavailable: PiiUnavailableReason; development?: boolean };
  /**
   * Texts the core marked as composed from the adopted catalogs (D-250), as
   * `markCatalogText(source, value)`: the second scanner does not read a
   * fragment with exactly that source and text. Forgotten after the case.
   */
  catalog?: { source: string; value: string }[];
}

/** The fake recognizer of a case: each value is found where it first appears in its fragment. */
function piiOf(payload: readonly Labeled<unknown>[], spec: GatewayInput['pii']): PiiCheck {
  if (spec === undefined) return fakePiiCheck(payload);
  if ('unavailable' in spec) return piiUnavailable(spec.unavailable, spec.development === true);
  const entities = payload.map((fragment, index): PiiEntity[] => {
    const text = payloadText(fragment.value) ?? '';
    return (spec.found[index] ?? []).map(({ kind, value }) => {
      const start = text.indexOf(value);
      if (start < 0) throw new Error('"pii": a found value is not in its fragment');
      return { kind, start, end: start + value.length, score: 0.99 };
    });
  });
  return fakePiiCheck(payload, entities);
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

/**
 * The notes of a project offered to the Coder (I-11 P3, D-166): each one
 * through `checkCoderNote`, then, when it passes, alone through the gateway
 * towards `target`, as the core does. `canary` is a fake unique string: it
 * leaks when it is in a path or a text that would reach the run.
 */
interface CoderNotesInput {
  coderNotes: {
    target: 'claude' | 'codex';
    notes: { path: unknown; label: unknown; link?: unknown; text: string }[];
    canary?: string;
  };
}

/** Paths given, in order; the notes held, by reason (a refusal of the gateway is its rule); whether the canary would leave. */
export interface CoderNotesOutcome {
  given: string[];
  held: Record<string, number>;
  leaked: boolean;
}

function evaluateCoderNotes(input: CoderNotesInput['coderNotes']): CoderNotesOutcome {
  const given: string[] = [];
  const texts: string[] = [];
  const held: Record<string, number> = {};
  const hold = (reason: string): void => {
    held[reason] = (held[reason] ?? 0) + 1;
  };
  for (const note of input.notes) {
    const check = checkCoderNote({ path: note.path, label: note.label, link: note.link });
    if (check.decision === 'skip') {
      hold(check.reason);
      continue;
    }
    const label = isLabel(note.label) ? note.label : 'L2';
    const decision = gatewayCheck([{ value: note.text, label, source: 'eval:note' }], createContext('L1', isAtMost(label, 'L1') ? label : 'L1'), { kind: 'executor', id: input.target, locality: 'cloud' }, secretMatcher([]));
    if (decision.decision === 'block') {
      hold(decision.rule);
      continue;
    }
    given.push(String(note.path));
    texts.push(...decision.texts);
  }
  const canary = input.canary;
  const leaked = canary !== undefined && canary !== '' && [...given, ...texts].some((text) => text.includes(canary));
  return { given, held, leaked };
}

/**
 * A tool of Arianna's MCP server called by a cloud run (D-261), as the core
 * runs it: the session's clearance is `mcpClearance(task, card)`; each entry
 * of the index is a page the tool would read, refused when above the
 * clearance, otherwise read and passed through the gateway towards `target`.
 */
interface McpInput {
  mcp: {
    taskClearance: Label;
    cardCeiling: Label;
    /** Only claude runs have MCP sessions (D-261): any other target fails the case. */
    target: 'claude';
    /** A page with its `path` (checked with `isMcpKbPath`), or a skill without one. */
    index: { label: unknown; text: string; path?: string }[];
    canary?: string;
  };
}

/** The session's clearance; per entry `deny` (never read), `allow` or the gateway's rule; whether the canary would leave. */
export interface McpOutcome {
  clearance: Label;
  results: string[];
  leaked: boolean;
}

function evaluateMcp(input: McpInput['mcp']): McpOutcome {
  if ((input.target as string) !== 'claude') throw new Error('"mcp.target": only claude runs have MCP sessions');
  const clearance = mcpClearance(input.taskClearance, input.cardCeiling);
  const context = createContext(clearance);
  const sent: string[] = [];
  const results = input.index.map((entry) => {
    if (entry.path !== undefined && !isMcpKbPath(entry.path)) return 'deny';
    const label = isLabel(entry.label) ? entry.label : 'L2';
    const read = recordRead(context, label);
    if (!read.allowed) return 'deny';
    const decision = gatewayCheck([{ value: entry.text, label, source: 'mcp:kb_read' }], read.context, { kind: 'executor', id: input.target, locality: 'cloud' }, secretMatcher([]));
    if (decision.decision === 'block') return decision.rule;
    sent.push(...decision.texts);
    return 'allow';
  });
  const canary = input.canary;
  return { clearance, results, leaked: canary !== undefined && canary !== '' && sent.some((text) => text.includes(canary)) };
}

const WORKSPACE_RULES = [
  { path: 'repos', label: 'L1' as const },
  { path: 'repos/site/private', label: 'L2' as const },
];

/** `deniedReads` is present only when some read of `context.reads` was denied. */
export type GatewayOutcome =
  | { decision: 'allow'; rule: string; deniedReads?: number }
  | { decision: 'block'; rule: string; next: string; findings?: string[]; deniedReads?: number }
  | { declassify: 'refused' };

/** What a workspace case returns: the rule and the kinds of findings, never the paths. */
export type WorkspaceOutcome =
  | { decision: 'allow'; rule: 'workspace' }
  | { decision: 'block'; rule: 'not-allowlisted' | 'workspace-scan'; findings?: string[] };

function toFragment(input: FragmentInput): Labeled<unknown> {
  const source = typeof input.source === 'string' ? input.source : 'eval';
  if (Array.isArray(input.derivedFrom)) {
    const inputs = input.derivedFrom.map(derivedInput);
    return { value: input.value, label: derive(inputs), source: deriveSource(inputs, source) };
  }
  return { value: input.value, label: input.label as Label, source };
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

export function evaluateGateway(raw: unknown): GatewayOutcome | WorkspaceOutcome | CoderNotesOutcome | McpOutcome {
  if (typeof raw === 'object' && raw !== null && 'mcp' in raw) return evaluateMcp((raw as McpInput).mcp);
  if (typeof raw === 'object' && raw !== null && 'workspace' in raw) return evaluateWorkspace((raw as WorkspaceInput).workspace);
  if (typeof raw === 'object' && raw !== null && 'coderNotes' in raw) return evaluateCoderNotes((raw as CoderNotesInput).coderNotes);
  if (typeof raw === 'object' && raw !== null && 'project' in raw) {
    const { label, entries } = (raw as ProjectInput).project;
    return outcomeOf(checkProject({ label, entries }));
  }
  const input = raw as GatewayInput;
  if (!Array.isArray(input.payload)) throw new Error('"payload" must be a list');
  let payload = input.payload.map(toFragment);
  const { context, deniedReads } = contextOf(input.context);

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
      payload = [declassify(item, to, approval, context).item];
    } catch {
      return { declassify: 'refused' };
    }
  }

  const denied = deniedReads === 0 ? {} : { deniedReads };
  const secrets = secretMatcher(input.secrets ?? []);
  forgetCatalogTexts();
  for (const marked of input.catalog ?? []) markCatalogText(marked.source, marked.value);
  let decision;
  try {
    decision = gatewayCheckWithPii(payload, context, input.target, secrets, piiOf(payload, input.pii));
  } finally {
    forgetCatalogTexts();
  }
  if (decision.decision === 'allow') return { decision: 'allow', rule: decision.rule, ...denied };
  if (decision.pii !== undefined) return { decision: 'block', rule: decision.rule, next: decision.next, findings: [...new Set(decision.pii.map((finding) => finding.kind))], ...denied };
  const outcome = { decision: 'block' as const, rule: decision.rule, next: decision.next };
  return decision.findings === undefined
    ? { ...outcome, ...denied }
    : { ...outcome, findings: [...new Set(decision.findings.map((finding) => finding.kind))], ...denied };
}
