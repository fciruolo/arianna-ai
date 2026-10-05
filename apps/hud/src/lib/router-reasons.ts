import { EXECUTOR_TEXT, MODEL_TEXT } from './labels.ts';

/**
 * The router's reason in Italian (D-091). The core stores the reason as
 * packages/router/src/route.ts writes it: "<step> at <label> for <agent>,
 * difficulty <d> (default <d>[; rules: …])", then notes, then the choice, all
 * joined by "; ". The choice is the last part. Only the texts listed here are
 * translated: a choice this page does not know gets a generic text, a note it
 * does not know is left out.
 */
export const ROUTER_REASON_UNKNOWN = 'motivo non tradotto: è nel registro del router';

const OUTCOME_TEXT: Record<string, string> = {
  privacy: 'per privacy',
  agent: 'non consentito all’agente',
  escalation: 'già fallito',
  'not-for-step': 'non adatto al passo',
  'not-chosen': 'fuori dal livello di partenza',
  // Budget blocks (BudgetBlock.cause): Arianna's own cap, or the quota error of the binary.
  cap: 'per il tetto di spesa di Arianna',
  quota: 'per la quota esaurita dell’abbonamento',
};

const NOTES: Record<string, string> = {
  'context not issued by the policy, read as L2': 'contesto non etichettato dalla policy, trattato come L2',
  'cloud excluded: agent': 'cloud escluso: non consentito all’agente',
  'cloud excluded: privacy': 'cloud escluso per privacy',
};

function modelName(model: string): string {
  return MODEL_TEXT[model] ?? model;
}

function timeText(iso: string): string | undefined {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function choiceText(choice: string): string | undefined {
  const reads = /^no model reads (L[0-3])$/.exec(choice);
  if (reads?.[1] !== undefined) return `nessun modello può leggere dati ${reads[1]}`;
  const clearance = /^label above the clearance (L[0-3]) of the agent$/.exec(choice);
  if (clearance?.[1] !== undefined) return `l’etichetta supera il livello ${clearance[1]} consentito all’agente`;
  if (choice === 'no stronger executor is allowed after the failed attempts') return 'dopo i tentativi falliti nessun esecutore più forte è consentito';
  if (choice === 'budget exhausted with no expected reset') return 'budget esaurito, senza un ripristino previsto';
  if (choice === 'no executor allowed for this step is installed') return 'nessun esecutore consentito per questo passo è installato';
  const retry = /^budget exhausted, retry at (\S+)$/.exec(choice);
  if (retry?.[1] !== undefined) {
    const at = timeText(retry[1]);
    return at === undefined ? 'budget esaurito, riprova più tardi' : `budget esaurito, riprova alle ${at}`;
  }
  const route = /^([a-z0-9_-]+)\/([a-z0-9._-]+)( \(chosen by the user\)| \(tier \d+ unavailable\))?(, needs budget approval)?$/i.exec(choice);
  if (route !== null) {
    const [, executor = '', model = '', note, budget] = route;
    const why = note === undefined ? '' : note.includes('chosen by the user') ? ' (scelto da te)' : ' (il livello previsto non era disponibile)';
    return `${modelName(model)} su ${EXECUTOR_TEXT[executor] ?? executor}${why}${budget === undefined ? '' : ', serve l’approvazione del budget'}`;
  }
  return undefined;
}

function noteText(note: string): string | undefined {
  const known = NOTES[note];
  if (known !== undefined) return known;
  const missing = /^preferred (\S+) not installed$/.exec(note);
  if (missing?.[1] !== undefined) return `il modello scelto (${modelName(missing[1])}) non è installato`;
  const excluded = /^preferred (\S+) excluded: (\S+)$/.exec(note);
  if (excluded?.[1] !== undefined && excluded[2] !== undefined) {
    const why = OUTCOME_TEXT[excluded[2]];
    return `il modello scelto (${modelName(excluded[1])}) è escluso${why === undefined ? '' : ` ${why}`}`;
  }
  return undefined;
}

/** The reason in Italian: the choice, then the notes it knows; the generic text for an unknown choice. */
export function routerReasonText(reason: string | null | undefined): string {
  // route.ts joins head, notes and choice with "; ", and the head's "(default …; rules: …)"
  // uses the same separator: its second half becomes a part no note matches, so it is left out.
  // The choice never holds "; " (executor/model aliases and fixed texts), so it is always the last part.
  const parts = (reason ?? '').split('; ').map((part) => part.trim()).filter((part) => part !== '');
  const choice = parts.at(-1);
  const main = choice === undefined ? undefined : choiceText(choice);
  if (main === undefined) return ROUTER_REASON_UNKNOWN;
  const notes = parts
    .slice(0, -1)
    .map(noteText)
    .filter((text): text is string => text !== undefined);
  return notes.length === 0 ? main : `${main} (${notes.join('; ')})`;
}
