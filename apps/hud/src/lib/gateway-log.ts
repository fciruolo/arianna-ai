/**
 * «Registro del gateway» (D-296): what the page shows of each decision of the
 * gateway, as the core gives it (GET /api/gateway/log): when, towards whom,
 * which label, allowed or blocked and by which rule, the size, who asked.
 * The list never carries the text. «Cosa è uscito» (D-297): the detail of an
 * exit allowed to the cloud up to Interno asks its exact text, only from the
 * Mac (GET /api/gateway/log/:id/text); a blocked one says only its label.
 * Pure: the page asks, this decides.
 */
import { agentName } from './italian.ts';
import { LABEL_TEXT } from './labels.ts';
import type { Label } from './types.ts';

export type GatewayDecision = 'allow' | 'block';
export type GatewayTargetKind = 'executor' | 'channel' | 'web' | 'link' | 'other';

export interface GatewayLogEntry {
  id: string;
  ts: string;
  targetKind: GatewayTargetKind;
  target: string;
  locality: 'local' | 'cloud';
  label: Label;
  decision: GatewayDecision;
  rule: string;
  bytes: number | null;
  agent: string | null;
  model: string | null;
  /** `title` only where the list of conversations shows it; `open`: not purged. */
  conversation: { id: string; title: string | null; open: boolean } | null;
  card: { id: string; title: string } | null;
  /** The run of the exit. */
  runId: string | null;
  /** Its group (D-297): the request of the user it served (`t-…`), else its run (`r-…`), else itself (`row-…`). */
  requestKey: string;
  /** What it was (D-297): a closed code; null for an exit before it or of no kind. */
  what: string | null;
}

/** The exits of one run as one line (D-297): the newest row and the counts. */
export interface GatewayLogGroup {
  entry: GatewayLogEntry;
  count: number;
  allowed: number;
  blocked: number;
  bytes: number | null;
  firstTs: string;
  targets: number;
  /** The highest label among its exits, blocked ones too. */
  label: Label;
  /** Exits allowed to the cloud with Privato or Segreto (not a link): the line is red. */
  privateOut: number;
  /** Exits to the cloud, allowed or blocked. */
  cloud: number;
  /** The agents whose exits went to the cloud, in order; empty: only Arianna on the Mac. */
  agents: string[];
  /** Where the line says it went: its newest cloud target when it has one (never «sul Mac» then). */
  headline: { targetKind: GatewayTargetKind; target: string; locality: 'local' | 'cloud' };
}

export interface GatewayLogTarget {
  kind: GatewayTargetKind;
  target: string;
}

export interface GatewayLogPage {
  entries: GatewayLogEntry[];
  groups?: GatewayLogGroup[];
  next: string | null;
  targets?: GatewayLogTarget[];
}

