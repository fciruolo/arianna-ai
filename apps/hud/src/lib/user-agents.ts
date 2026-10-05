/**
 * The agents the user creates from the Agents page (D-119): types and calls
 * of `/api/agents`, and the Italian text of what a card allows and of the
 * work Arianna can hand to it (tappa T3).
 */

export type UserAgentState = 'disabled' | 'active' | 'official';

export interface CardSummary {
  maxLabel: string;
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
}

export interface UserAgentListing {
  official: UserAgentView[];
  user: UserAgentView[];
  refused: { name: string; reason: string; state: 'disabled' | 'active' }[];
}

export interface TemplateSource extends CardSummary {
  id: string;
}

export interface NewUserAgent {
  name: string;
  description: string;
  template: string;
  prompt: string;
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
export const loadTemplates = async (): Promise<TemplateSource[]> => (await call<{ templates: TemplateSource[] }>('GET', '/api/agents/sources')).templates;
export const createUserAgent = async (input: NewUserAgent): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', '/api/agents', input)).agent;
export const activateUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'activate'))).agent;
export const deactivateUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'deactivate'))).agent;
/** Only from the confirmation of the page: the L1/A1 ceiling is lifted. */
export const promoteUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'promote'), { confirm: true })).agent;
/** The prompt of a user's agent, read only when the page opens it to change it. */
export const loadUserAgentPrompt = async (name: string): Promise<string> => (await call<{ prompt: string }>('GET', path(name, 'prompt'))).prompt;
/** Description and prompt; the core checks them as at the creation. */
export const editUserAgent = async (name: string, edit: { description?: string; prompt?: string }): Promise<UserAgentView> =>
  (await call<{ agent: UserAgentView }>('POST', path(name, 'edit'), edit)).agent;
/** Only from the confirmation of the page, where the user typed the name: the files go into data/agents/eliminati. */
export const deleteUserAgent = async (name: string, typed: string): Promise<{ name: string; folder: string }> =>
  (await call<{ deleted: { name: string; folder: string } }>('POST', path(name, 'delete'), { confirm: typed })).deleted;
/** Only from the confirmation of the page: the card goes back disabled, under the L1/A1 ceiling. */
export const demoteUserAgent = async (name: string): Promise<UserAgentView> => (await call<{ agent: UserAgentView }>('POST', path(name, 'demote'), { confirm: true })).agent;

export interface TemplateText {
  title: string;
  text: string;
  /** What Arianna can hand to an agent of this template (tappa T3). */
  work: string;
  /** A starting point the page offers; invented, like every example. */
  example: { name: string; description: string; prompt: string };
}

export const TEMPLATE_TEXT: Record<string, TemplateText> = {
  answer: {
    title: 'Solo risposte',
    text: 'Nessuno strumento: risponde con quello che sa, sul modello locale. Legge fino ai dati di lavoro (L1), come il prompt che gli scrivi.',
    work: 'Arianna gli passa un testo da trattare (tradurre, riassumere, riscrivere) e lui risponde sul modello locale. Un testo di una conversazione privata (L2) parte solo con la tua approvazione.',
    example: {
      name: 'traduttore',
      description: 'Traduce testi tra italiano e inglese mantenendo il tono',
      prompt:
        'Traduci il testo che ricevi: dall’italiano all’inglese, oppure dall’inglese all’italiano.\nMantieni il tono e la formattazione dell’originale (elenchi, titoli, a capo).\nRispondi solo con la traduzione, senza commenti.',
    },
  },
  code: {
    title: 'Codice',
    text: 'Lavora sul codice dei progetti approvati, con i test, come il Coder ma senza dati privati.',
    work: 'Arianna gli passa lavori sul codice del progetto della conversazione, che fa con Claude Code come il Coder. Un incarico sopra L1 parte solo con la tua approvazione.',
    example: {
      name: 'revisore',
      description: 'Rilegge il codice indicato e corregge errori e casi limite, con i test',
      prompt:
        'Sei un revisore di codice TypeScript.\nLeggi i file che l’incarico indica, cerca errori, casi limite e test mancanti.\nCorreggi solo ciò che serve, fai girare i test e alla fine elenca cosa hai cambiato e perché.',
    },
  },
  web: {
    title: 'Ricerca sul web',
    text: 'Cerca e legge pagine pubbliche; vede solo dati pubblici e propone soltanto.',
    work: 'Per ora non riceve lavoro: gli strumenti del web arrivano più avanti. Puoi già crearlo e prepararne il prompt.',
    example: {
      name: 'ricercatore',
      description: 'Cerca fonti pubbliche su un argomento e le riassume',
      prompt: 'Cerca sul web fonti pubbliche e affidabili sull’argomento dell’incarico.\nPer ogni fonte scrivi titolo, indirizzo e una riga su cosa dice.',
    },
  },
};

/** The order of the templates on the page: the one that works with no cloud first. */
export const TEMPLATE_ORDER: readonly string[] = ['answer', 'code', 'web'];

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
  'repo.write': 'modifica il codice nel worktree',
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

/** The core's error in Italian; the core's message names the field, never the text. */
export function userAgentErrorText(error: unknown): string {
  if (!(error instanceof UserAgentApiError)) return 'Il core non risponde.';
  const message = error.message;
  if (error.status === 409) {
    if (message.startsWith('agents/')) return 'In agents/ c’è già una scheda con questo nome.';
    if (message.startsWith('data/agents')) return 'In data/agents c’è già una scheda con questo nome: spostala o eliminala prima.';
    if (message.startsWith('deactivate')) return 'Disattiva l’agente prima di eliminarlo.';
    return 'Esiste già un agente con questo nome.';
  }
  if (error.status === 404) return 'L’agente non c’è più: ricarica la pagina.';
  if (/was not created from the Agents page/.test(message)) return 'Questo agente non è nato da questa pagina: resta ufficiale.';
  if (/does not match any template/.test(message)) return 'La scheda è stata cambiata a mano oltre il suo modello: non può tornare fra i tuoi agenti.';
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
