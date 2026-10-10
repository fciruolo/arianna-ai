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
/**
 * What the voice reads of the conversation (D-072): the latest messages when
 * the call starts, each cut, then everything said or written after them. The
 * window stays anchored to its first message, so every turn's prompt extends
 * the previous one and oMLX reuses its prefix cache; past the maximum it
 * starts again from the latest messages (one turn reads the whole prompt).
 */
export const HISTORY_MESSAGES = 8;
export const HISTORY_MAX_MESSAGES = 40;
export const HISTORY_CHARS = 400;
/**
 * What a call reads from the database to find its window: more than the
 * maximum, system messages in between (with more than 40 of them during a
 * call the anchor falls out of the page and the window starts again: harmless).
 */
export const HISTORY_FETCH = 80;
export const MAX_REPLY_TOKENS = 200;
/** A transcript longer than this is cut: nobody says more in one turn. */
export const MAX_TURN_CHARS = 4000;

export interface VoicePrompt {
  /** Each part with its label, as the gateway checks them before the model reads them. */
  messages: { role: 'system' | 'user' | 'assistant'; content: string; label: Label }[];
  /** The highest label among what the model reads: the reply inherits it. */
  label: Label;
  /** The id of the first message read: the next turn starts from it too. */
  anchor: string | undefined;
}

/**
 * The system prompt, then the user and assistant messages from `anchor` on
 * (system messages are left out). Without an anchor, when it is no longer in
 * `history`, or when the window grew past the maximum, it starts again from
 * the latest messages.
 */
export function voicePrompt(history: readonly Message[], floor: Label, anchor?: string, system: { content: string; label: Label } = { content: VOICE_SYSTEM_PROMPT, label: 'L0' }): VoicePrompt {
  const spoken = history.filter((message) => message.role !== 'system');
  const from = anchor === undefined ? -1 : spoken.findIndex((message) => message.id === anchor);
  const kept = from !== -1 && spoken.length - from <= HISTORY_MAX_MESSAGES ? spoken.slice(from) : spoken.slice(-HISTORY_MESSAGES);
  const label = kept.reduce<Label>((highest, message) => maxLabel(highest, message.label), maxLabel(floor, system.label));
  return {
    label,
    anchor: kept[0]?.id,
    messages: [
      { role: 'system', content: system.content, label: system.label },
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

/**
 * What a local agent reads first in a call of its direct chat (D-158): our
 * fixed frame for the spoken answer, then the instructions of its card.
 */
export const AGENT_VOICE_FRAME = [
  'Sei un agente di Arianna e stai parlando al telefono con l’utente nella vostra chat diretta, senza Arianna in mezzo.',
  'Rispondi sempre in italiano, con una o due frasi brevi e naturali: quello che scrivi viene letto ad alta voce.',
  'Niente elenchi, niente markdown, niente emoji, niente link; i numeri scrivili come si dicono.',
  'Non hai strumenti: se una richiesta ne ha bisogno, dillo in una frase. Non chiedere mai credenziali.',
  'I messaggi precedenti della conversazione sono il contesto: possono venire dalla chat scritta.',
  'Le tue istruzioni:',
].join(' ');

export function agentVoiceSystem(instructions: string): string {
  return `${AGENT_VOICE_FRAME}\n${instructions}`;
}

/**
 * Who answers a call (D-158): Arianna, a local agent of a direct chat on its
 * own model, or a cloud agent (the Coder) through a local bridge.
 */
export type Speaker =
  | { kind: 'arianna' }
  | { kind: 'local'; agent: string; name: string; nameLabel: Label; model: string }
  | { kind: 'cloud'; agent: string; name: string; nameLabel: Label };

/** The Coder is "il Coder"; any other agent goes by its id. */
function toAgent(name: string): string {
  return name === 'Coder' ? 'al Coder' : `a ${name}`;
}

/**
 * A fixed greeting said by `speaker`: Arianna's as it is, an agent's with its
 * name in place of hers (the cloud one says it passes the words on).
 */
export function greetingFor(text: string, speaker: Speaker): string {
  if (speaker.kind === 'arianna') return text;
  const rest = text.replace(/^Ciao, sono Arianna\.\s*/, '');
  const intro = speaker.kind === 'cloud' ? `Ciao, sono la linea del ${speaker.name}: quello che mi dici lo passo ${toAgent(speaker.name)}.` : `Ciao, sono ${speaker.name}.`;
  return rest === '' ? intro : `${intro} ${rest}`;
}

/** The fixed texts of a call of a direct chat that differ from Arianna's (D-158). */
export function agentCallText(name: string): { bridged: string; busy: string; stillWorking: string; taskWaiting: string; cannotRead: string; gone: string } {
  return {
    bridged: `Lo passo ${toAgent(name)}, ti dico quando ha finito.`,
    busy: `${name} sta ancora lavorando alla richiesta di prima: aspetta la sua risposta, o fermalo in chat.`,
    stillWorking: `${name} ci sta ancora lavorando: il risultato lo trovi in chat.`,
    taskWaiting: `Per andare avanti ${name} ha bisogno di una tua risposta in chat.`,
    cannotRead: `Questa frase ${name} non può leggerla: scrivila in chat.`,
    gone: `${name} adesso non può rispondere: scrivigli in chat.`,
  };
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

/**
 * Cuts the model's text into sentences while it is written (D-070): a piece
 * ends at `.`, `!`, `?` or `…` followed by a space, or at a line break. Never
 * inside an open `<think>` block or code fence: those are held until closed,
 * so `speakable` can remove them whole.
 */
export function sentenceSplitter(): { push(text: string): string[]; end(): string[] } {
  let buffer = '';
  /** Where a cut is not allowed: inside think blocks and code fences, closed or not. */
  const held = (): [number, number][] => {
    const ranges: [number, number][] = [];
    for (const [open, close] of [
      ['<think>', '</think>'],
      ['```', '```'],
    ] as const) {
      let from = 0;
      for (;;) {
        const start = buffer.indexOf(open, from);
        if (start === -1) break;
        const stop = buffer.indexOf(close, start + open.length);
        const end = stop === -1 ? Infinity : stop + close.length;
        ranges.push([start, end]);
        if (stop === -1) break;
        from = end;
      }
    }
    return ranges;
  };
  const nextCut = (): number | undefined => {
    const ranges = held();
    for (const match of buffer.matchAll(/[.!?…]+(?=\s)|\n/g)) {
      const cut = match.index + match[0].length;
      if (!ranges.some(([start, end]) => match.index >= start && match.index < end)) return cut;
    }
    return undefined;
  };
  return {
    push(text) {
      buffer += text;
      const pieces: string[] = [];
      for (let cut = nextCut(); cut !== undefined; cut = nextCut()) {
        const piece = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut);
        if (piece !== '') pieces.push(piece);
      }
      return pieces;
    },
    end() {
      // An open think block or code fence (the model hit its token limit) is never said.
      const open = held().find(([, end]) => end === Infinity);
      const rest = (open === undefined ? buffer : buffer.slice(0, open[0])).trim();
      buffer = '';
      return rest === '' ? [] : [rest];
    },
  };
}

/** A piece that opens a delegation, once cleaned as it would be said: nothing of it, nor after it, is said. */
export function opensDelegation(piece: string): boolean {
  return speakable(piece).toUpperCase().startsWith(DELEGATION_PREFIX);
}

/** The request of a delegation, from the piece that opened it and those after it. */
export function delegationRequest(pieces: readonly string[]): string {
  return speakable(pieces.join(' ')).slice(DELEGATION_PREFIX.length).trim();
}
