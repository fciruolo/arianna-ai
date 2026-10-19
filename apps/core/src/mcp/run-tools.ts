import type { AgentCard, CloudToolId } from '@arianna/agents';
import { MCP_TOOL_NAMES, type McpToolName } from '@arianna/executors';

import { skillRefusalOf } from '../skills-catalog.ts';

/** The tool of the MCP server each `cloud_tools` entry of a card names (D-261). */
const CLOUD_TOOL_MCP: Readonly<Record<CloudToolId, McpToolName>> = { 'kb.search': 'kb_search', 'kb.read': 'kb_read' };

/**
 * The tools of Arianna's MCP server a run of this agent gets (D-261), in the
 * order of MCP_TOOL_NAMES: `list_skills` and `get_skill` when skills are
 * assigned to it and it may read them (D-161: never Arianna, never a card that
 * closes untrusted_content), `kb_search` and `kb_read` when its card lists
 * them in `cloud_tools`. Empty: the run goes without the server.
 */
export function mcpToolsOf(agent: string, card: Pick<AgentCard, 'trifecta' | 'cloudTools'>, assignedSkills: readonly string[]): McpToolName[] {
  const tools = new Set<McpToolName>();
  if (assignedSkills.length > 0 && skillRefusalOf(agent, card) === null) {
    tools.add('list_skills');
    tools.add('get_skill');
  }
  for (const tool of card.cloudTools ?? []) tools.add(CLOUD_TOOL_MCP[tool]);
  return MCP_TOOL_NAMES.filter((name) => tools.has(name));
}

/** The agents whose delegations on `claude` get the server, for now the Coder alone (D-261). */
export const MCP_DELEGATES: readonly string[] = ['coder'];

/**
 * The tools of a delegated step on `claude` (D-261): `mcpToolsOf` for an agent
 * of MCP_DELEGATES, none for any other (the Designer, GOD, a user's agent).
 */
export function delegationMcpTools(agent: string, card: Pick<AgentCard, 'trifecta' | 'cloudTools'>, assignedSkills: readonly string[]): McpToolName[] {
  return MCP_DELEGATES.includes(agent) ? mcpToolsOf(agent, card, assignedSkills) : [];
}
