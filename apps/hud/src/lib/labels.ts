import type { ConversationMode, Label, TaskStatus } from './types.ts';

// Text the user reads is in Italian (docs: user-facing language); code stays in English.

export const LABEL_TEXT: Record<Label, string> = {
  L0: 'L0 pubblico',
  L1: 'L1 lavoro',
  L2: 'L2 privato',
  L3: 'L3 segreto',
};

export const MODE_TEXT: Record<ConversationMode, string> = {
  work: 'Lavoro',
  private: 'Privata',
};

export const MODE_HINT: Record<ConversationMode, string> = {
  work: 'Fino a L1: può usare Claude Code e Codex. Niente dati privati.',
  private: 'Fino a L2: resta sul modello locale. Ciò che esce richiede la tua approvazione.',
};

export const STATUS_TEXT: Record<TaskStatus, string> = {
  inbox: 'In arrivo',
  ready: 'In coda',
  running: 'Al lavoro',
  waiting_user: 'Attende te',
  to_verify: 'Da verificare',
  done: 'Fatto',
  failed: 'Fallito',
};

export const ACTION_TEXT: Record<string, string> = {
  declassify: 'Declassamento',
  budget: 'Budget',
  'dirty-workspace': 'Cartella con modifiche',
  delete: 'Cancellazione',
  send_external: 'Invio all’esterno',
  payment: 'Pagamento',
  call: 'Chiamata',
};

/** The cloud models as the user reads them; an alias not listed is shown as it is. */
export const MODEL_TEXT: Record<string, string> = {
  sonnet: 'Claude Sonnet',
  opus: 'Claude Opus',
  fable: 'Claude Fable (con approvazione)',
  codex: 'Codex',
};

export const EXECUTOR_TEXT: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  local: 'modello locale',
};

/** "L2 → L1" for a declassification detail, undefined if the detail is not one. */
export function declassifyLabels(detail: Record<string, unknown>): string | undefined {
  const { from, to } = detail;
  return typeof from === 'string' && typeof to === 'string' ? `${from} → ${to}` : undefined;
}

export const DECISION_TEXT: Record<'approved' | 'rejected', string> = {
  approved: 'Approvata',
  rejected: 'Rifiutata',
};

export const REMOTE_CHANNEL_TEXT: Record<'telegram' | 'phone', string> = {
  telegram: 'Telegram',
  phone: 'telefono',
};
