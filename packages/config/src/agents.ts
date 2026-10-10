import { CHARACTER_ID } from './characters.ts';
import { CLOUD_MODELS, LEGACY_CODEX_ALIAS, LEGACY_CODEX_AS, type CloudModel } from './cloud.ts';
import { asArray, asOneOf, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

/** The settings of one agent in `[agents.<id>]` (D-116). */
export interface AgentSettings {
  /**
   * The model a new conversation with this agent starts with; absent, the
   * router chooses. Kept even while the model is off: the core offers it
   * only while it is on and the agent's card allows it.
   */
  model?: CloudModel;
  /**
   * The skills of the catalog (D-161) the agent reads in each of its
   * deliveries, as `<owner>/<repo>/<slug>`: third-party text, data and never
   * an instruction to Arianna. A skill no longer in the catalog is skipped.
   */
  skills?: string[];
}

/** A skill of the catalog (D-161): the GitHub source in lowercase, then the slug of the skill. */
export const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}\/[a-z0-9][a-z0-9-]{0,63}$/;
/** Skills assigned to one agent. */
export const MAX_AGENT_SKILLS = 20;
/** The skills block of one delivery (D-161): to Claude or Codex, and to an agent on the local model, whose context is smaller. */
export const SKILLS_DELIVERY_BYTES = { cloud: 128 * 1024, local: 16 * 1024 } as const;

/** A list of skill ids, checked and without repetitions. */
export function parseSkillIds(value: unknown, where: string): string[] {
  const list = asArray(value, where);
  if (list.length > MAX_AGENT_SKILLS) throw new ConfigError(`${where}: at most ${String(MAX_AGENT_SKILLS)} skills`);
  const ids: string[] = [];
  for (const [index, item] of list.entries()) {
    const id = asString(item, `${where}[${String(index)}]`);
    if (!SKILL_ID.test(id) || id.split('/')[1] === '.' || id.split('/')[1] === '..') throw new ConfigError(`${where}[${String(index)}]: a skill is <owner>/<repo>/<slug>, in lowercase`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
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
      onlyKeys(settings, ['model', 'skills'], where);
      const parsed: AgentSettings = {};
      if (settings.skills !== undefined) {
        // Third-party text is never an instruction to Arianna (D-161).
        if (agent === ORCHESTRATOR_AGENT) throw new ConfigError(`${where}.skills: Arianna reads no skills`);
        const skills = parseSkillIds(settings.skills, `${where}.skills`);
        if (skills.length > 0) parsed.skills = skills;
      }
      if (settings.model !== undefined) {
        if (agent === ORCHESTRATOR_AGENT) throw new ConfigError(`${where}.model: Arianna's model is the orchestrator of [roles], local only`);
        // `codex` from before D-141 is read as sol; the page writes the new alias at the next save.
        parsed.model = settings.model === LEGACY_CODEX_ALIAS ? LEGACY_CODEX_AS : asOneOf(settings.model, CLOUD_MODELS, `${where}.model`);
      }
      agents[agent] = parsed;
    }
  }
  if (legacy !== undefined && agents[LEGACY_DEFAULT_AGENT]?.model === undefined) {
    agents[LEGACY_DEFAULT_AGENT] = { ...agents[LEGACY_DEFAULT_AGENT], model: legacy };
  }
  return agents;
}