/** The filters of the page; an empty string is «tutti». `destination` is `<kind>/<target>` or `<kind>`. */
export interface GatewayLogFilters {
  decision: '' | GatewayDecision;
  destination: string;
  label: '' | Label;
  /** Days as the date field gives them (YYYY-MM-DD), both included. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: GatewayLogFilters = { decision: '', destination: '', label: '', from: '', to: '' };

export const GATEWAY_LOG_TITLE = 'Registro del gateway';
export const GATEWAY_LOG_INTRO =
  'Ogni volta che qualcosa prova a uscire da Arianna passa dal gateway, che lo lascia andare o lo ferma: qui c’è una riga per ogni tua domanda, con tutte le sue uscite (passi di Arianna, agenti, note, strumenti), la più recente in alto. Chi, dove, quando, con quale etichetta e perché; per ogni uscita cosa era e, verso il cloud, il testo esatto che è uscito, per 30 giorni e solo dal Mac.';

const EXECUTOR_TEXT: Record<string, string> = { claude: 'Claude', codex: 'Codex', local: 'Modello locale' };
const CHANNEL_TEXT: Record<string, string> = { web: 'Chat web', telegram: 'Telegram', phone: 'Telefono', voice: 'Voce', push: 'Notifiche push' };
const WEB_TEXT: Record<string, string> = {
  'web-search': 'Web · servizio fisso',
  'web-page-public': 'Web · pagina pubblica',
  'web-page-user': 'Web · pagina indicata da te',
  'web-page-sites': 'Web · sito della tua lista',
  'web-resource-public': 'Browser · risorsa di una pagina',
  'web-resource-user': 'Browser · risorsa di una pagina',
  'web-resource-sites': 'Browser · risorsa di una pagina',
  'web-typed-public': 'Browser · testo scritto',
  'web-typed-user': 'Browser · testo scritto',
  'web-typed-sites': 'Browser · testo scritto',
  'web-typed-session': 'Browser · testo scritto dopo il tuo accesso',
  'web-session': 'Browser · sito del tuo accesso',
  'web-form': 'Browser · modulo inviato da te',
};
const LINK_TEXT: Record<string, string> = { 'link-list': 'Link salvato · sito della lista', 'link-click': 'Link salvato · scaricato da te', 'link-video': 'Video di YouTube' };

/** Where it went, as the user reads it. */
export function targetText(kind: GatewayTargetKind, target: string): string {
  const table = kind === 'executor' ? EXECUTOR_TEXT : kind === 'channel' ? CHANNEL_TEXT : kind === 'web' ? WEB_TEXT : kind === 'link' ? LINK_TEXT : {};
  return table[target] ?? (target === 'other' ? 'Altro' : target);
}

const KIND_TEXT: Record<Exclude<GatewayTargetKind, 'other'>, string> = { executor: 'Modelli', channel: 'Canali', web: 'Web e browser', link: 'Link salvati' };

export interface DestinationOption {
  value: string;
  text: string;
}

/** The choices of «Destinazione»: every kind, then the targets seen, under their kind. */
export function destinationOptions(targets: readonly GatewayLogTarget[]): { group: string; options: DestinationOption[] }[] {
  const groups: { group: string; options: DestinationOption[] }[] = [];
  for (const kind of Object.keys(KIND_TEXT) as (keyof typeof KIND_TEXT)[]) {
    const own = targets.filter((item) => item.kind === kind);
    if (own.length === 0) continue;
    const seen = new Set<string>();
    const options: DestinationOption[] = [{ value: kind, text: `Tutti: ${KIND_TEXT[kind].toLowerCase()}` }];
    for (const item of own) {
      const text = targetText(kind, item.target);
      // Three targets of a resource read the same: one choice would hide the others, so the code tells them apart.
      const shown = seen.has(text) ? `${text} (${item.target})` : text;
      seen.add(text);
      options.push({ value: `${kind}/${item.target}`, text: shown });
    }
    groups.push({ group: KIND_TEXT[kind], options });
  }
  return groups;
}

export const DECISION_TEXT: Record<GatewayDecision, string> = { allow: 'ammessa', block: 'bloccata' };

/** What the rule that decided means; a code the page does not know is shown as it is. */
const RULE_TEXT: Record<string, string> = {
  local: 'Destinazione sul Mac: ammessa fino a Privato.',
  cloud: 'Verso il cloud al massimo Interno, controllo dei dati sensibili passato.',
  link: 'Indirizzo di un link salvato, verso il suo sito, col tuo consenso.',
  page: 'Indirizzo di una pagina pubblica, col consenso della conversazione.',
  resource: 'Risorsa chiesta da una pagina aperta nel browser dell’agente.',
  typed: 'Testo scritto dal browser dell’agente in un campo della pagina.',
  session: 'Richiesta verso il sito in cui sei entrato tu, solo a quel sito.',
  form: 'Modulo inviato da te mentre guidavi il browser: il contenuto non viene letto.',
  'invalid-input': 'Dati non validi: fermati prima di ogni controllo.',
  finance: 'Dati delle Finanze: non escono mai verso il cloud.',
  secret: 'Conteneva un valore Segreto del vault.',
  contaminated: 'Il lavoro aveva già letto dati più protetti di quanto la destinazione ammette.',
  'cloud-label': 'Etichetta troppo alta per il cloud (sopra Interno).',
  unscannable: 'Contenuto che il controllo non riesce a leggere: fermato per prudenza.',
  scanner: 'Il controllo ha trovato un dato sensibile (per esempio un IBAN o una chiave).',
  pii: 'Il secondo controllo ha trovato dati personali (per esempio un nome).',
  'pii-unavailable': 'Il secondo controllo dei dati personali non era disponibile.',
  'saved-private': 'Conteneva un dato privato salvato fra i clienti.',
  'link-invalid': 'Indirizzo del link non valido o fuori dai siti ammessi.',
  'page-consent': 'Pagina senza consenso: né pubblica, né indicata da te, né nella tua lista.',
  'resource-invalid': 'Risorsa della pagina non ammessa.',
  'typed-invalid': 'Testo da scrivere nella pagina non ammesso.',
  'session-invalid': 'Richiesta fuori dal sito del tuo accesso.',
};

export function ruleText(rule: string): string {
  return RULE_TEXT[rule] ?? `Regola «${rule}».`;
}

export function bytesText(bytes: number | null): string {
  if (bytes === null) return 'non misurata';
  if (bytes < 1024) return `${String(bytes)} byte`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 })} MB`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «09:41» today, «22 ott 09:41» another day, with the year when it is not this one. */
export function timeText(ts: string, now: Date = new Date()): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(date, now)) return time;
  const day = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${day} ${time}`;
}

