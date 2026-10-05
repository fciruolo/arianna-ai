import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { parsePersona, PersonaError, type Persona } from '@arianna/agents';
import {
  CLOUD_EXECUTORS,
  CLOUD_MODELS,
  CONFIG_FILE,
  DEFAULT_SPRITE_MODEL,
  DEFAULT_VOICE,
  diffConfig,
  LABELS_FILE,
  loadCatalog,
  MODEL_ROLES,
  parseConfig,
  readSettings,
  renderSettings,
  SPRITE_MODELS,
  settingsFingerprint,
  StaleSettingsError,
  TELEGRAM_TOKEN_REF,
  VAPID_PRIVATE_KEY_REF,
  writeSettings,
  type AriannaConfig,
  type CloudModel,
  type CloudModelSetting,
  type EndpointSettings,
  type ModelCatalog,
  type ModelRole,
  type ProjectSettings,
  type Settings,
  type SpriteModel,
  type VoiceConfig,
} from '@arianna/config';
import { scanText } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

/**
 * The settings page of the web chat (D-071): reads arianna.toml with its
 * fingerprint and writes it back as the wizard does (`readSettings` → change
 * → `renderSettings`, validated, renamed). The running core applies the new
 * file within a second (`watchConfig`), as after a change by hand.
 *
 * Two kinds of change. The ordinary ones (models by role, cloud models,
 * characters, `[voice]`, personas, the agents' models) are written at once.
 * An agent's model must be one its card allows (D-116): never a cloud model
 * for Arianna or for an agent without that cloud executor. The text of a
 * persona is L1 by the user's declaration (D-107): it is saved only when the
 * scanner finds nothing in it and it holds no value of the vault. The privacy ones (cloud
 * executors, Telegram, projects, local servers) take two steps: `prepare`
 * returns what changes and what may leave, with a confirmation id bound to
 * that exact file text; only `confirm` with that id, within a few minutes and
 * once, writes it. Label rules and the gateway are not here: only the file
 * changes them (docs/PRIVACY-POLICY-SPEC.md).
 *
 * Both writes are refused when the file changed since the page read it (the
 * fingerprint), and when the new text would change a section the request may
 * not touch: an ordinary save can never open an exit.
 */
export const ORDINARY_SECTIONS = ['roles', 'cloudModels', 'characters', 'voice', 'personas', 'agents', 'sprites'] as const;
export const PRIVACY_SECTIONS = ['executors', 'telegram', 'projects', 'endpoints'] as const;
type OrdinarySection = (typeof ORDINARY_SECTIONS)[number];
type PrivacySection = (typeof PRIVACY_SECTIONS)[number];
type Section = OrdinarySection | PrivacySection | 'database' | 'server';
const SECTIONS: readonly Section[] = [...ORDINARY_SECTIONS, ...PRIVACY_SECTIONS, 'database', 'server'];

/** What only a restart of the core applies; the page does not change them. */
export const RESTART_SECTIONS = ['paths', 'database', 'server'] as const;

/** How long a privacy change stays confirmable. */
export const CONFIRM_MS = 5 * 60_000;
const MAX_PENDING = 20;

export type SettingsErrorCode = 'invalid' | 'changed' | 'unreadable' | 'unknown' | 'expired';

