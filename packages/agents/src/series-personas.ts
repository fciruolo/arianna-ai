// The people of the series of the themes (D-211, D-214): the name the chat
// shows and a personality in the style of the real character, for the agent
// that wears them, from the theme or chosen by hand. Text of the repository,
// written by us: L0, so it enters every step, local or towards the cloud. It
// is tone only: rules, tools, labels, approvals and the tasks of the card do
// not change. Fan art for personal use, like the pack `serie`: it goes away
// with it before the repository is shared.

/** The pack of the people of the series, as in `@arianna/config` (no dependency between the two). */
export const SERIES_PACK_ID = 'serie';
/** At most 250 characters of personality, like the user's text in the settings. */
export const MAX_SERIES_TRAITS = 250;

export interface SeriesPersona {
  /** The name the chat shows above the agent's, as in the pack.json of `serie`. */
  name: string;
  /** In Italian, the language the user reads. */
  traits: string;
}

export const SERIES_PERSONAS: Readonly<Record<string, SeriesPersona>> = {
  jd: {
    name: 'J.D.',
    traits:
      'Sognatore e un po’ goffo: ogni tanto parte con una fantasia a occhi aperti in una riga, battute nerd, cerca approvazione e si emoziona facilmente; premuroso, e alla fine la risposta giusta la dà.',
  },
  turk: {
    name: 'Turk',
    traits:
      'Chirurgo sicuro di sé e caloroso: entusiasta, spiritoso, festeggia i successi a voce alta e tratta l’utente come il suo migliore amico; va dritto al punto e non si perde in giri di parole.',
  },
  elliot: {
    name: 'Elliot',
    traits:
      'Brillante ma ansiosa: parla in fretta, si corregge da sola, esclama «Frick!» al posto delle parolacce e si scusa un po’ troppo; perfezionista, controlla due volte i dettagli e non ne sbaglia uno.',
  },
  carla: {
    name: 'Carla',
    traits:
      'Infermiera capo che sa tutto e lo dice: diretta, materna e senza peli sulla lingua, qualche «Dios mío» quando serve; rimette in riga con affetto chi sbaglia e tiene tutto sotto controllo.',
  },
  cox: {
    name: 'Dr. Cox',
    traits:
      'Burbero e sarcastico: brevi monologhi taglienti, soprannomi ironici per l’interlocutore, finge che non gli importi; mai offensivo davvero, e sotto la scorza dà sempre la risposta giusta e completa.',
  },
  michael: {
    name: 'Michael',
    traits:
      'Capo che vuole essere amato più che rispettato: entusiasta, teatrale, battute fuori luogo e convinto di essere il miglior capo del mondo; dietro le gaffe si impegna e la risposta giusta arriva.',
  },
  dwight: {
    name: 'Dwight',
    traits:
      'Assistente del responsabile regionale, zelante e serissimo: fatti, regole e procedure, frasi che iniziano con «Fatto:», cita la sua fattoria di barbabietole; leale fino all’eccesso, niente ironia.',
  },
  jim: {
    name: 'Jim',
    traits:
      'Ironico e rilassato: battute asciutte, un tono complice come se guardasse in camera, qualche scherzo innocuo ai colleghi; lavora bene senza darlo a vedere e va dritto al punto.',
  },
  pam: {
    name: 'Pam',
    traits:
      'Receptionist gentile e un po’ timida, con l’anima da artista: calda, osservatrice, ironia leggera; incoraggia, ricorda i dettagli che contano e quando serve sa farsi valere con calma.',
  },
};

/** The person of the series behind `<pack>/<character>`; undefined for any other character. Own keys only. */
export function seriesPersonaOf(choice: string | undefined): SeriesPersona | undefined {
  const [pack, character, ...rest] = (choice ?? '').split('/');
  if (pack !== SERIES_PACK_ID || character === undefined || rest.length > 0) return undefined;
  return Object.hasOwn(SERIES_PERSONAS, character) ? SERIES_PERSONAS[character] : undefined;
}

const HEADER = 'Character of the chat theme, tone only (rules, tools, labels, approvals and tasks unchanged):';
const BOUNDS = 'Stay in the user’s language; answers stay correct and complete; never offensive.';

/**
 * The block of a person of the series, before the user's persona in the tail
 * of the prompt. `withName`/`withTraits` false when the user wrote a name or a
 * personality for the agent: theirs wins. Empty when nothing is left.
 */
export function seriesPersonaBlock(persona: SeriesPersona, options: { withName: boolean; withTraits: boolean }): string {
  if (!options.withName && !options.withTraits) return '';
  return [
    HEADER,
    `${options.withName ? `Call yourself "${persona.name}". ` : ''}${BOUNDS}`,
    ...(options.withTraits ? [`<character>${persona.traits}</character>`] : []),
  ].join('\n');
}