/** Who asked: the agent, or the core itself (a catalog, a notice). */
export function askerText(entry: Pick<GatewayLogEntry, 'agent'>): string {
  return entry.agent === null ? 'Arianna (sistema)' : agentName(entry.agent);
}

/** Where it was asked from: the conversation or the card, by title. */
export function originText(entry: Pick<GatewayLogEntry, 'conversation' | 'card'>): string | null {
  if (entry.conversation !== null) return entry.conversation.title ?? (entry.conversation.open ? 'Conversazione senza titolo' : 'Conversazione cancellata');
  if (entry.card !== null) return entry.card.title === '' ? 'Card senza titolo' : `Card «${entry.card.title}»`;
  return null;
}

/** The row in one line, e.g. «09:41 · Claude · Coder · Interno · ammessa · 640 byte». */
export function rowLine(entry: GatewayLogEntry, now: Date = new Date()): string {
  const parts = [timeText(entry.ts, now), targetText(entry.targetKind, entry.target), askerText(entry), LABEL_TEXT[entry.label], DECISION_TEXT[entry.decision]];
  if (entry.bytes !== null) parts.push(bytesText(entry.bytes));
  return parts.join(' · ');
}

/** Midnight of a day of the date field, local time; undefined when not a day. */
function localMidnight(day: string, plusDays = 0): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + plusDays);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** «Al» comes before «Dal»: the period is empty, the page says so instead of asking. */
export function periodProblem(filters: Pick<GatewayLogFilters, 'from' | 'to'>): string | null {
  const from = localMidnight(filters.from);
  const to = localMidnight(filters.to);
  return from !== undefined && to !== undefined && to < from ? '«Al» viene prima di «Dal»: cambia una delle due date.' : null;
}

