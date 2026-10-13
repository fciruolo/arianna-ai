import { LABEL_TEXT } from './labels.ts';

// The confirmation of an IM item (D-167, P4b): Arianna would write a title
// the user said in a private conversation into an IM file of a project, whose
// label is lower. The card shows the exact text and where it goes; "Sì" lets
// that text, and only that, go down to the label of the IM.

export interface ImConfirmation {
  /** "Scrivo «Fatture» nell’IM-34 di progetto-test, che è Interno: il Coder lo potrà leggere." */
  sentence: string;
  title: string;
  /** "IM-34 · giovedì 22 ottobre 2026, 10:00". */
  where: string;
}

export const IM_YES = 'Sì, scrivi';
export const IM_NO = 'No';

/** The card of an approval of kind `im`, or undefined when its detail is not a whole one. */
export function imConfirmation(detail: Record<string, unknown>): ImConfirmation | undefined {
  const { project, number, dateText, imLabel, title } = detail;
  if (typeof project !== 'string' || typeof number !== 'number' || typeof title !== 'string' || (imLabel !== 'L0' && imLabel !== 'L1')) return undefined;
  const reader = imLabel === 'L0' ? 'il Coder lo potrà leggere e potrà uscire dalla macchina' : 'il Coder lo potrà leggere';
  return {
    sentence: `Scrivo «${title}» nell’IM-${String(number)} di ${project}, che è ${LABEL_TEXT[imLabel]}: ${reader}.`,
    title,
    where: typeof dateText === 'string' ? `IM-${String(number)} · ${dateText}` : `IM-${String(number)}`,
  };
}
