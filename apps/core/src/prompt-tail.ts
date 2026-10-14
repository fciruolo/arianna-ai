import { join } from 'node:path';

import { flatPersonaText, personaBlock, personaParts, SERIES_ROSTER_SOURCE, SERIES_USER_NAMES_SOURCE, seriesNamesOf, seriesPersonaBlock, seriesPersonaOf, seriesRosterBlock, seriesSource, type PersonaParts, type SeriesPersona } from '@arianna/agents';
import { ORIGINAL_PACK, type CharacterChoices, type Personas } from '@arianna/config';
import { isAtMost, PERSONA_LABEL, personaFits, profileBlock, scanText, type KnownSecrets, type Label, type ProfileFact } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { servesSync, type CharacterDirs } from './characters.ts';
import { themeCharactersSync } from './themes.ts';

/**
 * The tail of an agent's system prompt (D-107, tappa A3): labeled pieces
 * written by the user that go after the stable prefix, so that the cached
 * block of oMLX (D-075) is the same whatever they say. Each piece passes the
 * gateway on its own, with its label and source, and counts in the label of
 * the step; the model reads the texts the gateway let out, joined in order.
 *
 * The person of the series the agent wears (D-214, L0, text of the
 * repository) first, then the persona, then, in the steps on this machine only, the profile
 * «Su di te» (D-114, tappa B, `profilePart`) with its own label and source.
 */
export interface TailPart {
  text: string;
  label: Label;
  source: string;
}

/** The lower of two labels. */
export function minLabel(a: Label, b: Label): Label {
  return isAtMost(a, b) ? a : b;
}

/**
 * The persona of `agent` as one piece for a step with `clearance` (the lower
 * of the agent's ceiling and the task's): the fixed sentences of tone and
 * address (L0) always, the user's text (L1 by declaration) only when the
 * clearance admits L1, never for an L0 agent or task (`personaParts`). None
 * when nothing is left: the prompt is then the same byte for byte as without
 * a persona. Own keys only: an agent named `constructor` has no persona.
 */
export function personaPart(personas: Personas, agent: string, clearance: Label, secrets: KnownSecrets = knownSecrets): TailPart | undefined {
  const persona = Object.hasOwn(personas, agent) ? personas[agent] : undefined;
  if (persona === undefined) return undefined;
  const parts = withoutPersonal(personaParts(persona, clearance), secrets);
  const text = personaBlock(parts);
  return text === '' ? undefined : { text, label: parts.label, source: `persona:${agent}` };
}

/**
 * The parts without a free text that looks like personal data or holds a
 * value of the vault (the user's choice of 2026-10-14): the settings page
 * already refuses such a text, but `arianna.toml` can be written by hand. The
 * text is dropped, tone and address stay; the label falls back to L0 when no
 * text is left. The gateway would stop it towards the cloud anyway; this keeps
 * it out of the local prompt too, and says nothing of the text.
 */
export function withoutPersonal(parts: PersonaParts, secrets: KnownSecrets = knownSecrets): PersonaParts {
  // Both the text as written and as the block shows it (flatPersonaText): a value split over lines joins again there.
  const clean = (text: string | undefined): boolean =>
    text === undefined || [text, flatPersonaText(text)].every((form) => scanText(form).length === 0 && secrets.find(form).length === 0);
  const kept: PersonaParts = { tone: parts.tone, address: parts.address, label: 'L0' };
  if (parts.displayName !== undefined && clean(parts.displayName)) kept.displayName = parts.displayName;
  if (parts.traits !== undefined && clean(parts.traits)) kept.traits = parts.traits;
  if (parts.specialization !== undefined && clean(parts.specialization)) kept.specialization = parts.specialization;
  if (kept.displayName !== undefined || kept.traits !== undefined || kept.specialization !== undefined) kept.label = parts.label;
  return kept;
}

/** What the tail reads of the settings: the personas, and what tells the character an agent wears. */
export interface TailConfig {
  personas: Personas;
  /** `[characters]`: a choice always wins over the theme. */
  characters?: CharacterChoices;
  /** `[appearance]`: the theme whose characters the agents wear without a choice. */
  appearance?: { theme: string };
  /** ARIANNA_HOME, where `apps/hud/themes` and the packs in git are. */
  home?: string;
  /** Where data/characters is. */
  paths?: { data: string };
  /** The characters of a theme by id; read from `home` when not given (tests give it). */
  themeCharacters?: (theme: string) => Record<string, string>;
  /** Whether a pack serves a character; read from `home` and `paths` when not given (tests give it). */
  serves?: (pack: string, character: string) => boolean;
  /** The agents loaded now, by origin (D-217); `configureTailAgents` when not given (tests give it). */
  agentsNow?: () => TailAgents;
}

/** The agents loaded now: the cards of agents/ (in git, their names L0) and the user's (D-119, their names L1). */
export interface TailAgents {
  official: readonly string[];
  user: readonly string[];
}

// Set by main.ts; none until then, so nobody is listed in who is who.
let tailAgents: () => TailAgents = () => ({ official: [], user: [] });

