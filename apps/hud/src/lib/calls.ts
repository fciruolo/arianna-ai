import { agentTitle } from './italian.ts';
import type { Conversation, ConversationAgent, ConversationMode } from './types.ts';

/**
 * Calls in the web chat (D-066), pure for the tests: the receipts among the
 * messages, the duration, the Italian texts. The call itself (WebRTC) is in
 * call-session.ts.
 */
export interface CallInfo {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  reason: 'waiting' | 'task-done' | 'scheduled' | null;
  taskId: string | null;
  status: 'scheduled' | 'ringing' | 'connecting' | 'active' | 'ended' | 'missed' | 'skipped' | 'failed';
  scheduledAt: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  delegations: number;
}

/** "3:07", or "1:02:05" past an hour. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(whole % 60)}` : `${String(minutes)}:${pad(whole % 60)}`;
}

/**
 * Who answers a call (D-158): Arianna, or the agent of a direct chat. `name`
 * is the bare name ("Arianna", "Coder"), `the` the name in a sentence ("il
 * Coder"), `subject` the same at the start of one ("Il Coder"), `from`
 * after "da" ("da Arianna", "dal Coder").
 */
export interface Callee {
  agent: ConversationAgent | null;
  name: string;
  the: string;
  subject: string;
  from: string;
}

const ARIANNA: Callee = { agent: null, name: 'Arianna', the: 'Arianna', subject: 'Arianna', from: 'da Arianna' };

/** Arianna for null, otherwise the agent; the Coder takes the article, as elsewhere in the chat. */
export function calleeOf(agent: ConversationAgent | null | undefined): Callee {
  if (agent === null || agent === undefined || agent === 'arianna') return ARIANNA;
  const name = agentTitle(agent);
  return agent === 'coder' ? { agent, name, the: `il ${name}`, subject: `Il ${name}`, from: `dal ${name}` } : { agent, name, the: name, subject: name, from: `da ${name}` };
}

/**
 * Whether a conversation has the phone (D-158) and who answers: every private
 * conversation with Arianna (the secretary's too) and every direct chat with
 * an agent, whatever its mode. Never an incognito conversation (D-136), a
 * system chat or a work conversation with Arianna. Archived ones keep the
 * phone, off (see callBlocker).
 */
export function conversationCallee(conversation: Pick<Conversation, 'mode' | 'agent' | 'origin' | 'incognito'> | undefined): Callee | undefined {
  if (conversation === undefined || conversation.incognito === true || conversation.origin === 'system') return undefined;
  if (conversation.agent !== null) return calleeOf(conversation.agent);
  return conversation.mode === 'private' ? ARIANNA : undefined;
}

/** The same rule for the empty page of a new conversation (D-158): the call creates it. */
export function draftCallee(draft: { mode: ConversationMode; agent?: ConversationAgent | undefined; incognito?: boolean | undefined } | null): Callee | undefined {
  if (draft === null || draft.incognito === true) return undefined;
  if (draft.agent !== undefined) return calleeOf(draft.agent);
  return draft.mode === 'private' ? ARIANNA : undefined;
}

/** The line of a receipt: who called, how long, how it ended. */
export function receiptText(call: CallInfo, callee: Callee = ARIANNA): string {
  const who = call.direction === 'in' ? `Hai chiamato ${callee.the}` : `${callee.subject} ti ha chiamato`;
  if (call.status === 'scheduled') return `Chiamata programmata per le ${new Date(call.scheduledAt ?? call.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
  if (call.status === 'missed') return `${callee.subject} ti ha cercato: chiamata persa`;
  if (call.status === 'skipped') return `Chiamata non fatta (${SKIP_TEXT[call.endReason ?? ''] ?? 'regole delle chiamate'})`;
  if (call.status === 'failed') return `${who}: la chiamata non è partita`;
  if (call.endedAt === null) return `${who}: in corso`;
  const seconds = (Date.parse(call.endedAt) - Date.parse(call.answeredAt ?? call.createdAt)) / 1000;
  const delegations = call.delegations === 0 ? '' : ` · ${String(call.delegations)} ${call.delegations === 1 ? 'lavoro passato' : 'lavori passati'} ad Arianna`;
  return `${who} · ${clock(seconds)}${END_TEXT[call.endReason ?? ''] ?? ''}${delegations}`;
}

const END_TEXT: Record<string, string> = {
  'time-limit': ' · finita per il limite di tempo',
  disconnected: ' · linea caduta',
  'voice-error': ' · errore della voce',
  'core-restart': ' · interrotta dal riavvio',
};

const SKIP_TEXT: Record<string, string> = {
  'quiet-hours': 'fascia di silenzio',
  'daily-limit': 'massimo di chiamate al giorno',
  cancelled: 'annullata',
  'agent-off': 'l’agente non poteva rispondere',
};

/**
 * Where each receipt goes: after the last message written before the call
 * ended (or started, while it is on); -1 before every message.
 */
export function receiptAnchors(messages: readonly { ts: string }[], calls: readonly CallInfo[]): Map<number, CallInfo[]> {
  const anchors = new Map<number, CallInfo[]>();
  for (const call of calls) {
    const at = Date.parse(call.endedAt ?? call.createdAt);
    let index = -1;
    messages.forEach((message, position) => {
      if (Date.parse(message.ts) <= at) index = position;
    });
    anchors.set(index, [...(anchors.get(index) ?? []), call]);
  }
  return anchors;
}

/** Why the phone button does not call, in Italian; undefined when it can. */
export function callBlocker(voiceState: string | null, archived: boolean, busy: boolean): string | undefined {
  if (archived) return 'Ripristina la conversazione per chiamare';
  if (busy) return 'C’è già una chiamata in corso';
  if (voiceState === null) return 'Leggo lo stato della voce…';
  if (voiceState === 'off') return 'Le chiamate sono spente: aggiungi [voice] ad arianna.toml';
  if (voiceState !== 'up') return 'Il servizio voce non è pronto: apri il provino della voce';
  return undefined;
}

/** The errors of POST /api/calls, in Italian (codes of apps/core/src/voice/calls.ts). */
export function callErrorText(message: string): string {
  const code = message.split(':', 1)[0] ?? '';
  return (
    {
      busy: 'C’è già una chiamata in corso.',
      archived: 'La conversazione è archiviata: ripristinala per chiamare.',
      'voice-off': 'Il servizio voce non risponde: guarda il provino della voce.',
      'not-ready': 'Mancano dei modelli: assegna stt, tts e voice in [roles] e scaricali (vedi il provino della voce).',
      'not-found': 'La conversazione non esiste più.',
      'agent-off': 'L’agente non può rispondere adesso: la sua scheda è spenta, il suo esecutore non è disponibile o non c’è un modello locale per lui.',
      invalid: 'Qui non si può chiamare: solo nelle conversazioni private con Arianna e nelle chat dirette con un agente, mai in incognito.',
    }[code] ?? 'La chiamata non è partita.'
  );
}

/** What the incoming call screen says about why Arianna calls. */
export const RING_TEXT: Record<'waiting' | 'task-done' | 'scheduled', string> = {
  waiting: 'Un lavoro aspetta una tua risposta',
  'task-done': 'Ti chiama per il lavoro che avevi chiesto',
  scheduled: 'È l’ora della chiamata che avevi programmato',
};
