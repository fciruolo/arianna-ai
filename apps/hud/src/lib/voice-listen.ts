/**
 * «Ascolta» next to the voice chosen for the calls (D-192): a fixed sentence
 * said by the speech model of «Parla con la sua voce» with the voice written
 * in the field, through the route of the voice trial (D-066,
 * `/api/voice/trial/speak`). The audio stays on the Mac. This file says when
 * the button can be used and, when not, why, in plain words.
 */
import { ApiError } from './api.ts';
import { errorText } from './italian.ts';

export const LISTEN_PHRASE = 'Ciao, sono Arianna. Questa è la voce con cui ti chiamerò.';

export interface ListenInput {
  /** The state of the voice service from `/api/voice/trial`; undefined while unknown. */
  service: string | undefined;
  /** A call is starting, ringing or on in this page, or one is still open on the core. */
  callBusy: boolean;
  /** The speech model of «Parla con la sua voce», with its voices; undefined when none is chosen or it is not a candidate. */
  model: { present: boolean; voices: readonly string[] } | undefined;
  /** The voice written in the field. */
  voice: string;
}

const STARTING = new Set(['idle', 'starting', 'restarting']);

/** Why «Ascolta» cannot be used now, or undefined when it can. */
export function listenBlocker(input: ListenInput): string | undefined {
  if (input.service === undefined) return 'Controllo il servizio della voce…';
  if (input.service === 'off') {
    return 'Il servizio della voce è spento, quindi Arianna non può parlare. Si accende quando salvi con «Chiamate accese»; se resta spento, apri il Provino della voce per sapere cosa manca.';
  }
  if (input.service === 'not-installed') return 'Manca l’ambiente della voce sul Mac: apri il Provino della voce per sapere come prepararlo.';
  if (STARTING.has(input.service)) return 'Il servizio della voce sta partendo: tra qualche secondo «Ascolta» si accende da solo.';
  if (input.service !== 'up') return 'Il servizio della voce non risponde: apri il Provino della voce per sapere cosa manca.';
  if (input.callBusy) return 'C’è una chiamata in corso: ascolta la voce quando finisce.';
  if (input.model === undefined) return 'Scegli prima in Modelli chi «Parla con la sua voce».';
  if (!input.model.present) return 'Il modello della voce non è ancora scaricato: scaricalo da Modelli.';
  const voice = input.voice.trim();
  if (voice === '') return 'Scrivi o scegli una voce nel campo, poi ascoltala.';
  if (!input.model.voices.includes(voice)) return `«${voice}» non è fra le voci del modello scelto in Modelli: scegline una dall’elenco del campo, poi ascoltala.`;
  return undefined;
}

/** Whether the service may still change by itself: the page asks again until it settles. */
export function serviceSettling(service: string | undefined): boolean {
  return service === undefined || STARTING.has(service);
}

/** Why the sentence was not said. */
export function listenErrorText(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 503) return 'Il servizio della voce si è spento: riprova quando torna acceso.';
    if (cause.status === 400) return 'Questa voce non si può provare con il modello scelto: controlla Modelli e il campo della voce.';
    if (cause.status === 502 || cause.status === 504) return 'La voce non ha risposto: riprova fra poco. Se succede ancora, apri il Provino della voce.';
  }
  return errorText(cause);
}
