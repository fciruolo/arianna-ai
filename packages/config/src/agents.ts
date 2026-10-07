import { CHARACTER_ID } from './characters.ts';
import { CLOUD_MODELS, LEGACY_CODEX_ALIAS, LEGACY_CODEX_AS, type CloudModel } from './cloud.ts';
import { asOneOf, asTable, ConfigError, onlyKeys } from './validate.ts';

/** The settings of one agent in `[agents.<id>]` (D-116). */
export interface AgentSettings {
  /**
   * The model a new conversation with this agent starts with; absent, the
   * router chooses. Kept even while the model is off: the core offers it
   * only while it is on and the agent's card allows it.
   */
  model?: CloudModel;
}

/** Agent id → its settings. */
export type AgentsSettings = Record<string, AgentSettings>;

/**
 * Arianna's model is the `orchestrator` role of `[roles]`, local only: one
 * place to set it, never a cloud model (D-116).
 */
export const ORCHESTRATOR_AGENT = 'arianna';

/**
 * The agent whose default `default` of `[cloud.models]` was before D-116: a
 * new work conversation delegated to the Coder.
 */
export const LEGACY_DEFAULT_AGENT = 'coder';

/**
 * `[agents.<id>]` of arianna.toml (D-116). Ordinary settings, never
 * permissions: tools, labels and the cloud an agent may use stay in
 * agents/*.yaml, and the core checks the model against them. `legacy` is
 * `default` of `[cloud.models]`, read as the Coder's model when its table has
 * none.
 */
export function parseAgents(value: unknown, legacy?: CloudModel): AgentsSettings {
  const agents: AgentsSettings = {};
  if (value !== undefined) {
    const table = asTable(value, 'agents');
    for (const [agent, raw] of Object.entries(table)) {
      // Same ids as [characters]; `__proto__` and the like never match.
      if (!CHARACTER_ID.test(agent)) throw new ConfigError('agents: an agent id is lowercase letters, digits, - and _');
      const where = `agents.${agent}`;
      const settings = asTable(raw, where);
      onlyKeys(settings, ['model'], where);
      if (settings.model === undefined) {
        agents[agent] = {};
        continue;
      }
      if (agent === ORCHESTRATOR_AGENT) throw new ConfigError(`${where}.model: Arianna's model is the orchestrator of [roles], local only`);
      // `codex` from before D-141 is read as sol; the page writes the new alias at the next save.
      agents[agent] = { model: settings.model === LEGACY_CODEX_ALIAS ? LEGACY_CODEX_AS : asOneOf(settings.model, CLOUD_MODELS, `${where}.model`) };
    }
  }
  if (legacy !== undefined && agents[LEGACY_DEFAULT_AGENT]?.model === undefined) {
    agents[LEGACY_DEFAULT_AGENT] = { model: legacy };
  }
  return agents;
}
