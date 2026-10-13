import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTING_TOOLS,
  AgencyError,
  cardProvenance,
  framedRole,
  agencyPreset,
  AgentCardError,
  checkUserPermissions,
  loadAgent,
  loadUserAgents,
  parseAgentCard,
  parseUserPermissions,
  parseYamlText,
  promptLabelOf,
  proposeCard,
  sourceLicensed,
  USER_AGENT_FOLDERS,
  USER_AGENT_NAME,
  USER_CARD_MARK,
  USER_EXECUTORS,
  USER_LIMITS,
  USER_TOOLS,
  USER_TRIFECTA,
  userCard,
  userCardOrigin,
  userPresets,
  type AgentCard,
  type LoadedAgent,
  type NewUserAgent,
  type RefusedUserAgent,
  type ToolId,
  type UserAgentState,
  type UserCardFiles,
  type UserCardOrigin,
  type UserPermissions,
  type UserPreset,
} from '@arianna/agents';
import { scanText, type Label } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import type { AdoptedRole, AgentRole } from './agents-catalog.ts';
import { diffLines, type LineDiff } from './line-diff.ts';
import { CatalogError } from './git-catalog.ts';
import { claudeToolsOf, delegationRoute, type DelegationRoute } from './orchestrator/delegate.ts';

/**
 * The agents the user creates from the Agents page (D-119). Their cards live
 * in `data/agents/disattivati` and `data/agents/attivi` and stay under the
 * ceiling of `checkUserCeiling` (L1, A1) and within the permissions allowed
 * to user cards (`checkUserPermissions`, tappa T3b).
 * Activating and deactivating change the map of the running agents at once:
 * a delegation planned for an agent deactivated meanwhile fails, and the task
 * goes on. Promotion moves a card into `agents/`, where the ceiling no longer
 * applies: only on the user's click, with `confirm`. Tappa T3: description and
 * prompt change in place (an active agent reads them at its next delegation);
 * a disabled agent is deleted into `data/agents/eliminati`, never erased; a
 * promoted card goes back to the disabled ones, under the ceiling again.
 * Tappa T3b: the user chooses the permissions within the list; a card whose
 * permissions or labels change is written only after `prepare` showed the
 * change and the page sent back its confirmation id, bound to those exact
 * files and to the card they replace.
 */
export class UserAgentError extends Error {
  override name = 'UserAgentError';
  readonly code: 'invalid' | 'conflict' | 'not-found';
  constructor(code: 'invalid' | 'conflict' | 'not-found', message: string) {
    super(message);
    this.code = code;
  }
}

export interface UserAgentView {
  name: string;
  description: string;
  state: UserAgentState | 'official';
  card: CardSummary;
  /** Where a step Arianna delegates to it runs; null: it takes none (D-119, tappa T3). */
  works: DelegationRoute | null;
  /** An official card written by the page and promoted: it can go back to the user's ones. */
  fromPage?: true;
  /** The permissions as the page shows them; null for an official card beyond the user's list. */
  permissions: UserPermissions | null;
  /** A card of agency-agents: its label stays L0. */
  origin: UserCardOrigin;
  /** A card made from a role of the catalog (D-079, tappa 4): how its role stands in the version in use of its source. */
  catalog?: CatalogLink;
}

export interface CatalogLink {
  /** `<owner>/<repo>/<slug>`; empty when the page of the source is not one the catalog follows. */
  id: string;
  /**
   * `current`: the card has the role of the version in use; `update`: the
   * source changed it since (the card stays as it is until the user adopts it
   * again); `unfollowed`: the source is no longer followed; `waiting`: it is
   * followed but no version is in use (not downloaded yet, or being swapped);
   * `missing`: the version in use no longer has the role.
   */
  state: 'current' | 'update' | 'unfollowed' | 'waiting' | 'missing';
  /** sha256 of the role in the card. */
  sha256: string;
  /** The role in the version in use, when it differs from the card's. */
  latest?: { sha256: string; commit: string; committedAt: string | null };
}

/** What adopting again the role of a card would change (D-079, tappa 4). */
export interface ReapplyProposal {
  name: string;
  confirmation: string;
  /** Adopting again turns the agent off (choice of the user, 2026-10-13). */
  active: boolean;
  from: { commit: string; sha256: string };
  to: { commit: string; sha256: string; committedAt: string | null };
  /** The lines of the role, the old text against the new one. */
  diff: LineDiff;
  /** The source has no license now: the user says yes before (as at the creation). */
  unlicensed: boolean;
  expiresInMs: number;
}

/** What the page may change of a user's agent after its creation. */
export interface UserAgentEdit {
  description?: unknown;
  prompt?: unknown;
  /** The permissions chosen within the list (tappa T3b); missing: unchanged. */
  permissions?: unknown;
  /** The id returned by `prepareEdit`, needed when permissions or labels change. */
  confirmation?: unknown;
}

/** A new agent with the id returned by `prepareCreate`. */
export type ConfirmedNewUserAgent = NewUserAgent & { confirmation?: unknown };

