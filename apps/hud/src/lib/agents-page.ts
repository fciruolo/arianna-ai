/**
 * The page Impostazioni → Agenti as a list of cards and the detail of one
 * agent (D-133): who is in the list, the filters, and which agents hold edits
 * not saved. Pure functions; the page is `AgentsSettings.vue`.
 */
import { personasBody, type PersonaForm } from './persona.ts';
import type { UserAgentListing, UserAgentView } from './user-agents.ts';

/** One card of the list. */
export interface AgentEntry {
  id: string;
  /** In `agents/`, in git; otherwise one of the user's, in `data/agents`. */
  official: boolean;
  on: boolean;
  /** `cloud`: what it receives can go to Claude; `local`: it stays on the computer. */
  where: 'cloud' | 'local';
  description: string;
  /** The listing's view; undefined for an agent the settings name but the core did not list. */
  view: UserAgentView | undefined;
}

export type AgentFilter = 'all' | 'on' | 'off';

export type AgentTab = 'persona' | 'look' | 'model' | 'skills' | 'permissions' | 'card';

export const TAB_TEXT: Record<AgentTab, string> = { persona: 'Personalità', look: 'Aspetto', model: 'Modello', skills: 'Skill', permissions: 'Permessi', card: 'Scheda e prompt' };

/** The tabs of an agent: "Skill" for every one (D-161, Arianna says why not), "Scheda e prompt" only for the user's ones, whose texts the page can change. */
export function tabsOf(entry: AgentEntry): AgentTab[] {
  return entry.official ? ['persona', 'look', 'model', 'skills', 'permissions'] : ['persona', 'look', 'model', 'skills', 'permissions', 'card'];
}

/** Where a card runs: any executor but the local model sends what it receives to the cloud. */
export function whereOf(view: UserAgentView): AgentEntry['where'] {
  return view.card.executors.some((executor) => executor !== 'local') ? 'cloud' : 'local';
}

/**
 * The cards of the list: Arianna first, then the others by id; the official
 * ones always on. `known` are the agents the settings name (characters,
 * personas, models): one the listing lacks still gets a card, as an official
 * one, so its look and persona stay reachable.
 */
export function agentEntries(listing: UserAgentListing | null, known: readonly string[]): AgentEntry[] {
  const entries = new Map<string, AgentEntry>();
  for (const view of listing?.official ?? []) entries.set(view.name, { id: view.name, official: true, on: true, where: whereOf(view), description: view.description, view });
  for (const view of listing?.user ?? []) entries.set(view.name, { id: view.name, official: false, on: view.state === 'active', where: whereOf(view), description: view.description, view });
  for (const id of known) if (!entries.has(id)) entries.set(id, { id, official: true, on: true, where: 'local', description: '', view: undefined });
  return [...entries.values()].sort((a, b) => (a.id === 'arianna' ? -1 : b.id === 'arianna' ? 1 : a.id.localeCompare(b.id)));
}

/** The cards the search and the filter leave; the search looks at the shown name, the id and the description. */
export function filterEntries(entries: readonly AgentEntry[], query: string, filter: AgentFilter, nameOf: (id: string) => string): AgentEntry[] {
  const words = query.trim().toLowerCase();
  return entries.filter(
    (entry) => (filter === 'all' || (filter === 'on') === entry.on) && (words === '' || `${nameOf(entry.id)} ${entry.id} ${entry.description}`.toLowerCase().includes(words)),
  );
}

/** The parts of the settings the page edits per agent. */
export interface AgentParts {
  characters: Record<string, string>;
  personas: Record<string, PersonaForm>;
  agents: Record<string, string>;
  /** Agent → its skills (D-161); absent with an older core. */
  skills?: Record<string, string[]>;
}

/** The agents whose look, persona or model differ from what was read; a persona compared as it is sent. */
export function changedAgents(form: AgentParts, base: AgentParts): string[] {
  const ids = new Set([...Object.keys(form.characters), ...Object.keys(base.characters), ...Object.keys(form.personas), ...Object.keys(form.agents), ...Object.keys(form.skills ?? {})]);
  const persona = (forms: Record<string, PersonaForm>, id: string): string => JSON.stringify(forms[id] === undefined ? {} : personasBody({ [id]: forms[id] }));
  return [...ids]
    .filter(
      (id) =>
        (form.characters[id] ?? '') !== (base.characters[id] ?? '') ||
        (form.agents[id] ?? '') !== (base.agents[id] ?? '') ||
        persona(form.personas, id) !== persona(base.personas, id) ||
        (form.skills?.[id] ?? []).join('\n') !== (base.skills?.[id] ?? []).join('\n'),
    )
    .sort();
}

/** The names in the bar "Modifiche non salvate a …": up to three, then how many more. */
export function unsavedNames(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} e altri ${String(names.length - 3)}`;
}
