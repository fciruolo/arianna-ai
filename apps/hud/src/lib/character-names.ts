import { shallowRef } from 'vue';

import { agentName } from './italian.ts';
import type { CharacterListing } from './types.ts';

/**
 * The name of the person of the series an agent wears (D-214): with a
 * character of the pack `serie` the chat shows first the character's name
 * («Dr. Cox») and under it, smaller, the agent's («GOD»). The name comes from
 * the pack.json the core serves, so nothing of the series is written here.
 */
export const SERIES_PACK = 'serie';

/**
 * Agent → the name the chat shows above the agent's: the one the user wrote
 * for it (it always wins, D-214), else the person of the series it wears;
 * agents with neither are left out.
 */
export function seriesNames(listing: CharacterListing | null | undefined): Record<string, string> {
  const names: Record<string, string> = {};
  if (listing === null || listing === undefined) return names;
  const own = listing.names ?? {};
  for (const [agent, name] of Object.entries(own)) {
    if (typeof name === 'string' && name.trim() !== '' && name.trim() !== agentName(agent)) names[agent] = name.trim();
  }
  const pack = listing.packs.find((entry) => entry.id === SERIES_PACK);
  if (pack === undefined) return names;
  for (const [agent, choice] of Object.entries(listing.agents)) {
    if (choice.pack !== SERIES_PACK || Object.hasOwn(names, agent)) continue;
    const name = pack.characters.find((character) => character.id === choice.character)?.name;
    if (name !== undefined && name.trim() !== '') names[agent] = name;
  }
  return names;
}

/** What the chat shows of an agent: the character's name first when there is one, the agent's under it. */
export interface AgentLabel {
  main: string;
  sub: string | null;
}

export function agentLabelOf(agent: string, names: Readonly<Record<string, string>>): AgentLabel {
  const series = Object.hasOwn(names, agent) ? names[agent] : undefined;
  return series === undefined ? { main: agentName(agent), sub: null } : { main: series, sub: agentName(agent) };
}

/** The same on one line, for titles, labels for screen readers and sentences: «Dr. Cox (GOD)». */
export function agentLabelText(agent: string, names: Readonly<Record<string, string>>): string {
  const label = agentLabelOf(agent, names);
  return label.sub === null ? label.main : `${label.main} (${label.sub})`;
}

/**
 * The name inside the messages of a chat (user's request, 2026-10-15): the
 * character's alone, «Carla» and not «Carla (Arianna)»; the header above
 * keeps both. Without a character, the agent's.
 */
export function agentShortNameOf(agent: string, names: Readonly<Record<string, string>>): string {
  return agentLabelOf(agent, names).main;
}

/** The names of the characters in use, set by the store at each read of /api/characters. */
export const characterNames = shallowRef<Record<string, string>>({});

export function rememberCharacterNames(listing: CharacterListing | null | undefined): void {
  characterNames.value = seriesNames(listing);
}

/** The agent as the chat shows it now (reactive in a template). */
export function agentLabel(agent: string): AgentLabel {
  return agentLabelOf(agent, characterNames.value);
}

export function agentLabelLine(agent: string): string {
  return agentLabelText(agent, characterNames.value);
}

/** agentShortNameOf with the names in use (reactive in a template). */
export function agentShortName(agent: string): string {
  return agentShortNameOf(agent, characterNames.value);
}
