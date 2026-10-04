import { maxLabel, type Label } from '@arianna/policy';

import type { Message } from '../conversations.ts';
import type { TrialModel } from './trial.ts';

/**
 * The pure parts of a call (D-066): which models answer, what the voice model
 * reads, and how a reply asks for a delegation. The voice does not think at
 * length: anything that takes work goes to Arianna's task in the same
 * conversation, and the call says "ci lavoro".
 */
export const VOICE_SYSTEM_PROMPT = [
  'Sei Arianna, l’assistente personale dell’utente, e state parlando al telefono.',
  'Rispondi sempre in italiano, con una o due frasi brevi e naturali: quello che scrivi viene letto ad alta voce.',
  'Niente elenchi, niente markdown, niente emoji, niente link; i numeri scrivili come si dicono.',
  'Se l’utente ti chiede un lavoro che richiede tempo o strumenti (cercare, leggere documenti, controllare qualcosa, scrivere codice, preparare un testo lungo), non farlo tu:',
  'rispondi con una sola riga che comincia con "DELEGA:" seguita dalla richiesta riformulata in modo completo e autonomo, senza altro testo.',
  'I messaggi precedenti della conversazione sono il contesto: possono venire dalla chat scritta.',
].join(' ');

export const DELEGATION_PREFIX = 'DELEGA:';
/** What the voice reads of the conversation: the latest messages, each cut. */
export const HISTORY_MESSAGES = 16;
export const HISTORY_CHARS = 1200;
export const MAX_REPLY_TOKENS = 200;
/** A transcript longer than this is cut: nobody says more in one turn. */
export const MAX_TURN_CHARS = 4000;

export interface VoicePrompt {
  /** Each part with its label, as the gateway checks them before the model reads them. */
  messages: { role: 'system' | 'user' | 'assistant'; content: string; label: Label }[];
  /** The highest label among what the model reads: the reply inherits it. */
  label: Label;
}

/** The system prompt, then the latest user and assistant messages; system messages are left out. */
export function voicePrompt(history: readonly Message[], floor: Label): VoicePrompt {
  const kept = history.filter((message) => message.role !== 'system').slice(-HISTORY_MESSAGES);
  const label = kept.reduce<Label>((highest, message) => maxLabel(highest, message.label), floor);
  return {
    label,
    messages: [
      { role: 'system', content: VOICE_SYSTEM_PROMPT, label: 'L0' },
      ...kept.map((message) => ({
        role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: message.body.length > HISTORY_CHARS ? `${message.body.slice(0, HISTORY_CHARS)}…` : message.body,
        label: message.label,
      })),
    ],
  };
}

export type VoiceReply = { kind: 'say'; text: string } | { kind: 'delegate'; request: string };

/**
 * What the model wrote: a delegation when a line starts with the prefix,
 * otherwise words to say, cleaned of what cannot be spoken.
 */
export function parseReply(text: string): VoiceReply {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.toUpperCase().startsWith(DELEGATION_PREFIX));
  if (line !== undefined) {
    const request = line.slice(DELEGATION_PREFIX.length).trim();
    if (request !== '') return { kind: 'delegate', request };
  }
  return { kind: 'say', text: speakable(text) };
}

/** Markdown and emoji out, one line: the reply is read aloud. */
export function speakable(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~>#|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first sentences of a task's answer, to say at the end of a delegation. */
export function summaryToSay(text: string, limit = 400): string {
  const clean = speakable(text);
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return `${end > 80 ? cut.slice(0, end + 1) : cut.trimEnd()} Il resto te l’ho scritto in chat.`;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** A transcript without control characters (tab and newline stay), cut to a turn. */
export function cleanTranscript(text: string): string {
  return text.replace(CONTROL, '').trim().slice(0, MAX_TURN_CHARS);
}

export type CallReadiness =
  | { ready: true; stt: { id: string; family: string }; tts: { id: string; family: string }; voice: string }
  | { ready: false; missing: ('voice' | 'stt' | 'tts')[] };

/**
 * A call needs the three roles assigned, with the stt and tts models on disk,
 * and a local server that serves the voice alias (an endpoint with a `models`
 * table written by hand must list it). It speaks with the voice of `[voice]`
 * when the tts model has it, else with the first of its own (D-067).
 */
export function callReadiness(roles: { voice?: string }, models: readonly TrialModel[], voiceServed = true, wanted?: string): CallReadiness {
  const stt = models.find((model) => model.kind === 'stt' && model.assigned && model.present);
  const tts = models.find((model) => model.kind === 'tts' && model.assigned && model.present);
  // A copied voice is a person's (D-069): never someone else's in its place.
  const fallback = tts?.family === 'qwen3-tts-base' ? undefined : tts?.voices[0];
  const voice = tts === undefined ? undefined : wanted !== undefined && tts.voices.includes(wanted) ? wanted : fallback;
  const missing = [
    ...(roles.voice === undefined || !voiceServed ? ['voice' as const] : []),
    ...(stt === undefined ? ['stt' as const] : []),
    ...(tts === undefined || voice === undefined ? ['tts' as const] : []),
  ];
  if (stt === undefined || tts === undefined || voice === undefined || missing.length > 0) return { ready: false, missing };
  return { ready: true, stt: { id: stt.id, family: stt.family }, tts: { id: tts.id, family: tts.family }, voice };
}

/** Spoken by the call itself, never by the model. */
export const CALL_TEXT = {
  greeting: 'Ciao, sono Arianna. Dimmi pure.',
  delegated: 'Ci lavoro e ti dico appena ho finito.',
  tooMany: 'In questa chiamata ho già passato troppi lavori: scrivimelo in chat e ci penso.',
  privateInWork: 'Questo sembra un dato privato: in una conversazione di lavoro non posso tenerlo. Parliamone in una conversazione privata.',
  modelDown: 'Scusa, in questo momento il modello locale non risponde. Riprova tra poco o scrivimi in chat.',
  stillWorking: 'Ci sto ancora lavorando: ti scrivo il risultato in chat.',
  taskFailed: 'Il lavoro non è riuscito: trovi l’errore in chat.',
  taskWaiting: 'Per andare avanti mi serve una tua risposta in chat.',
  cannotDelegate: 'Non riesco a passare questo lavoro: scrivimelo in chat.',
  cannotRead: 'Questa conversazione non posso leggerla a voce: scrivimi in chat.',
  notUnderstood: 'Scusa, non ho capito: puoi ripetere?',
  notHere: 'Questa risposta non posso dirla qui: guardala in chat.',
  warning: 'Manca un minuto alla fine della chiamata.',
  goodbye: 'Il tempo della chiamata è finito. Ci sentiamo in chat, ciao!',
} as const;
