/**
 * The agents the user creates from the Agents page (D-119): types and calls
 * of `/api/agents`, and the Italian text of what a card allows and of the
 * work Arianna can hand to it (tappa T3). Tappa T3b: the permissions chosen
 * within the list, and the confirmation of what changes.
 */

export type UserAgentState = 'disabled' | 'active' | 'official';

export interface CardSummary {
  maxLabel: string;
  /** The label the gateway gives the prompt (tappa T3b). */
  promptLabel?: string;
  cloudMaxLabel?: string;
  executors: string[];
  tools: string[];
  trifecta: { private_data: boolean; untrusted_content: boolean; external_comms: boolean };
  autonomy: string;
  approvals: string[];
  limits: { maxSteps: number; maxMinutes: number; maxCost: number };
}

/** Where a step Arianna delegates to the agent runs; null: it takes none yet (D-119, tappa T3). */
export type UserAgentWork = 'claude' | 'local' | null;

export interface UserAgentView {
  name: string;
  description: string;
  state: UserAgentState;
  card: CardSummary;
  works: UserAgentWork;
  /** An official agent created from this page and promoted: it can go back among the user's ones. */
  fromPage?: true;
  /** The permissions as chosen on the page; null for an official card beyond the user's list. */
  permissions: UserPermissions | null;
  /** `agency`: a card of agency-agents, which stays at L0. */
  origin: 'page' | 'agency';
}

/** What the user chooses within the ceiling (tappa T3b). */
export interface UserPermissions {
  executor: 'local' | 'claude';
  tools: string[];
  autonomy: 'A0' | 'A1';
  maxSteps: number;
  maxMinutes: number;
}

/** What the page offers: starting points and the list the permissions come from. */
export interface UserAgentSources {
  presets: { id: string; permissions: UserPermissions }[];
  allowed: {
    executors: string[];
    tools: Record<string, string[]>;
    acting: string[];
    limits: { maxSteps: number; maxMinutes: number };
    trifecta: CardSummary['trifecta'];
  };
  claudeTools: Record<string, string[]>;
}

export interface PermissionChange {
  field: 'executor' | 'tools' | 'autonomy' | 'maxSteps' | 'maxMinutes' | 'maxLabel' | 'promptLabel';
  before: string | number | string[] | null;
  after: string | number | string[];
}

/** What the core will write, shown before it does; `confirmation` null: nothing of the permissions changes. */
export interface AgentProposal {
  name: string;
  confirmation: string | null;
  before: CardSummary | null;
  after: CardSummary;
  changes: PermissionChange[];
  trifecta: CardSummary['trifecta'];
  cloud: { executor: 'claude'; briefMax: string; promptLabel: string; claudeTools: string[] } | null;
  expiresInMs: number;
}

export interface UserAgentListing {
  official: UserAgentView[];
  user: UserAgentView[];
  refused: { name: string; reason: string; state: 'disabled' | 'active' }[];
}

export interface NewUserAgent {
  name: string;
  description: string;
  prompt: string;
  permissions: UserPermissions;
}

export interface UserAgentEdit {
  description?: string;
  prompt?: string;
  permissions?: UserPermissions;
}

export const MAX_USER_PROMPT = 4000;
export const USER_AGENT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

export class UserAgentApiError extends Error {
  override name = 'UserAgentApiError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // The core takes a POST only with a JSON body: `{}` when there is nothing to send.
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new UserAgentApiError(response.status, typeof data.error === 'string' ? data.error : `HTTP ${String(response.status)}`);
  return data as T;
}

const path = (name: string, action: string): string => `/api/agents/${encodeURIComponent(name)}/${action}`;

export const listUserAgents = (): Promise<UserAgentListing> => call('GET', '/api/agents');
export const loadSources = (): Promise<UserAgentSources> => call('GET', '/api/agents/sources');
/** What the new card would be: nothing is written yet. */
export const prepareUserAgent = async (input: NewUserAgent): Promise<AgentProposal> => (await call<{ proposal: AgentProposal }>('POST', '/api/agents/prepare', input)).proposal;
/** Only from the confirmation of the page, with the id `prepareUserAgent` returned for this same input. */
export const createUserAgent = async (input: NewUserAgent, confirmation: string | null): Promise<UserAgentView> =>
  (await call<{ agent: UserAgentView }>('POST', '/api/agents', { ...input, ...(confirmation === null ? {} : { confirmation }) })).agent;
