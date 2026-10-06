import type { LoadedAgent } from '@arianna/agents';
import { isAtMost, type ConversationMode } from '@arianna/policy';

import { briefCeiling, delegationRoute } from './orchestrator/delegate.ts';

/**
 * The direct chat with any agent (D-111d): who the user may talk with in
 * place of Arianna, and how, from the agent's card. An agent on Claude works
 * in the folder of a project, so it needs a work conversation on one (every
 * message goes as it is to Claude). A local agent answers with one call to
 * the local model: a work conversation, or a private one when its card may
 * read L2. Arianna is never one: she answers when nobody else does.
 */
export interface DirectPolicy {
  agent: string;
  description: string;
  /** Every message goes to Claude: the warning, "va a Claude", the context indicator. */
  cloud: boolean;
  /** The modes the conversation may have with this agent. */
  modes: ConversationMode[];
  /** The conversation needs one of the approved projects. */
  project: boolean;
}

/** The policy of one agent, or undefined when it cannot answer a direct chat now (its executor is off). */
export function directPolicyOf(name: string, agent: LoadedAgent, available: { claude: boolean }): DirectPolicy | undefined {
  if (name === 'arianna') return undefined;
  const route = delegationRoute(agent.card);
  if (route === 'claude') {
    if (!available.claude) return undefined;
    return { agent: name, description: agent.card.description, cloud: true, modes: ['work'], project: true };
  }
  if (route === 'local') {
    // A brief of a private conversation is L2: only an agent that may read it answers there without a declassification.
    const modes: ConversationMode[] = isAtMost('L2', briefCeiling(agent.card)) ? ['private', 'work'] : ['work'];
    return { agent: name, description: agent.card.description, cloud: false, modes, project: false };
  }
  return undefined;
}

/** Every agent the user may talk with now, the Coder first, then by name. */
export function directPolicies(agents: ReadonlyMap<string, LoadedAgent>, available: { claude: boolean }): DirectPolicy[] {
  const out: DirectPolicy[] = [];
  for (const [name, agent] of agents) {
    const policy = directPolicyOf(name, agent, available);
    if (policy !== undefined) out.push(policy);
  }
  const rank = (name: string): number => (name === 'coder' ? 0 : 1);
  return out.sort((a, b) => rank(a.agent) - rank(b.agent) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}
