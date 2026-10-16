/**
 * The settings page (D-071): the shapes of `/api/settings` and the pure parts
 * of the page, from the values of the core to the forms and back, and the
 * Italian texts of the confirmation card. Ordinary sections are saved one
 * card at a time; privacy ones are prepared, shown, then confirmed.
 */
import { EXECUTOR_TEXT, labelWord } from './labels.ts';
import { SCAN_KINDS } from './profile.ts';
import { personasBody, type PersonaForm, type PersonaValues } from './persona.ts';
import type { Label } from './types.ts';

export const MODEL_ROLES = ['orchestrator', 'extractor', 'embedder', 'voice', 'stt', 'tts', 'pii', 'vision'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
// Claude's models, then Codex's (D-141).
export const CLOUD_MODELS = ['sonnet', 'opus', 'fable', 'luna', 'sol', 'astra'] as const;
export type CloudModelAlias = (typeof CLOUD_MODELS)[number];
export const CLOUD_EXECUTORS = ['claude', 'codex'] as const;

export interface VoiceValues {
  port: number;
  voice: string;
  limits: { callMinutes: number; warnSeconds: number; delegations: number; delegationSeconds: number };
  outgoing: { maxPerDay: number; quietFrom: string; quietTo: string; quietWeekend: boolean; ringSeconds: number; waitingMinutes: number };
  push: { publicKey: string; subject: string } | null;
}

export interface NotificationsValues {
  replies: boolean;
  approvals: boolean;
  failures: boolean;
  quiet: string | null;
}

/** D-145: the label the user gave a management folder of a project. */
export interface ProjectFolderValues {
  path: string;
  label: Label;
}

/** The days of `[secretary]`, Monday first, as the core names them. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_TEXT: Record<Weekday, string> = { mon: 'Lun', tue: 'Mar', wed: 'Mer', thu: 'Gio', fri: 'Ven', sat: 'Sab', sun: 'Dom' };

/** `[secretary]` (I-12, D-144): reminders on or off, three clocks in order, the days. */
export interface SecretaryValues {
  enabled: boolean;
  morning: string;
  afternoon: string;
  evening: string;
  days: Weekday[];
}

/** As the core reads a file without `[secretary]`: on, 9:00, 14:30, 18:30, every day (D-144). */
export const DEFAULT_SECRETARY: SecretaryValues = { enabled: true, morning: '09:00', afternoon: '14:30', evening: '18:30', days: [...WEEKDAYS] };

/** Why the Segretaria card cannot be saved, in Italian; undefined when it can. */
export function secretaryProblem(form: SecretaryValues): string | undefined {
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (![form.morning, form.afternoon, form.evening].every((value) => clock.test(value))) return 'Scrivi i tre orari.';
  if (!(form.morning < form.afternoon && form.afternoon < form.evening)) return 'Gli orari vanno in ordine: mattina, dopo pranzo, fine giornata.';
  if (form.days.length === 0) return 'Scegli almeno un giorno, o spegni i promemoria.';
  return undefined;
}

/** What the page sends: the days Monday first, once each. */
export function secretaryBody(form: SecretaryValues): SecretaryValues {
  return { enabled: form.enabled, morning: form.morning, afternoon: form.afternoon, evening: form.evening, days: WEEKDAYS.filter((day) => form.days.includes(day)) };
}

export interface ProjectValues {
  name: string;
  path: string;
  label: 'L0' | 'L1';
  /** D-145: the parts the user listed; absent, every git subfolder of the container. */
  parts?: string[];
  /** D-145: `[[project.folder]]`, written from the tab "Conoscenza" of Progetti. */
  folders?: ProjectFolderValues[];
  /** D-235: who writes the cards of a plan of the project; absent, the rule of D-164. */
  planner?: ProjectPlanner;
}

/** The values of `planner` in a `[[project]]` (D-235). */
export const PLANNERS = ['opus', 'sonnet', 'local'] as const;
export type ProjectPlanner = (typeof PLANNERS)[number];

export interface EndpointValues {
  id: string;
  url: string;
  command?: string[];
  models?: Record<string, string>;
}

/** `[project_rules]` as the core sends it (I-14, D-174): template null when there is none. */
export interface ProjectRulesValues {
  template: string | null;
  /** Project (container) name → its own rules; an empty text is "no rules". */
  projects: Record<string, string>;
}

/** The longest text of a rule set, as the core checks it. */
export const MAX_PROJECT_RULES = 4000;

/** What the page edits: the template as text, '' for none. */
export interface ProjectRulesForm {
  template: string;
  projects: Record<string, string>;
}

export function projectRulesForm(values: ProjectRulesValues | undefined): ProjectRulesForm {
  return { template: values?.template ?? '', projects: { ...(values?.projects ?? {}) } };
}

export function projectRulesBody(form: ProjectRulesForm): ProjectRulesValues {
  return { template: form.template.trim() === '' ? null : form.template, projects: { ...form.projects } };
}

/** Why the rules cannot be saved yet, or undefined. */
export function projectRulesProblem(form: ProjectRulesForm): string | undefined {
  const long = [form.template, ...Object.values(form.projects)].some((text) => text.length > MAX_PROJECT_RULES);
  return long ? `Al massimo ${String(MAX_PROJECT_RULES)} caratteri per testo.` : undefined;
}

/** `[appearance]` (D-103): the id of the theme, `base` for the chat as it comes; `seasonal` the switch of the feasts (D-246), none from an older core. */
export interface AppearanceValues {
  theme: string;
  seasonal?: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceValues = { theme: 'base', seasonal: true };

/** What the user rewrote of a person of the series (D-223): each field optional, the repository's text where absent. */
export interface SeriesValues {
  traits?: string;
  scene?: string;
  quotes?: string[];
}

export interface SettingsValues {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: { models: Record<CloudModelAlias, boolean | string> };
  characters: Record<string, string>;
  /** Agent → persona (D-107); an agent without one has the defaults. */
  personas: Record<string, PersonaValues>;
  /** Character of the pack serie → what the user rewrote (D-223). Optional: an older core sends none. */
  series?: Record<string, SeriesValues>;
  /** Agent → the model a new conversation with it starts with (D-116); absent, the router chooses. */
  agents: Record<string, { model: CloudModelAlias }>;
  /** `[project_rules]` (I-14, D-174): the common template and the projects with their own rules. Optional: an older core sends none. */
  projectRules?: ProjectRulesValues;
  /** Agent → the skills of the catalog it reads in each delivery (D-161); optional: an older core sends none. */
  skills?: Record<string, string[]>;
  /** The model that draws a character (D-123): `[sprites] model`, opus when absent (D-132). */
  sprites: 'sonnet' | 'opus' | 'local';
  /** Messages of the user before an idle agent leaves the conversation (I-8, D-130): `[participants] leave_after`; 0 never. */
  participants: number;
  voice: VoiceValues | null;
  /** `[notifications]` (I-1); `quiet` "HH:MM-HH:MM" or null. */
  notifications: NotificationsValues;
  /** `[secretary]` (I-12, D-144). Optional: a core without it sends none. */
  secretary?: SecretaryValues;
  /** `[appearance]` (D-103): the theme of the chat on every device. Optional: an older core sends none. */
  appearance?: AppearanceValues;
  executors: string[];
  telegram: { chats: number[] } | null;
  projects: ProjectValues[];
  endpoints: EndpointValues[];
  /** `[capture] fetch_sites` (D-154): sites whose links are downloaded by themselves. Optional: an older core sends none. */
  fetchSites?: string[];
}

export interface CatalogModel {
  id: string;
  family: string;
  runtime: string;
  ramMinGib: number;
  roles: ModelRole[];
  status: string;
  present: boolean;
}

export type WatchdogState = 'idle' | 'starting' | 'up' | 'down' | 'restarting' | 'failed' | 'stopped';

export interface LocalServerStatus {
  id: string;
  url: string;
  managed: boolean;
  adopted: boolean;
  state: WatchdogState;
}

export interface SettingsView {
  fingerprint: string | null;
  values: SettingsValues | null;
  error: string | null;
  restartPending: string[];
  catalog: CatalogModel[];
  labels: string | null;
  voiceDefaults: VoiceValues;
  /** Agent → the cloud models its card allows (D-116); empty for Arianna, whose model is the orchestrator. */
  agentModels: Record<string, CloudModelAlias[]>;
  /** Agent → why it may receive no skills, null when it may (D-161); optional: an older core sends none. */
  agentSkills?: Record<string, string | null>;
  /** Only from GET: a write answers without it. */
  local?: LocalServerStatus[];
}

export interface PrivacyChanges {
  executors?: { before: string[]; after: string[] };
  telegram?: { before: { chats: number[] } | null; after: { chats: number[] } | null };
  projects?: { added: ProjectValues[]; removed: ProjectValues[]; changed: { name: string; before: ProjectValues; after: ProjectValues }[] };
  endpoints?: { added: EndpointValues[]; removed: EndpointValues[]; changed: { id: string; before: EndpointValues; after: EndpointValues }[] };
  fetchSites?: { before: string[]; after: string[] };
}

export interface PrivacyExits {
  executors: string[];
  projects: { name: string; label: string }[];
  telegram: { chats: number } | null;
  endpoints: { id: string; url: string; command: string[] | null }[];
  /** Optional: an older core sends none. */
  fetchSites?: string[];
}

export interface PrivacyProposal {
  id: string;
  expiresAt: string;
  sections: string[];
  changes: PrivacyChanges;
  exits: PrivacyExits;
}

export type OrdinarySection = 'roles' | 'cloudModels' | 'characters' | 'voice' | 'personas' | 'series' | 'projectRules' | 'agents' | 'skills' | 'sprites' | 'participants' | 'notifications' | 'secretary' | 'appearance';

/** What an ordinary save sends: the values, except the agents, where `null` is "the router chooses". */
export type SettingsBody = Partial<Pick<SettingsValues, Exclude<OrdinarySection, 'agents'>>> & { agents?: ReturnType<typeof agentsBody> };
export type PrivacySection = 'executors' | 'telegram' | 'projects' | 'endpoints' | 'fetchSites';
export type Section = OrdinarySection | PrivacySection;

/**
 * The roles of the local models in plain words (D-192): `task` says what the
 * model does («Chi fa cosa»), `name` is the short name in sentences and
 * filters, `hint` explains it under the menu.
 */
export const ROLE_TEXT: Record<ModelRole, { task: string; name: string; hint: string }> = {
  orchestrator: { task: 'Ragiona e risponde in chat', name: 'Mente di Arianna', hint: 'È la mente di Arianna. Solo modelli sul Mac.' },
  extractor: { task: 'Legge i documenti', name: 'Lettura dei documenti', hint: 'Tira fuori date, importi e nomi da fatture e note.' },
  embedder: { task: 'Cerca nell’archivio', name: 'Ricerca nell’archivio', hint: 'Trova le note simili a quello che chiedi.' },
  voice: { task: 'Risponde al telefono', name: 'Telefono', hint: 'Più piccolo e veloce, per le chiamate.' },
  stt: { task: 'Capisce quello che dici', name: 'Ascolto', hint: 'Trasforma la tua voce in testo.' },
  tts: { task: 'Parla con la sua voce', name: 'Voce', hint: 'Trasforma le risposte in voce.' },
  pii: { task: 'Riconosce i dati personali', name: 'Dati personali', hint: 'Secondo controllo di nomi e indirizzi prima del cloud; per ora solo in prova.' },
  vision: { task: 'Guarda le immagini allegate', name: 'Immagini', hint: 'Legge le immagini che alleghi in una chat privata; si carica solo quando serve.' },
};

export const STATE_TEXT: Record<WatchdogState, string> = {
  idle: 'fermo',
  starting: 'in avvio',
  up: 'acceso',
  down: 'non risponde',
  restarting: 'in riavvio',
  failed: 'guasto',
  stopped: 'spento',
};

export const SECTION_TEXT: Record<string, string> = {
  roles: 'Ruoli dei modelli locali',
  cloudModels: 'Modelli cloud accesi',
  characters: 'Personaggi',
  personas: 'Personalità',
  projectRules: 'Regole dei progetti',
  agents: 'Modelli degli agenti',
  sprites: 'Modello dei personaggi',
  participants: 'Uscita degli agenti',
  voice: 'Voce',
  notifications: 'Notifiche',
  secretary: 'Segretaria',
  appearance: 'Tema',
  executors: 'Esecutori cloud',
  telegram: 'Telegram',
  projects: 'Progetti',
  endpoints: 'Server locali',
  fetchSites: 'Domini approvati',
  paths: 'percorsi',
  database: 'database',
  server: 'server',
};

/** The catalog entries a role may use, those on disk first. */
export function roleOptions(catalog: readonly CatalogModel[], role: ModelRole): CatalogModel[] {
  return catalog.filter((model) => model.roles.includes(role)).sort((a, b) => Number(b.present) - Number(a.present));
}

/** A deep copy of plain JSON values; unlike structuredClone it also takes Vue's reactive proxies. */
export function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Plain JSON values compared regardless of key order: a card is changed when this is false. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

// --- Forms: what the page edits, and the body each card sends.

export interface CloudModelRow {
  alias: CloudModelAlias;
  enabled: boolean;
  /** Empty: the alias, the newest model the binary knows. */
  name: string;
}

export interface CloudModelsForm {
  rows: CloudModelRow[];
}

export function cloudModelsForm(values: SettingsValues['cloudModels']): CloudModelsForm {
  return {
    rows: CLOUD_MODELS.map((alias) => {
      const value = values.models[alias];
      return { alias, enabled: value !== false, name: typeof value === 'string' ? value : '' };
    }),
  };
}

export function cloudModelsBody(form: CloudModelsForm): SettingsValues['cloudModels'] {
  const models = Object.fromEntries(form.rows.map((row) => [row.alias, !row.enabled ? false : row.name.trim() === '' ? true : row.name.trim()])) as Record<
    CloudModelAlias,
    boolean | string
  >;
  return { models };
}

/** Agent → its model in the form (D-116): `''` is "the router chooses". Every agent with a card, none else. */
export type AgentsForm = Record<string, CloudModelAlias | ''>;

export function agentsForm(values: SettingsValues['agents'], allowed: SettingsView['agentModels']): AgentsForm {
  return Object.fromEntries(Object.keys(allowed).map((agent) => [agent, Object.hasOwn(values, agent) ? (values[agent]?.model ?? '') : '']));
}

/** Agent → its skills in the form (D-161): every agent with a card, an empty list for none, so a removal is sent too. */
export type SkillsForm = Record<string, string[]>;

export function skillsForm(values: SettingsValues['skills'], allowed: SettingsView['agentSkills']): SkillsForm {
  const given = values ?? {};
  const agents = new Set([...Object.keys(allowed ?? {}), ...Object.keys(given)]);
  return Object.fromEntries([...agents].sort().map((agent) => [agent, Object.hasOwn(given, agent) ? [...(given[agent] ?? [])] : []]));
}

/** Every agent of the form with its list: the core keeps an unchanged list even for an agent that may no longer take skills. */
export function skillsBody(form: SkillsForm): Record<string, string[]> {
  return Object.fromEntries(Object.entries(form).map(([agent, ids]) => [agent, [...ids]]));
}

/** Every agent of the form, `null` for "the router chooses": the core writes exactly this table. */
export function agentsBody(form: AgentsForm): Record<string, { model: CloudModelAlias | null }> {
  return Object.fromEntries(Object.entries(form).map(([agent, model]) => [agent, { model: model === '' ? null : model }]));
}

/** The executor of a cloud model, as `executorOf` of packages/router/src/config.ts has it: a new alias goes in both. */
export function executorOfModel(model: string): 'claude' | 'codex' {
  // `codex`: the single model of Codex before D-141, in older rows.
  return CODEX_MODELS.includes(model) || model === 'codex' ? 'codex' : 'claude';
}

/** The aliases of Codex's models (D-141). */
export const CODEX_MODELS: readonly string[] = ['luna', 'sol', 'astra'];

/**
 * Why a model the card allows would not start a new conversation now
 * (D-116): turned off, or its executor off. It can still be chosen: it
 * applies once the cause is gone. Codex has its adapter since D-140.
 */
export function modelBlocker(model: CloudModelAlias, values: Pick<SettingsValues, 'cloudModels' | 'executors'>): string | undefined {
  if (values.cloudModels.models[model] === false) return 'spento in Modelli';
  if (!values.executors.includes(executorOfModel(model))) return 'esecutore spento';
  return undefined;
}

/** Roles with no model are left out of `[roles]`. */
export function rolesBody(form: Partial<Record<ModelRole, string | undefined>>): Partial<Record<ModelRole, string>> {
  return Object.fromEntries(Object.entries(form).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));
}

/** The characters: an empty choice is the default one, left out of `[characters]`. */
export function charactersBody(form: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(form).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));
}