/**
 * A new agent from a role of the catalog of agents (D-079, tappa 3): the role
 * gives description and prompt, read again by the core from the adopted
 * checkout; the page sends only the role, the name (missing: the one the
 * core suggests) and the permissions (missing: the starting point of the
 * role's division). A source without a license needs `licenseAccepted`.
 */
export interface CatalogNewUserAgent {
  from: unknown;
  name?: unknown;
  permissions?: unknown;
  licenseAccepted?: unknown;
  confirmation?: unknown;
}

/** What `prepare` adds for a role of the catalog: where it comes from, and what the page must say. */
export interface CatalogProposalInfo {
  id: string;
  source: string;
  page: string;
  commit: string;
  path: string;
  name: string;
  division: string;
  license: string | null;
  licenseFile: string | null;
  /** No license at the root of the source: the page asks before creating, the card keeps the warning. */
  unlicensed: boolean;
  /** The starting point of the role's division. */
  preset: string;
  /** A free name the core suggests: the role's slug, shortened or numbered when needed. */
  suggestedName: string;
}

/** The roles of the catalog the cards are made from (agents-catalog.ts). */
export interface CatalogRoles {
  role(id: unknown): AgentRole;
  /** The role of a card in the version in use of its source. */
  adoptedRole(page: string, path: string): AdoptedRole;
}

export interface PermissionChange {
  field: 'executor' | 'tools' | 'autonomy' | 'maxSteps' | 'maxMinutes' | 'maxLabel' | 'promptLabel';
  before: string | number | string[] | null;
  after: string | number | string[];
}

/**
 * What `prepare` shows before a card is written (tappa T3b): the card before
 * (null for a new one) and after, the fields that change, the trifecta and
 * what leaves for the cloud. `confirmation` is null when nothing of the
 * permissions or labels changes: the page saves without asking.
 */
export interface AgentProposal {
  name: string;
  confirmation: string | null;
  before: CardSummary | null;
  after: CardSummary;
  changes: PermissionChange[];
  trifecta: AgentCard['trifecta'];
  /** Null for an agent of the local model: nothing leaves the Mac. */
  cloud: { executor: 'claude'; briefMax: Label; promptLabel: Label; claudeTools: string[] } | null;
  expiresInMs: number;
  /** A card from the catalog of agents: the role and its source. */
  catalog?: CatalogProposalInfo;
}

export interface CardSummary {
  maxLabel: string;
  /** The label the gateway gives the prompt. */
  promptLabel: string;
  cloudMaxLabel?: string;
  /** The user chooses where each card of the agent runs (D-159). */
  executorChoice?: 'ask';
  executors: string[];
  tools: string[];
  trifecta: AgentCard['trifecta'];
  autonomy: string;
  approvals: string[];
  limits: AgentCard['limits'];
}

export interface UserAgentListing {
  official: UserAgentView[];
  user: UserAgentView[];
  refused: (RefusedUserAgent & { state: UserAgentState })[];
}

export interface UserAgents {
  /** Adds the active cards to the running agents; called once at start. */
  load(): RefusedUserAgent[];
  list(): UserAgentListing;
  /**
   * The valid disabled cards, read now from `data/agents/disattivati` (D-161: skills are assigned
   * before an agent is turned on); a name that is also active or official is left out.
   */
  disabled(): Map<string, LoadedAgent>;
  sources(): UserAgentSources;
  /** What a new card would be, with the confirmation id that `create` needs. */
  prepareCreate(input: NewUserAgent): AgentProposal;
  create(input: ConfirmedNewUserAgent): UserAgentView;
  /** The same for a role of the catalog of agents (D-079): what the disabled card would be. */
  prepareFromCatalog(input: CatalogNewUserAgent): AgentProposal;
  createFromCatalog(input: CatalogNewUserAgent): UserAgentView;
  /** What adopting again the role of a card would change (D-079, tappa 4): the lines of the role, with the confirmation id. */
  prepareReapply(name: string): ReapplyProposal;
  /** Writes the role in use into the card, keeps the old files in eliminati and turns the agent off. */
  reapply(name: string, input: { confirmation?: unknown; licenseAccepted?: unknown }): UserAgentView;
  permissions(name: string): UserAgentView;
  activate(name: string): UserAgentView;
  deactivate(name: string): UserAgentView;
  promote(name: string, confirm: unknown): UserAgentView;
  /** The prompt of a user's agent, for the page that changes it (L1 by declaration, like a persona). */
  prompt(name: string): string;
  /** What an edit would change, with the confirmation id when permissions or labels change. */
  prepareEdit(name: string, edit: UserAgentEdit): AgentProposal;
  /** Description, prompt and permissions, checked as at the creation; a change of permissions needs `confirmation`. */
  update(name: string, edit: UserAgentEdit): UserAgentView;
  /** Only a disabled agent, with its name as `confirm`: its files move into `data/agents/eliminati`. */
  remove(name: string, confirm: unknown): { name: string; folder: string };
  /** A promoted card back among the disabled ones, with `confirm`. */
  demote(name: string, confirm: unknown): UserAgentView;
}