export const activateUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'activate'))).agent;
export const deactivateUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'deactivate'))).agent;
/** Only from the confirmation of the page: the L1/A1 ceiling is lifted. */
export const promoteUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'promote'), { confirm: true })).agent;
/** The prompt of a user's agent, read only when the page opens it to change it. */
export const loadUserAgentPrompt = async (name: string): Promise<string> => (await call<{ prompt: string }>('GET', path(name, 'prompt'))).prompt;
/** What an edit would change; the confirmation id is null when only the texts change. */
export const prepareUserAgentEdit = async (name: string, edit: UserAgentEdit): Promise<AgentProposal> =>
  (await call<{ proposal: AgentProposal }>('POST', path(name, 'prepare'), edit)).proposal;
/** Description, prompt and permissions; the core checks them as at the creation, a change of permissions with its confirmation. */
export const editUserAgent = async (name: string, edit: UserAgentEdit, confirmation: string | null = null): Promise<UserAgentView> =>
  (await call<{ agent: UserAgentView }>('POST', path(name, 'edit'), { ...edit, ...(confirmation === null ? {} : { confirmation }) })).agent;
/** Only from the confirmation of the page, where the user typed the name: the files go into data/agents/eliminati. */
export const deleteUserAgent = async (name: string, typed: string): Promise<{ name: string; folder: string }> =>
  (await call<{ deleted: { name: string; folder: string } }>('POST', path(name, 'delete'), { confirm: typed })).deleted;
/** Only from the confirmation of the page: the card goes back disabled, under the L1/A1 ceiling. */
export const demoteUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'demote'), { confirm: true })).agent;

export interface PresetText {
  title: string;
  text: string;
  /** A starting point the page offers; invented, like every example. */
  example: { name: string; description: string; prompt: string };
}

/** The starting points of the page (tappa T3b): they fill the permissions, which the user can then change. */
export const PRESET_TEXT: Record<string, PresetText> = {
  answer: {
    title: 'Solo risposte',
    text: 'Sul modello locale, senza strumenti: Arianna gli passa un testo da trattare (tradurre, riassumere, riscrivere) e lui risponde.',
    example: {
      name: 'traduttore',
      description: 'Traduce testi tra italiano e inglese mantenendo il tono',
      prompt:
        'Traduci il testo che ricevi: dall’italiano all’inglese, oppure dall’inglese all’italiano.\nMantieni il tono e la formattazione dell’originale (elenchi, titoli, a capo).\nRispondi solo con la traduzione, senza commenti.',
    },
  },
  code: {
    title: 'Codice',
    text: 'Con Claude Code sul codice del progetto della conversazione: legge, modifica e prova, come il Coder ma senza dati privati.',
    example: {
      name: 'revisore',
      description: 'Rilegge il codice indicato e corregge errori e casi limite, con i test',
      prompt:
        'Sei un revisore di codice TypeScript.\nLeggi i file che l’incarico indica, cerca errori, casi limite e test mancanti.\nCorreggi solo ciò che serve, fai girare i test e alla fine elenca cosa hai cambiato e perché.',
    },
  },
};

/** The order of the starting points on the page: the one that works with no cloud first. */
export const PRESET_ORDER: readonly string[] = ['answer', 'code'];

const WORK_TEXT: Record<'claude' | 'local' | 'none', string> = {
  claude: 'riceve lavoro da Arianna (Claude Code)',
  local: 'riceve lavoro da Arianna (modello locale)',
  none: 'non riceve ancora lavoro',
};

/** One short line on the work an agent gets from Arianna, for the lists. */
export function workText(works: UserAgentWork): string {
  return WORK_TEXT[works ?? 'none'];
}

const TOOL_TEXT: Record<string, string> = {
  'repo.read': 'legge il codice del progetto',
  'repo.write': 'modifica il codice del progetto',
  'repo.test': 'esegue i test',
  'task.update': 'sposta le carte della conversazione',
  'user.ask': 'ti fa domande in chat',
  'web.search': 'cerca sul web',
  'web.fetch': 'legge pagine web',
  'kb.search': 'cerca nella base di conoscenza',
  'kb.read': 'legge la base di conoscenza',
  'kb.write': 'scrive note in kb/inbox',
  'task.create': 'crea carte in Inbox',
  'task.delegate': 'delega passi ad altri agenti',
  'channel.send': 'manda messaggi su un canale esterno',
  'file.delete': 'cancella file',
};

