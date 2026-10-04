import type { Label } from '@arianna/policy';

import type { Autonomy, Difficulty, ExecutorKind } from './card.ts';
import type { ToolId, TrifectaSide } from './tools.ts';

/**
 * Card templates for agents proposed from the agency-agents catalog (D-079).
 * Tools, clearance, trifecta and autonomy of a proposed card come from here,
 * chosen by us per division: never from the third-party file, whose `tools`
 * and `services` are only shown as information.
 *
 * Every template: `max_label` at most L1 (a third-party prompt never reads
 * private data), `untrusted_content` open (the prompt itself is untrusted),
 * so another side removed; no approvals, no task.delegate, no channel.send,
 * autonomy at most A1.
 */
export interface CardTemplate {
  id: string;
  maxLabel: Label;
  executors: ExecutorKind[];
  tools: ToolId[];
  trifecta: Record<TrifectaSide, boolean>;
  autonomy: Autonomy;
  difficulty: Difficulty;
  limits: { maxSteps: number; maxMinutes: number; maxCost: number };
}

/** Works on the code of approved projects, like the Coder without L2. */
const CODE: CardTemplate = {
  id: 'code',
  maxLabel: 'L1',
  executors: ['local', 'claude', 'codex'],
  tools: ['repo.read', 'repo.write', 'repo.test', 'task.update', 'user.ask'],
  trifecta: { private_data: false, untrusted_content: true, external_comms: false },
  autonomy: 'A1',
  difficulty: 'normal',
  limits: { maxSteps: 50, maxMinutes: 45, maxCost: 0 },
};

/** Searches the public web: public data only, so the web opens nothing private. */
const WEB: CardTemplate = {
  id: 'web',
  maxLabel: 'L0',
  executors: ['local'],
  tools: ['web.search', 'web.fetch'],
  trifecta: { private_data: false, untrusted_content: true, external_comms: true },
  autonomy: 'A0',
  difficulty: 'normal',
  limits: { maxSteps: 20, maxMinutes: 15, maxCost: 0 },
};

/** Answers only: no tools, public data, proposals only. */
const ANSWER: CardTemplate = {
  id: 'answer',
  maxLabel: 'L0',
  executors: ['local'],
  tools: [],
  trifecta: { private_data: false, untrusted_content: true, external_comms: false },
  autonomy: 'A0',
  difficulty: 'normal',
  limits: { maxSteps: 10, maxMinutes: 10, maxCost: 0 },
};

export const CARD_TEMPLATES: readonly CardTemplate[] = [CODE, WEB, ANSWER];

const BY_DIVISION: Readonly<Record<string, CardTemplate>> = {
  engineering: CODE,
  testing: CODE,
  marketing: WEB,
  research: WEB,
};

/** The template of a division; any division not listed only answers. */
export function templateFor(division: string): CardTemplate {
  return Object.hasOwn(BY_DIVISION, division) ? (BY_DIVISION[division] ?? ANSWER) : ANSWER;
}