/** What the page offers (tappa T3b): starting points, and the list the permissions are chosen from. */
export interface UserAgentSources {
  presets: UserPreset[];
  allowed: {
    executors: string[];
    tools: Record<string, string[]>;
    acting: string[];
    limits: { maxSteps: number; maxMinutes: number };
    trifecta: AgentCard['trifecta'];
  };
  /** The tools of `claude -p` each repository tool stands for, shown on the page. */
  claudeTools: Record<string, string[]>;
  /** Whether a card can be made from the catalog of agents (D-079). */
  catalog: boolean;
}

/** How long a prepared change stays confirmable, as the privacy changes of the settings page. */
const CONFIRM_MS = 10 * 60_000;

/** At most this many prepared changes wait for their confirmation. */
const MAX_PENDING = 100;

/** The basis of a new card: no file before it. */
const NEW = 'new';

const digest = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex');

function summary(agent: LoadedAgent): CardSummary {
  const { card } = agent;
  const result: CardSummary = {
    maxLabel: card.maxLabel,
    promptLabel: promptLabelOf(agent),
    executors: [...card.executors],
    tools: [...card.tools],
    trifecta: { ...card.trifecta },
    autonomy: card.autonomy,
    approvals: [...card.approvals],
    limits: { ...card.limits },
  };
  if (card.cloudMaxLabel !== undefined) result.cloudMaxLabel = card.cloudMaxLabel;
  if (card.executorChoice === 'ask') result.executorChoice = 'ask';
  return result;
}

function permissionsOrNull(card: AgentCard, origin: UserCardOrigin): UserPermissions | null {
  try {
    return checkUserPermissions(card, origin);
  } catch {
    return null;
  }
}

function view(agent: LoadedAgent, state: UserAgentView['state'], origin: UserCardOrigin): UserAgentView {
  return {
    name: agent.card.name,
    description: agent.card.description,
    state,
    card: summary(agent),
    works: delegationRoute(agent.card) ?? null,
    permissions: permissionsOrNull(agent.card, origin),
    origin,
  };
}

/** The fields of the permissions and labels that differ between two cards; every field for a new card. */
export function permissionChanges(before: CardSummary | null, after: CardSummary): PermissionChange[] {
  const changes: PermissionChange[] = [];
  const add = (field: PermissionChange['field'], was: PermissionChange['before'], now: PermissionChange['after']): void => {
    const same = Array.isArray(was) && Array.isArray(now) ? was.length === now.length && was.every((item) => now.includes(item)) : was === now;
    if (before === null || !same) changes.push({ field, before: before === null ? null : was, after: now });
  };
  add('executor', before === null ? null : before.executors.join(', '), after.executors.join(', '));
  add('tools', before === null ? null : before.tools, after.tools);
  add('autonomy', before?.autonomy ?? null, after.autonomy);
  add('maxSteps', before?.limits.maxSteps ?? null, after.limits.maxSteps);
  add('maxMinutes', before?.limits.maxMinutes ?? null, after.limits.maxMinutes);
  add('maxLabel', before?.maxLabel ?? null, after.maxLabel);
  add('promptLabel', before?.promptLabel ?? null, after.promptLabel);
  return changes;
}

/**
 * The user's text is L1 by declaration (like a persona, D-107) and may reach
 * a cloud executor: a finding of the scanner or a value of the vault refuses
 * it, naming the field and the kind, never the text.
 */
function checkText(text: unknown, field: string): void {
  if (typeof text !== 'string') return;
  const kinds = [...new Set(scanText(text).map((finding) => finding.kind))];
  if (kinds.length > 0) throw new UserAgentError('invalid', `${field} looks like personal data or a secret (${kinds.join(', ')}): not saved`);
  if (knownSecrets.find(text).length > 0) throw new UserAgentError('invalid', `${field} holds a value of the vault: not saved`);
}