export interface VoiceForm {
  enabled: boolean;
  values: VoiceValues;
  /** Push on: key and contact filled in. */
  push: boolean;
  publicKey: string;
  subject: string;
}

export function voiceForm(voice: VoiceValues | null, defaults: VoiceValues): VoiceForm {
  const values = copy(voice ?? defaults);
  return { enabled: voice !== null, values: { ...values, push: null }, push: values.push !== null, publicKey: values.push?.publicKey ?? '', subject: values.push?.subject ?? '' };
}

export function voiceBody(form: VoiceForm): VoiceValues | null {
  if (!form.enabled) return null;
  return { ...copy(form.values), push: form.push ? { publicKey: form.publicKey.trim(), subject: form.subject.trim() } : null };
}

/** The Notifiche card (I-1): the three kinds and the quiet hours as two times. */
export interface NotificationsForm {
  replies: boolean;
  approvals: boolean;
  failures: boolean;
  quiet: boolean;
  quietFrom: string;
  quietTo: string;
}

const DEFAULT_QUIET = { from: '22:00', to: '07:00' };
const QUIET = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;

export function notificationsForm(values: NotificationsValues): NotificationsForm {
  const match = values.quiet === null ? null : QUIET.exec(values.quiet);
  return {
    replies: values.replies,
    approvals: values.approvals,
    failures: values.failures,
    quiet: match !== null,
    quietFrom: match?.[1] ?? DEFAULT_QUIET.from,
    quietTo: match?.[2] ?? DEFAULT_QUIET.to,
  };
}

