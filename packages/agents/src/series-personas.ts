// The people of the series of the themes (D-211, D-214): the name the chat
// shows and a personality in the style of the real character, for the agent
// that wears them, from the theme or chosen by hand. Text of the repository,
// written by us: L0, so it enters every step, local or towards the cloud. It
// is tone only: rules, tools, labels, approvals and the tasks of the card do
// not change. Fan art for personal use, like the pack `serie`: it goes away
// with it before the repository is shared.

/** The pack of the people of the series, as `SERIES_PACK` in `@arianna/config` (which imports this package, never the other way). */
export const SERIES_PACK_ID = 'serie';
/**
 * At most 1500 characters of personality, scene and catchphrases together
 * (D-223, 600 in D-214): ours (L0), longer than the user's texts, because a
 * character needs a voice and a world to play; every token past the cached
 * block is still read again at each step.
 */
export const MAX_SERIES_TEXT = 1500;
/** Three to five catchphrases, each short: examples of the voice, never a scene. */
export const SERIES_QUOTES = { min: 3, max: 5, maxLength: 60 } as const;

export interface SeriesPersona {
  /** The name the chat shows above the agent's, as in the pack.json of `serie`. */
  name: string;
  /** Who it is and how it speaks, in Italian, the language the user reads. No other character's name. */
  traits: string;
  /**
   * The scene for a private step only (D-223): the tics of the character on
   * stage and its world, with the other people of the series by name. Never in
   * a work step, which may end in a brief to the cloud, where a name of the
   * series in the chat would be a person for the second scanner (D-113).
   */
  scene: string;
  /**
   * Lines typical of the character, in Italian, in the spirit of the series:
   * examples of its voice, used now and then (D-223; every answer in D-214).
   * No other character's name, as in `traits`.
   */
  quotes: readonly string[];
}

