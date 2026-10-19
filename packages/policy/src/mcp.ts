// The clearance of a session of Arianna's MCP server (D-261): what an agent in
// the cloud may read through her tools while it runs. Never above L1, the
// ceiling of every cloud executor, whatever the task or the card says.
import { isAtMost, isLabel, LABELS, type Label } from './labels.ts';

/** Highest label a tool of the MCP server may return to a cloud run. */
export const MCP_CEILING: Label = 'L1';

/**
 * The lowest of the task's clearance, the card's ceiling and L1. A value that
 * is not a label admits nothing beyond public text (L0): a clearance falls
 * back to the least, never to the default label of data (L2).
 */
export function mcpClearance(taskClearance: Label, cardCeiling: Label): Label {
  const candidates = [taskClearance, cardCeiling, MCP_CEILING].map((label: unknown) => (isLabel(label) ? label : LABELS[0]));
  return candidates.reduce((min, label) => (isAtMost(label, min) ? label : min));
}
