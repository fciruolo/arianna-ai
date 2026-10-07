import { INCOGNITO_PATH } from './incognito.ts';
import { agentName } from './italian.ts';
import { MODEL_TEXT } from './labels.ts';
import { executorOfModel } from './settings.ts';
import type { CloudExecutorKind, ConversationAgent, ConversationMode } from './types.ts';

/**
 * A new conversation as in Claude Code (D-108): "Nuovo" opens a draft that
 * lives only in the page, with an empty chat and the field ready. The core
 * creates the conversation only with the first message, so an empty
 * conversation never reaches the list. Pure: the store and the page use it.
 */
export interface Draft {
  /** A new number for each draft opened: the page starts a fresh field for each. */
  key: number;
  mode: ConversationMode;
  /** The approved project of a work conversation, by name. */
  project?: string | undefined;
  /** Who answers in place of Arianna (D-111d): the direct chat with an agent, as its card allows. */
  agent?: ConversationAgent | undefined;
  /** An incognito conversation (D-136): with Arianna only, never with a direct agent. */
  incognito?: boolean | undefined;
  /** "Prova in chat" of a local model (D-142): an incognito private draft where only that catalog model answers. */
  trialModel?: string | undefined;
  /**
   * Set once the core created the conversation but the first message did not
   * go through: a retry sends to it, never creates a second one.
   */
  conversationId: string | null;
}

export const DRAFT_PATH = '/nuova';

/** What "Nuovo" chose: the mode, the project, and who answers. */
export type DraftChoice = Pick<Draft, 'mode' | 'project' | 'agent' | 'incognito' | 'trialModel'>;

const MODE_WORD: Record<ConversationMode, string> = { private: 'privata', work: 'lavoro' };

/** An agent id as the core writes it: Arianna is never one. */
const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const isAgentId = (value: string | null | undefined): value is string => typeof value === 'string' && AGENT_ID.test(value) && value !== 'arianna';

/**
 * `/nuova?tipo=privata`, `/nuova?tipo=lavoro&progetto=arianna`, with an agent
 * `/nuova?con=traduttore&tipo=lavoro`: a reload comes back to the draft.
 */
export function draftPath(choice: DraftChoice): string {
  // Incognito (D-136): always the same address, the choice lives in the state of the history entry.
  if (choice.incognito === true) return INCOGNITO_PATH;
  const params = new URLSearchParams();
  if (isAgentId(choice.agent)) params.set('con', choice.agent);
  params.set('tipo', MODE_WORD[choice.mode]);
  if (choice.mode === 'work' && choice.project !== undefined && choice.project !== '') params.set('progetto', choice.project);
  return `${DRAFT_PATH}?${params.toString()}`;
}

/**
 * The draft an address asks for, or undefined for any other address. An
 * unknown type is a private one. `tipo=coder` is the address of the first
 * direct chat (D-111c), read as `con=coder&tipo=lavoro`.
 */
export function draftFromAddress(pathname: string, search: string): DraftChoice | undefined {
  if (pathname !== DRAFT_PATH && pathname !== `${DRAFT_PATH}/`) return undefined;
  const params = new URLSearchParams(search);
  const kind = params.get('tipo');
  const asked = kind === 'coder' ? 'coder' : params.get('con');
  const agent = isAgentId(asked) ? { agent: asked } : {};
  const mode: ConversationMode = kind === 'lavoro' || kind === 'coder' ? 'work' : 'private';
  const project = mode === 'work' ? params.get('progetto')?.trim() : undefined;
  return { mode, ...(project === undefined || project === '' ? {} : { project }), ...agent };
}

/** Who answers in a draft of this choice: an agent id, never Arianna; what its card allows is checked against the list (D-111d). */
export function choiceAgent(choice: DraftChoice): ConversationAgent | undefined {
  return choice.incognito !== true && isAgentId(choice.agent) ? choice.agent : undefined;
}

/** The same choice: the page does not open a draft again for it. */
export function sameChoice(a: DraftChoice, b: DraftChoice): boolean {
  return a.mode === b.mode && a.project === b.project && a.agent === b.agent && (a.incognito === true) === (b.incognito === true) && a.trialModel === b.trialModel;
}

/** What stays out of Arianna's hands in a direct chat on Claude or Codex (D-111, D-140): also said where such a conversation is deleted. */
export const SESSION_COPY = 'Claude Code e Codex tengono una copia della sessione nella tua home: eliminare la conversazione qui non la cancella.';

const PROVIDER: Record<CloudExecutorKind, string> = { claude: 'Claude (Anthropic)', codex: 'Codex (OpenAI)' };
const SHORT: Record<CloudExecutorKind, string> = { claude: 'Claude', codex: 'Codex' };

/**
 * Where the messages of a direct chat may go (D-140): every cloud executor of
 * the agent's card that runs now, the one of the chosen model first. The
 * model is a preference of the router, not a promise: with its executor out
 * of quota the step goes to the other, so a privacy warning names both.
 * Claude when nothing is known, as before.
 */
