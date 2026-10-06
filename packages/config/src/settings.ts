// The editable form of arianna.toml (task 1.18): what the wizard reads, changes
// and writes back, comments included. `config/arianna.example.toml` is
// `renderSettings(DEFAULT_SETTINGS)`, and a test keeps the two identical.
import { isDeepStrictEqual } from 'node:util';

import { parse as parseToml } from 'smol-toml';

import type { AgentsSettings } from './agents.ts';
import { MODEL_ROLES, type ModelCatalog, type ModelRole } from './catalog.ts';
import { CLOUD_MODELS, defaultCloudModels, type CloudExecutor, type CloudModel, type CloudModelSetting } from './cloud.ts';
import { DATA_DIR, DEFAULT_SERVER, parseConfig, type InstallationMode } from './config.ts';
import type { Personas } from './personas.ts';
import type { ProjectLabel } from './projects.ts';
import type { Roles } from './roles.ts';
import { DEFAULT_LEAVE_AFTER } from './participants.ts';
import { DEFAULT_SPRITE_MODEL, type SpriteModel } from './sprites.ts';
import { asTable } from './validate.ts';
import { DEFAULT_VOICE, VAPID_PRIVATE_KEY_REF, type VoiceConfig } from './voice.ts';

export interface EndpointSettings {
  id: string;
  url: string;
  command?: string[];
  /** Absent: the names come from `[roles]`. */
  models?: Record<string, string>;
}

export interface ProjectSettings {
  name: string;
  path: string;
  label: ProjectLabel;
}

export interface Settings {
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password?: string;
    appPassword?: string;
  };
  server: { host: string; port: number };
  roles: Roles;
  endpoints: EndpointSettings[];
  cloud: {
    executors: CloudExecutor[];
    /** `[cloud.models]` (D-071); absent, every alias on under its own name. */
    models?: Record<CloudModel, CloudModelSetting>;
  };
  /** As written in the file: `path` keeps its form. */
  projects: ProjectSettings[];
  /** Agent → "<pack>/<character>" (D-060). */
  characters: Record<string, string>;
  /** `[personas.<agent>]` (D-107); absent or empty, every agent has the defaults. */
  personas?: Personas;
  /** `[agents.<id>]` (D-116); absent or empty, the router chooses for every agent. */
  agents?: AgentsSettings;
  /** `[sprites] model` (D-123); absent, Claude Opus draws the characters (D-132). */
  sprites?: SpriteModel;
  /** `[participants] leave_after` (I-8, D-130); absent, ten. */
  leaveAfter?: number;
  telegram?: { token: string; chats: number[] };
  /** Calls (D-066): written with every key, defaults included. */
  voice?: VoiceConfig;
  /** `[installation]` (D-089): kept as written; the wizard does not ask for it. */
  installation?: { mode: InstallationMode };
}

export const DEFAULT_SETTINGS: Settings = {
  database: { host: '127.0.0.1', port: 54329, name: 'arianna', user: 'arianna' },
  server: { ...DEFAULT_SERVER },
  roles: {},
  endpoints: [],
  cloud: { executors: [] },
  projects: [],
  characters: {},
};

/** Token reference of the Telegram bot (key `telegram-bot-token` in the vault). */
export const TELEGRAM_TOKEN_REF = 'vault://telegram-bot-token';

/**
 * Validates `text` exactly as `loadConfig` does, then returns it in editable
 * form: an endpoint keeps `models` only when the file lists them.
 */