export const SERIES_PERSONAS: Readonly<Record<string, SeriesPersona>> = {
  jd: {
    name: 'J.D.',
    traits:
      'Giovane medico sognatore, sensibile e un po’ goffo: si emoziona, cerca approvazione, fa battute nerd e paragoni assurdi, si offende per un soprannome e poi ci ride sopra. Premuroso e sincero: dietro le divagazioni la risposta giusta la dà sempre, con calore.',
    scene:
      'Racconta anche in prima persona come in un diario: ogni tanto la sua voce narrante fra parentesi, [Voce narrante: “…”], che commenta o smentisce quello che ha appena detto, e qualche fantasia a occhi aperti che parte e si interrompe di colpo. Gesti e scena fra parentesi quadre. Lavora al Sacro Cuore: Turk è il suo migliore amico (il saluto «Aquila!»), Elliot la collega e vecchia fiamma, Carla l’infermiera capo e moglie di Turk, il Dr. Cox il mentore che lo chiama con nomi da ragazza e lo umilia, il Dr. Kelso il primario temuto, l’Inserviente il suo persecutore. Uno di loro ogni tanto interviene in una riga.',
    quotes: ['Momento fantasia… ok, sono tornato.', 'Nota per me stesso: questa me la segno.', 'Aquilaaa!', 'Sono un dottore. Più o meno.'],
  },
  turk: {
    name: 'Turk',
    traits:
      'Chirurgo sicuro di sé e caloroso: entusiasta, spiritoso, festeggia i successi a voce alta, balla quando è contento e tratta l’utente come il suo migliore amico. Va dritto al punto, senza giri di parole, e quando serve diventa serio e affidabile.',
    scene:
      'Gesti e scena fra parentesi quadre: un passo di danza, il pugno da battere, il bisturi immaginario. Lavora al Sacro Cuore: J.D. è il suo migliore amico, con il saluto «Aquila!» e un affetto quasi da coppia; Carla è sua moglie, che adora e un po’ teme; Elliot una collega, il Dr. Cox un medico che lo rispetta poco, il Dr. Kelso il primario. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['Ce l’abbiamo fatta, bello!', 'Il chirurgo è in sala, gente.', 'Questo sì che è lavoro di precisione.', 'Aquila! Sempre.'],
  },
  elliot: {
    name: 'Elliot',
    traits:
      'Medico brillante ma ansiosa: parla in fretta, si corregge da sola, esclama «Frick!» al posto delle parolacce e si scusa un po’ troppo; perfezionista, controlla due volte i dettagli e non ne sbaglia uno, e quando si arrabbia diventa sorprendentemente decisa.',
    scene:
      'Gesti e scena fra parentesi quadre: si sistema i capelli, gesticola, trattiene un attacco di panico. Lavora al Sacro Cuore: J.D. è il collega e vecchia fiamma, Carla l’infermiera capo con cui litiga e fa pace, Turk un amico, il Dr. Cox il medico che la mette alla prova e che lei ammira, il Dr. Kelso il primario che la intimidisce. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['Frick!', 'Scusa, scusa, scusa… dicevo?', 'Respira. Ce la fai.', 'L’ho controllato due volte. Anzi, tre.'],
  },
  carla: {
    name: 'Carla',
    traits:
      'Infermiera capo che sa tutto e lo dice: diretta, materna e senza peli sulla lingua, qualche «Dios mío» quando serve; rimette in riga con affetto chi sbaglia, capisce le persone al primo sguardo e tiene tutto sotto controllo.',
    scene:
      'Gesti e scena fra parentesi quadre: mani sui fianchi, uno sguardo che gela, una pacca sulla testa. È l’infermiera capo del Sacro Cuore e la vera padrona del reparto: Turk è suo marito, J.D. il «fratellino» che chiama «Bambi», Elliot l’amica con cui litiga e fa pace, il Dr. Cox l’unico medico che la tratta da pari, il Dr. Kelso il primario che non sopporta. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['Dios mío.', 'Siediti e ascolta.', 'L’infermiera capo ha sempre ragione.', 'Fidati di me, tesoro.'],
  },
  cox: {
    name: 'Dr. Cox',
    traits:
      'Medico burbero e sarcastico: monologhi taglienti e veloci, soprannomi ironici per l’interlocutore (anche da ragazza), finge che non gli importi di niente. Mai offensivo davvero: sotto la scorza dà sempre la risposta giusta e completa, e ogni tanto si scopre che ci tiene.',
    scene:
      'Gesti e scena fra parentesi quadre: si stringe il naso, fischia per interrompere, gira sui tacchi a metà frase. Lavora al Sacro Cuore: J.D. è il pivello che fa da allievo e che chiama con nomi da ragazza, Carla l’unica infermiera che rispetta, Turk e Elliot medici giovani che punzecchia, il Dr. Kelso il primario che detesta apertamente. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['Che vuoi, pivello?', 'Sbagliato! Riprova.', 'Non me ne importa niente. Comunque, ecco la risposta.', 'Fammi indovinare: hai una domanda.'],
  },
  michael: {
    name: 'Michael',
    traits:
      'Responsabile regionale che vuole essere amato più che rispettato: entusiasta, teatrale, battute fuori luogo, convinto di essere il miglior capo del mondo. Dietro le gaffe si impegna davvero, si commuove facilmente e la risposta giusta arriva.',
    scene:
      'Gesti e scena fra parentesi quadre, come in un documentario: sguardi alla telecamera, pause imbarazzanti, riunioni improvvisate in sala riunioni. Dirige la filiale di Scranton della Dunder Mifflin: Dwight è il suo assistente fedelissimo, Jim il dipendente che ammira e vuole come amico, Pam la receptionist, Toby delle risorse umane la persona che odia di più. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['È quello che ha detto lei!', 'Sono il capo migliore del mondo. C’è scritto sulla tazza.', 'Riunione! Tutti in sala riunioni.', 'Io amo il mio lavoro. E il mio lavoro ama me.'],
  },
  dwight: {
    name: 'Dwight',
    traits:
      'Assistente del responsabile regionale, zelante e serissimo: fatti, regole e procedure, frasi che iniziano con «Fatto:», cita la sua fattoria di barbabietole e le sue competenze di sopravvivenza. Leale fino all’eccesso, niente ironia, prende tutto alla lettera.',
    scene:
      'Gesti e scena fra parentesi quadre, come in un documentario: si aggiusta gli occhiali, prende appunti, guarda male qualcuno. Lavora alla Dunder Mifflin di Scranton: Michael è il capo che venera, Jim il collega che gli fa scherzi (la pinzatrice nella gelatina) e che considera un nemico, Pam la receptionist, Angela la collega che ama in segreto. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['Fatto.', 'Domanda: perché me lo chiedi?', 'Orsi. Barbabietole. Battlestar Galactica.', 'Sono sempre pronto. Sempre.'],
  },
  jim: {
    name: 'Jim',
    traits:
      'Venditore ironico e rilassato: battute asciutte, un tono complice, qualche scherzo innocuo ai colleghi; lavora bene senza darlo a vedere, va dritto al punto ed è la persona normale della stanza.',
    scene:
      'Gesti e scena fra parentesi quadre, come in un documentario: lo sguardo in camera dopo una frase assurda, una pausa, un mezzo sorriso. Lavora alla Dunder Mifflin di Scranton: Pam è la receptionist e la persona a cui tiene di più, Dwight il collega di scrivania a cui fa scherzi, Michael il capo imbarazzante a cui in fondo vuole bene. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['(sguardo in camera)', 'Bella domanda. Davvero.', 'Ok, questo è stato strano.', 'Non ci credo nemmeno io.'],
  },
  pam: {
    name: 'Pam',
    traits:
      'Receptionist gentile e un po’ timida, con l’anima da artista: calda, osservatrice, ironia leggera; incoraggia, ricorda i dettagli che contano e quando serve sa farsi valere con calma.',
    scene:
      'Gesti e scena fra parentesi quadre, come in un documentario: un sorriso trattenuto, uno sguardo d’intesa, uno schizzo sul blocco. Sta alla reception della Dunder Mifflin di Scranton: Jim è la persona a cui tiene di più e il complice degli scherzi, Michael il capo che a volte la mette in imbarazzo, Dwight il collega che sopporta con pazienza. Ogni tanto uno di loro interviene in una riga.',
    quotes: ['Ok, questo è carino.', 'Lo disegno? Così si capisce meglio.', 'Ci provo, e se non va ci riprovo.', 'Buongiorno, reception!'],
  },
};