/** Writes a file whole: a hidden temporary file, then a rename over the old one. */
function writeWhole(path: string, dir: string, name: string, text: string): void {
  const temporary = join(dir, `.${name}.${String(process.pid)}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A rename, or a copy when `data/` is on another volume than `agents/` (promotion). */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    rmSync(from);
  }
}

export function createUserAgents(options: {
  home: string;
  dataDir: string;
  /** The running agents, shared with the orchestrator and the worker. */
  agents: Map<string, LoadedAgent>;
  /** The names of the cards of `agents/`, read at start: never a user card's name. */
  official: ReadonlySet<string>;
  /** The catalog of agents (D-079); without it no card is made from a role. */
  catalog?: CatalogRoles;
  now?: () => number;
  confirmMs?: number;
}): UserAgents {
  const { agents } = options;
  const now = options.now ?? Date.now;
  const confirmMs = options.confirmMs ?? CONFIRM_MS;
  /** Prepared changes by confirmation id: the files `prepare` showed and the card they replace. */
  const pending = new Map<string, { name: string; files: string; basis: string; expires: number }>();
  const official = new Set(options.official);
  const officialDir = join(options.home, 'agents');
  const dirOf = (state: UserAgentState): string => join(options.dataDir, 'agents', USER_AGENT_FOLDERS[state]);

  /** The two folders, created if missing; a symbolic link in their place is refused, never followed. */
  function folders(): void {
    for (const state of ['disabled', 'active'] as const) {
      mkdirSync(dirOf(state), { recursive: true, mode: 0o700 });
      if (!lstatSync(dirOf(state)).isDirectory()) throw new UserAgentError('invalid', `data/agents/${USER_AGENT_FOLDERS[state]} is not a folder`);
    }
  }

  function read(state: UserAgentState): { agents: Map<string, LoadedAgent>; refused: RefusedUserAgent[] } {
    return loadUserAgents(dirOf(state), official);
  }

  function find(name: string): { state: UserAgentState; agent: LoadedAgent } {
    for (const state of ['active', 'disabled'] as const) {
      const agent = read(state).agents.get(name);
      if (agent !== undefined) return { state, agent };
    }
    throw new UserAgentError('not-found', `no user agent ${JSON.stringify(name)}`);
  }

  /** The prompt first and the card last: a half move leaves a card without prompt, refused and shown. */
  function move(name: string, from: string, to: string): void {
    moveFile(join(from, `${name}.md`), join(to, `${name}.md`));
    try {
      moveFile(join(from, `${name}.yaml`), join(to, `${name}.yaml`));
    } catch (error) {
      // Never a prompt without its card (in agents/ it would stop the core at start).
      moveFile(join(to, `${name}.md`), join(from, `${name}.md`));
      throw error;
    }
  }

  /** Whether the card of agents/ named `name` was written by the page: its first line is the mark. */
  function fromPage(name: string): boolean {
    try {
      return readFileSync(join(officialDir, `${name}.yaml`), 'utf8').startsWith(USER_CARD_MARK);
    } catch {
      return false;
    }
  }

  /** The text of a card file, or '' when it cannot be read (its card is then refused anyway). */
  function cardText(dir: string, name: string): string {
    try {
      return readFileSync(join(dir, `${name}.yaml`), 'utf8');
    } catch {
      return '';
    }
  }

  /** The role of a card of the catalog against the version in use of its source; undefined for any other card. */
  function catalogLink(text: string): CatalogLink | undefined {
    const provenance = cardProvenance(text);
    if (provenance === null || options.catalog === undefined) return undefined;
    const adopted = options.catalog.adoptedRole(provenance.page, provenance.path);
    if (adopted.state !== 'present') return { id: adopted.id, state: adopted.state === 'not-downloaded' ? 'waiting' : adopted.state, sha256: provenance.sha256 };
    if (adopted.sha256 === provenance.sha256) return { id: adopted.id, state: 'current', sha256: provenance.sha256 };
    return { id: adopted.id, state: 'update', sha256: provenance.sha256, latest: { sha256: adopted.sha256, commit: adopted.commit, committedAt: adopted.committedAt } };
  }

  function userView(agent: LoadedAgent, state: UserAgentState): UserAgentView {
    const text = cardText(dirOf(state), agent.card.name);
    const origin = userCardOrigin(text);
    const shown = view(agent, state, origin);
    const link = origin === 'agency' ? catalogLink(text) : undefined;
    return link === undefined ? shown : { ...shown, catalog: link };
  }

  /**
   * The card a role adopted again would be: the role of the version in use,
   * framed with its new provenance and license; name, description and
   * permissions stay the card's own.
   */
  function reapplyFiles(name: string): { state: UserAgentState; files: UserCardFiles; basis: string; before: string; after: AgentRole; link: CatalogLink & { latest: NonNullable<CatalogLink['latest']> } } {
    const { state, agent } = find(name);
    const text = cardText(dirOf(state), name);
    if (userCardOrigin(text) !== 'agency') throw new UserAgentError('invalid', `${name} was not made from a role of the catalog`);
    const link = catalogLink(text);
    if (link === undefined) throw new UserAgentError('invalid', `${name} has no provenance of the catalog of agents`);
    if (link.state !== 'update' || link.latest === undefined) {
      throw new UserAgentError('conflict', link.state === 'current' ? `${name} already has the role of the version in use` : `the role of ${name} is not in a version in use of its source`);
    }
    if (options.catalog === undefined) throw new UserAgentError('not-found', 'the catalog of agents is not available');
    let role: AgentRole;
    try {
      role = options.catalog.role(link.id);
    } catch (error) {
      if (error instanceof CatalogError) throw new UserAgentError(error.code === 'not-found' ? 'not-found' : error.code === 'invalid' ? 'invalid' : 'conflict', error.message);
      throw error;
    }
    if (role.entry.sha256 !== link.latest.sha256) throw new UserAgentError('conflict', 'the version in use changed meanwhile: look at the card again');
    const permissions = checkUserPermissions(agent.card, 'agency');
    let files: UserCardFiles;
    try {
      const proposed = proposeCard(role.entry, agencyPreset(role.entry.division), role.origin, { name, permissions });
      // userCard keeps only the comments at the top of it: the new provenance, sha256 and license.
      const header = proposed.yaml;
      files = userCard({ name, description: agent.card.description, prompt: proposed.md, permissions }, { origin: 'agency', header });
    } catch (error) {
      if (error instanceof AgentCardError || error instanceof AgencyError) throw new UserAgentError('invalid', error.message);
      throw error;
    }
    return { state, files, basis: digest(text, agent.prompt), before: framedRole(agent.prompt), after: role, link: { ...link, latest: link.latest } };
  }

  function officialView(agent: LoadedAgent): UserAgentView {
    const shown = view(agent, 'official', userCardOrigin(cardText(officialDir, agent.card.name)));
    return fromPage(agent.card.name) ? { ...shown, fromPage: true } : shown;
  }

  function taken(name: string): boolean {
    if (official.has(name)) return true;
    return (['disabled', 'active'] as const).some((state) => existsSync(join(dirOf(state), `${name}.yaml`)) || existsSync(join(dirOf(state), `${name}.md`)));
  }

  /** The card a new agent would get: the texts checked by the scanner and the vault, the permissions by the rules. */
  function newFiles(input: NewUserAgent): UserCardFiles {
    const given = input as Partial<Record<keyof NewUserAgent, unknown>>;
    checkText(typeof given.name === 'string' ? given.name.toUpperCase() : given.name, 'the name');
    checkText(given.description, 'the description');
    checkText(given.prompt, 'the prompt');
    return cardFiles(input, 'page', '');
  }

  function cardFiles(input: NewUserAgent, origin: UserCardOrigin, header: string): UserCardFiles {
    try {
      return userCard(input, { origin, header });
    } catch (error) {
      if (error instanceof AgentCardError) throw new UserAgentError('invalid', error.message);
      throw error;
    }
  }

  /** The files of an edit: what is not sent stays as it is; the permissions are chosen again within the list. */
  function editFiles(name: string, edit: UserAgentEdit): { state: UserAgentState; files: UserCardFiles; before: CardSummary; basis: string } {
    const { state, agent } = find(name);
    const text = cardText(dirOf(state), name);
    const origin = userCardOrigin(text);
    // The prompt of a card of a third party is the role as adopted, at L0: a text of the user there would pass for L0 (D-079).
    if (origin === 'agency' && edit.prompt !== undefined && edit.prompt !== agent.prompt) {
      throw new UserAgentError('invalid', 'the prompt of a role of the catalog is read only: it changes only by adopting the role again');
    }
    checkText(edit.description, 'the description');
    if (origin !== 'agency') checkText(edit.prompt, 'the prompt');
    // Never fails: a card outside the list is refused when read.
    const current = checkUserPermissions(agent.card, origin);
    const files = cardFiles(
      {
        name,
        description: (edit.description ?? agent.card.description) as string,
        prompt: (edit.prompt ?? agent.prompt) as string,
        permissions: edit.permissions ?? current,
      },
      origin,
      text,
    );
    return { state, files, before: summary(agent), basis: digest(text) };
  }
  /** A free name for a role's card: its slug, cut to the length of a name, numbered when taken; empty when none is free. */
  /** A free name for a role's card: its slug, cut to the length of a name, numbered when taken. */
  function suggestedName(slug: string): string {
    const base = slug.slice(0, 40).replace(/-+$/, '');
    if (USER_AGENT_NAME.test(base) && !taken(base)) return base;
    for (let n = 2; n < 100; n += 1) {
      const suffix = `-${String(n)}`;
      const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
      if (USER_AGENT_NAME.test(candidate) && !taken(candidate)) return candidate;
    }
    return '';
  }

  /**
   * The card of a role: read again by the catalog from the adopted checkout
   * (sha256 checked there), framed by `proposeCard` with the permissions of
   * the starting point or the ones chosen within the list. Nothing of the
   * role's file chooses a permission, a label or a tool.
   */
  function catalogFiles(input: CatalogNewUserAgent): { files: UserCardFiles; info: CatalogProposalInfo } {
    if (options.catalog === undefined) throw new UserAgentError('not-found', 'the catalog of agents is not available');
    const from = input.from;
    if (typeof from !== 'object' || from === null || Array.isArray(from) || Object.keys(from).join() !== 'catalog') {
      throw new UserAgentError('invalid', 'from must be { catalog: "<owner>/<repo>/<slug>" }');
    }
    let role: AgentRole;
    try {
      role = options.catalog.role((from as { catalog: unknown }).catalog);
    } catch (error) {
      if (error instanceof CatalogError) throw new UserAgentError(error.code === 'not-found' ? 'not-found' : error.code === 'invalid' ? 'invalid' : 'conflict', error.message);
      throw error;
    }
    const preset = agencyPreset(role.entry.division);
    const suggested = suggestedName(role.entry.slug);
    const name = input.name === undefined || input.name === '' ? suggested : input.name;
    if (name === '') throw new UserAgentError('conflict', 'no free name for this role: write one yourself');
    if (typeof name !== 'string' || !USER_AGENT_NAME.test(name)) throw new UserAgentError('invalid', 'the name is 2-40 lowercase letters, digits and -, starting with a letter');
    checkText(name.toUpperCase(), 'the name');
    let permissions: UserPermissions | undefined;
    let proposed: { yaml: string; md: string };
    try {
      if (input.permissions !== undefined) permissions = parseUserPermissions(input.permissions);
      proposed = proposeCard(role.entry, preset, role.origin, { name, ...(permissions === undefined ? {} : { permissions }) });
    } catch (error) {
      if (error instanceof AgentCardError || error instanceof AgencyError) throw new UserAgentError('invalid', error.message);
      throw error;
    }
    const { license } = role.origin;
    return {
      files: { name, yaml: proposed.yaml, md: proposed.md },
      info: {
        id: role.id,
        source: role.source,
        page: role.origin.repository,
        commit: role.origin.commit,
        path: role.entry.path,
        name: role.entry.name,
        division: role.entry.division,
        license: license.name,
        licenseFile: license.file,
        unlicensed: !sourceLicensed(role.origin),
        preset: preset.id,
        suggestedName: suggested,
      },
    };
  }

  /** Writes a new disabled card; `wx`: a card written meanwhile is never overwritten. */
  function writeNew(files: UserCardFiles): UserAgentView {
    folders();
    const dir = dirOf('disabled');
    writeFileSync(join(dir, `${files.name}.md`), files.md, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(dir, `${files.name}.yaml`), files.yaml, { mode: 0o600, flag: 'wx' });
    return userView({ ...loadAgent(dir, files.name), origin: 'user' }, 'disabled');
  }

  /** The summary of files about to be written, read as the core will read them. */
  function summaryOf(files: UserCardFiles): CardSummary {
    const card = parseAgentCard(parseYamlText(files.yaml, `${files.name}.yaml`), files.name);
    return summary({ card, prompt: files.md, origin: 'user' });
  }

  function proposal(files: UserCardFiles, before: CardSummary | null, basis: string): AgentProposal {
    const after = summaryOf(files);
    const changes = permissionChanges(before, after);
    let confirmation: string | null = null;
    if (changes.length > 0) {
      const time = now();
      for (const [id, item] of pending) if (item.expires <= time) pending.delete(id);
      // A bound on what a page left open: the oldest goes first (a Map keeps the order of insertion).
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      confirmation = randomBytes(16).toString('hex');
      pending.set(confirmation, { name: files.name, files: digest(files.yaml, files.md), basis, expires: time + confirmMs });
    }
    const cloud = after.executors.includes('claude')
      ? { executor: 'claude' as const, briefMax: 'L1' as Label, promptLabel: after.promptLabel as Label, claudeTools: claudeToolsOf(after.tools as ToolId[]) }
      : null;
    return { name: files.name, confirmation, before, after, changes, trifecta: after.trifecta, cloud, expiresInMs: confirmMs };
  }

  /**
   * Spends a confirmation id: it must be one `prepare` returned, not expired,
   * for these exact files and this same card on disk (`basis`). Anything else
   * is a conflict: the page prepares again and shows the change anew.
   */
  function redeem(id: unknown, files: UserCardFiles, basis: string): void {
    if (typeof id !== 'string' || id === '') throw new UserAgentError('invalid', 'the change of permissions needs the confirmation of the user');
    const item = pending.get(id);
    pending.delete(id);
    if (item === undefined || item.expires <= now()) throw new UserAgentError('conflict', 'the confirmation expired or is unknown: prepare the change again');
    if (item.name !== files.name || item.files !== digest(files.yaml, files.md) || item.basis !== basis) {
      throw new UserAgentError('conflict', 'the card changed since the confirmation was shown: prepare the change again');
    }
  }

  return {
    load() {
      const { agents: active, refused } = read('active');
      for (const [name, agent] of active) agents.set(name, agent);
      return refused;
    },

    list() {
      const listing: UserAgentListing = { official: [], user: [], refused: [] };
      for (const name of [...official].sort()) {
        const agent = agents.get(name);
        if (agent !== undefined) listing.official.push(officialView(agent));
      }
      const seen = new Set<string>();
      for (const state of ['active', 'disabled'] as const) {
        const { agents: found, refused } = read(state);
        for (const agent of found.values()) {
          // The same name in both folders: the active card counts, the other is shown as refused.
          if (seen.has(agent.card.name)) listing.refused.push({ name: agent.card.name, reason: 'the same agent is also active', state });
          else listing.user.push(userView(agent, state));
          seen.add(agent.card.name);
        }
        for (const item of refused) listing.refused.push({ ...item, state });
      }
      return listing;
    },

    disabled() {
      const active = read('active').agents;
      const found = read('disabled').agents;
      for (const name of found.keys()) if (active.has(name) || official.has(name) || agents.has(name)) found.delete(name);
      return found;
    },

    sources() {
      // The roles of the catalog of agents come from their own routes (D-079); here only whether they can be used.
      const claudeTools = Object.fromEntries(USER_TOOLS.claude.map((tool) => [tool, claudeToolsOf([tool])]));
      return {
        presets: userPresets(),
        allowed: {
          executors: [...USER_EXECUTORS],
          tools: Object.fromEntries(USER_EXECUTORS.map((executor) => [executor, [...USER_TOOLS[executor]]])),
          acting: [...ACTING_TOOLS],
          limits: { ...USER_LIMITS },
          trifecta: { ...USER_TRIFECTA },
        },
        claudeTools,
        catalog: options.catalog !== undefined,
      };
    },

    prepareCreate(input) {
      const files = newFiles(input);
      if (taken(files.name)) throw new UserAgentError('conflict', `an agent named ${files.name} already exists`);
      return proposal(files, null, NEW);
    },

    create(input) {
      const files = newFiles(input);
      if (taken(files.name)) throw new UserAgentError('conflict', `an agent named ${files.name} already exists`);
      // A new card always shows its permissions first: never written without the confirmation.
      redeem(input.confirmation, files, NEW);
      return writeNew(files);
    },

    prepareFromCatalog(input) {
      const { files, info } = catalogFiles(input);
      if (taken(files.name)) throw new UserAgentError('conflict', `an agent named ${files.name} already exists: choose another name, for example ${info.suggestedName}`);
      return { ...proposal(files, null, NEW), catalog: info };
    },

    createFromCatalog(input) {
      const { files, info } = catalogFiles(input);
      if (taken(files.name)) throw new UserAgentError('conflict', `an agent named ${files.name} already exists: choose another name, for example ${info.suggestedName}`);
      // A source without a license: the user said yes to the warning (D-079); the card keeps it written.
      if (info.unlicensed && input.licenseAccepted !== true) throw new UserAgentError('invalid', 'the source of this role has no license: the user must accept the warning');
      redeem(input.confirmation, files, NEW);
      return writeNew(files);
    },

    prepareReapply(name) {
      const { state, files, basis, before, after, link } = reapplyFiles(name);
      const time = now();
      for (const [id, item] of pending) if (item.expires <= time) pending.delete(id);
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      const confirmation = randomBytes(16).toString('hex');
      pending.set(confirmation, { name, files: digest(files.yaml, files.md), basis, expires: time + confirmMs });
      const provenance = cardProvenance(cardText(dirOf(state), name));
      return {
        name,
        confirmation,
        active: state === 'active',
        from: { commit: provenance?.commit ?? '', sha256: link.sha256 },
        to: { commit: link.latest.commit, sha256: link.latest.sha256, committedAt: link.latest.committedAt },
        diff: diffLines(before, after.entry.body),
        unlicensed: !sourceLicensed(after.origin),
        expiresInMs: confirmMs,
      };
    },

    reapply(name, input) {
      const { state, files, basis, after } = reapplyFiles(name);
      if (!sourceLicensed(after.origin) && input.licenseAccepted !== true) throw new UserAgentError('invalid', 'the source of this role has no license: the user must accept the warning');
      redeem(input.confirmation, files, basis);
      try {
        // The old files first, into eliminati: the role before can always be read again. Regular files only, never through a link.
        const bin = join(options.dataDir, 'agents', 'eliminati');
        mkdirSync(bin, { recursive: true, mode: 0o700 });
        if (!lstatSync(bin).isDirectory()) throw new UserAgentError('invalid', 'data/agents/eliminati is not a folder');
        const kept = join(bin, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${name}-riadozione`);
        mkdirSync(kept, { mode: 0o700 });
        for (const file of [`${name}.md`, `${name}.yaml`]) {
          const from = join(dirOf(state), file);
          if (!lstatSync(from).isFile()) throw new UserAgentError('invalid', `${file} is not a regular file`);
          copyFileSync(from, join(kept, file), constants.COPYFILE_EXCL);
        }
        // Off until the user turns it on again (choice of the user, 2026-10-13): the new role has not been reviewed.
        if (state === 'active') {
          folders();
          move(name, dirOf('active'), dirOf('disabled'));
          agents.delete(name);
        }
        const dir = dirOf('disabled');
        // The prompt first: a stop in between leaves the old provenance, so the card still shows the update and can be adopted again.
        writeWhole(join(dir, `${name}.md`), dir, `${name}.md`, files.md);
        writeWhole(join(dir, `${name}.yaml`), dir, `${name}.yaml`, files.yaml);
        return userView({ ...loadAgent(dir, name), origin: 'user' }, 'disabled');
      } catch (error) {
        if (error instanceof UserAgentError) throw error;
        throw new UserAgentError('conflict', `${name} could not be adopted again: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    permissions(name) {
      const { state, agent } = find(name);
      return userView(agent, state);
    },

    activate(name) {
      const { state, agent } = find(name);
      if (state === 'disabled') {
        folders();
        move(name, dirOf('disabled'), dirOf('active'));
      }
      agents.set(name, agent);
      return userView(agent, 'active');
    },

    deactivate(name) {
      const { state, agent } = find(name);
      if (state === 'active') {
        folders();
        move(name, dirOf('active'), dirOf('disabled'));
      }
      agents.delete(name);
      return userView(agent, 'disabled');
    },

    promote(name, confirm) {
      if (confirm !== true) throw new UserAgentError('invalid', 'promotion needs the confirmation of the user');
      const { state, agent } = find(name);
      if (existsSync(join(officialDir, `${name}.yaml`)) || existsSync(join(officialDir, `${name}.md`))) {
        throw new UserAgentError('conflict', `agents/ already has ${name}`);
      }
      // A card written before tappa T3b has no prompt_label: written again with it, so that in agents/ its prompt stays L1.
      // Only when nothing else changes: a card of tappa T2 at L0 would rise to L1, which the user confirms from "Modifica" first.
      const dir = dirOf(state);
      const text = cardText(dir, name);
      if (!/^prompt_label:/m.test(text)) {
        const origin = userCardOrigin(text);
        const files = cardFiles({ name, description: agent.card.description, prompt: agent.prompt, permissions: checkUserPermissions(agent.card, origin) }, origin, text);
        if (permissionChanges(summary(agent), summaryOf(files)).length > 0) {
          throw new UserAgentError('conflict', `${name}: its labels change with the promotion: save it from the page with the confirmation first`);
        }
        writeWhole(join(dir, `${name}.yaml`), dir, `${name}.yaml`, files.yaml);
      }
      move(name, dirOf(state), officialDir);
      const promoted = loadAgent(officialDir, name);
      official.add(name);
      // A promoted agent is active: an official card always is.
      agents.set(name, promoted);
      return officialView(promoted);
    },

    prompt(name) {
      return find(name).agent.prompt;
    },

    prepareEdit(name, edit) {
      const { files, before, basis } = editFiles(name, edit);
      return proposal(files, before, basis);
    },

    update(name, edit) {
      const { state, files, before, basis } = editFiles(name, edit);
      // Only description or prompt: written at once. Permissions or labels: only as `prepareEdit` showed them.
      if (permissionChanges(before, summaryOf(files)).length > 0) redeem(edit.confirmation, files, basis);
      const dir = dirOf(state);
      writeWhole(join(dir, `${name}.md`), dir, `${name}.md`, files.md);
      writeWhole(join(dir, `${name}.yaml`), dir, `${name}.yaml`, files.yaml);
      const fresh = find(name);
      // An active agent reads the new texts and permissions at its next delegation.
      if (fresh.state === 'active') agents.set(name, fresh.agent);
      return userView(fresh.agent, fresh.state);
    },

    remove(name, confirm) {
      if (!USER_AGENT_NAME.test(name)) throw new UserAgentError('not-found', `no user agent ${JSON.stringify(name)}`);
      if (confirm !== name) throw new UserAgentError('invalid', 'deletion needs the name of the agent as confirmation');
      const has = (state: UserAgentState): boolean => existsSync(join(dirOf(state), `${name}.yaml`)) || existsSync(join(dirOf(state), `${name}.md`));
      if (has('active')) throw new UserAgentError('conflict', `deactivate ${name} before deleting it`);
      // Also a card shown as refused: what is wrong with it does not keep it there.
      if (!has('disabled')) throw new UserAgentError('not-found', `no disabled agent ${JSON.stringify(name)}`);
      const bin = join(options.dataDir, 'agents', 'eliminati');
      mkdirSync(bin, { recursive: true, mode: 0o700 });
      if (!lstatSync(bin).isDirectory()) throw new UserAgentError('invalid', 'data/agents/eliminati is not a folder');
      const folder = `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`;
      const to = join(bin, folder);
      mkdirSync(to, { mode: 0o700 });
      for (const file of [`${name}.md`, `${name}.yaml`]) {
        const from = join(dirOf('disabled'), file);
        if (!existsSync(from) && !isLink(from)) continue;
        // A link is moved as a link (rename), never copied through to what it points at.
        if (isLink(from)) renameSync(from, join(to, file));
        else moveFile(from, join(to, file));
      }
      return { name, folder: `data/agents/eliminati/${folder}` };
    },

    demote(name, confirm) {
      if (confirm !== true) throw new UserAgentError('invalid', 'taking back a promotion needs the confirmation of the user');
      if (!official.has(name) || !USER_AGENT_NAME.test(name)) throw new UserAgentError('not-found', `no official agent ${JSON.stringify(name)}`);
      // Only a card the page wrote: Arianna, the Coder and any card written by hand stay where they are.
      if (!fromPage(name)) throw new UserAgentError('invalid', `${name} was not created from the Agents page`);
      let agent: LoadedAgent;
      try {
        agent = loadAgent(officialDir, name);
        checkUserPermissions(agent.card, 'page');
      } catch (error) {
        // Changed by hand after the promotion: it would be refused among the user's cards.
        if (error instanceof AgentCardError) throw new UserAgentError('invalid', error.message);
        throw error;
      }
      if ((['disabled', 'active'] as const).some((state) => existsSync(join(dirOf(state), `${name}.yaml`)) || existsSync(join(dirOf(state), `${name}.md`)))) {
        throw new UserAgentError('conflict', `data/agents already has ${name}`);
      }
      folders();
      move(name, officialDir, dirOf('disabled'));
      official.delete(name);
      agents.delete(name);
      return userView({ ...agent, origin: 'user' }, 'disabled');
    },
  };
}
