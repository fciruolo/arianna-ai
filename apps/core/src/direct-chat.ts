import { isFinanceCard, type LoadedAgent } from '@arianna/agents';
import { isAtMost, type ConversationMode } from '@arianna/policy';

import { GOD_AGENT, GOD_PROJECT } from './god/clone.ts';
import { briefCeiling, CLOUD_DELEGATES, delegationRoute, isCloudRoute } from './orchestrator/delegate.ts';

/**
 * The direct chat with any agent (D-111d): who the user may talk with in
 * place of Arianna, and how, from the agent's card. An agent on Claude Code
 * or Codex (D-140) works in the folder of a project, so it needs a work
 * conversation on one (every message goes as it is to the cloud). A local agent answers with one call to
 * the local model: a work conversation, or a private one when its card may
 * read L2. Arianna is never one: she answers when nobody else does.
 */
export interface DirectPolicy {
  agent: string;
  description: string;
  /** Every message goes to the cloud: the warning, "va a Claude", the context indicator. */
  cloud: boolean;
  /** The cloud executors of its card that run now, in the card's order (D-140): what the warning names. */
  executors: ('claude' | 'codex')[];
  /** The modes the conversation may have with this agent. */
  modes: ConversationMode[];
  /** The conversation needs one of the approved projects. */
  project: boolean;
  /**
   * Only on a part of this project (D-127): GOD works on the clones of
   * Arianna's code alone. The chat opens it from its own entry, not from the
   * list of agents of "+ Nuovo".
   */
  container?: string;
  /**
   * The agent of the Finances (D-183): its conversation is private and marked
   * from birth, and it answers with its read-only tools on the local model.
   */
  finance?: true;
}

/** True when `project` (a part `<container>:<part>`, or a project of one part) belongs to the container the policy asks for, or the policy asks for none. */
export function projectFits(policy: Pick<DirectPolicy, 'container'>, project: string | undefined): boolean {
  if (policy.container === undefined) return true;
  return project !== undefined && (project === policy.container || project.startsWith(`${policy.container}:`));
}

/** The policy of one agent, or undefined when it cannot answer a direct chat now (its executor is off). */
export function directPolicyOf(name: string, agent: LoadedAgent, available: { claude: boolean; codex: boolean }): DirectPolicy | undefined {
  if (name === 'arianna') return undefined;
  // The agent of the Finances (D-183): only in a private conversation, marked from birth, nothing of it goes out.
  // It answers with its tools on the local model (as Arianna does), not with one call like the other local agents.
  if (isFinanceCard(agent.card) && agent.card.executors.every((executor) => executor === 'local')) {
    return { agent: name, description: agent.card.description, cloud: false, executors: [], modes: ['private'], project: false, finance: true };
  }
  const route = delegationRoute(agent.card);
  if (isCloudRoute(route)) {
    const executors = agent.card.executors.filter((executor): executor is 'claude' | 'codex' => (CLOUD_DELEGATES as readonly string[]).includes(executor) && available[executor as 'claude' | 'codex']);
    if (executors.length === 0) return undefined;
    return { agent: name, description: agent.card.description, cloud: true, executors, modes: ['work'], project: true, ...(name === GOD_AGENT ? { container: GOD_PROJECT } : {}) };
  }
  if (route === 'local') {
    // A brief of a private conversation is L2: only an agent that may read it answers there without a declassification.
    const modes: ConversationMode[] = isAtMost('L2', briefCeiling(agent.card)) ? ['private', 'work'] : ['work'];
    return { agent: name, description: agent.card.description, cloud: false, executors: [], modes, project: false };
  }
  return undefined;
}

/** Every agent the user may talk with now, the Coder first, then by name. */
export function directPolicies(agents: ReadonlyMap<string, LoadedAgent>, available: { claude: boolean; codex: boolean }): DirectPolicy[] {
  const out: DirectPolicy[] = [];
  for (const [name, agent] of agents) {
    const policy = directPolicyOf(name, agent, available);
    if (policy !== undefined) out.push(policy);
  }
  const rank = (name: string): number => (name === 'coder' ? 0 : 1);
  return out.sort((a, b) => rank(a.agent) - rank(b.agent) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}