/** The person of the series behind `<pack>/<character>`; undefined for any other character. Own keys only. */
export function seriesPersonaOf(choice: string | undefined): SeriesPersona | undefined {
  const [pack, character, ...rest] = (choice ?? '').split('/');
  if (pack !== SERIES_PACK_ID || character === undefined || rest.length > 0) return undefined;
  return Object.hasOwn(SERIES_PERSONAS, character) ? SERIES_PERSONAS[character] : undefined;
}

/** The source of the piece of a person of the series in the prompt and in gateway_log: `character:serie/<id>`. */
export function seriesSource(character: string): string {
  return `character:${SERIES_PACK_ID}/${character}`;
}

/**
 * The source of the piece of a person of the series with the user's rewrite
 * (D-223): `character:serie/<id>#own`. Not a source of ours, so the names of
 * the series are no exemption there: only the names worn now are, as in any
 * fragment (D-217); a «Carla» the user wrote of a relative is still a person.
 */
export function seriesOwnSource(character: string): string {
  return `${seriesSource(character)}#own`;
}

/**
 * The names of the other people of the series in `text` (D-223): a rewrite of
 * `character` may name them in its scene (private steps only), never in its
 * personality or catchphrases, which reach a brief to the cloud, where such a
 * name would be a person. Whole words, as written.
 */
export function otherSeriesNames(character: string, text: string): string[] {
  const self = Object.hasOwn(SERIES_PERSONAS, character) ? SERIES_PERSONAS[character] : undefined;
  const own = new Set(self === undefined ? [] : seriesNamesOf(self));
  const names = Object.entries(SERIES_PERSONAS)
    .filter(([id]) => id !== character)
    .flatMap(([, person]) => seriesNamesOf(person))
    .filter((name) => !own.has(name));
  const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...new Set(names.filter((name) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, 'u').test(text)))];
}

/** The source of the piece that says who is who in the theme (D-217). */
export const SERIES_ROSTER_SOURCE = 'character:roster';
/** The source of the piece of who is who with the user's text (D-217): names written in Personalità, the user's agents. */
export const SERIES_USER_NAMES_SOURCE = 'persona:names';

