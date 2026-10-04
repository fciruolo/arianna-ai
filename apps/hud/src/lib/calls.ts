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

/** The line of a receipt: who called, how long, how it ended. */
export function receiptText(call: CallInfo): string {
  const who = call.direction === 'in' ? 'Hai chiamato Arianna' : 'Arianna ti ha chiamato';
  if (call.status === 'scheduled') return `Chiamata programmata per le ${new Date(call.scheduledAt ?? call.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
  if (call.status === 'missed') return 'Arianna ti ha cercato: chiamata persa';
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
    }[code] ?? 'La chiamata non è partita.'
  );
}

/** What the incoming call screen says about why Arianna calls. */
export const RING_TEXT: Record<'waiting' | 'task-done' | 'scheduled', string> = {
  waiting: 'Un lavoro aspetta una tua risposta',
  'task-done': 'Ti chiama per il lavoro che le avevi chiesto',
  scheduled: 'È l’ora della chiamata che avevi programmato',
};

/** The value of an <input type="datetime-local"> as a Date in local time; undefined when empty or invalid. */
export function localDateTime(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const [, year, month, day, hours, minutes] = match.map(Number);
  const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, hours ?? 0, minutes ?? 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The default of the scheduling field: in one hour, rounded to five minutes, in local time. */
export function inAnHour(now: Date = new Date()): string {
  const date = new Date(now.getTime() + 3_600_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5, 0, 0);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
