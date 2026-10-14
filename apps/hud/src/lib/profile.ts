/**
 * «Su di te» (D-114, tappa A): the facts of the user's profile as the page
 * shows them, and the words it uses. Pure: the component and the tests use it.
 * The labels stay in the code; the page says «Solo in casa» (L2) and
 * «Condivisibile» (L1), never L1/L2.
 */
export type FactLabel = 'L1' | 'L2';

export interface UserFact {
  id: string;
  topic: string;
  text: string;
  label: FactLabel;
  createdAt: string;
  updatedAt: string;
}

/** What the page shows before a fact becomes «Condivisibile»: exactly what is written on confirmation. */
export interface ShareProposal {
  id: string;
  expiresAt: string;
  factId: string;
  topic: string;
  text: string;
  from: 'L2';
  to: 'L1';
}

export interface FactForm {
  topic: string;
  text: string;
  shared: boolean;
}

export const EMPTY_FACT: FactForm = { topic: '', text: '', shared: false };

export const MAX_TOPIC = 60;
export const MAX_FACT_TEXT = 300;

export const LEVEL_TEXT: Record<FactLabel, string> = {
  L2: 'Solo in casa',
  L1: 'Condivisibile',
};

export const LEVEL_HINT: Record<FactLabel, string> = {
  L2: 'Lo sanno Arianna e gli agenti sul Mac, nelle conversazioni private. Non esce mai da solo.',
  L1: 'Vale anche nelle conversazioni di lavoro e può arrivare a Claude e Codex.',
};

export const PROFILE_INTRO =
  'Cose stabili su di te che Arianna può ricordare: una alla volta, ognuna con il suo livello. Le scrivi solo tu: un agente non le cambia mai.';

export const PROFILE_REAL_DATA =
  'Finché l’installazione non è pronta per i dati veri (password vere dal vault) scrivi qui solo cose inventate. Salute, documenti e credenziali non vanno mai qui: restano nel vault o nell’archivio.';

export const TOPIC_NOTICE = 'L’argomento può uscire anche quando il testo resta in casa: scrivi «figli», non i loro nomi.';

export const SHARED_NOTICE = 'Questo testo può arrivare a Claude e Codex: non scriverci nomi di clienti, importi o password.';

export const SHARE_CONFIRM_TEXT = 'Da ora questo testo vale anche nelle conversazioni di lavoro e può arrivare a Claude e Codex. Resta registrato che l’hai deciso tu, con questo testo, anche se poi lo cambi o lo elimini.';

/** The problems of a form before it is sent, by field, in Italian. */
export function factProblems(form: FactForm): Partial<Record<'topic' | 'text', string>> {
  const problems: Partial<Record<'topic' | 'text', string>> = {};
  const topic = form.topic.trim();
  const text = form.text.trim();
  if (topic === '') problems.topic = 'Scrivi l’argomento.';
  else if (topic.length > MAX_TOPIC) problems.topic = `Al massimo ${String(MAX_TOPIC)} caratteri.`;
  if (text === '') problems.text = 'Scrivi il testo.';
  else if (text.length > MAX_FACT_TEXT) problems.text = `Al massimo ${String(MAX_FACT_TEXT)} caratteri.`;
  return problems;
}

/** The form of an existing fact. */
export function formOf(fact: UserFact): FactForm {
  return { topic: fact.topic, text: fact.text, shared: fact.label === 'L1' };
}

/**
 * What saving a form does: `share` when a fact «Solo in casa» becomes
 * «Condivisibile» (prepared and confirmed), `save` otherwise (immediate,
 * raising included).
 */
export function saveKind(fact: UserFact | null, form: FactForm): 'save' | 'share' {
  return fact !== null && fact.label === 'L2' && form.shared ? 'share' : 'save';
}

/** The kinds of the core's scanner as the page names them. */
export const SCAN_KINDS: Record<string, string> = {
  iban: 'un IBAN',
  'tax-code': 'un codice fiscale',
  'card-number': 'un numero di carta',
  token: 'un token o una chiave',
  'private-key': 'una chiave privata',
};

/** The core's refusal in plain Italian; the field it names, if any. */
export function factErrorText(message: string, status: number): { field: 'topic' | 'text' | null; text: string } {
  const field = /^(?:invalid: )?(topic|text) /.exec(message)?.[1] as 'topic' | 'text' | undefined;
  const where = field === 'topic' ? 'L’argomento' : 'Il testo';
  if (/looks like personal data or a secret/.test(message)) {
    const kinds = /\(([^)]*)\)/.exec(message)?.[1]?.split(', ').map((kind) => SCAN_KINDS[kind] ?? 'un dato personale') ?? [];
    const what = kinds.length > 0 ? [...new Set(kinds)].join(', ') : 'un dato personale o un segreto';
    return { field: field ?? null, text: `${where} sembra contenere ${what}: non salvato.` };
  }
  if (/holds a value of the vault/.test(message)) return { field: field ?? null, text: `${where} contiene un valore del vault: non salvato.` };
  if (/never enter the profile/.test(message)) return { field: null, text: 'Salute, documenti e credenziali non entrano in «Su di te».' };
  if (status === 409 && /another fact has this topic/.test(message)) return { field: 'topic', text: 'C’è già un fatto con questo argomento.' };
  if (/already shareable/.test(message)) return { field: null, text: 'Questo fatto è già condivisibile.' };
  if (status === 410 || /expired/.test(message)) return { field: null, text: 'La conferma è scaduta: salva di nuovo.' };
  if (status === 409 && /changed/.test(message)) return { field: null, text: 'Il fatto è cambiato nel frattempo: ricarica e riprova.' };
  if (status === 404) return { field: null, text: 'Il fatto non c’è più: ricarica la pagina.' };
  if (/at most \d+ facts/.test(message)) return { field: null, text: 'Hai raggiunto il numero massimo di fatti.' };
  return { field: null, text: 'Non salvato: riprova.' };
}