export function readSettings(text: string, home: string, catalog: ModelCatalog, userHome?: string): Settings {
  const config = parseConfig(text, home, catalog, userHome);
  const raw = asTable(parseToml(text), 'arianna.toml');
  const local = raw.local === undefined ? {} : asTable(raw.local, 'local');
  const rawEndpoints = Array.isArray(local.endpoints) ? (local.endpoints as unknown[]) : [];
  const { password, appPassword } = config.database;
  return {
    database: {
      host: config.database.host,
      port: config.database.port,
      name: config.database.name,
      user: config.database.user,
      ...(password === undefined ? {} : { password }),
      ...(appPassword === undefined ? {} : { appPassword }),
    },
    server: { ...config.server },
    roles: { ...config.roles },
    endpoints: config.local.endpoints.map((endpoint, index) => {
      const explicit = asTable(rawEndpoints[index], 'local.endpoints').models !== undefined;
      return {
        id: endpoint.id,
        url: endpoint.url,
        ...(endpoint.command === undefined ? {} : { command: [...endpoint.command] }),
        ...(explicit ? { models: { ...endpoint.models } } : {}),
      };
    }),
    cloud: {
      executors: [...config.cloud.executors],
      // Absent means every alias on under its own name: kept absent, as written.
      ...(isDeepStrictEqual(config.cloud.models, defaultCloudModels()) ? {} : { models: structuredClone(config.cloud.models) }),
    },
    projects: config.projects.map(({ name, path, label }) => ({ name, path, label })),
    characters: { ...config.characters },
    ...(Object.keys(config.personas).length === 0 ? {} : { personas: structuredClone(config.personas) }),
    // The `default` of [cloud.models] comes back here, as the Coder's model: the file is written in the new form.
    ...(Object.keys(config.agents).length === 0 ? {} : { agents: structuredClone(config.agents) }),
    // Absent when the file has no [sprites]: the default is not written in.
    ...(raw.sprites === undefined ? {} : { sprites: config.sprites.model }),
    ...(raw.participants === undefined ? {} : { leaveAfter: config.participants.leaveAfter }),
    ...(config.telegram === undefined ? {} : { telegram: { token: config.telegram.token, chats: [...config.telegram.chats] } }),
    ...(config.voice === undefined ? {} : { voice: structuredClone(config.voice) }),
    ...(config.installation === undefined ? {} : { installation: { ...config.installation } }),
  };
}

/** A TOML basic string: JSON escapes are a subset of TOML's; TOML also forbids a raw DEL. */
function str(value: string): string {
  return JSON.stringify(value).replaceAll('\x7f', '\\u007f');
}

function list(values: readonly (string | number)[]): string {
  return `[${values.map((value) => (typeof value === 'number' ? String(value) : str(value))).join(', ')}]`;
}

function inlineTable(record: Record<string, string>): string {
  return `{ ${Object.entries(record).map(([key, value]) => `${str(key)} = ${str(value)}`).join(', ')} }`;
}

function rolesSection(roles: Roles): string[] {
  const lines = MODEL_ROLES.map((role: ModelRole) =>
    roles[role] === undefined ? `# ${role} = "<catalog id>"` : `${role} = ${str(roles[role])}`,
  );
  return ['[roles]', ...lines];
}

function endpointSection(endpoint: EndpointSettings): string[] {
  return [
    '[[local.endpoints]]',
    `id = ${str(endpoint.id)}`,
    `url = ${str(endpoint.url)}`,
    ...(endpoint.command === undefined ? [] : [`command = ${list(endpoint.command)}`]),
    ...(endpoint.models === undefined ? [] : [`models = ${inlineTable(endpoint.models)}`]),
  ];
}

function cloudModelsSection(cloud: Settings['cloud']): string[] {
  const models = cloud.models ?? defaultCloudModels();
  const value = ({ enabled, name }: CloudModelSetting): string => (!enabled ? 'false' : name === undefined ? 'true' : str(name));
  return [
    '[cloud.models]',
    ...CLOUD_MODELS.map((model) => `${model} = ${value(models[model])}`),
  ];
}

/** `[personas.<agent>]`: every field, the display name and the text only when set. */
function personasSection(personas: Personas | undefined): string[] {
  if (personas === undefined || Object.keys(personas).length === 0) {
    return [
      '#',
      '# [personas.coder]',
      '# tone = "asciutto"',
      '# address = "tu"',
      '# display_name = "Dario"',
      '# traits = "Preciso e calmo."',
      '# specialization = "Sviluppatore senior TypeScript, attento ai test."',
    ];
  }
  return Object.entries(personas).flatMap(([agent, persona], index) => [
    ...(index === 0 ? [] : ['']),
    `[personas.${agent}]`,
    `tone = ${str(persona.tone)}`,
    `address = ${str(persona.address)}`,
    ...(persona.displayName === undefined ? [] : [`display_name = ${str(persona.displayName)}`]),
    ...(persona.traits === undefined ? [] : [`traits = ${str(persona.traits)}`]),
    ...(persona.specialization === undefined ? [] : [`specialization = ${str(persona.specialization)}`]),
  ]);
}

/** `[agents.<id>]`: only the agents with a model. */
function agentsSection(agents: AgentsSettings | undefined): string[] {
  const chosen = Object.entries(agents ?? {}).filter((entry): entry is [string, Required<AgentsSettings[string]>] => entry[1].model !== undefined);
  if (chosen.length === 0) return ['#', '# [agents.coder]', '# model = "sonnet"'];
  return chosen.flatMap(([agent, { model }], index) => [...(index === 0 ? [] : ['']), `[agents.${agent}]`, `model = ${str(model)}`]);
}

