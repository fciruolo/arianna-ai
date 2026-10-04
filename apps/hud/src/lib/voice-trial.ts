/**
 * Texts and choices of the voice trial page (D-066), pure for the tests. The
 * phrase and the reply are made up (fake data only), with what trips speech
 * models in Italian: numbers, an hour, a name, a street, accents.
 */
import type { TrialModel } from './api.ts';

export const TRIAL_PHRASE =
  'Domani alle nove e mezza ho una riunione con Giulia in via Garibaldi: ricordami di portare la fattura numero 1427 e di chiamare l’idraulico perché la caldaia è rotta.';

export const TRIAL_REPLY =
  'Certo! Ti ho segnato la riunione con Giulia per domani alle nove e mezza. Ti ricorderò la fattura 1427 e la telefonata all’idraulico: vuoi che la chiami io?';

export const FAMILY_TEXT: Record<string, string> = {
  parakeet: 'Parakeet v3',
  whisper: 'Whisper large-v3-turbo',
  kokoro: 'Kokoro',
  chatterbox: 'Chatterbox',
};

export const VOICE_TEXT: Record<string, string> = {
  if_sara: 'Sara (femminile)',
  im_nicola: 'Nicola (maschile)',
};

/** What blocks the page, in Italian, or undefined when the service is ready. */
export function blocker(state: string): { title: string; steps: string[] } | undefined {
  if (state === 'up') return undefined;
  if (state === 'off') {
    return { title: 'Le chiamate sono spente', steps: ['Aggiungi la sezione [voice] a config/arianna.toml (l’esempio è in config/arianna.example.toml).', 'Riavvia il nucleo (pnpm start).'] };
  }
  if (state === 'not-installed') {
    return { title: 'Manca l’ambiente Python della voce', steps: ['Installa uv: brew install uv.', 'Crea l’ambiente: pnpm voice:sync (circa 1 GB in data/voice).', 'Riavvia il nucleo (pnpm start).'] };
  }
  if (state === 'failed') {
    return { title: 'Il servizio voce non parte', steps: ['Guarda data/voice/tmp/voice.log.', 'Ricrea l’ambiente con pnpm voice:sync, poi riavvia il nucleo.'] };
  }
  return { title: 'Il servizio voce si sta avviando', steps: ['Attendi qualche secondo: la pagina si aggiorna da sola.'] };
}

/** Bytes as the user reads them: "2,5 GB". */
export function sizeText(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toLocaleString('it-IT', { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 1e6).toLocaleString('it-IT')} MB`;
}

/** Seconds with one decimal, Italian style. */
export function secondsText(seconds: number): string {
  return `${seconds.toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** The lines to write in [roles] of arianna.toml for the chosen models. */
export function rolesSnippet(stt: string | undefined, tts: string | undefined): string {
  return ['[roles]', ...(stt === undefined ? [] : [`stt = "${stt}"`]), ...(tts === undefined ? [] : [`tts = "${tts}"`])].join('\n');
}

/** The download still needed for the candidates not on disk. */
export function missingBytes(models: readonly TrialModel[]): number {
  return models.filter((model) => !model.present).reduce((sum, model) => sum + model.sizeBytes, 0);
}
