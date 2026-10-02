import { evaluateGateway } from './gateway.ts';
import type { EvalGroup } from './types.ts';

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