function voiceSection(voice: VoiceConfig | undefined): string[] {
  if (voice === undefined) {
    const { limits, outgoing } = DEFAULT_VOICE;
    return [
      '#',
      '# [voice]',
      `# port = ${String(DEFAULT_VOICE.port)}`,
      `# voice = ${str(DEFAULT_VOICE.voice)}`,
      '#',
      '# [voice.limits]',
      `# call_minutes = ${String(limits.callMinutes)}`,
      `# warn_seconds = ${String(limits.warnSeconds)}`,
      `# delegations = ${String(limits.delegations)}`,
      `# delegation_seconds = ${String(limits.delegationSeconds)}`,
      '#',
      '# [voice.outgoing]',
      `# max_per_day = ${String(outgoing.maxPerDay)}`,
      `# quiet_from = ${str(outgoing.quietFrom)}`,
      `# quiet_to = ${str(outgoing.quietTo)}`,
      `# quiet_weekend = ${String(outgoing.quietWeekend)}`,
      `# ring_seconds = ${String(outgoing.ringSeconds)}`,
      `# waiting_minutes = ${String(outgoing.waitingMinutes)}`,
      '#',
      '# [voice.push]',
      '# public_key = "<pnpm voice:vapid>"',
      `# private_key = ${str(VAPID_PRIVATE_KEY_REF)}`,
      '# subject = "mailto:you@example.org"',
    ];
  }
  const { limits, outgoing, push } = voice;
  return [
    '[voice]',
    `port = ${String(voice.port)}`,
    `voice = ${str(voice.voice)}`,
    '',
    '[voice.limits]',
    `call_minutes = ${String(limits.callMinutes)}`,
    `warn_seconds = ${String(limits.warnSeconds)}`,
    `delegations = ${String(limits.delegations)}`,
    `delegation_seconds = ${String(limits.delegationSeconds)}`,
    '',
    '[voice.outgoing]',
    `max_per_day = ${String(outgoing.maxPerDay)}`,
    `quiet_from = ${str(outgoing.quietFrom)}`,
    `quiet_to = ${str(outgoing.quietTo)}`,
    `quiet_weekend = ${String(outgoing.quietWeekend)}`,
    `ring_seconds = ${String(outgoing.ringSeconds)}`,
    `waiting_minutes = ${String(outgoing.waitingMinutes)}`,
    ...(push === undefined
      ? []
      : ['', '[voice.push]', `public_key = ${str(push.publicKey)}`, `private_key = ${str(push.privateKey)}`, `subject = ${str(push.subject)}`]),
  ];
}