export function cloudTargets(executors: readonly CloudExecutorKind[] | undefined, model: string | null): CloudExecutorKind[] {
  const known: CloudExecutorKind[] = executors === undefined || executors.length === 0 ? ['claude'] : [...executors];
  const chosen: CloudExecutorKind | undefined = model === null ? undefined : executorOfModel(model);
  return chosen !== undefined && known.includes(chosen) ? [chosen, ...known.filter((item) => item !== chosen)] : known;
}

/**
 * Who answers a direct chat on the cloud, and with what (D-141, asked by the
 * user: "se apro la singola chat del coder chi mi risponde?"): always the
 * agent, never Arianna; the model chosen here, or the router at each message;
 * and the model of its latest answer, when there is one.
 */
export function whoAnswers(agent: string, model: string | null, last: string | null): string {
  const chosen = model === null ? 'il modello che il router sceglie a ogni messaggio' : (MODEL_TEXT[model] ?? model);
  const latest = last === null ? '' : ` · ultima risposta: ${MODEL_TEXT[last] ?? last}`;
  return `Risponde ${agentName(agent)}, con ${chosen}${latest}`;
}

/** "Claude (Anthropic)", or "Claude (Anthropic) o Codex (OpenAI)" while the router chooses. */
export function providerText(targets: readonly CloudExecutorKind[]): string {
  return targets.map((target) => PROVIDER[target]).join(' o ');
}

/** "Claude", "Codex", "Claude o Codex": for the short badges. */
export function shortTarget(targets: readonly CloudExecutorKind[]): string {
  return targets.map((target) => SHORT[target]).join(' o ');
}

/** "al Coder", "a traduttore": the name of an agent after "a". */
export function toAgent(agent: string): string {
  const name = agentName(agent);
  return agent === 'coder' ? `al ${name}` : `a ${name}`;
}

/** The warning of a direct chat with an agent on Claude or Codex, plain and never hidden (D-111d, D-140). */
export function cloudWarning(agent: string, project: string | undefined, targets: readonly CloudExecutorKind[] = ['claude']): string {
  const files = project === undefined || project === '' ? '' : `, insieme ai file del progetto ${project} che ${agentName(agent)} apre`;
  return `Ogni messaggio va così com'è a ${providerText(targets)}${files}. Arianna non lo filtra. Per dati personali usa una conversazione privata. ${SESSION_COPY}`;
}

/** The note of a direct chat with a local agent: nothing leaves the Mac. */
export function localNote(agent: string): string {
  return `${agentName(agent)} risponde con il modello locale: niente esce dal Mac. Arianna non è in mezzo.`;
}

/** Above this many characters a message of a direct chat on Claude asks before it goes (D-111, risposta 5). */
export const LONG_TO_CLAUDE = 4000;

/** Whether a message of a direct chat asks "Va davvero a Claude?" first: only when it goes to Claude. */
export function asksBeforeClaude(cloud: boolean, text: string): boolean {
  return cloud && text.length > LONG_TO_CLAUDE;
}

/** What the first message may be: a text for Arianna or the agent; the "/" commands work once the conversation exists. */
export function firstMessageProblem(text: string, goesToArianna: (draft: string) => boolean, agent?: ConversationAgent): string | undefined {
  if (text.trim() === '') return 'Scrivi il primo messaggio.';
  if (!goesToArianna(text)) return `I comandi con "/" funzionano dopo il primo messaggio: scrivi prima ${agent === undefined ? 'ad Arianna' : toAgent(agent)}.`;
  return undefined;
}

/** What the first "Invia" does: create the conversation, or send to the one already created by a failed attempt. */
export function draftStep(draft: Pick<Draft, 'conversationId'>): { kind: 'create' } | { kind: 'send'; conversationId: string } {
  return draft.conversationId === null ? { kind: 'create' } : { kind: 'send', conversationId: draft.conversationId };
}

/** Why the project of a work draft cannot be used, said before the first message; undefined when it can, or while the list is unknown. */
export function draftProjectProblem(draft: Pick<Draft, 'mode' | 'project'>, approved: readonly string[] | undefined): string | undefined {
  if (draft.mode !== 'work' || draft.project === undefined || approved === undefined) return undefined;
  return approved.includes(draft.project)
    ? undefined
    : `Il progetto "${draft.project}" non è fra quelli approvati: apri "Nuovo" e scegline un altro, o lascia la conversazione senza progetto.`;
}

/**
 * What "Invia" does with a message of the direct chat (D-111): `send`, `ask`
 * "Va davvero a Claude?" first, or `wait` while the question is open. Only
 * the button of the question confirms: Enter again, or a held key, never does.
 * A text that does not go to Claude (a note, a command) never asks.
 */
export function longMessageStep(
  cloud: boolean,
  text: string,
  goesToClaude: boolean,
  state: { asking: boolean; confirmed: boolean },
): 'send' | 'ask' | 'wait' {
  if (!goesToClaude || !asksBeforeClaude(cloud, text) || state.confirmed) return 'send';
  return state.asking ? 'wait' : 'ask';
}