const LABEL_TEXT: Record<string, string> = {
  L0: 'L0, solo dati pubblici',
  L1: 'L1, dati di lavoro',
  L2: 'L2, dati privati',
};

const AUTONOMY_TEXT: Record<string, string> = {
  A0: 'A0, propone soltanto',
  A1: 'A1, agisce solo nella sandbox',
  A2: 'A2, azioni reversibili fuori dalla sandbox',
  A3: 'A3, anche azioni esterne',
};

const EXECUTOR_TEXT: Record<string, string> = { local: 'modello locale', claude: 'Claude Code', codex: 'Codex' };

/** What a card allows, one line per fact, in Italian. */
export function permissionLines(card: CardSummary): string[] {
  const lines = [
    `Dati: ${LABEL_TEXT[card.maxLabel] ?? card.maxLabel}${card.cloudMaxLabel === undefined ? '' : ` (in cloud al massimo ${card.cloudMaxLabel})`}`,
    `Autonomia: ${AUTONOMY_TEXT[card.autonomy] ?? card.autonomy}`,
    `Gira su: ${card.executors.map((executor) => EXECUTOR_TEXT[executor] ?? executor).join(', ')}`,
    card.tools.length === 0 ? 'Strumenti: nessuno' : `Strumenti: ${card.tools.map((tool) => TOOL_TEXT[tool] ?? tool).join('; ')}`,
    `Limiti: ${String(card.limits.maxSteps)} passi, ${String(card.limits.maxMinutes)} minuti per task`,
  ];
  if (card.approvals.length > 0) lines.push(`Con la tua approvazione: ${card.approvals.join(', ')}`);
  return lines;
}

/**
 * The permissions as the core will accept them (tappa T3b), after a click:
 * the local model takes no tools, A0 drops the tools that act, limits stay
 * whole numbers from 1 to the ceiling. The core checks again.
 */
export function adjustPermissions(permissions: UserPermissions, allowed: UserAgentSources['allowed']): UserPermissions {
  const offered = allowed.tools[permissions.executor] ?? [];
  const tools = offered.filter((tool) => permissions.tools.includes(tool) && !(permissions.autonomy === 'A0' && allowed.acting.includes(tool)));
  const whole = (value: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : 1);
  return {
    executor: permissions.executor,
    tools,
    autonomy: permissions.autonomy,
    maxSteps: whole(permissions.maxSteps, allowed.limits.maxSteps),
    maxMinutes: whole(permissions.maxMinutes, allowed.limits.maxMinutes),
  };
}

/** Two choices are the same, whatever the order of the tools. */
export function samePermissionsOf(a: UserPermissions, b: UserPermissions): boolean {
  return (
    a.executor === b.executor &&
    a.autonomy === b.autonomy &&
    a.maxSteps === b.maxSteps &&
    a.maxMinutes === b.maxMinutes &&
    a.tools.length === b.tools.length &&
    a.tools.every((tool) => b.tools.includes(tool))
  );
}

const FIELD_TEXT: Record<PermissionChange['field'], string> = {
  executor: 'Dove lavora',
  tools: 'Strumenti',
  autonomy: 'Autonomia',
  maxSteps: 'Passi per lavoro',
  maxMinutes: 'Minuti per lavoro',
  maxLabel: 'Dati che può leggere',
  promptLabel: 'Etichetta del prompt',
};

function valueText(field: PermissionChange['field'], value: PermissionChange['before']): string {
  if (value === null) return '—';
  if (Array.isArray(value)) return value.length === 0 ? 'nessuno' : value.map((tool) => TOOL_TEXT[tool] ?? tool).join('; ');
  if (field === 'executor') return String(value).split(', ').map((executor) => EXECUTOR_TEXT[executor] ?? executor).join(', ');
  if (field === 'autonomy') return AUTONOMY_TEXT[String(value)] ?? String(value);
  if (field === 'maxLabel' || field === 'promptLabel') return LABEL_TEXT[String(value)] ?? String(value);
  return String(value);
}

/** One row per field that changes, in Italian: what it was (— for a new card) and what it becomes. */
export function changeRows(proposal: AgentProposal): { field: string; before: string; after: string }[] {
  return proposal.changes.map((change) => ({ field: FIELD_TEXT[change.field], before: valueText(change.field, change.before), after: valueText(change.field, change.after) }));
}

