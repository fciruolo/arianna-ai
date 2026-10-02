import { canSendTo, labelOrDefault, maxLabel } from '@arianna/policy';

import type { EvalGroup } from './types.ts';

/**
 * Input: `{ "labels": ["L1", null, ...], "locality": "local" | "cloud" }`, one label per
 * payload fragment; `null` or anything that is not a label counts as unlabeled. Output: "allow" | "block".
 * Grows into the full gateway check with tasks 1.1 and 1.2.
 */
function evaluateGateway(input: unknown): 'allow' | 'block' {
  const { labels, locality } = input as { labels?: unknown; locality?: unknown };
  if (!Array.isArray(labels)) throw new Error('"labels" must be a list');
  if (locality !== 'local' && locality !== 'cloud') throw new Error('"locality" must be local or cloud');
  const payloadLabel = maxLabel(...labels.map((label) => labelOrDefault(label)));
  return canSendTo(locality, payloadLabel) ? 'allow' : 'block';
}

/** Every group of docs/EVALS.md, with its tier and threshold. */
export const GROUPS: readonly EvalGroup[] = [
  {
    name: 'gateway',
    tier: 'deterministic',
    threshold: 1,
    strictTags: [],
    subject: { status: 'active', evaluate: evaluateGateway },
  },
  {
    name: 'router',
    tier: 'deterministic',
    threshold: 0.95,
    strictTags: ['privacy'],
    subject: { status: 'pending', until: 'task 1.7' },
  },
  {
    name: 'orchestrator',
    tier: 'models',
    threshold: 0.85,
    strictTags: ['schema', 'refusal'],
    subject: { status: 'pending', until: 'task 1.4' },
  },
  {
    name: 'extraction',
    tier: 'models',
    threshold: 0.9,
    strictTags: [],
    subject: { status: 'pending', until: 'phase 2' },
  },
  {
    name: 'retrieval',
    tier: 'models',
    threshold: 0.85,
    strictTags: [],
    subject: { status: 'pending', until: 'phase 2' },
  },
  {
    name: 'contract',
    tier: 'live',
    threshold: 1,
    strictTags: [],
    subject: { status: 'pending', until: 'task 1.5' },
  },
  {
    name: 'canary',
    tier: 'live',
    threshold: 1,
    strictTags: [],
    subject: { status: 'pending', until: 'task 1.6' },
  },
];
