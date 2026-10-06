/**
 * The direct chat with the Coder (D-111): how full its Claude Code session
 * is, for the indicator in the header. Pure: the page uses it.
 */

/** The context window of the Claude models the Coder runs on (tokens). */
export const CONTEXT_WINDOW = 200_000;

export interface ContextMeter {
  /** "34k di 200k", or "—" before the first answer. */
  text: string;
  /** 0-100, rounded; 0 before the first answer. */
  percent: number;
  /** ok below 60%, warn up to 85%, full above: the session is near its limit and Claude Code compacts it. */
  level: 'ok' | 'warn' | 'full';
}

const thousands = (tokens: number): string => (tokens < 1000 ? String(tokens) : `${String(Math.round(tokens / 1000))}k`);

export function contextMeter(tokens: number | null, window = CONTEXT_WINDOW): ContextMeter {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return { text: '—', percent: 0, level: 'ok' };
  const percent = Math.min(100, Math.round((tokens / window) * 100));
  return { text: `${thousands(tokens)} di ${thousands(window)}`, percent, level: percent > 85 ? 'full' : percent >= 60 ? 'warn' : 'ok' };
}

/** What the indicator says to a screen reader and on hover. */
export function contextTitle(meter: ContextMeter): string {
  if (meter.text === '—') return 'Contesto del Coder: ancora vuoto, si riempie con le risposte.';
  const tail = meter.level === 'full' ? ' Quasi pieno: Claude Code riassumerà la sessione, oppure apri una conversazione nuova.' : '';
  return `Contesto del Coder: ${meter.text} token usati (${String(meter.percent)}%).${tail}`;
}