/** The three sides of the lethal trifecta, each with why it is open or closed for a user's agent. */
export function trifectaRows(trifecta: CardSummary['trifecta']): { side: string; open: boolean; why: string }[] {
  return [
    {
      side: 'Dati privati',
      open: trifecta.private_data,
      why: trifecta.private_data ? 'legge dati privati (L2)' : 'legge al massimo dati di lavoro (L1), mai le conversazioni private',
    },
    {
      side: 'Contenuti non fidati',
      open: trifecta.untrusted_content,
      why: trifecta.untrusted_content ? 'il codice di un progetto e i testi che riceve possono contenere istruzioni ostili' : 'non legge contenuti di terzi',
    },
    {
      side: 'Comunicazione esterna',
      open: trifecta.external_comms,
      why: trifecta.external_comms ? 'può mandare dati fuori' : 'niente web né canali; Claude Code lavora in una sandbox senza rete',
    },
  ];
}

/** What leaves the Mac for an agent on Claude; nothing for one on the local model. */
export function cloudLines(cloud: AgentProposal['cloud']): string[] {
  if (cloud === null) return ['Niente esce dal Mac: lavora sul modello locale.'];
  return [
    `Il prompt (${cloud.promptLabel}) e l’incarico di Arianna, fino a ${cloud.briefMax}, vanno a Claude Code passando dal gateway; un incarico sopra ${cloud.briefMax} parte solo con la tua approvazione.`,
    cloud.claudeTools.length === 0
      ? 'In Claude Code non ha strumenti: risponde soltanto.'
      : `In Claude Code usa ${cloud.claudeTools.join(', ')}, solo nella cartella del progetto della conversazione.`,
  ];
}

/** The core's error in Italian; the core's message names the field, never the text. */
export function userAgentErrorText(error: unknown): string {
  if (!(error instanceof UserAgentApiError)) return 'Il core non risponde.';
  const message = error.message;
  if (error.status === 409) {
    if (/prepare the change again/.test(message)) return 'La scheda è cambiata o la conferma è scaduta: rivedi le modifiche e conferma di nuovo.';
    if (message.startsWith('agents/')) return 'In agents/ c’è già una scheda con questo nome.';
    if (message.startsWith('data/agents')) return 'In data/agents c’è già una scheda con questo nome: spostala o eliminala prima.';
    if (message.startsWith('deactivate')) return 'Disattiva l’agente prima di eliminarlo.';
    return 'Esiste già un agente con questo nome.';
  }
  if (error.status === 404) return 'L’agente non c’è più: ricarica la pagina.';
  if (/was not created from the Agents page/.test(message)) return 'Questo agente non è nato da questa pagina: resta ufficiale.';
  if (/needs the confirmation of the user/.test(message) && /permissions/.test(message)) return 'Serve la tua conferma delle modifiche ai permessi.';
  if (/local agent only answers/.test(message)) return 'Sul modello locale l’agente risponde soltanto: niente strumenti.';
  if (/not allowed with A0/.test(message)) return 'Con A0 l’agente propone soltanto: niente modifica del codice né test.';
  if (/max_?[sS]teps/.test(message)) return 'I passi vanno da 1 a 50.';
  if (/max_?[mM]inutes/.test(message)) return 'I minuti vanno da 1 a 45.';
  if (/permissions of a user's agent|^permissions:/.test(message)) return 'La scheda va oltre i permessi ammessi per gli agenti utente: non può stare fra i tuoi agenti.';
  if (/above (L1|A1)|not allowed/.test(message)) return 'La scheda supera il tetto L1/A1 delle schede utente: non può tornare fra i tuoi agenti.';
  if (/as confirmation/.test(message)) return 'Per eliminare scrivi esattamente il nome dell’agente.';
  const field = message.startsWith('the prompt') ? 'Il prompt' : message.startsWith('the name') ? 'Il nome' : 'La descrizione';
  if (/looks like personal data or a secret/.test(message)) return `${field} sembra contenere dati personali o un segreto: non salvato.`;
  if (/value of the vault/.test(message)) return `${field} contiene un valore del vault: non salvato.`;
  if (/control characters/.test(message)) return 'Il prompt contiene caratteri di controllo: sono ammessi solo a capo e tabulazioni.';
  if (/the name is/.test(message)) return 'Il nome va da 2 a 40 caratteri: minuscole, cifre e trattini, e comincia con una lettera.';
  if (/description/.test(message)) return 'La descrizione è una riga sola, al massimo 200 caratteri.';
  if (/prompt/.test(message)) return `Il prompt non può essere vuoto né superare ${String(MAX_USER_PROMPT)} caratteri.`;
  return `Non riuscito: ${message}`;
}