/** What tells the tail which agents are loaded now (D-217): a key of `[characters]` without its agent counts for nothing. */
export function configureTailAgents(read: () => TailAgents): void {
  tailAgents = read;
}

/** The folders of the packs, as main.ts gives them to the chat. */
export function characterDirsOf(home: string, data: string): CharacterDirs {
  return { original: join(home, 'apps', 'hud', 'characters', 'originali'), series: join(home, 'apps', 'hud', 'characters', 'serie'), data: join(data, 'characters') };
}

/**
 * The `<pack>/<character>` `agent` wears, chosen as `assignCharacters` chooses
 * it for the chat (D-103): the user's choice when it is served, else the
 * theme's when served, else the original of the same name, else the Coder's.
 * The theme is read once, and only when the choice does not decide.
 * Undefined when nothing can be read (no home and no reader).
 */
export function characterChoiceOf(config: TailConfig, agent: string): string | undefined {
  return characterResolver(config)?.choose(agent);
}

/**
 * The choice of `characterChoiceOf` for many agents at once (D-217): the
 * theme is read once, and only when a choice does not decide. `agents` are
 * those that may wear a character of the theme or of `[characters]`.
 */
function characterResolver(config: TailConfig): { choose: (agent: string) => string | undefined; agents: () => string[] } | undefined {
  const home = config.home;
  const serves =
    config.serves ?? (home === undefined || config.paths === undefined ? undefined : ((dirs: CharacterDirs) => (pack: string, character: string) => servesSync(dirs, pack, character))(characterDirsOf(home, config.paths.data)));
  if (serves === undefined) return undefined;
  const served = (choice: string | undefined): boolean => {
    const [pack, character, ...rest] = (choice ?? '').split('/');
    return pack !== undefined && character !== undefined && rest.length === 0 && serves(pack, character);
  };
  let themed: Record<string, string> | undefined;
  const themeCharacters = (): Record<string, string> => {
    if (themed !== undefined) return themed;
    const theme = config.appearance?.theme;
    const read = config.themeCharacters ?? (home === undefined ? undefined : (id: string) => themeCharactersSync(join(home, 'apps', 'hud', 'themes'), id));
    themed = theme === undefined || read === undefined ? {} : read(theme);
    return themed;
  };
  return {
    choose: (agent) => {
      const chosen = config.characters !== undefined && Object.hasOwn(config.characters, agent) ? config.characters[agent] : undefined;
      if (served(chosen)) return chosen;
      const fromTheme = Object.hasOwn(themeCharacters(), agent) ? themeCharacters()[agent] : undefined;
      if (served(fromTheme)) return fromTheme;
      for (const fallback of [`${ORIGINAL_PACK}/${agent}`, `${ORIGINAL_PACK}/coder`]) if (served(fallback)) return fallback;
      return undefined;
    },
    agents: () => [...new Set([...Object.keys(config.characters ?? {}), ...Object.keys(themeCharacters())])],
  };
}

/** How an agent is named in the roster (D-217): as the cards and the chat call it. */
const AGENT_LABEL: Readonly<Record<string, string>> = { arianna: 'Arianna', coder: 'Coder', god: 'GOD', designer: 'Designer', finanze: 'Finanze', reviewer: 'Reviewer' };

function agentLabel(agent: string): string {
  return Object.hasOwn(AGENT_LABEL, agent) ? (AGENT_LABEL[agent] ?? agent) : agent.charAt(0).toUpperCase() + agent.slice(1);
}

/**
 * Every loaded agent that wears a person of the series now, Arianna first,
 * with that person and whether it is one of the user's (its name is then L1).
 * A key of `[characters]` or of the theme without a loaded agent is left out.
 */
export function wornSeries(config: TailConfig): { agent: string; person: SeriesPersona; user: boolean }[] {
  const resolver = characterResolver(config);
  if (resolver === undefined) return [];
  const loaded = (config.agentsNow ?? tailAgents)();
  return resolver
    .agents()
    .filter((agent) => loaded.official.includes(agent) || loaded.user.includes(agent))
    .sort((a, b) => (a === 'arianna' ? -1 : b === 'arianna' ? 1 : a.localeCompare(b)))
    .flatMap((agent) => {
      const person = seriesPersonaOf(resolver.choose(agent));
      return person === undefined ? [] : [{ agent, person, user: !loaded.official.includes(agent) }];
    });
}

/**
 * The names of the people of the series worn now, whole, with their forms
 * («Cox» for «Dr. Cox», which the scanner finds alone) (D-217): what an
 * answer of an agent may call another by, and so what a later brief may hold.
 * The gateway takes them for no person in every fragment, only as the whole
 * name the scanner found: «Carla Bianchi» is still a person.
 */
export function wornSeriesNames(config: TailConfig): string[] {
  return [...new Set(wornSeries(config).flatMap(({ person }) => seriesNamesOf(person)))];
}

/** The display name the user wrote for `agent`, if any: own keys only. */
function ownName(config: TailConfig, agent: string): string | undefined {
  return Object.hasOwn(config.personas, agent) ? config.personas[agent]?.displayName : undefined;
}

