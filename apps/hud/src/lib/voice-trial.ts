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
  'qwen3-tts': 'Qwen3-TTS 1.7B',
  'voxtral-tts': 'Voxtral 4B',
};

/** What the user should know before choosing (D-067). */
export const FAMILY_NOTE: Record<string, string> = {
  kokoro: 'Piccolo e veloce; solo due voci italiane, con accento inglese.',
  'qwen3-tts': 'Licenza libera; voci nate cinesi e inglesi a cui si chiede l’italiano.',
  'voxtral-tts': 'Voci italiane native; licenza CC BY-NC 4.0 (solo uso non commerciale, con attribuzione); più lento e più memoria.',
};

export const VOICE_TEXT: Record<string, string> = {
  if_sara: 'Sara (femminile)',
  im_nicola: 'Nicola (maschile)',
  it_female: 'Italiana (femminile)',
  it_male: 'Italiano (maschile)',
  serena: 'Serena (femminile)',
  vivian: 'Vivian (femminile)',
  ryan: 'Ryan (maschile)',
  aiden: 'Aiden (maschile)',
};

/** The voice to show for a model: the one picked, else the one of [voice] when the model has it, else its first. */
export function voiceFor(voices: readonly string[], picked: string | undefined, configured: string | null | undefined): string | undefined {
  if (picked !== undefined && voices.includes(picked)) return picked;
  if (configured !== null && configured !== undefined && voices.includes(configured)) return configured;
  return voices[0];
}

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

/** The lines to write in [roles] and [voice] of arianna.toml for the chosen models and voice. */
export function rolesSnippet(stt: string | undefined, tts: string | undefined, voice?: string): string {
  const roles = ['[roles]', ...(stt === undefined ? [] : [`stt = "${stt}"`]), ...(tts === undefined ? [] : [`tts = "${tts}"`])];
  return [...roles, ...(voice === undefined ? [] : ['', '[voice]', `voice = "${voice}"`])].join('\n');
}

/** The download still needed for the candidates not on disk. */
export function missingBytes(models: readonly TrialModel[]): number {
  return models.filter((model) => !model.present).reduce((sum, model) => sum + model.sizeBytes, 0);
}
