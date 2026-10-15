/**
 * The card of a person of the series in Impostazioni → Agenti → Aspetto
 * (D-223): the texts as the user edits them, what of them is a rewrite, and
 * what the core would refuse. Pure: the card fetches and saves, this decides.
 */
import type { SeriesValues } from './settings.ts';

/** As `SERIES_OVERRIDE_LIMITS` and `SERIES_QUOTES` of @arianna/agents. */
export const SERIES_LIMITS = { traits: 450, scene: 750, quotes: { min: 3, max: 5, length: 60 } } as const;

export interface SeriesTexts {
  traits: string;
  scene: string;
  quotes: string[];
}

/** The fields of the card: one line per catchphrase. */
export interface SeriesForm {
  traits: string;
  scene: string;
  quotes: string;
}

/** The card filled with the user's rewrite where there is one, the repository's text elsewhere. */
export function seriesForm(repository: SeriesTexts, own: SeriesValues | null | undefined): SeriesForm {
  return {
    traits: own?.traits ?? repository.traits,
    scene: own?.scene ?? repository.scene,
    quotes: (own?.quotes ?? repository.quotes).join('\n'),
  };
}

/** The catchphrases of the field: one per line, blank lines left out. */
export function quoteLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Only what differs from the repository's text: the rewrite as `[series.<id>]` holds it; empty when nothing does. */
export function seriesRewrite(form: SeriesForm, repository: SeriesTexts): SeriesValues {
  const rewrite: SeriesValues = {};
  if (flat(form.traits) !== '' && flat(form.traits) !== flat(repository.traits)) rewrite.traits = flat(form.traits);
  if (flat(form.scene) !== '' && flat(form.scene) !== flat(repository.scene)) rewrite.scene = flat(form.scene);
  const quotes = quoteLines(form.quotes);
  if (quotes.length > 0 && quotes.join('\n') !== repository.quotes.join('\n')) rewrite.quotes = quotes;
  return rewrite;
}

const length = (text: string): number => Array.from(text).length;

/** A name of the series with its forms, as the core reads them: «Dr. Cox» also «Cox», «J.D.» also «JD». */
export function nameForms(name: string): string[] {
  const forms = new Set([name]);
  const words = name.split(' ');
  if (words.length > 1) forms.add(words.at(-1) ?? name);
  if (name.includes('.')) forms.add(name.replaceAll('.', ''));
  return [...forms];
}

/** The names of `others` written in `text`, whole words. */
export function namesIn(text: string, others: readonly string[]): string[] {
  const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return others.filter((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text));
}

/**
 * Why the core would refuse the card, in Italian; null when it would not.
 * `others`: the names of the other people of the series, with their forms,
 * which only the scene may hold (D-223).
 */
export function seriesProblem(form: SeriesForm, others: readonly string[] = []): string | null {
  if (/[<>]/.test(`${form.traits}${form.scene}${form.quotes}`)) return 'Niente < né >: sono i bordi del testo che riceve il modello.';
  if (length(flat(form.traits)) > SERIES_LIMITS.traits) return `«Chi è e come parla»: al massimo ${String(SERIES_LIMITS.traits)} caratteri.`;
  if (length(flat(form.scene)) > SERIES_LIMITS.scene) return `«La scena»: al massimo ${String(SERIES_LIMITS.scene)} caratteri.`;
  const quotes = quoteLines(form.quotes);
  if (quotes.length < SERIES_LIMITS.quotes.min || quotes.length > SERIES_LIMITS.quotes.max) return `Battute: da ${String(SERIES_LIMITS.quotes.min)} a ${String(SERIES_LIMITS.quotes.max)}, una per riga.`;
  const long = quotes.find((quote) => length(quote) > SERIES_LIMITS.quotes.length);
  if (long !== undefined) return `Ogni battuta al massimo ${String(SERIES_LIMITS.quotes.length)} caratteri.`;
  const named = namesIn(`${form.traits}\n${form.quotes}`, others);
  if (named.length > 0) return `${named.join(', ')}: gli altri personaggi solo nella scena. Personalità e battute vanno anche nelle chat di lavoro, dove un nome diventerebbe una persona per il controllo dei dati personali.`;
  return null;
}

/** `[series]` with the rewrite of `id`: the character left out when nothing differs from the repository. */
export function withRewrite(series: Record<string, SeriesValues>, id: string, rewrite: SeriesValues): Record<string, SeriesValues> {
  const next = Object.fromEntries(Object.entries(series).filter(([other]) => other !== id));
  if (Object.keys(rewrite).length > 0) next[id] = rewrite;
  return next;
}