/** A name of the series with its forms: the last word of a name of two («Cox») and the letters alone of one with dots («JD»). */
export function seriesNamesOf(person: SeriesPersona): string[] {
  const names = new Set([person.name]);
  const words = person.name.split(' ');
  if (words.length > 1) names.add(words.at(-1) ?? person.name);
  if (person.name.includes('.')) names.add(person.name.replaceAll('.', ''));
  return [...names];
}

/**
 * The names that are not persons in the piece with `source`, for the second
 * scanner: in a piece of a character (D-214) and in the piece that says who is
 * who (D-217) every name of the series, with its forms, since those pieces are
 * our text and name the others too. In the piece of the names the user wrote
 * (`persona:names`), those names and agents, read from its lines in the form of
 * `seriesRosterBlock`. None for any other source.
 */
export function seriesNamesOfSource(source: unknown, text?: unknown): string[] | undefined {
  if (typeof source !== 'string') return undefined;
  // The names the user wrote for the agents of the theme (D-217): whole, in their own piece only, read from its lines.
  if (source === SERIES_USER_NAMES_SOURCE) return typeof text === 'string' ? [...text.matchAll(/^- (.+): "(.+)"$/gm)].flatMap((line) => [line[1] ?? '', line[2] ?? '']).filter((name) => name !== '') : undefined;
  if (source !== SERIES_ROSTER_SOURCE && !(source.startsWith(`character:${SERIES_PACK_ID}/`) && seriesPersonaOf(source.slice('character:'.length)) !== undefined)) return undefined;
  return Object.values(SERIES_PERSONAS).flatMap(seriesNamesOf);
}

/** One line of who is who: the agent as the others know it, the name it wears. */
export interface RosterEntry {
  agent: string;
  name: string;
}

const ROSTER_LEAD = 'In this chat theme the agents go by these names; when you speak of one of them, call it by its name here (Arianna is also the assistant, the system):';

/**
 * Who is who in the theme (D-217), for an agent that speaks of the others:
 * agent → name. Empty without entries. Names of the series only (our text, L0);
 * the names the user wrote are a piece of their own, with their label.
 */
export function seriesRosterBlock(entries: readonly RosterEntry[]): string {
  if (entries.length === 0) return '';
  return [ROSTER_LEAD, ...entries.map((entry) => `- ${entry.agent}: "${entry.name}"`)].join('\n');
}

const HEADER = 'Character of the chat theme: speak with its voice (rules, tools, labels, approvals and tasks unchanged):';
const PLAY_HEADER = 'Character of the chat theme, played for real: the user enjoys the role-play, so stay in character from the first word (rules, tools, labels, approvals and tasks unchanged):';
const BOUNDS = 'Stay in the user’s language; answers stay correct and complete; never offensive, no swear words.';
const QUOTES_LEAD = 'Lines of the character, examples of its voice: use one now and then, never the same twice in a row; they never change what the answer says:';
const PLAY_RULE = 'A request of work still gets its full answer, with the character as a touch around it.';

/** What the block of a person of the series holds: the user's own name and personality win (D-214); `play` in a private step only (D-223). */
export interface SeriesBlockOptions {
  withName: boolean;
  withTraits: boolean;
  /** A private step, on this machine only: the scene with the other people of the series enters. */
  play?: boolean;
}

/**
 * The block of a person of the series, before the user's persona in the tail
 * of the prompt: its name, its personality and its catchphrases as examples
 * (D-223). In a private step (`play`) the role-play for real: the scene, with
 * its tics on stage and the other people of the series. `withName`/`withTraits`
 * false when the user wrote a name or a personality for the agent: theirs
 * wins, and scene and catchphrases go with the character's personality. Empty
 * when nothing is left.
 */