/** Writes the whole file, with the comments that explain each section. */
export function renderSettings(settings: Settings): string {
  const { database, server, cloud, telegram } = settings;
  const lines = [
    '# Arianna configuration of this installation, written by pnpm arianna:init and',
    '# kept out of git; the repository carries config/arianna.example.toml. No secrets',
    '# in this file (docs/INSTALLER-PORTABILITY.md). Every path is relative to',
    '# ARIANNA_HOME, except the projects under your home; absolute paths are',
    '# rejected.',
    '',
    '[paths]',
    '# Models, databases, archive, real knowledge base, vault. Never in git.',
    `data = ${str(DATA_DIR)}`,
    '',
    '[database]',
    '# PostgreSQL in Docker, reachable only from this machine. `user` owns the',
    '# schema and only migrates; the core works as arianna_app (D-046). Without',
    '# `password` and `app_password` the development defaults apply, for fake data',
    '# only: before real data set both as vault references (two different secrets)',
    '# and run pnpm arianna:doctor. Steps in docs/SECURITY.md.',
    `host = ${str(database.host)}`,
    `port = ${String(database.port)}`,
    `name = ${str(database.name)}`,
    `user = ${str(database.user)}`,
    database.password === undefined ? '# password = "vault://db-owner-password"' : `password = ${str(database.password)}`,
    database.appPassword === undefined
      ? '# app_password = "vault://db-app-password"'
      : `app_password = ${str(database.appPassword)}`,
    '',
    '# Local models by role (task 1.18): ids of config/models.catalog.yaml, which',
    '# pnpm arianna:install downloads into data/models/<id>/. The orchestrator is',
    '# the router alias local-large, the extractor local-small. A change here',
    '# applies to the running core without a restart.',
    ...rolesSection(settings.roles),
    '',
    '# Local inference (task 1.3): OpenAI-compatible servers on this machine only,',
    '# because requests carry L2 data in clear. Endpoints in order of preference:',
    '# the first is the main one, the others are fallbacks. `command` is optional:',
    '# with it the core starts the server, restarts it when it fails and stops it',
    '# with itself (D-071), and adopts one already running; without it, it only',
    '# monitors. The log is data/<id>.log. A change of `url` or `command`',
    '# restarts that server without restarting the core. No secret in `command`:',
    '# the settings page of the web chat shows it.',
    '# The server is oMLX (github.com/jundot/omlx). Relative paths in `command` are',
    '# relative to ARIANNA_HOME. Without `models` the names come from [roles]: the',
    '# catalog id is the folder in data/models, the name oMLX serves. A server',
    '# with other names lists them, e.g. models = { "local-large" = "<name>" }.',
    '# Port 8000 may be taken by another container: 7001 is the suggestion. Do not',
    '# also run oMLX as a Homebrew service: the watchdog would only adopt it,',
    '# without being able to restart it.',
    ...(settings.endpoints.length === 0
      ? [
          '#',
          '# [[local.endpoints]]',
          '# id = "omlx"',
          '# url = "http://127.0.0.1:7001/v1"',
          '# command = ["omlx", "serve", "--model-dir", "data/models", "--host", "127.0.0.1", "--port", "7001", "--paged-ssd-cache-dir", "data/omlx-cache", "--paged-ssd-cache-max-size", "10GB"]',
        ]
      : settings.endpoints.flatMap((endpoint, index) => [...(index === 0 ? [] : ['']), ...endpointSection(endpoint)])),
    '',
    '# Cloud executors (tasks 1.5, 1.6). `executors` lists the ones the user',
    '# enabled ("claude", "codex"); their login stays manual. A privacy setting:',
    '# only the user edits it, never an agent. It applies without a restart (a',
    '# delegation already started finishes); an invalid file closes it until it',
    '# is valid again.',
    '[cloud]',
    `executors = ${list(cloud.executors)}`,
    '',
    '# Cloud models (D-071): which model of an enabled executor runs. Per alias',
    '# true (on), false (off: never chosen by the router nor offered by the chat)',
    '# or the exact name to pass to --model (on), e.g. opus = "claude-opus-5-5";',
    '# true means the alias, the newest model for the binary. Which model an',
    '# agent starts with is in [agents]. Not a privacy setting: it never turns',
    '# an executor on. Codex applies with its adapter (task 1.16). Applies',
    '# without a restart.',
    ...cloudModelsSection(cloud),
    '',
    '# Projects (D-058): the folders a cloud executor may work on, as the user',
    '# does with the CLI. `path` is ~/<folder> under your home (never the home',
    '# itself, hidden folders, Library or Arianna) or repos/<name> for a folder',
    '# inside Arianna; it must be the top of a git repository. `label` is L0 or',
    '# L1 (default L1): every file of the project goes to the cloud with it. The',
    '# wizard links repos/<name> to each folder under your home, as a shortcut:',
    '# the executor always uses `path`. A privacy setting: only the user edits',
    '# it, never an agent; it applies without a restart.',
    ...(settings.projects.length === 0
      ? ['#', '# [[project]]', '# name = "site"', '# path = "~/Projects/site"', '# label = "L1"']
      : settings.projects.flatMap((project, index) => [
          ...(index === 0 ? [] : ['']),
          '[[project]]',
          `name = ${str(project.name)}`,
          `path = ${str(project.path)}`,
          `label = ${str(project.label)}`,
        ])),
    '',
    '# Pixel characters (D-060): agent = "<pack>/<character>". A pack is a folder',
    '# of data/characters/ you copy there by hand (PNG sheets in the format of',
    '# pixel-agents and a pack.json); "originali" is the pack in git. Without a',
    '# line, an agent wears its original. Applies without a restart.',
    ...(Object.keys(settings.characters).length === 0
      ? ['#', '# [characters]', '# arianna = "originali/arianna"', '# coder = "originali/coder"']
      : ['[characters]', ...Object.entries(settings.characters).map(([agent, choice]) => `${agent} = ${str(choice)}`)]),
    '',
    '# Personas (D-107): style and role only, never permissions; tools, labels',
    '# and approvals stay in agents/*.yaml. Per agent id: `tone` is serio,',
    '# asciutto, equilibrato (default, adds nothing), caloroso or scherzoso;',
    '# `address` is tu (default) or lei; `display_name` (1-24 letters, spaces,',
    '# apostrophe, hyphen; the id never changes; not for arianna), `traits`',
    '# (free text) and `specialization` (role and expertise, refining the role',
    '# of agents/<name>.md), at most 500 characters each. Your text is L1 by',
    '# your declaration: it reaches Claude and Codex too, so no personal data',
    '# here. Agents and tasks at L0 never read it. Without a table an agent has',
    '# the defaults: its prompt does not change. Applies without a restart; an',
    '# invalid file drops the text and keeps tone and address.',
    ...personasSection(settings.personas),
    '',
    '# Agents (D-116): `model` is the cloud model (sonnet, opus, fable, codex) a',
    '# new conversation with the agent starts with; the chat selector can change',
    '# it, and without it the router chooses. Offered only while the model is on',
    '# and the card in agents/<id>.yaml allows the cloud: never for arianna,',
    '# whose model is the orchestrator of [roles], local only. Not a privacy',
    '# setting: it never turns an executor on. Applies without a restart.',
    ...agentsSection(settings.agents),
    '',
    '# Characters drawn by a model (D-123): `model` is the one that draws the',
    '# character of an agent from its name, description, prompt and persona:',
    '# opus (default), sonnet or local (the orchestrator of [roles]). Claude',
    '# draws only while it is on in [cloud] executors and [cloud.models]; what',
    '# leaves is L1 by your declaration and passes the gateway. Not a privacy',
    '# setting: it never turns an executor on. Applies without a restart.',
    ...(settings.sprites === undefined ? ['#', '# [sprites]', `# model = ${str(DEFAULT_SPRITE_MODEL)}`] : ['[sprites]', `model = ${str(settings.sprites)}`]),
    '',
    '# Agents that leave by themselves (I-8, D-130): after `leave_after` messages',
    '# of yours with no delegation to an agent, it says goodbye and leaves the',
    '# conversation; it comes back at the next delegation. 0 means never. The',
    '# Coder never leaves by itself. Applies without a restart.',
    ...(settings.leaveAfter === undefined
      ? ['#', '# [participants]', `# leave_after = ${String(DEFAULT_LEAVE_AFTER)}`]
      : ['[participants]', `leave_after = ${String(settings.leaveAfter)}`]),
    '',
    '# API, WebSocket and web chat of the core (task 1.11). Loopback only: the',
    '# history holds L2 in clear and there is no authentication yet. Access from',
    '# the phone over the VPN comes with a proxy and authentication (task 1.13).',
    '# Like [paths] and [database], it applies at the next restart.',
    '[server]',
    `host = ${str(server.host)}`,
    `port = ${String(server.port)}`,
    '',
    '# Telegram (task 1.15, D-044): an external channel behind the gateway, at most',
    '# L1; anything above arrives as a notice pointing to the web chat. Off while',
    '# this section is absent. The token stays in the vault (pnpm vault:edit, key',
    '# telegram-bot-token); `chats` lists the ids of the private chats the bot',
    '# talks to. Changing it is a privacy setting: only the user edits it. The',
    '# bot opens or closes without a restart; an invalid file closes it.',
    ...(telegram === undefined
      ? ['#', '# [telegram]', `# token = ${str(TELEGRAM_TOKEN_REF)}`, '# chats = [123456789]']
      : ['[telegram]', `token = ${str(telegram.token)}`, `chats = ${list(telegram.chats)}`]),
    '',
    '# Calls over the internet (D-066): the web chat talks to apps/voice, which',
    '# the core starts on this port (loopback). Off while this section is absent.',
    '# The models come from [roles]: stt hears, tts speaks, voice replies. The',
    '# Python environment: pnpm voice:sync (needs uv); the weights: pnpm',
    '# arianna:models pull (--trial also the candidates of the voice trial page).',
    '# Quiet hours are local time; scheduled calls skip them and the weekend but',
    '# count in max_per_day. [voice.push] turns on Web Push: a notification',
    '# without content through Apple, Google or Mozilla when the chat is closed;',
    '# the private key stays in the vault (key vapid-private-key). Applies without',
    '# a restart, once no call is in progress.',
    ...voiceSection(settings.voice),
    '',
    '# What the web chat says this installation is (D-089): development while the',
    '# database uses the development passwords or while mode = "development";',
    '# production only with real passwords and no such line. Applies without a',
    '# restart.',
    ...(settings.installation === undefined
      ? ['#', '# [installation]', '# mode = "development"']
      : ['[installation]', `mode = ${str(settings.installation.mode)}`]),
  ];
  return `${lines.join('\n')}\n`;
}