export function notificationsBody(form: NotificationsForm): NotificationsValues {
  return { replies: form.replies, approvals: form.approvals, failures: form.failures, quiet: form.quiet ? `${form.quietFrom}-${form.quietTo}` : null };
}

/** Why the Notifiche card cannot be saved: quiet hours without two different times. */
export function notificationsProblem(form: NotificationsForm): string | undefined {
  if (!form.quiet) return undefined;
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!clock.test(form.quietFrom) || !clock.test(form.quietTo)) return 'Scrivi le due ore del silenzio.';
  if (form.quietFrom === form.quietTo) return 'Le ore di silenzio devono iniziare e finire a ore diverse.';
  return undefined;
}

export interface TelegramForm {
  enabled: boolean;
  chats: number[];
}

export function telegramForm(telegram: SettingsValues['telegram']): TelegramForm {
  return { enabled: telegram !== null, chats: [...(telegram?.chats ?? [])] };
}

export function telegramBody(form: TelegramForm): SettingsValues['telegram'] {
  return form.enabled ? { chats: [...form.chats] } : null;
}

/** A Telegram chat id as typed: an integer, negative for groups; undefined otherwise. */
export function chatId(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^-?\d{1,19}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

export interface EndpointForm {
  id: string;
  url: string;
  /** One argument per line: no quoting to get wrong. */
  command: string;
  /** Kept as in the file: the page does not edit it. */
  models?: Record<string, string>;
}

export function endpointsForm(endpoints: readonly EndpointValues[]): EndpointForm[] {
  return endpoints.map((endpoint) => ({
    id: endpoint.id,
    url: endpoint.url,
    command: (endpoint.command ?? []).join('\n'),
    ...(endpoint.models === undefined ? {} : { models: { ...endpoint.models } }),
  }));
}

export function endpointsBody(form: readonly EndpointForm[], before: readonly EndpointValues[] = []): EndpointValues[] {
  return form.map((endpoint) => {
    // The text of a command not touched: the arguments of the file, even empty or with spaces around.
    const saved = before.find((item) => item.command !== undefined && item.command.join('\n') === endpoint.command)?.command;
    const command = saved !== undefined ? [...saved] : endpoint.command
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    return {
      id: endpoint.id.trim(),
      url: endpoint.url.trim(),
      ...(command.length === 0 ? {} : { command }),
      ...(endpoint.models === undefined ? {} : { models: { ...endpoint.models } }),
    };
  });
}

/** The executors in their usual order, whatever order they were ticked in. */
export function executorsBody(chosen: readonly string[]): string[] {
  return CLOUD_EXECUTORS.filter((executor) => chosen.includes(executor));
}

// --- The confirmation card.

export interface ChangeLine {
  kind: 'add' | 'remove' | 'change';
  text: string;
}

function projectText(project: ProjectValues): string {
  return `${project.name} (${labelWord(project.label)}, ${project.path})`;
}

const LABEL_ORDER: readonly string[] = ['L0', 'L1', 'L2', 'L3'];

/**
 * A changed project, one line: its label and path when they change, then
 * each management folder whose label changes (D-145), with "scende" when it
 * goes down; "come da nome" is the label a folder has without a choice.
 */
function projectChange(before: ProjectValues, after: ProjectValues): string {
  const head = before.label !== after.label || before.path !== after.path ? `Progetto ${projectText(before)} → ${labelWord(after.label)}, ${after.path}` : `Progetto ${after.name}`;
  const parts: string[] = [];
  if (!sameValue(before.parts ?? null, after.parts ?? null)) parts.push(after.parts === undefined ? 'parti: tutte le cartelle git' : `parti: ${after.parts.join(', ')}`);
  const old = new Map((before.folders ?? []).map((folder) => [folder.path.toLowerCase(), folder.label]));
  const now = new Map((after.folders ?? []).map((folder) => [folder.path.toLowerCase(), folder.label]));
  const names = new Map([...(before.folders ?? []), ...(after.folders ?? [])].map((folder) => [folder.path.toLowerCase(), folder.path]));
  for (const [key, name] of names) {
    const from = old.get(key);
    const to = now.get(key);
    if (from === to) continue;
    // Without a choice a folder has its label by name (D-145): Workplan and IM Interne, the others Private.
    const byName = ['workplan', 'im'].includes(key) ? 'L1' : 'L2';
    const down = LABEL_ORDER.indexOf(to ?? byName) < LABEL_ORDER.indexOf(from ?? byName);
    parts.push(`cartella ${name}: ${from === undefined ? 'come da nome' : labelWord(from)} → ${to === undefined ? 'come da nome' : labelWord(to)}${down ? ' (scende)' : ''}`);
  }
  return parts.length === 0 ? head : `${head}: ${parts.join('; ')}`;
}

/** A command as the core runs it: an argument that is empty or holds spaces or quotes is quoted, so ["sh -c x"] never reads as ["sh", "-c", "x"]. */
export function commandText(command: readonly string[]): string {
  return command.map((arg) => (arg === '' || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function modelsText(models: Record<string, string> | undefined): string {
  return models === undefined ? 'dai ruoli' : Object.entries(models).map(([role, name]) => `${role} = ${name}`).join(', ');
}

function endpointText(endpoint: EndpointValues): string {
  return `${endpoint.id} (${endpoint.url}${endpoint.command === undefined ? ', solo osservato' : `, comando: ${commandText(endpoint.command)}`})`;
}

function endpointChange(before: EndpointValues, after: EndpointValues): string {
  const parts: string[] = [];
  if (before.url !== after.url) parts.push(`indirizzo ${before.url} → ${after.url}`);
  if (!sameValue(before.command ?? null, after.command ?? null)) {
    parts.push(after.command === undefined ? 'senza comando: Arianna lo controlla soltanto' : `comando: ${commandText(after.command)}`);
  }
  if (!sameValue(before.models ?? null, after.models ?? null)) parts.push(`nomi dei modelli: ${modelsText(after.models)}`);
  return `Server ${after.id}: ${parts.join('; ')}`;
}

/** What changes, one line each, in the order of the sections. */
export function changeLines(changes: PrivacyChanges): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (changes.executors !== undefined) {
    const { before, after } = changes.executors;
    for (const executor of after.filter((item) => !before.includes(item))) lines.push({ kind: 'add', text: `${EXECUTOR_TEXT[executor] ?? executor} acceso` });
    for (const executor of before.filter((item) => !after.includes(item))) lines.push({ kind: 'remove', text: `${EXECUTOR_TEXT[executor] ?? executor} spento` });
  }
  if (changes.telegram !== undefined) {
    const { before, after } = changes.telegram;
    if (before === null && after !== null) lines.push({ kind: 'add', text: `Telegram acceso (${chatsText(after.chats.length)})` });
    else if (before !== null && after === null) lines.push({ kind: 'remove', text: 'Telegram spento' });
    else if (before !== null && after !== null) {
      for (const chat of after.chats.filter((item) => !before.chats.includes(item))) lines.push({ kind: 'add', text: `Chat di Telegram ${String(chat)}` });
      for (const chat of before.chats.filter((item) => !after.chats.includes(item))) lines.push({ kind: 'remove', text: `Chat di Telegram ${String(chat)}` });
    }
  }
  if (changes.projects !== undefined) {
    for (const project of changes.projects.added) lines.push({ kind: 'add', text: `Progetto ${projectText(project)}` });
    for (const project of changes.projects.removed) lines.push({ kind: 'remove', text: `Progetto ${projectText(project)}` });
    for (const { before, after } of changes.projects.changed) lines.push({ kind: 'change', text: projectChange(before, after) });
  }
  if (changes.endpoints !== undefined) {
    for (const endpoint of changes.endpoints.added) lines.push({ kind: 'add', text: `Server ${endpointText(endpoint)}` });
    for (const endpoint of changes.endpoints.removed) lines.push({ kind: 'remove', text: `Server ${endpointText(endpoint)}` });
    for (const { before, after } of changes.endpoints.changed) lines.push({ kind: 'change', text: endpointChange(before, after) });
  }
  if (changes.fetchSites !== undefined) {
    const { before, after } = changes.fetchSites;
    for (const site of after.filter((item) => !before.includes(item))) lines.push({ kind: 'add', text: `Link di ${site} scaricati da soli` });
    for (const site of before.filter((item) => !after.includes(item))) lines.push({ kind: 'remove', text: `Link di ${site} non più scaricati da soli` });
  }
  if (lines.length === 0) lines.push({ kind: 'change', text: 'Cambia solo l’ordine o la forma nel file: le uscite restano le stesse.' });
  return lines;
}

function chatsText(count: number): string {
  return count === 1 ? '1 chat' : `${String(count)} chat`;
}

/** After the change, who may receive what: every exit, not only the changed ones. */
export function exitLines(exits: PrivacyExits): string[] {
  const lines: string[] = [];
  const projects = exits.projects.map((project) => `${project.name} (${labelWord(project.label)})`).join(', ');
  for (const executor of exits.executors) {
    const name = EXECUTOR_TEXT[executor] ?? executor;
    lines.push(projects === '' ? `Verso ${name}: il testo dei lavori che Arianna gli passa, solo Pubblico o Interno; nessun progetto.` : `Verso ${name}: il testo dei lavori che Arianna gli passa, solo Pubblico o Interno, e i file dei progetti ${projects}.`);
  }
  if (exits.executors.length === 0) lines.push('Claude e Codex spenti: nessun lavoro esce verso il cloud.');
  lines.push(exits.telegram === null ? 'Telegram spento.' : `Telegram: ${chatsText(exits.telegram.chats)}, al massimo Interno.`);
  for (const endpoint of exits.endpoints) {
    lines.push(
      endpoint.command === null
        ? `${endpoint.id} (${endpoint.url}) vede i dati privati.`
        : `${endpoint.id} (${endpoint.url}) vede i dati privati; Arianna lo avvia con: ${commandText(endpoint.command)}`,
    );
  }
  const sites = exits.fetchSites ?? [];
  lines.push(
    sites.length === 0
      ? 'Nessun sito scaricato da solo: un link si scarica solo con «Scarica e riassumi».'
      : `Arianna scarica da sola i link di: ${sites.join(', ')} (anche i sottodomini); ogni sito riceve solo l’indirizzo dei suoi link, i post di X vanno a publish.twitter.com.`,
  );
  return lines;
}

/** "4:52" until the confirmation expires; "0:00" once it has. */
export function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`;
}

const PERSONA_FIELD_TEXT: Record<string, string> = {
  displayName: '«Nome in chat»',
  traits: '«Come parla»',
  specialization: '«Specializzazione»',
};

/** "arianna" → "Arianna": the agent's id as the page names it. */
const capitalized = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * The core's refusal of a free text with personal data or a value of the
 * vault (D-107g), in plain Italian: which field and which kind, never the
 * text (the core never repeats it either). Undefined for any other message.
 */
export function personalDataText(message: string): string | undefined {
  const persona = /^personas\.([a-z0-9_-]+)\.(displayName|traits|specialization) /.exec(message);
  const rules = /^projectRules\.(template|projects\.[a-z0-9-]+) /.exec(message);
  let where: string;
  if (persona !== null) where = `Il campo ${PERSONA_FIELD_TEXT[persona[2] ?? ''] ?? ''} della personalità di ${capitalized(persona[1] ?? '')}`;
  else if (rules?.[1] === 'template') where = 'Il modello delle regole dei progetti';
  else if (rules !== null) where = `La regola del progetto ${(rules[1] ?? '').slice('projects.'.length)}`;
  else return undefined;
  if (/ holds a value of the vault/.test(message)) return `${where} contiene un valore del vault: toglilo prima di salvare.`;
  if (!/ looks like personal data or a secret/.test(message)) return undefined;
  const kinds = /\(([^)]*)\)/.exec(message)?.[1]?.split(', ').map((kind) => SCAN_KINDS[kind] ?? 'un dato personale') ?? [];
  const what = kinds.length > 0 ? [...new Set(kinds)].join(', ') : 'un dato personale o un segreto';
  return `${where} contiene ${what}: toglilo prima di salvare.`;
}

// The refusals of the project list (D-058) in plain Italian, with what to do
// (D-228). The same table is projectProblemText in
// packages/config/src/project-messages.ts: test/project-messages.test.ts keeps
// the two equal.
const PROJECT_PROBLEMS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/^your whole home cannot be a project/, () => 'La tua cartella utente intera non può essere un progetto: scegli una cartella dentro, per esempio ~/Sites/negozio.'],
  [/^an absolute path is not accepted, write (\S.*)$/, (match) => `Scrivi la cartella come ${match[1] ?? ''}: con ~/ vale anche su un altro Mac, dove la tua cartella utente ha un altro nome.`],
  [
    /^a project must be under your home/,
    () => 'Un progetto deve stare nella tua cartella utente (~/…) o dentro Arianna (repos/<nome>): una cartella altrove sul disco non si può aggiungere. Spostala nella tua cartella utente e riprova.',
  ],
  [/^write ~\/<folder> for a folder under your home/, () => 'Scrivi la cartella come ~/… se sta nella tua cartella utente (per esempio ~/Sites/negozio), oppure repos/<nome> se sta dentro Arianna.'],
  [/^every folder of the path must be a plain name/, () => 'Ogni cartella del percorso deve avere un nome semplice: niente cartelle nascoste (col punto davanti), niente . o .., niente barre doppie.'],
  [/^Library holds the settings/, () => 'Library contiene le impostazioni e i dati di tutte le app: non può essere un progetto.'],
  [/^must not be ARIANNA_HOME/, () => 'La cartella non può essere quella di Arianna, né stare dentro o contenerla: per una cartella dentro Arianna scrivi repos/<nome>.'],
  [/^a folder inside Arianna must be (\S+)$/, (match) => `Una cartella dentro Arianna si scrive repos/ seguito dal nome del progetto: qui ${match[1] ?? ''}.`],
  [/^lowercase letters, digits and dashes/, () => 'Il nome del progetto usa solo lettere minuscole, cifre e trattini, e comincia con una lettera o una cifra (per esempio negozio-finto).'],
  [/^a project goes to the cloud, so it is L0 or L1/, () => 'Un progetto va a Claude o Codex: la riservatezza è Pubblico o Interno. Le cartelle private restano fuori dalla lista.'],
  [/^(\S+) is listed twice$/, (match) => `Il progetto ${match[1] ?? ''} compare due volte.`],
  [/^(\S+) and (\S+) are the same folder or one inside the other$/, (match) => `I progetti ${match[1] ?? ''} e ${match[2] ?? ''} sono la stessa cartella, o uno sta dentro l’altro.`],
  [/^the home folder \(HOME\) must be/, () => 'La cartella utente di questo computer (HOME) non è valida: dev’essere un percorso completo diverso da /.'],
];

/** A refusal of the project list in Italian (D-228), or undefined for any other message. */
export function projectProblemText(message: string): string | undefined {
  const where = /^project(?:\[\d+\](?:\.[a-z]+)?)?: (.*)$/s.exec(message);
  if (where?.[1] === undefined) return undefined;
  for (const [pattern, text] of PROJECT_PROBLEMS) {
    const match = pattern.exec(where[1]);
    if (match !== null) return text(match);
  }
  return undefined;
}

/** Why arianna.toml is not valid, one sentence ending with its period: a refused project in Italian, anything else as the core says it. */
export function fileErrorText(error: string): string {
  return projectProblemText(error) ?? `${error}.`;
}

/** What the page says about a refused write: the status picks the case, the core's message the detail. */
export function writeError(status: number, message: string): { text: string; reload: boolean } {
  const personal = status === 400 ? personalDataText(message) : undefined;
  if (personal !== undefined) return { text: personal, reload: false };
  const project = projectProblemText(message);
  if (status === 409) {
    if (/changed since the page read it/.test(message)) return { text: 'Il file arianna.toml è cambiato mentre la pagina era aperta: ho ricaricato i valori. Rifai la modifica.', reload: true };
    return { text: `Le impostazioni non si leggono: ${project ?? message}`, reload: true };
  }
  if (status === 404 || status === 410) return { text: 'La conferma è scaduta o è già stata usata: rivedi di nuovo le uscite.', reload: false };
  if (status === 400 && project !== undefined) return { text: `Progetti non salvati. ${project}`, reload: false };
  if (status === 400) return { text: `Arianna ha rifiutato la modifica: ${message}`, reload: false };
  return { text: `Non riuscito: ${message}`, reload: false };
}

/** A card is changed when what it would send differs; executors and chats are sets, their order is not a change. */
export function sectionChanged(section: Section, form: unknown, base: unknown): boolean {
  // An agent added with the defaults is no change: compared as sent.
  if (section === 'personas') return !sameValue(personasBody(form as Record<string, PersonaForm>), personasBody(base as Record<string, PersonaForm>));
  if (section === 'executors' || section === 'fetchSites') return !sameValue([...(form as string[])].sort(), [...(base as string[])].sort());
  if (section === 'telegram') {
    const sorted = (value: TelegramForm): TelegramForm => ({ enabled: value.enabled, chats: [...value.chats].sort((a, b) => a - b) });
    return !sameValue(sorted(form as TelegramForm), sorted(base as TelegramForm));
  }
  return !sameValue(form, base);
}

/**
 * What a poll does with the settings it read. `generation` counts the writes
 * and applies of the page: an answer to a read started before one of them is
 * older than what the page shows, and is dropped.
 */
export function pollAction(state: { started: number; generation: number; fingerprint: string | null; seen: string | null; open: boolean; busy: boolean; dirty: boolean }): 'ignore' | 'stale' | 'apply' {
  if (state.started !== state.generation || state.open || state.busy || state.fingerprint === state.seen) return 'ignore';
  return state.dirty ? 'stale' : 'apply';
}

/** The sections kept as edited when a new view arrives: those asked for that are changed. */
export function keptSections(keep: readonly Section[], changed: (section: Section) => boolean): Section[] {
  return keep.filter(changed);
}

/** Why the voice card cannot be saved: a number left empty or not whole. */
export function voiceProblem(form: VoiceForm): string | undefined {
  if (!form.enabled) return undefined;
  const { port, limits, outgoing } = form.values;
  const numbers = [port, limits.callMinutes, limits.warnSeconds, limits.delegations, limits.delegationSeconds, outgoing.maxPerDay, outgoing.ringSeconds, outgoing.waitingMinutes];
  if (numbers.some((value) => typeof value !== 'number' || !Number.isInteger(value))) return 'Un numero è vuoto o non intero.';
  return undefined;
}

/**
 * The keys of the notifications with the chat closed (D-066): stored in
 * `[voice.push]`, shown and saved from Notifiche since D-192. The rest of
 * `[voice]` is the part of Voce e chiamate: each section changes and saves
 * only its part, the other one as read.
 */
export interface PushPart {
  push: boolean;
  publicKey: string;
  subject: string;
}

export function pushPart(form: VoiceForm): PushPart {
  return { push: form.push, publicKey: form.publicKey, subject: form.subject };
}

/** `target` with the push part of `source`. */
export function withPush(target: VoiceForm, source: VoiceForm): VoiceForm {
  return { ...copy(target), ...pushPart(source) };
}

/** The push part differs (Notifiche). */
export function pushChanged(form: VoiceForm, base: VoiceForm): boolean {
  return !sameValue(pushPart(form), pushPart(base));
}

/** Calls, limits and the voice differ (Voce e chiamate), whatever the push part. */
export function callsChanged(form: VoiceForm, base: VoiceForm): boolean {
  return !sameValue(withPush(form, base), base);
}

/** The [voice] a section sends: its own part as edited, the other part as read. */
export function voiceSent(part: 'calls' | 'push', current: VoiceForm, read: VoiceForm): VoiceValues | null {
  return voiceBody(part === 'push' ? withPush(read, current) : withPush(current, read));
}

/**
 * The [voice] of the page after a save of `part`: what the core answered,
 * with the edits of the other part kept only when there were edits (a voice
 * turned off drops its keys, and keys not touched follow the file).
 */
export function voiceAfterSave(part: 'calls' | 'push', before: VoiceForm, read: VoiceForm, fresh: VoiceForm): VoiceForm {
  if (part === 'calls') return pushChanged(before, read) ? withPush(fresh, before) : fresh;
  return callsChanged(before, read) ? withPush(before, fresh) : fresh;
}

/** Why the push part cannot be saved: on, with the key or the contact empty. */
export function pushProblem(form: VoiceForm): string | undefined {
  if (form.push && (form.publicKey.trim() === '' || form.subject.trim() === '')) return 'Per le notifiche a chat chiusa servono la chiave pubblica e l’email di contatto.';
  return undefined;
}

/**
 * A site as typed in the card "Domini approvati" (D-154): an address or a host
 * name becomes the host name, lowercase, without `www.`; undefined when it is
 * not a name like "example.com".
 */
export function fetchSiteOf(typed: string): string | undefined {
  let text = typed.trim().toLowerCase();
  if (text === '') return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let host: string;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    host = url.hostname.replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return undefined;
  }
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+$/.test(labels.at(-1) ?? '')) return undefined;
  return host;
}

/** The largest `[participants] leave_after` the core takes (I-8, D-130). */
export const MAX_LEAVE_AFTER = 100;

/** A valid number of messages for an idle agent to leave: a whole number, 0 (never) to MAX_LEAVE_AFTER. */
export function leaveAfterProblem(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LEAVE_AFTER
    ? undefined
    : `Un numero intero da 0 (mai) a ${String(MAX_LEAVE_AFTER)}.`;
}