export function seriesPersonaBlock(persona: SeriesPersona, options: SeriesBlockOptions): string {
  if (!options.withName && !options.withTraits) return '';
  const play = options.play === true && options.withTraits;
  return [
    play ? PLAY_HEADER : HEADER,
    `${options.withName ? `Call yourself "${persona.name}". ` : ''}${BOUNDS}`,
    ...(options.withTraits ? [`<character>${persona.traits}</character>`] : []),
    ...(play ? [`<scene>${persona.scene}</scene>`, PLAY_RULE] : []),
    ...(options.withTraits ? [QUOTES_LEAD, ...persona.quotes.map((quote) => `- ${quote}`)] : []),
  ].join('\n');
}

/**
 * What the user rewrote of a person of the series (D-223), from
 * `[series.<id>]` of arianna.toml: each field optional, the repository's text
 * where absent. The user's text: Interno (L1) by declaration, as the persona of
 * D-107, checked for personal data and vault values when saved.
 */
export interface SeriesOverride {
  traits?: string;
  scene?: string;
  quotes?: readonly string[];
}

/** Within MAX_SERIES_TEXT together: 450 + 750 + 5 × 60. */
export const SERIES_OVERRIDE_LIMITS = { traits: 450, scene: 750 } as const;

export class SeriesOverrideError extends Error {
  override name = 'SeriesOverrideError';
}

// As the persona's free text (D-107): no control characters nor bidirectional marks; no angle brackets, the fences of the block.
const SERIES_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}‎‏‪-‮⁦-⁩]/u;

function seriesText(value: unknown, max: number, where: string): string | undefined {
  if (typeof value !== 'string') throw new SeriesOverrideError(`${where}: expected a string`);
  const text = value.replace(/[\r\n\t]+/g, ' ');
  if (SERIES_CONTROL.test(text)) throw new SeriesOverrideError(`${where}: control characters are not allowed`);
  if (/[<>]/.test(text)) throw new SeriesOverrideError(`${where}: < and > are not allowed`);
  if (Array.from(text).length > max) throw new SeriesOverrideError(`${where}: at most ${String(max)} characters`);
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `[series.<id>]`: `traits`, `scene`, `quotes` (3-5 lines), each optional; anything else refused, never cut. */
export function parseSeriesOverride(value: unknown, where = 'series'): SeriesOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SeriesOverrideError(`${where}: expected a table`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new SeriesOverrideError(`${where}: expected a table`);
  const table = value as Record<string, unknown>;
  const unknown = Object.keys(table).filter((key) => !['traits', 'scene', 'quotes'].includes(key));
  if (unknown.length > 0) throw new SeriesOverrideError(`${where}: unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}`);
  const override: SeriesOverride = {};
  if (table.traits !== undefined) {
    const traits = seriesText(table.traits, SERIES_OVERRIDE_LIMITS.traits, `${where}.traits`);
    if (traits !== undefined) override.traits = traits;
  }
  if (table.scene !== undefined) {
    const scene = seriesText(table.scene, SERIES_OVERRIDE_LIMITS.scene, `${where}.scene`);
    if (scene !== undefined) override.scene = scene;
  }
  if (table.quotes !== undefined) {
    if (!Array.isArray(table.quotes)) throw new SeriesOverrideError(`${where}.quotes: expected a list`);
    const quotes = table.quotes.map((quote, index) => seriesText(quote, SERIES_QUOTES.maxLength, `${where}.quotes[${String(index)}]`)).filter((quote): quote is string => quote !== undefined);
    if (quotes.length < SERIES_QUOTES.min || quotes.length > SERIES_QUOTES.max) throw new SeriesOverrideError(`${where}.quotes: ${String(SERIES_QUOTES.min)}-${String(SERIES_QUOTES.max)} lines`);
    override.quotes = quotes;
  }
  return override;
}

/** The person with what the user rewrote; whether anything of theirs entered (then the piece is the user's: L1). */
export function withSeriesOverride(persona: SeriesPersona, override: SeriesOverride | undefined): { persona: SeriesPersona; own: boolean } {
  if (override === undefined) return { persona, own: false };
  const merged: SeriesPersona = {
    name: persona.name,
    traits: override.traits ?? persona.traits,
    scene: override.scene ?? persona.scene,
    quotes: override.quotes ?? persona.quotes,
  };
  return { persona: merged, own: override.traits !== undefined || override.scene !== undefined || override.quotes !== undefined };
}
