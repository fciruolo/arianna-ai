import type { ConversationMode, Label, TaskStatus } from './types.ts';

// Text the user reads is in Italian (docs: user-facing language); code stays in English.

/**
 * The labels as the user reads them (decisione sulle etichette parlanti,
 * 2026-10-06): the words of the SPEC with a coloured dot. The codes L0-L3
 * stay in the code, the logs and the page "Sviluppo di Arianna".
 */
export const LABEL_TEXT: Record<Label, string> = {
  L0: 'Pubblico',
  L1: 'Interno',
  L2: 'Privato',
  L3: 'Segreto',
};

/** The colour of each label (tokens --l0 … --l3). */
export const LABEL_CLASS: Record<Label, string> = { L0: 'text-l0', L1: 'text-l1', L2: 'text-l2', L3: 'text-l3' };

/** The legend: what each label means, an example, and where it may go. */
export const LABEL_LEGEND: readonly { label: Label; meaning: string; example: string; goes: string }[] = [
  {
    label: 'L0',
    meaning: 'Ciò che potrebbe stare su un sito pubblico.',
    example: 'Le frasi fisse di Arianna, la documentazione di un progetto aperto.',
    goes: 'Può uscire ovunque: cloud, Telegram, telefono.',
  },
  {
    label: 'L1',
    meaning: 'Lavoro, senza dati personali.',
    example: 'Il codice di un progetto approvato, una conversazione di lavoro.',
    goes: 'Può andare a Claude Code e Codex, solo nei progetti approvati, e sui canali esterni (Telegram, telefono), sempre attraverso il controllo del gateway.',
  },
  {
    label: 'L2',
    meaning: 'Dati personali. Anche tutto ciò che non ha un\'etichetta vale Privato.',
    example: 'Le note private, una conversazione privata, i documenti in kb/private.',
    goes: 'Resta sui canali locali: questo Mac con il modello locale e la chat dal telefono via VPN. Esce solo un testo che approvi tu, e da quel momento vale Interno.',
  },
  {
    label: 'L3',
    meaning: 'Password, chiavi, IBAN, documenti d\'identità: nessun modello li legge in chiaro, nemmeno quello locale.',
    example: 'I valori del vault: Arianna ne conosce solo il riferimento.',
    goes: 'Non esce mai, verso nessuno, nemmeno con la tua approvazione.',
  },
];

/** The rule that ties them together, said under the legend. */
export const LABEL_RULE = 'Un testo prende l\'etichetta più alta di ciò che ha letto: una risposta scritta leggendo una nota privata vale Privato.';

export const MODE_TEXT: Record<ConversationMode, string> = {
  work: 'Lavoro',
  private: 'Privata',
};

export const MODE_HINT: Record<ConversationMode, string> = {
  work: 'Fino a Interno: può usare Claude Code e Codex. Niente dati privati.',
  private: 'Fino a Privato: resta sul modello locale. Ciò che esce richiede la tua approvazione.',
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
  // The secretary (D-144).
  'commitment.add': 'Segno questo impegno?',
  'commitment.done': 'Lo segno come fatto?',
};

/** The cloud models as the user reads them; an alias not listed is shown as it is. */
export const MODEL_TEXT: Record<string, string> = {
  sonnet: 'Claude Sonnet',
  opus: 'Claude Opus',
  fable: 'Claude Fable (con approvazione)',
  luna: 'Codex Luna',
  sol: 'Codex Sol',
  astra: 'Codex Astra',
  // The single model of Codex before D-141, in the answers written then.
  codex: 'Codex',
};

export const EXECUTOR_TEXT: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  local: 'modello locale',
};

/** The word of a label code, or the code itself when it is not one (D-129). */
export function labelWord(code: string): string {
  return code === 'L0' || code === 'L1' || code === 'L2' || code === 'L3' ? LABEL_TEXT[code] : code;
}

/** "Privato → Interno" for a declassification detail, undefined if the detail is not one. */
export function declassifyLabels(detail: Record<string, unknown>): string | undefined {
  const { from, to } = detail;
  return typeof from === 'string' && typeof to === 'string' ? `${labelWord(from)} → ${labelWord(to)}` : undefined;
}

export const DECISION_TEXT: Record<'approved' | 'rejected', string> = {
  approved: 'Approvata',
  rejected: 'Rifiutata',
};

export const REMOTE_CHANNEL_TEXT: Record<'telegram' | 'phone', string> = {
  telegram: 'Telegram',
  phone: 'telefono',
};
