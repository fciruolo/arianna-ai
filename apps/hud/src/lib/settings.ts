/**
 * The settings page (D-071): the shapes of `/api/settings` and the pure parts
 * of the page, from the values of the core to the forms and back, and the
 * Italian texts of the confirmation card. Ordinary sections are saved one
 * card at a time; privacy ones are prepared, shown, then confirmed.
 */
import { EXECUTOR_TEXT, labelWord } from './labels.ts';
import { personasBody, type PersonaForm, type PersonaValues } from './persona.ts';
import type { Label } from './types.ts';

export const MODEL_ROLES = ['orchestrator', 'extractor', 'embedder', 'voice', 'stt', 'tts'] as const;
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
}

export interface EndpointValues {
  id: string;
  url: string;
  command?: string[];
  models?: Record<string, string>;
}

export interface SettingsValues {
  roles: Partial<Record<ModelRole, string>>;
  cloudModels: { models: Record<CloudModelAlias, boolean | string> };
  characters: Record<string, string>;
  /** Agent → persona (D-107); an agent without one has the defaults. */
  personas: Record<string, PersonaValues>;
  /** Agent → the model a new conversation with it starts with (D-116); absent, the router chooses. */
  agents: Record<string, { model: CloudModelAlias }>;
  /** The model that draws a character (D-123): `[sprites] model`, opus when absent (D-132). */
  sprites: 'sonnet' | 'opus' | 'local';
  /** Messages of the user before an idle agent leaves the conversation (I-8, D-130): `[participants] leave_after`; 0 never. */
  participants: number;
  voice: VoiceValues | null;
  /** `[notifications]` (I-1); `quiet` "HH:MM-HH:MM" or null. */
  notifications: NotificationsValues;
  /** `[secretary]` (I-12, D-144). Optional: a core without it sends none. */
  secretary?: SecretaryValues;
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

export type OrdinarySection = 'roles' | 'cloudModels' | 'characters' | 'voice' | 'personas' | 'agents' | 'sprites' | 'participants' | 'notifications' | 'secretary';

/** What an ordinary save sends: the values, except the agents, where `null` is "the router chooses". */
export type SettingsBody = Partial<Pick<SettingsValues, Exclude<OrdinarySection, 'agents'>>> & { agents?: ReturnType<typeof agentsBody> };
export type PrivacySection = 'executors' | 'telegram' | 'projects' | 'endpoints' | 'fetchSites';
export type Section = OrdinarySection | PrivacySection;

export const ROLE_TEXT: Record<ModelRole, { title: string; hint: string }> = {
  orchestrator: { title: 'Orchestratore', hint: 'Arianna che ragiona' },
  extractor: { title: 'Estrattore', hint: 'schede e fatti dai documenti' },
  embedder: { title: 'Embedder', hint: 'ricerca nell’archivio' },
  voice: { title: 'Voce', hint: 'risponde in chiamata' },
  stt: { title: 'Trascrizione', hint: 'stt' },
  tts: { title: 'Sintesi', hint: 'tts' },
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
  agents: 'Modelli degli agenti',
  sprites: 'Modello dei personaggi',
  participants: 'Uscita degli agenti',
  voice: 'Voce',
  notifications: 'Notifiche',
  secretary: 'Segretaria',
  executors: 'Esecutori cloud',
  telegram: 'Telegram',
  projects: 'Progetti',
  endpoints: 'Server locali',
  fetchSites: 'Link scaricati',
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
    parts.push(after.command === undefined ? 'senza comando: il nucleo lo osserva soltanto' : `comando: ${commandText(after.command)}`);
  }
  if (!sameValue(before.models ?? null, after.models ?? null)) parts.push(`nomi dei modelli: ${modelsText(after.models)}`);
  return `Server ${after.id}: ${parts.join('; ')}`;
}

/** What changes, one line each, in the order of the sections. */
export function changeLines(changes: PrivacyChanges): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (changes.executors !== undefined) {
    const { before, after } = changes.executors;
    for (const executor of after.filter((item) => !before.includes(item))) lines.push({ kind: 'add', text: `Esecutore ${EXECUTOR_TEXT[executor] ?? executor} acceso` });
    for (const executor of before.filter((item) => !after.includes(item))) lines.push({ kind: 'remove', text: `Esecutore ${EXECUTOR_TEXT[executor] ?? executor} spento` });
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
    lines.push(projects === '' ? `${name} potrà ricevere testi Pubblici o Interni dal gateway; nessun progetto.` : `${name} potrà ricevere testi Pubblici o Interni dal gateway e lavorare in: ${projects}.`);
  }
  if (exits.executors.length === 0) lines.push('Nessun esecutore cloud: niente esce verso Claude Code o Codex.');
  lines.push(exits.telegram === null ? 'Telegram spento.' : `Telegram: ${chatsText(exits.telegram.chats)}, al massimo Interno.`);
  for (const endpoint of exits.endpoints) {
    lines.push(
      endpoint.command === null
        ? `${endpoint.id} (${endpoint.url}) vede i dati Privati in chiaro.`
        : `${endpoint.id} (${endpoint.url}) vede i dati Privati in chiaro; il nucleo esegue: ${commandText(endpoint.command)}`,
    );
  }
  const sites = exits.fetchSites ?? [];
  lines.push(
    sites.length === 0
      ? 'Nessun sito scaricato da solo: un link si scarica solo con «Scarica e riassumi».'
      : `Al riordino il nucleo scarica i link di: ${sites.join(', ')} (anche i sottodomini); ogni sito riceve solo l’indirizzo dei suoi link, i post di X vanno a publish.twitter.com.`,
  );
  return lines;
}

/** "4:52" until the confirmation expires; "0:00" once it has. */
export function countdown(expiresAt: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${String(Math.floor(left / 60))}:${String(left % 60).padStart(2, '0')}`;
}

/** What the page says about a refused write: the status picks the case, the core's message the detail. */
export function writeError(status: number, message: string): { text: string; reload: boolean } {
  if (status === 409) {
    if (/changed since the page read it/.test(message)) return { text: 'Il file arianna.toml è cambiato mentre la pagina era aperta: ho ricaricato i valori. Rifai la modifica.', reload: true };
    return { text: `Le impostazioni non si leggono: ${message}`, reload: true };
  }
  if (status === 404 || status === 410) return { text: 'La conferma è scaduta o è già stata usata: rivedi di nuovo le uscite.', reload: false };
  if (status === 400) return { text: `Il nucleo ha rifiutato la modifica: ${message}`, reload: false };
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
  if (form.push && (form.publicKey.trim() === '' || form.subject.trim() === '')) return 'Per le notifiche push servono chiave pubblica e contatto.';
  return undefined;
}

/**
 * A site as typed in the card "Link scaricati" (D-154): an address or a host
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