/** The address of a page: the filters, then the cursor. Days become local midnights, «Al» included. `grouped`: one line per question of the user (D-297). */
export function queryOf(filters: GatewayLogFilters, before?: string | null, limit?: number, grouped = false): string {
  const params = new URLSearchParams();
  if (grouped) params.set('group', 'request');
  if (filters.decision !== '') params.set('decision', filters.decision);
  if (filters.destination !== '') {
    const [kind, target] = filters.destination.split('/');
    if (kind !== undefined && kind !== '') params.set('kind', kind);
    if (target !== undefined && target !== '') params.set('target', target);
  }
  if (filters.label !== '') params.set('label', filters.label);
  const from = localMidnight(filters.from);
  if (from !== undefined) params.set('from', from.toISOString());
  const to = localMidnight(filters.to, 1);
  if (to !== undefined) params.set('to', to.toISOString());
  if (before !== undefined && before !== null) params.set('before', before);
  if (limit !== undefined) params.set('limit', String(limit));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

export function filtersActive(filters: GatewayLogFilters): number {
  return [filters.decision, filters.destination, filters.label, filters.from, filters.to].filter((value) => value !== '').length;
}

/** The rows already shown and the next page, without repeating one. */
export function appendPage(shown: readonly GatewayLogEntry[], page: readonly GatewayLogEntry[]): GatewayLogEntry[] {
  const ids = new Set(shown.map((entry) => entry.id));
  return [...shown, ...page.filter((entry) => !ids.has(entry.id))];
}

/** The empty page: nothing at all yet, or nothing with these filters. */
export function emptyText(filters: GatewayLogFilters): { title: string; text: string } {
  if (filtersActive(filters) > 0) return { title: 'Nessuna decisione con questi filtri', text: 'Prova a togliere un filtro o ad allargare il periodo.' };
  return {
    title: 'Ancora nessuna decisione',
    text: 'Quando Arianna manda qualcosa a un modello, a un canale o a un sito, qui compare la decisione del gateway. Le conversazioni in incognito non compaiono mai.',
  };
}

/** Allowed towards the cloud with Privato or Segreto: the line of the left bar warns about these. */
export function isPrivateOut(entry: Pick<GatewayLogEntry, 'decision' | 'locality' | 'label' | 'targetKind'>): boolean {
  return entry.decision === 'allow' && entry.locality === 'cloud' && (entry.label === 'L2' || entry.label === 'L3') && entry.targetKind !== 'link';
}

/** What the core says of the text of one exit (D-297). */
export type GatewayTextState = 'text' | 'blocked' | 'local' | 'private' | 'gone' | 'none';

export interface GatewayTextPart {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface GatewayText {
  id: string;
  state: GatewayTextState;
  label: Label;
  parts?: GatewayTextPart[];
  bytes?: number;
  verified?: boolean | null;
  /** What it was about (D-297): the path, the search, the skill, the site. */
  subject?: string | null;
}

export const TEXT_FROM_MAC = 'Il testo si legge dal Mac.';
export const TEXT_GONE = 'Testo non più disponibile (conversazione eliminata o oltre 30 giorni).';

/** «Fermata: …» of a blocked exit, by its label: never its text. */
export function blockedText(label: Label): string {
  if (label === 'L2' || label === 'L3') return `Fermata: conteneva un dato ${LABEL_TEXT[label]}. Non è uscito nulla e il testo non si conserva.`;
  return 'Fermata: non è uscito nulla e il testo non si conserva.';
}

/**
 * Why the detail shows no text without even asking the core: from the phone
 * (the route is Mac only), a blocked exit, an exit that stayed on the Mac,
 * an allowed one above Interno. Null: the page asks for it.
 */
export function textNotice(entry: Pick<GatewayLogEntry, 'decision' | 'locality' | 'label'>, remote: boolean): string | null {
  if (entry.decision === 'block') return blockedText(entry.label);
  if (entry.locality !== 'cloud') return 'Destinazione sul Mac: il testo non è uscito e non si conserva.';
  if (entry.label === 'L2' || entry.label === 'L3') return 'Uscita Privata (l’indirizzo di un link o una richiesta del browser): il testo non si conserva.';
  if (remote) return TEXT_FROM_MAC;
  return null;
}

/** What the core answered, when it is not a text. */
export function textStateNotice(text: Pick<GatewayText, 'state' | 'label'>): string | null {
  switch (text.state) {
    case 'text':
      return null;
    case 'blocked':
      return blockedText(text.label);
    case 'local':
      return 'Destinazione sul Mac: il testo non è uscito e non si conserva.';
    case 'private':
      return 'Uscita Privata: il testo non si conserva.';
    case 'gone':
      return TEXT_GONE;
    case 'none':
      return 'Testo non salvato: l’uscita è precedente alla conservazione dei testi, o non è legata a una conversazione o a una card (per esempio il browser guidato da te).';
  }
}

/** All the parts, in the order they left, as «Copia» puts them on the clipboard. */
export function copyOfText(parts: readonly GatewayTextPart[]): string {
  return parts.map((part) => part.text).join('\n\n');
}

/** «2,1 KB», with «troncato a 1 MB» when a part was cut, and the number of parts when more than one. */
export function textSizeText(text: Pick<GatewayText, 'parts' | 'bytes'>): string {
  const parts = text.parts ?? [];
  const size = bytesText(text.bytes ?? parts.reduce((sum, part) => sum + part.bytes, 0));
  const count = parts.length > 1 ? ` in ${String(parts.length)} parti` : '';
  return `${size}${count}${parts.some((part) => part.truncated) ? ' · troncato a 1 MB' : ''}`;
}

/** Whether the kept text is the one the log measured (its sha256), in words. */
export function verifiedText(verified: boolean | null | undefined): string {
  if (verified === true) return 'Coincide con l’impronta (sha256) scritta nel registro al momento dell’uscita.';
  if (verified === false) return 'Non coincide con l’impronta scritta nel registro: segnalalo.';
  return 'Troncato: l’impronta del registro non si può confrontare.';
}

/** The name of each kind of exit (D-297, «Cosa era»): L0, shown from the phone too. */
const WHAT_TEXT: Record<string, string> = {
  brief: 'Istruzioni iniziali',
  'project-note': 'Nota del progetto',
  'local-turn': 'Passo del modello locale',
  'cloud-text': 'Richiesta di Arianna a Claude',
  'mcp-skills': 'Elenco delle skill',
  'mcp-skill': 'Skill',
  'mcp-kb-search': 'Ricerca nella KB',
  'mcp-kb-read': 'Lettura nota',
  'mcp-web-page': 'Pagina web',
  'mcp-web-address': 'Indirizzo di una pagina web',
};

const DENIED = '-denied';

/** «Lettura nota», «Accesso negato (Lettura nota)»; for an exit of no kind, its destination. */
export function whatText(entry: Pick<GatewayLogEntry, 'what' | 'targetKind' | 'target'>): string {
  const what = entry.what;
  if (what === null) return targetText(entry.targetKind, entry.target);
  if (what.endsWith(DENIED)) {
    const tool = WHAT_TEXT[what.slice(0, -DENIED.length)];
    return tool === undefined ? 'Accesso negato' : `Accesso negato (${tool})`;
  }
  return WHAT_TEXT[what] ?? 'Uscita';
}

/** The exit with its subject when the Mac has it: «Lettura nota · kb/a.md», «Accesso negato a kb/b.md». */
export function exitText(entry: Pick<GatewayLogEntry, 'what' | 'targetKind' | 'target'>, subject: string | null | undefined): string {
  if (subject === null || subject === undefined || subject === '') return whatText(entry);
  if (entry.what?.endsWith(DENIED) === true) return `Accesso negato a ${subject}`;
  return `${whatText(entry)} · ${subject}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('it-IT')} ${n === 1 ? one : many}`;
}

/** «20 uscite · 16 ammesse · 4 bloccate · 48 KB»; a group of one says nothing more than its row. */
export function groupCounts(group: Pick<GatewayLogGroup, 'count' | 'allowed' | 'blocked' | 'bytes'>): string {
  const parts = [plural(group.count, 'uscita', 'uscite'), plural(group.allowed, 'ammessa', 'ammesse'), plural(group.blocked, 'bloccata', 'bloccate')];
  if (group.bytes !== null) parts.push(bytesText(group.bytes));
  return parts.join(' · ');
}

/** The groups already shown and the next page, without repeating one. */
export function appendGroups(shown: readonly GatewayLogGroup[], page: readonly GatewayLogGroup[]): GatewayLogGroup[] {
  const ids = new Set(shown.map((group) => group.entry.id));
  return [...shown, ...page.filter((group) => !ids.has(group.entry.id))];
}

/**
 * The exits of one group, newest first, a page of 100, with the filters of
 * the page but the outcome: the same exits its counts count.
 */
export function requestQuery(key: string, before?: string | null, filters: GatewayLogFilters = EMPTY_FILTERS): string {
  const rest = queryOf({ ...filters, decision: '' }, before);
  const params = new URLSearchParams(rest.slice(1));
  params.set('request', key);
  params.set('limit', '100');
  return `?${params.toString()}`;
}

/** The outcome of a group, in words: «ammesse», «bloccate» or «con blocchi». */
export function groupDecision(group: Pick<GatewayLogGroup, 'blocked' | 'allowed'>): string {
  if (group.blocked === 0) return 'ammesse';
  if (group.allowed === 0) return 'bloccate';
  return 'con blocchi';
}

/** «Claude e altre · fuori dal Mac»: a line with an exit to the cloud never reads «sul Mac». */
export function groupHeadline(group: Pick<GatewayLogGroup, 'headline' | 'targets' | 'cloud' | 'count'>): { target: string; place: string } {
  const target = `${targetText(group.headline.targetKind, group.headline.target)}${group.targets > 1 ? ' e altre' : ''}`;
  if (group.cloud === 0) return { target, place: 'sul Mac' };
  return { target, place: group.cloud === group.count ? 'fuori dal Mac' : `fuori dal Mac (${group.cloud.toLocaleString('it-IT')} di ${group.count.toLocaleString('it-IT')})` };
}

/** Who asked a line: the agents that worked in the cloud («Designer e Coder»), else Arianna. */
export function groupAsker(group: Pick<GatewayLogGroup, 'agents' | 'entry'>): string {
  if (group.agents.length === 0) return group.entry.agent === null ? 'Arianna' : askerText(group.entry);
  const names = group.agents.map((agent) => agentName(agent));
  return names.length === 1 ? (names[0] ?? 'Arianna') : `${names.slice(0, -1).join(', ')} e ${names.at(-1) ?? ''}`;
}