export class SettingsError extends Error {
  override name = 'SettingsError';
  readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** An alias of `[cloud.models]` as in the file: on, off, or the exact name (on). */
type CloudModelValue = boolean | string;

/** The settings as the page sees them: no database, server or vault reference. */
export interface SettingsValues {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: { models: Record<CloudModel, CloudModelValue> };
  characters: Record<string, string>;
  /** Agent → persona (D-107), as `[personas]` holds it; an agent without one has the defaults. */
  personas: Record<string, Persona>;
  /** Agent → the model a new conversation with it starts with (D-116); absent, the router chooses. */
  agents: Record<string, { model: CloudModel }>;
  /** The model that draws a character (D-123): sonnet when the file has no [sprites]. */
  sprites: SpriteModel;
  voice: (Omit<VoiceConfig, 'push'> & { push: { publicKey: string; subject: string } | null }) | null;
  executors: string[];
  telegram: { chats: number[] } | null;
  projects: ProjectSettings[];
  endpoints: EndpointSettings[];
}

export interface CatalogModel {
  id: string;
  family: string;
  runtime: string;
  ramMinGib: number;
  roles: ModelRole[];
  status: string;
  /** Every file in data/models/<id> with its size. */
  present: boolean;
}

export interface SettingsView {
  /** sha256 of the file read; sent back with every change. */
  fingerprint: string | null;
  /** Null when the file cannot be read; `error` says why (key and rule, never a value). */
  values: SettingsValues | null;
  error: string | null;
  ordinary: readonly string[];
  privacy: readonly string[];
  /** Never changed here: only the file and a restart. */
  restartOnly: readonly string[];
  /** Changed in the file, waiting for a restart of the core. */
  restartPending: string[];
  catalog: CatalogModel[];
  /** config/labels.toml as written, for reading only. */
  labels: string | null;
  /** What `[voice]` holds when the page turns it on. */
  voiceDefaults: NonNullable<SettingsValues['voice']>;
  /** Agent → the cloud models its card allows as its model, on or off (D-116); empty for Arianna. */
  agentModels: Record<string, CloudModel[]>;
}

/** What a privacy change would change, section by section. */
export interface PrivacyChanges {
  executors?: { before: string[]; after: string[] };
  telegram?: { before: { chats: number[] } | null; after: { chats: number[] } | null };
  projects?: { added: ProjectSettings[]; removed: ProjectSettings[]; changed: { name: string; before: ProjectSettings; after: ProjectSettings }[] };
  endpoints?: { added: EndpointSettings[]; removed: EndpointSettings[]; changed: { id: string; before: EndpointSettings; after: EndpointSettings }[] };
}

/** After the change: who may receive what. */
export interface PrivacyExits {
  /** Cloud executors on; each may receive the projects below, and L0-L1 texts through the gateway. */
  executors: string[];
  projects: { name: string; label: string }[];
  /** Telegram on, at most L1 (D-044): the number of chats. */
  telegram: { chats: number } | null;
  /** Local servers: they see L2 in clear, and with `command` the core runs that program. */
  endpoints: { id: string; url: string; command: string[] | null }[];
}

export interface PrivacyProposal {
  id: string;
  expiresAt: string;
  sections: PrivacySection[];
  changes: PrivacyChanges;
  exits: PrivacyExits;
}

export interface SettingsChange {
  /** Section names only, never values. */
  sections: string[];
  privacy: boolean;
  /** The confirmation id, for a privacy change. */
  confirmation?: string;
}

export interface SettingsPageOptions {
  /** ARIANNA_HOME. */
  home: string;
  /** For `~/` of the projects: the same home the core read the file with. */
  userHome: string;
  /** data/: the models are in data/models. */
  dataDir: string;
  /** The configuration in use (`settings.current()`). */
  running: () => AriannaConfig;
  /** Agent → the cloud models its card allows (D-116): `[agents]` names only these agents and models. */
  agentModels: () => Record<string, readonly CloudModel[]>;
  /** After each write, for the event log. */
  onChanged?: (change: SettingsChange) => void;
  now?: () => number;
  confirmMs?: number;
}

export interface SettingsPage {
  read(): SettingsView;
  /** `{ fingerprint, values: { roles?, cloudModels?, characters?, voice?, personas?, agents?, sprites? } }`. */
  update(body: Record<string, unknown>): SettingsView;
  /** `{ fingerprint, values: { executors?, telegram?, projects?, endpoints? } }`. */
  prepare(body: Record<string, unknown>): PrivacyProposal;
  /** `{ id }`. */
  confirm(body: Record<string, unknown>): SettingsView;
}

// --- Input checks: strict shapes before rendering; the file's rules come after, from parseConfig.

function invalid(message: string): never {
  throw new SettingsError('invalid', message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) invalid(`${where}: unknown field(s) ${unknown.join(', ')}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') invalid(`${where} must be a string`);
  return value;
}

function integer(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(`${where} must be an integer`);
  return value;
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) invalid(`${where} must be a list`);
  return value.map((item, index) => text(item, `${where}[${String(index)}]`));
}

function stringRecord(value: unknown, where: string, key?: RegExp): Record<string, string> {
  const table = record(value, where);
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(table)) {
    // JSON.parse makes it an own key; assigned here it would be dropped without a word.
    if (name === '__proto__') invalid(`${where}: __proto__ is not a valid key`);
    if (key !== undefined && !key.test(name)) invalid(`${where}: ${JSON.stringify(name).slice(0, 80)} is not a valid key`);
    result[name] = text(item, `${where}.${name}`);
  }
  return result;
}

/** An agent id: written unquoted as a TOML key. */
const AGENT_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function rolesFromBody(value: unknown): Settings['roles'] {
  const roles = stringRecord(value, 'roles');
  only(roles, MODEL_ROLES, 'roles');
  return roles;
}

function cloudModelsFromBody(value: unknown, cloud: Settings['cloud']): Settings['cloud'] {
  const table = record(value, 'cloudModels');
  only(table, ['models'], 'cloudModels');
  const given = record(table.models, 'cloudModels.models');
  only(given, CLOUD_MODELS, 'cloudModels.models');
  const models = Object.fromEntries(
    CLOUD_MODELS.map((model): [CloudModel, CloudModelSetting] => {
      const item = given[model];
      if (item === undefined || item === true) return [model, { enabled: true }];
      if (item === false) return [model, { enabled: false }];
      return [model, { enabled: true, name: text(item, `cloudModels.models.${model}`) }];
    }),
  ) as Record<CloudModel, CloudModelSetting>;
  return { executors: cloud.executors, models };
}

/**
 * `[agents]` from the page: agent → `{ model }`, `null` for "the router
 * chooses". Only an agent with a card, and only a model the card allows:
 * Arianna, whose model is the orchestrator of `roles`, allows none. The
 * agents the page does not offer (no card) keep what the file says, and so
 * does a model the card no longer allows while it is sent back unchanged:
 * the core ignores it (agentDefaultModel), and saving the look of an agent
 * must not fail on it.
 */
function agentsFromBody(value: unknown, allowed: Record<string, readonly CloudModel[]>, current: Settings['agents']): NonNullable<Settings['agents']> {
  const table = record(value, 'agents');
  const agents: NonNullable<Settings['agents']> = {};
  for (const [agent, settings] of Object.entries(current ?? {})) {
    if (!Object.hasOwn(allowed, agent) && settings.model !== undefined) agents[agent] = { model: settings.model };
  }
  for (const [agent, raw] of Object.entries(table)) {
    if (!AGENT_KEY.test(agent)) invalid('agents: an agent id is lowercase letters, digits, - and _');
    const where = `agents.${agent}`;
    const models = Object.hasOwn(allowed, agent) ? allowed[agent] : undefined;
    if (models === undefined) invalid(`${where}: no such agent`);
    const item = record(raw, where);
    only(item, ['model'], where);
    if (item.model === null || item.model === undefined) continue;
    const unchanged = current !== undefined && Object.hasOwn(current, agent) && current[agent]?.model === item.model;
    if (!unchanged && !models.includes(item.model as CloudModel)) {
      invalid(models.length === 0 ? `${where}.model: this agent runs on local models only` : `${where}.model must be one of ${models.join(', ')} or null`);
    }
    agents[agent] = { model: item.model as CloudModel };
  }
  return agents;
}

function voiceFromBody(value: unknown, current: VoiceConfig | undefined): VoiceConfig | undefined {
  if (value === null) return undefined;
  const voice = record(value, 'voice');
  only(voice, ['port', 'voice', 'limits', 'outgoing', 'push'], 'voice');
  const limits = record(voice.limits, 'voice.limits');
  only(limits, ['callMinutes', 'warnSeconds', 'delegations', 'delegationSeconds'], 'voice.limits');
  const outgoing = record(voice.outgoing, 'voice.outgoing');
  only(outgoing, ['maxPerDay', 'quietFrom', 'quietTo', 'quietWeekend', 'ringSeconds', 'waitingMinutes'], 'voice.outgoing');
  if (typeof outgoing.quietWeekend !== 'boolean') invalid('voice.outgoing.quietWeekend must be true or false');
  const next: VoiceConfig = {
    port: integer(voice.port, 'voice.port'),
    voice: text(voice.voice, 'voice.voice'),
    limits: {
      callMinutes: integer(limits.callMinutes, 'voice.limits.callMinutes'),
      warnSeconds: integer(limits.warnSeconds, 'voice.limits.warnSeconds'),
      delegations: integer(limits.delegations, 'voice.limits.delegations'),
      delegationSeconds: integer(limits.delegationSeconds, 'voice.limits.delegationSeconds'),
    },
    outgoing: {
      maxPerDay: integer(outgoing.maxPerDay, 'voice.outgoing.maxPerDay'),
      quietFrom: text(outgoing.quietFrom, 'voice.outgoing.quietFrom'),
      quietTo: text(outgoing.quietTo, 'voice.outgoing.quietTo'),
      quietWeekend: outgoing.quietWeekend,
      ringSeconds: integer(outgoing.ringSeconds, 'voice.outgoing.ringSeconds'),
      waitingMinutes: integer(outgoing.waitingMinutes, 'voice.outgoing.waitingMinutes'),
    },
  };
  if (voice.push !== undefined && voice.push !== null) {
    const push = record(voice.push, 'voice.push');
    only(push, ['publicKey', 'subject'], 'voice.push');
    // The private key is a vault reference the page never sees: kept, or the usual one.
    next.push = {
      publicKey: text(push.publicKey, 'voice.push.publicKey'),
      privateKey: current?.push?.privateKey ?? VAPID_PRIVATE_KEY_REF,
      subject: text(push.subject, 'voice.push.subject'),
    };
  }
  return next;
}

const PERSONA_FIELDS = ['tone', 'address', 'displayName', 'traits', 'specialization'] as const;
const PERSONA_TEXTS = [
  ['displayName', 'display_name'],
  ['traits', 'traits'],
  ['specialization', 'specialization'],
] as const;

/**
 * `[personas]` from the page: agent → `{ tone, address, displayName?, traits?,
 * specialization? }` (null or empty is none), checked by `parsePersona` as the
 * file is. The user's text is L1 by declaration and reaches the cloud: a
 * finding of the scanner or a value of the vault refuses it, naming the field
 * and the kind, never the text.
 */
function personasFromBody(value: unknown): NonNullable<Settings['personas']> {
  const table = record(value, 'personas');
  const personas: NonNullable<Settings['personas']> = {};
  for (const [agent, item] of Object.entries(table)) {
    // AGENT_KEY already refuses `__proto__`; the key is text from the page, never repeated.
    if (!AGENT_KEY.test(agent)) invalid('personas: an agent id is lowercase letters, digits, - and _');
    const where = `personas.${agent}`;
    const given = record(item, where);
    only(given, PERSONA_FIELDS, where);
    const raw: Record<string, unknown> = {};
    if (given.tone !== undefined) raw.tone = given.tone;
    if (given.address !== undefined) raw.address = given.address;
    for (const [field, key] of PERSONA_TEXTS) {
      const text = given[field];
      if (text === undefined || text === null || text === '') continue;
      if (typeof text === 'string') {
        const kinds = [...new Set(scanText(text).map((finding) => finding.kind))];
        if (kinds.length > 0) invalid(`${where}.${field} looks like personal data or a secret (${kinds.join(', ')}): not saved`);
        if (knownSecrets.find(text).length > 0) invalid(`${where}.${field} holds a value of the vault: not saved`);
      }
      raw[key] = text;
    }
    try {
      personas[agent] = parsePersona(raw, where);
    } catch (error) {
      // The message names the field, never the text.
      if (error instanceof PersonaError) invalid(error.message);
      throw error;
    }
  }
  return personas;
}

function executorsFromBody(value: unknown): Settings['cloud']['executors'] {
  const executors = strings(value, 'executors');
  for (const executor of executors) {
    if (!CLOUD_EXECUTORS.includes(executor as (typeof CLOUD_EXECUTORS)[number])) invalid(`executors: ${JSON.stringify(executor).slice(0, 40)} is not one of ${CLOUD_EXECUTORS.join(', ')}`);
  }
  return executors as Settings['cloud']['executors'];
}

function telegramFromBody(value: unknown, current: Settings['telegram']): Settings['telegram'] {
  if (value === null) return undefined;
  const telegram = record(value, 'telegram');
  only(telegram, ['chats'], 'telegram');
  if (!Array.isArray(telegram.chats)) invalid('telegram.chats must be a list');
  const chats = telegram.chats.map((chat, index) => integer(chat, `telegram.chats[${String(index)}]`));
  // The token is a vault reference the page never sees.
  return { token: current?.token ?? TELEGRAM_TOKEN_REF, chats };
}

function projectsFromBody(value: unknown): ProjectSettings[] {
  if (!Array.isArray(value)) invalid('projects must be a list');
  return value.map((item, index) => {
    const where = `projects[${String(index)}]`;
    const project = record(item, where);
    only(project, ['name', 'path', 'label'], where);
    const label = text(project.label, `${where}.label`);
    if (label !== 'L0' && label !== 'L1') invalid(`${where}.label must be L0 or L1`);
    return { name: text(project.name, `${where}.name`), path: text(project.path, `${where}.path`), label };
  });
}

function endpointsFromBody(value: unknown): EndpointSettings[] {
  if (!Array.isArray(value)) invalid('endpoints must be a list');
  return value.map((item, index) => {
    const where = `endpoints[${String(index)}]`;
    const endpoint = record(item, where);
    only(endpoint, ['id', 'url', 'command', 'models'], where);
    const next: EndpointSettings = { id: text(endpoint.id, `${where}.id`), url: text(endpoint.url, `${where}.url`) };
    if (endpoint.command !== undefined && endpoint.command !== null) next.command = strings(endpoint.command, `${where}.command`);
    if (endpoint.models !== undefined && endpoint.models !== null) next.models = stringRecord(endpoint.models, `${where}.models`);
    return next;
  });
}

// --- Views.

function cloudModelsOf(cloud: Settings['cloud']): SettingsValues['cloudModels'] {
  const models = Object.fromEntries(
    CLOUD_MODELS.map((model): [CloudModel, CloudModelValue] => {
      const setting = cloud.models?.[model] ?? { enabled: true };
      return [model, !setting.enabled ? false : (setting.name ?? true)];
    }),
  ) as Record<CloudModel, CloudModelValue>;
  return { models };
}

/** The agents with a model, as compared and shown. */
function agentsOf(settings: Settings): SettingsValues['agents'] {
  const agents: SettingsValues['agents'] = {};
  for (const [agent, { model }] of Object.entries(settings.agents ?? {})) if (model !== undefined) agents[agent] = { model };
  return agents;
}

function voiceOf(voice: VoiceConfig | undefined): SettingsValues['voice'] {
  if (voice === undefined) return null;
  const { push, ...rest } = structuredClone(voice);
  return { ...rest, push: push === undefined ? null : { publicKey: push.publicKey, subject: push.subject } };
}

export function valuesOf(settings: Settings): SettingsValues {
  return {
    roles: { ...settings.roles },
    cloudModels: cloudModelsOf(settings.cloud),
    characters: { ...settings.characters },
    personas: structuredClone(settings.personas ?? {}),
    agents: agentsOf(settings),
    sprites: settings.sprites ?? DEFAULT_SPRITE_MODEL,
    voice: voiceOf(settings.voice),
    executors: [...settings.cloud.executors],
    telegram: settings.telegram === undefined ? null : { chats: [...settings.telegram.chats] },
    projects: settings.projects.map((project) => ({ ...project })),
    endpoints: structuredClone(settings.endpoints),
  };
}

/** One section of the settings, as compared: vault references included. */
function sectionOf(settings: Settings, section: Section): unknown {
  switch (section) {
    case 'cloudModels':
      return cloudModelsOf(settings.cloud);
    case 'agents':
      return agentsOf(settings);
    case 'sprites':
      return settings.sprites ?? DEFAULT_SPRITE_MODEL;
    case 'executors':
      return settings.cloud.executors;
    case 'database':
    case 'server':
    case 'roles':
    case 'characters':
    case 'personas':
    case 'voice':
    case 'telegram':
    case 'projects':
    case 'endpoints':
      return settings[section];
  }
}

export function changedSections(before: Settings, after: Settings): Section[] {
  return SECTIONS.filter((section) => !isDeepStrictEqual(sectionOf(before, section), sectionOf(after, section)));
}

function listDiff<T>(before: readonly T[], after: readonly T[], key: (item: T) => string): { added: T[]; removed: T[]; changed: { key: string; before: T; after: T }[] } {
  const old = new Map(before.map((item) => [key(item), item]));
  const now = new Map(after.map((item) => [key(item), item]));
  return {
    added: after.filter((item) => !old.has(key(item))),
    removed: before.filter((item) => !now.has(key(item))),
    changed: after.flatMap((item) => {
      const previous = old.get(key(item));
      return previous === undefined || isDeepStrictEqual(previous, item) ? [] : [{ key: key(item), before: previous, after: item }];
    }),
  };
}

function privacyChanges(before: SettingsValues, after: SettingsValues, sections: readonly PrivacySection[]): PrivacyChanges {
  const changes: PrivacyChanges = {};
  if (sections.includes('executors')) changes.executors = { before: before.executors, after: after.executors };
  if (sections.includes('telegram')) changes.telegram = { before: before.telegram, after: after.telegram };
  if (sections.includes('projects')) {
    const { added, removed, changed } = listDiff(before.projects, after.projects, (project) => project.name);
    changes.projects = { added, removed, changed: changed.map(({ key, ...rest }) => ({ name: key, ...rest })) };
  }
  if (sections.includes('endpoints')) {
    const { added, removed, changed } = listDiff(before.endpoints, after.endpoints, (endpoint) => endpoint.id);
    changes.endpoints = { added, removed, changed: changed.map(({ key, ...rest }) => ({ id: key, ...rest })) };
  }
  return changes;
}

function exitsOf(values: SettingsValues): PrivacyExits {
  return {
    executors: values.executors,
    projects: values.projects.map(({ name, label }) => ({ name, label })),
    telegram: values.telegram === null ? null : { chats: values.telegram.chats.length },
    endpoints: values.endpoints.map(({ id, url, command }) => ({ id, url, command: command ?? null })),
  };
}

/** The message of an error that is safe to show: a ConfigError names a key and a rule, never a value. */
function configMessage(error: unknown): string | undefined {
  return error instanceof Error && error.name === 'ConfigError' ? error.message : undefined;
}

function present(dataDir: string, id: string, files: readonly { path: string; sizeBytes: number }[]): boolean {
  return files.every((file) => {
    try {
      return statSync(join(dataDir, 'models', id, file.path)).size === file.sizeBytes;
    } catch {
      return false;
    }
  });
}

interface Pending {
  /** The fingerprint of the file the change was prepared on. */
  fingerprint: string;
  /** Exactly what confirm writes: the change shown, nothing else. */
  settings: Settings;
  sections: PrivacySection[];
  expires: number;
}

export function createSettingsPage(options: SettingsPageOptions): SettingsPage {
  const now = options.now ?? Date.now;
  const confirmMs = options.confirmMs ?? CONFIRM_MS;
  const path = join(options.home, CONFIG_FILE);
  const pending = new Map<string, Pending>();

  function catalogNow(): ModelCatalog {
    try {
      return loadCatalog(options.home);
    } catch (error) {
      throw new SettingsError('unreadable', configMessage(error) ?? 'the model catalog cannot be read');
    }
  }

  function load(): { text: string; fingerprint: string; catalog: ModelCatalog } {
    if (!existsSync(path)) throw new SettingsError('unreadable', `${CONFIG_FILE} is missing: run pnpm arianna:init`);
    const text = readFileSync(path, 'utf8');
    return { text, fingerprint: settingsFingerprint(text), catalog: catalogNow() };
  }

  function parse(text: string, catalog: ModelCatalog): Settings {
    try {
      return readSettings(text, options.home, catalog, options.userHome);
    } catch (error) {
      throw new SettingsError('unreadable', configMessage(error) ?? `${CONFIG_FILE} cannot be read`);
    }
  }

  /** The file as the caller read it: a different fingerprint means someone else wrote it meanwhile. */
  function current(fingerprint: unknown): { settings: Settings; catalog: ModelCatalog; fingerprint: string } {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) invalid('fingerprint is required');
    const file = load();
    if (file.fingerprint !== fingerprint) throw new SettingsError('changed', `${CONFIG_FILE} changed since the page read it: reload`);
    return { settings: parse(file.text, file.catalog), catalog: file.catalog, fingerprint: file.fingerprint };
  }

  /** Validated exactly as the core reads it, and only `allowed` sections changed. */
  function check(before: Settings, after: Settings, catalog: ModelCatalog, allowed: readonly Section[]): Section[] {
    // What the file would hold, read back.
    let reread: Settings;
    try {
      reread = readSettings(renderSettings(after), options.home, catalog, options.userHome);
    } catch (error) {
      const message = configMessage(error);
      if (message === undefined) throw error;
      invalid(message);
    }
    const sections = changedSections(before, reread);
    const outside = sections.filter((section) => !allowed.includes(section));
    if (outside.length > 0) invalid(`this request may not change ${outside.join(', ')}`);
    return sections;
  }

  function write(settings: Settings, catalog: ModelCatalog, fingerprint: string): void {
    try {
      writeSettings(options.home, catalog, settings, { userHome: options.userHome, expected: fingerprint });
    } catch (error) {
      if (error instanceof StaleSettingsError) throw new SettingsError('changed', `${CONFIG_FILE} changed since the page read it: reload`);
      const message = configMessage(error);
      if (message === undefined) throw error;
      invalid(message);
    }
  }

  function changed(change: SettingsChange): void {
    try {
      options.onChanged?.(change);
    } catch {
      // The file is written: a broken listener does not undo it.
    }
  }

  function values(body: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
    only(body, ['fingerprint', 'values'], 'body');
    const given = record(body.values, 'values');
    only(given, allowed, 'values');
    if (Object.keys(given).length === 0) invalid('values: nothing to change');
    return given;
  }

  function read(): SettingsView {
    const base = {
      ordinary: ORDINARY_SECTIONS,
      privacy: PRIVACY_SECTIONS,
      restartOnly: RESTART_SECTIONS,
      voiceDefaults: { ...structuredClone(DEFAULT_VOICE), push: null },
      agentModels: Object.fromEntries(Object.entries(options.agentModels()).map(([agent, models]) => [agent, [...models]])),
    };
    let labels: string | null;
    try {
      labels = readFileSync(join(options.home, LABELS_FILE), 'utf8');
    } catch {
      labels = null;
    }
    const file = load();
    const catalog = file.catalog.models.map(({ id, family, runtime, ramMinGib, roles, status, files }) => ({
      id,
      family,
      runtime,
      ramMinGib,
      roles: [...roles],
      status,
      present: present(options.dataDir, id, files),
    }));
    try {
      const settings = readSettings(file.text, options.home, file.catalog, options.userHome);
      const restartPending = diffConfig(options.running(), parseConfig(file.text, options.home, file.catalog, options.userHome)).restart;
      return { ...base, fingerprint: file.fingerprint, values: valuesOf(settings), error: null, restartPending, catalog, labels };
    } catch (error) {
      const message = configMessage(error);
      if (message === undefined) throw error;
      return { ...base, fingerprint: file.fingerprint, values: null, error: message, restartPending: [], catalog, labels };
    }
  }

  return {
    read,

    update(body) {
      const given = values(body, ORDINARY_SECTIONS);
      const { settings, catalog, fingerprint } = current(body.fingerprint);
      const next: Settings = structuredClone(settings);
      if (given.roles !== undefined) next.roles = rolesFromBody(given.roles);
      if (given.cloudModels !== undefined) next.cloud = cloudModelsFromBody(given.cloudModels, settings.cloud);
      if (given.characters !== undefined) next.characters = stringRecord(given.characters, 'characters', AGENT_KEY);
      if (given.personas !== undefined) {
        const personas = personasFromBody(given.personas);
        if (Object.keys(personas).length === 0) delete next.personas;
        else next.personas = personas;
      }
      if (given.agents !== undefined) {
        const agents = agentsFromBody(given.agents, options.agentModels(), settings.agents);
        if (Object.keys(agents).length === 0) delete next.agents;
        else next.agents = agents;
      }
      if (given.sprites !== undefined) {
        if (typeof given.sprites !== 'string' || !(SPRITE_MODELS as readonly string[]).includes(given.sprites)) invalid(`sprites: one of ${SPRITE_MODELS.join(', ')}`);
        next.sprites = given.sprites as SpriteModel;
      }
      if (given.voice !== undefined) {
        const voice = voiceFromBody(given.voice, settings.voice);
        if (voice === undefined) delete next.voice;
        else next.voice = voice;
      }
      const sections = check(settings, next, catalog, ORDINARY_SECTIONS);
      if (sections.length > 0) {
        write(next, catalog, fingerprint);
        changed({ sections, privacy: false });
      }
      return read();
    },

    prepare(body) {
      const given = values(body, PRIVACY_SECTIONS);
      const { settings, catalog, fingerprint } = current(body.fingerprint);
      const next: Settings = structuredClone(settings);
      if (given.executors !== undefined) next.cloud.executors = executorsFromBody(given.executors);
      if (given.telegram !== undefined) {
        const telegram = telegramFromBody(given.telegram, settings.telegram);
        if (telegram === undefined) delete next.telegram;
        else next.telegram = telegram;
      }
      if (given.projects !== undefined) next.projects = projectsFromBody(given.projects);
      if (given.endpoints !== undefined) next.endpoints = endpointsFromBody(given.endpoints);
      const sections = check(settings, next, catalog, PRIVACY_SECTIONS);
      if (sections.length === 0) invalid('values: nothing changes');
      const privacy = sections as PrivacySection[];
      // Old proposals go first; past the cap, the oldest one.
      const at = now();
      for (const [id, entry] of pending) if (entry.expires <= at) pending.delete(id);
      while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string);
      const id = randomUUID();
      const expires = at + confirmMs;
      pending.set(id, { fingerprint, settings: next, sections: privacy, expires });
      const after = valuesOf(next);
      return {
        id,
        expiresAt: new Date(expires).toISOString(),
        sections: privacy,
        changes: privacyChanges(valuesOf(settings), after, privacy),
        exits: exitsOf(after),
      };
    },

    confirm(body) {
      only(body, ['id'], 'body');
      const id = text(body.id, 'id');
      const entry = pending.get(id);
      // Once only, whatever comes next.
      pending.delete(id);
      if (entry === undefined) throw new SettingsError('unknown', 'no such confirmation: prepare the change again');
      if (entry.expires <= now()) throw new SettingsError('expired', 'the confirmation expired: prepare the change again');
      // Written only over the file it was prepared on: what was shown is exactly what changes.
      write(entry.settings, catalogNow(), entry.fingerprint);
      changed({ sections: entry.sections, privacy: true, confirmation: id });
      return read();
    },
  };
}
