import { isAtMost, LABELS, type Label } from '@arianna/policy';

import {
  APPROVAL_ACTIONS,
  isToolId,
  toolSpec,
  TRIFECTA_SIDES,
  type ApprovalAction,
  type ToolId,
  type TrifectaSide,
} from './tools.ts';

export const EXECUTORS = ['local', 'claude', 'codex'] as const;
export type ExecutorKind = (typeof EXECUTORS)[number];
const CLOUD_EXECUTORS: readonly ExecutorKind[] = ['claude', 'codex'];

export const AUTONOMY_LEVELS = ['A0', 'A1', 'A2', 'A3'] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const DIFFICULTIES = ['trivial', 'normal', 'hard', 'critical'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** A validated agent card (docs/AGENT-CARDS.md). */
export interface AgentCard {
  name: string;
  description: string;
  /** Highest clearance of the agent; never L3. */
  maxLabel: Label;
  /** Highest label a cloud executor of this agent may see; set when the card has one. */
  cloudMaxLabel?: Label;
  executors: ExecutorKind[];
  tools: ToolId[];
  trifecta: Record<TrifectaSide, boolean>;
  autonomy: Autonomy;
  /** The decision in docs/DECISIONS.md that raised the agent above A1. */
  autonomyDecision?: string;
  difficulty: Difficulty;
  limits: { maxSteps: number; maxMinutes: number; maxCost: number };
  approvals: ApprovalAction[];
  /** File name of the prompt, next to the card. */
  prompt: string;
}

export class AgentCardError extends Error {
  override name = 'AgentCardError';
}

type Table = Record<string, unknown>;

const KEYS = [
  'name',
  'description',
  'max_label',
  'cloud_max_label',
  'executors',
  'tools',
  'trifecta',
  'autonomy',
  'autonomy_decision',
  'difficulty',
  'limits',
  'approvals',
  'prompt',
];

/**
 * Validates a parsed card. `name` is the file name without extension: the
 * card's own `name` must match it. Rules beyond the shape:
 * - at least one side of the trifecta is removed, and no tool opens a removed side;
 * - a card cleared for L2 reads private data, so it cannot claim that side removed;
 * - a cloud executor next to an L2 clearance needs `cloud_max_label` at most L1;
 * - every approval a tool needs is listed in `approvals`;
 * - autonomy above A1 needs the decision that granted it.
 */
export function parseAgentCard(raw: unknown, name: string): AgentCard {
  const where = `agents/${name}.yaml`;
  const fail = (message: string): never => {
    throw new AgentCardError(`${where}: ${message}`);
  };
  // Own properties only: values inherited from a polluted prototype never count.
  const card = ownTable(raw, where);
  const unknown = Object.keys(card).filter((key) => !KEYS.includes(key));
  if (unknown.length > 0) fail(`unknown key(s) ${unknown.join(', ')}`);

  if (card.name !== name) fail(`name must be "${name}", like the file`);
  const description = text(card.description, `${where}: description`);

  const maxLabel = oneOf(card.max_label, LABELS, `${where}: max_label`);
  if (maxLabel === 'L3') fail('max_label L3 does not exist: no model reads secrets, only vault:// references');

  const executors = list(card.executors, `${where}: executors`).map((item) => oneOf(item, EXECUTORS, `${where}: executors`));
  if (executors.length === 0) fail('executors must not be empty');
  unique(executors, `${where}: executors`);
  const hasCloud = executors.some((executor) => CLOUD_EXECUTORS.includes(executor));

  // The declared trifecta is the agent at work on the local model. A cloud
  // executor opens untrusted content and external communication by itself
  // (its own shell and web tools, and being a cloud service), whatever the
  // tools list: there the private data side must be removed, by a label
  // ceiling of at most L1 (L0 public, L1 work data; private data starts at L2).
  let cloudMaxLabel: Label | undefined;
  if (card.cloud_max_label !== undefined) {
    if (!hasCloud) fail('cloud_max_label without a cloud executor');
    cloudMaxLabel = oneOf(card.cloud_max_label, LABELS, `${where}: cloud_max_label`);
    if (!isAtMost(cloudMaxLabel, 'L1')) fail('cloud_max_label must be at most L1: cloud executors never see L2');
    if (!isAtMost(cloudMaxLabel, maxLabel)) fail('cloud_max_label must not exceed max_label');
  } else if (hasCloud && !isAtMost(maxLabel, 'L1')) {
    fail(`a cloud executor with max_label ${maxLabel} needs cloud_max_label (at most L1)`);
  }

  const tools = list(card.tools, `${where}: tools`).map((item) => {
    if (!isToolId(item)) return fail(`tool ${JSON.stringify(item)} is not in the registry`);
    return item;
  });
  unique(tools, `${where}: tools`);

  const trifectaTable = ownTable(card.trifecta, `${where}: trifecta`);
  const extra = Object.keys(trifectaTable).filter((key) => !(TRIFECTA_SIDES as readonly string[]).includes(key));
  if (extra.length > 0) fail(`trifecta: unknown key(s) ${extra.join(', ')}`);
  const trifecta = Object.fromEntries(
    TRIFECTA_SIDES.map((side) => {
      const value = trifectaTable[side];
      if (typeof value !== 'boolean') return fail(`trifecta.${side} must be true or false`);
      return [side, value];
    }),
  ) as Record<TrifectaSide, boolean>;
  if (TRIFECTA_SIDES.every((side) => trifecta[side])) {
    fail('the card has all three sides of the lethal trifecta: remove at least one');
  }
  if (!isAtMost(maxLabel, 'L1') && !trifecta.private_data) {
    fail(`max_label ${maxLabel} reads private data: trifecta.private_data must be true`);
  }
  for (const tool of tools) {
    for (const side of toolSpec(tool).opens) {
      if (!trifecta[side]) fail(`tool ${tool} opens ${side}, which the card declares removed`);
    }
  }

  const autonomy = oneOf(card.autonomy, AUTONOMY_LEVELS, `${where}: autonomy`);
  let autonomyDecision: string | undefined;
  if (card.autonomy_decision !== undefined) {
    autonomyDecision = text(card.autonomy_decision, `${where}: autonomy_decision`);
    if (!/^D-\d{3,}$/.test(autonomyDecision)) fail('autonomy_decision must be a decision id like D-040');
  }
  if ((autonomy === 'A2' || autonomy === 'A3') && autonomyDecision === undefined) {
    fail(`autonomy ${autonomy} needs autonomy_decision: raising an agent above A1 is the user's decision`);
  }

  const difficulty = oneOf(card.difficulty, DIFFICULTIES, `${where}: difficulty`);

  const limitsTable = ownTable(card.limits, `${where}: limits`);
  const extraLimits = Object.keys(limitsTable).filter((key) => !['max_steps', 'max_minutes', 'max_cost'].includes(key));
  if (extraLimits.length > 0) fail(`limits: unknown key(s) ${extraLimits.join(', ')}`);
  const limits = {
    maxSteps: integer(limitsTable.max_steps, `${where}: limits.max_steps`, 1, 1000),
    maxMinutes: integer(limitsTable.max_minutes, `${where}: limits.max_minutes`, 1, 1440),
    maxCost: nonNegative(limitsTable.max_cost, `${where}: limits.max_cost`),
  };

  const approvals = list(card.approvals, `${where}: approvals`).map((item) =>
    oneOf(item, APPROVAL_ACTIONS, `${where}: approvals`),
  );
  unique(approvals, `${where}: approvals`);
  for (const tool of tools) {
    const approval = toolSpec(tool).approval;
    if (approval !== undefined && !approvals.includes(approval)) {
      fail(`tool ${tool} needs approval "${approval}": add it to approvals`);
    }
  }

  const prompt = text(card.prompt, `${where}: prompt`);
  if (prompt !== `${name}.md`) fail(`prompt must be "${name}.md"`);

  const result: AgentCard = {
    name,
    description,
    maxLabel,
    executors,
    tools,
    trifecta,
    autonomy,
    difficulty,
    limits,
    approvals,
    prompt,
  };
  if (cloudMaxLabel !== undefined) result.cloudMaxLabel = cloudMaxLabel;
  if (autonomyDecision !== undefined) result.autonomyDecision = autonomyDecision;
  return result;
}

/** Highest label the given executor of this agent may see. */
export function labelCeiling(card: AgentCard, executor: ExecutorKind): Label {
  if (!card.executors.includes(executor)) {
    throw new AgentCardError(`agent ${card.name} cannot use executor ${executor}`);
  }
  return CLOUD_EXECUTORS.includes(executor) ? (card.cloudMaxLabel ?? card.maxLabel) : card.maxLabel;
}

/** A copy holding only the own enumerable properties, on a null prototype. */
function ownTable(value: unknown, where: string): Table {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentCardError(`${where}: expected a mapping`);
  }
  return Object.assign(Object.create(null) as Table, value);
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new AgentCardError(`${where}: expected a list`);
  return value as unknown[];
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new AgentCardError(`${where}: expected a non-empty string`);
  return value;
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new AgentCardError(`${where}: expected one of ${allowed.join(', ')}`);
  return found;
}

function integer(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AgentCardError(`${where}: expected an integer between ${String(min)} and ${String(max)}`);
  }
  return value;
}

function nonNegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AgentCardError(`${where}: expected a number of at least 0`);
  }
  return value;
}

function unique(values: readonly string[], where: string): void {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new AgentCardError(`${where}: ${duplicate} listed twice`);
}
