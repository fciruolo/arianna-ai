import { join } from 'node:path';

import { flatPersonaText, personaBlock, personaParts, SERIES_PACK_ID, SERIES_ROSTER_SOURCE, SERIES_USER_NAMES_SOURCE, seriesLinesBlock, seriesLinesSource, seriesNamesOf, seriesPersonaBlock, seriesPersonaOf, seriesOwnSource, seriesRosterBlock, seriesSource, withSeriesOverride, type PersonaParts, type SeriesOverride, type SeriesPersona } from '@arianna/agents';
import { ORIGINAL_PACK, type CharacterChoices, type Personas, type SeriesOverrides } from '@arianna/config';
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
  /** `[series.<id>]` (D-223): what the user rewrote of the people of the series. */
  series?: SeriesOverrides;
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
  /** The archive of real lines (D-224); `configureSeriesLines` when not given (tests give it). */
  lines?: LinesSource;
}

/** What the tail reads of the archive of real lines (D-224): `SeriesLines` of series-lines.ts. */
export interface LinesSource {
  has(character: string, named: boolean): boolean;
  draw(character: string, options: { conversation: string; named: boolean }): string[];
}

// Set by main.ts; none until then, so the fixed catchphrases stay.
let seriesLines: LinesSource | undefined;

/** What gives the tail the real lines of the people of the series (D-224). */
export function configureSeriesLines(source: LinesSource | undefined): void {
  seriesLines = source;
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
const AGENT_LABEL: Readonly<Record<string, string>> = { arianna: 'Arianna', coder: 'Coder', god: 'GOD', designer: 'Designer', finanze: 'Finanze', reviewer: 'Reviewer', 'local-chat': 'Modello locale' };

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
 * for no person in this piece alone (`seriesNamesOfSource`). With a private
 * `clearance` (L2 or more, a step on this machine) the role-play for real
 * (D-223); the default L0 is the plain voice.
 */
export function characterPart(config: TailConfig, agent: string, clearance: Label = 'L0', lines = false): TailPart | undefined {
  const worn = wornPerson(config, agent, clearance);
  if (worn === undefined) return undefined;
  const { id, merged, own, play } = worn;
  // With real lines drawn apart for each answer (D-224) the fixed catchphrases stay out.
  const text = seriesPersonaBlock(merged.persona, { withName: own?.displayName === undefined, withTraits: own?.traits === undefined, play, lines: lines && drawsLines(config, worn, clearance) });
  // The user's text has its own source: no exemption for the names of the series there (D-223).
  return text === '' ? undefined : { text, label: merged.own ? PERSONA_LABEL : 'L0', source: merged.own ? seriesOwnSource(id) : seriesSource(id) };
}

interface WornPerson {
  id: string;
  merged: { persona: SeriesPersona; own: boolean };
  own: Personas[string] | undefined;
  play: boolean;
  /** The user rewrote the catchphrases (D-223): theirs win over the archive. */
  ownQuotes: boolean;
}

function wornPerson(config: TailConfig, agent: string, clearance: Label): WornPerson | undefined {
  const choice = characterChoiceOf(config, agent);
  if (seriesPersonaOf(choice) === undefined || choice === undefined) return undefined;
  const own = Object.hasOwn(config.personas, agent) ? config.personas[agent] : undefined;
  // The scene with the other people of the series in a private step only (D-223): it never reaches a brief to the cloud.
  return seriesWorn(config, choice.split('/')[1] ?? '', own, clearance, !isAtMost(clearance, 'L1'));
}

/** The person of the series `id` for a step with `clearance`, with the persona `own` of the agent that wears it (none in a chat with the character, D-225). */
function seriesWorn(config: TailConfig, id: string, own: Personas[string] | undefined, clearance: Label, play: boolean): WornPerson | undefined {
  const person = seriesPersonaOf(`${SERIES_PACK_ID}/${id}`);
  if (person === undefined) return undefined;
  // What the user rewrote (D-223) is theirs, Interno (L1): only in a step that admits it, and never when it looks like personal data or a vault value now.
  const override = config.series !== undefined && Object.hasOwn(config.series, id) ? config.series[id] : undefined;
  const fits = personaFits(clearance) && override !== undefined && seriesFits(override);
  const merged = fits ? withSeriesOverride(person, override) : { persona: person, own: false };
  return { id, merged, own, play, ownQuotes: fits && override.quotes !== undefined };
}

/** Real lines go with the character's own personality only, and not over the catchphrases the user wrote (D-224). */
function drawsLines(config: TailConfig, worn: WornPerson, clearance: Label): boolean {
  const source = config.lines ?? seriesLines;
  // The archive is a file of data/ the user may write by hand: Interno (L1), never in an L0 step.
  return source !== undefined && personaFits(clearance) && worn.own?.traits === undefined && !worn.ownQuotes && source.has(worn.id, worn.play);
}

/**
 * The real lines of the person of the series `agent` wears, drawn by the core
 * for one answer in `conversation` (D-224), as one piece, Interno (L1: the
 * file may hold lines written by hand), never in an L0 step: the caller puts
 * it at the end of the last message, after the history, so that the cached
 * prefix stays the same from one answer to the next. A line that names
 * someone else in a private step only (as the scene, D-223). None when the
 * agent wears no person of the series, the user's personality or catchphrases
 * win, or the archive is empty; then `characterPart` keeps the fixed ones.
 * None either with the switch «Personaggio» of the conversation off (`on`
 * false, D-225).
 */
export function linesPart(config: TailConfig, agent: string, clearance: Label, conversation: string, on = true): TailPart | undefined {
  if (!on) return undefined;
  const worn = wornPerson(config, agent, clearance);
  const source = config.lines ?? seriesLines;
  if (worn === undefined || source === undefined || !drawsLines(config, worn, clearance)) return undefined;
  const text = seriesLinesBlock(source.draw(worn.id, { conversation, named: worn.play }));
  return text === '' ? undefined : { text, label: PERSONA_LABEL, source: seriesLinesSource(worn.id) };
}

/**
 * The block of the person of the series `character` in a chat with that
 * character on Claude (D-225, tappa B), one piece: the role-play for real
 * (`play`), scene and other people of the series included, since in that chat
 * every name of the series is no person for the second scanner
 * (`seriesShowNames`). The repository's text (L0, `character:serie/<id>`) or
 * the user's rewrite (L1, `#own`) as in `characterPart`; no agent, so no
 * persona of an agent wins. `lines`: real lines come apart with each message
 * (`chatLinesPart`), the fixed catchphrases stay out. None for an id that is
 * not a person of the series.
 */
export function chatCharacterPart(config: TailConfig, character: string, clearance: Label = 'L1', lines = false): TailPart | undefined {
  const worn = seriesWorn(config, character, undefined, clearance, true);
  if (worn === undefined) return undefined;
  const { id, merged } = worn;
  const text = seriesPersonaBlock(merged.persona, { withName: true, withTraits: true, play: true, lines: lines && drawsLines(config, worn, clearance) });
  return text === '' ? undefined : { text, label: merged.own ? PERSONA_LABEL : 'L0', source: merged.own ? seriesOwnSource(id) : seriesSource(id) };
}

/**
 * The real lines of `character` drawn for one message of a chat with that
 * character (D-225, tappa B), as `linesPart` draws them for an agent: Interno
 * (L1), lines that name the others of the series too. The caller puts them
 * after the user's message, at every message, also when the session resumes.
 */
export function chatLinesPart(config: TailConfig, character: string, clearance: Label, conversation: string): TailPart | undefined {
  const worn = seriesWorn(config, character, undefined, clearance, true);
  const source = config.lines ?? seriesLines;
  if (worn === undefined || source === undefined || !drawsLines(config, worn, clearance)) return undefined;
  const text = seriesLinesBlock(source.draw(worn.id, { conversation, named: true }));
  return text === '' ? undefined : { text, label: PERSONA_LABEL, source: seriesLinesSource(worn.id) };
}

/** No text of the user's rewrite looks like personal data or holds a value of the vault (D-223), as the persona's (D-107). */
export function seriesFits(override: SeriesOverride, secrets: KnownSecrets = knownSecrets): boolean {
  const texts = [override.traits, override.scene, ...(override.quotes ?? [])].filter((text): text is string => text !== undefined);
  return texts.every((text) => scanText(text).length === 0 && secrets.find(text).length === 0);
}

/**
 * The pieces of the tail of `agent` for a step with `clearance`, in the order
 * the model reads them. `character` false: the switch «Personaggio» of the
 * conversation is off (D-225), the character's block stays out; who is who
 * and the persona the user wrote stay.
 */
export function tailParts(config: TailConfig, agent: string, clearance: Label, options: { lines?: boolean; character?: boolean } = {}): TailPart[] {
  // `lines`: the caller adds `linesPart` at the end of the last message, so the fixed catchphrases stay out (D-224).
  const character = options.character === false ? undefined : characterPart(config, agent, clearance, options.lines === true);
  const pieces = [character, rosterPart(config, agent), personaPart(config.personas, agent, clearance), userNamesPart(config, agent, clearance)];
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