/**
 * Who is who in the theme for `agent` (D-217), one L0 piece: the other cards
 * of agents/ that wear a person of the series, by its name. An agent the user
 * named in Personalità, or one of the user's agents (its name is the user's
 * text), is left to `userNamesPart`, L1.
 */
export function rosterPart(config: TailConfig, agent: string): TailPart | undefined {
  const entries = wornSeries(config)
    .filter((entry) => entry.agent !== agent && !entry.user && ownName(config, entry.agent) === undefined)
    .map((entry) => ({ agent: agentLabel(entry.agent), name: entry.person.name }));
  const text = seriesRosterBlock(entries);
  return text === '' ? undefined : { text, label: 'L0', source: SERIES_ROSTER_SOURCE };
}

/** Source of the piece with the names the user wrote for the other agents (D-217). */
export const USER_NAMES_SOURCE = SERIES_USER_NAMES_SOURCE;

/**
 * Who is who where the user's text is in (D-217): the names the user wrote in
 * Personalità for the other agents that wear a person of the series (they win
 * over the character's), and the user's agents (D-119) with the character they
 * wear (their own name is the user's text). L1 by declaration as the persona
 * (D-107): only when the clearance admits it, never with a name or an agent
 * that looks like personal data or holds a value of the vault.
 */
export function userNamesPart(config: TailConfig, agent: string, clearance: Label, secrets: KnownSecrets = knownSecrets): TailPart | undefined {
  if (!personaFits(clearance)) return undefined;
  const clean = (text: string) => scanText(text).length === 0 && secrets.find(text).length === 0;
  const entries = wornSeries(config).flatMap((entry) => {
    const name = ownName(config, entry.agent) ?? (entry.user ? entry.person.name : undefined);
    const label = agentLabel(entry.agent);
    return entry.agent === agent || name === undefined || !clean(name) || !clean(label) ? [] : [{ agent: label, name }];
  });
  const text = seriesRosterBlock(entries);
  return text === '' ? undefined : { text, label: PERSONA_LABEL, source: USER_NAMES_SOURCE };
}

/**
 * The person of the series `agent` wears (D-214) as one piece, L0: text of
 * the repository, so it enters every step, an L0 agent's and a brief to the
 * cloud too. The name and the personality the user wrote for the agent win:
 * each of them leaves the character's out, whatever the clearance of the step.
 * Source `character:serie/<id>`: the second scanner takes the character's name
 * for no person in this piece alone (`seriesNamesOfSource`).
 */
export function characterPart(config: TailConfig, agent: string): TailPart | undefined {
  const choice = characterChoiceOf(config, agent);
  const person = seriesPersonaOf(choice);
  if (person === undefined || choice === undefined) return undefined;
  const own = Object.hasOwn(config.personas, agent) ? config.personas[agent] : undefined;
  const text = seriesPersonaBlock(person, { withName: own?.displayName === undefined, withTraits: own?.traits === undefined });
  return text === '' ? undefined : { text, label: 'L0', source: seriesSource(choice.split('/')[1] ?? '') };
}

/** The pieces of the tail of `agent` for a step with `clearance`, in the order the model reads them. */
export function tailParts(config: TailConfig, agent: string, clearance: Label): TailPart[] {
  const pieces = [characterPart(config, agent), rosterPart(config, agent), personaPart(config.personas, agent, clearance), userNamesPart(config, agent, clearance)];
  return pieces.filter((piece): piece is TailPart => piece !== undefined);
}

/** The profile as a piece of the tail; `topicsOnly` when only the topics entered (the step may then offer profile.read). */
export interface ProfilePart extends TailPart {
  topicsOnly: boolean;
}

/** Source of the profile piece in gateway_log: no text, no topic. */
export const PROFILE_SOURCE = 'profile:user';

/**
 * The profile «Su di te» (D-114, tappa B) as one piece of the tail, for a step
 * on the local model only, with `clearance` the lower of the card's
 * `max_label` and the task's: in a private step topics and texts of every
 * fact (L2 as soon as one L2 text is in), in a work step the texts of the L1
 * facts and the topics of the L2 ones (L1), nothing for an L0 agent or task
 * (`profileBlock` of the policy). Past its limit only the topics (L1), and
 * `readTool` says that the step offers profile.read; `shareTool` that it
 * offers profile.share, and a private fact says how to ask for it (D-213).
 * Never for a brief to the cloud: a single fact leaves only with profile.share.
 */
export function profilePart(facts: readonly ProfileFact[], clearance: Label, options: { readTool?: boolean; shareTool?: boolean } = {}): ProfilePart | undefined {
  const block = profileBlock(clearance, facts, {
    ...(options.readTool === undefined ? {} : { readTool: options.readTool }),
    ...(options.shareTool === undefined ? {} : { shareTool: options.shareTool }),
  });
  return block === undefined ? undefined : { text: block.text, label: block.label, source: PROFILE_SOURCE, topicsOnly: block.topicsOnly };
}

/** The tail as the prompt receives it: the texts the gateway let out, empty ones left out; '' without any. */
export function promptTail(texts: readonly string[]): string {
  return texts.filter((text) => text !== '').join('\n\n');
}
