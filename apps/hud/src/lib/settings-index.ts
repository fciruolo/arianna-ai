/**
 * The index of the settings page (D-105, revised in D-192): entries grouped
 * by subject, one section shown at a time on the right, chosen by the
 * address (`/impostazioni/<slug>`) so that a reload and the back button keep
 * it. Every section has a title, one pill that says when a change counts, a
 * sentence and an example. Pure: the page and the address use it, it decides.
 */
import { CHANGELOG_PATH, DEV_PATH, SETTINGS_PATH } from './route.ts';

/** How a section takes effect, as checked in the code of the core (settings-page.ts, D-071). */
export type SectionBehaviour = 'now' | 'restart' | 'confirm' | 'read' | 'action' | 'browser';

/** The one pill under the title (D-192); null: the section shows none (read only, or each card says it). */
export const BEHAVIOUR_TEXT: Record<SectionBehaviour, string | null> = {
  now: 'Vale appena salvi',
  restart: 'Al riavvio',
  confirm: 'Con conferma',
  read: null,
  action: 'Cambia solo con «Usa questa versione»',
  browser: null,
};

export interface IndexItem {
  /** The id of the section in the page. */
  id: string;
  /** The last part of the address. */
  slug: string;
  title: string;
  behaviour: SectionBehaviour;
  /** Lets data out of this computer: the index shows a lock and the save bar asks to review the exits. */
  privacy?: boolean;
  /** One sentence under the title: what the section is for, in plain words. */
  lead: string;
  /** A concrete case, shown after «Esempio:». */
  example?: string;
}

export interface IndexGroup {
  group: string;
  items: IndexItem[];
}

export const PRIVACY_HINT = 'Fa uscire dati dal Mac: chiede conferma';

export const SETTINGS_INDEX: readonly IndexGroup[] = [
  {
    group: 'Intelligenza',
    items: [
      // One page for every model (I-3, D-137).
      {
        id: 'models',
        slug: 'modelli',
        title: 'Modelli',
        behaviour: 'now',
        lead: 'Quali modelli usa Arianna e per fare cosa. Quelli sul Mac sono gratis e vedono tutto; quelli cloud (Claude, Codex) consumano l’abbonamento e ricevono solo dati di lavoro.',
        example: 'scegli un modello più grande per «Ragiona e risponde in chat»: dal messaggio dopo Arianna risponde con quello, senza uscire dal Mac.',
      },
      {
        id: 'agents',
        slug: 'agenti',
        title: 'Agenti',
        behaviour: 'now',
        lead: 'Chi lavora con Arianna: come si chiama, come parla, che aspetto ha, con quale modello lavora e cosa può fare.',
        example: 'dai al Coder un tono «diretto»: da ora le sue risposte in chat sono più asciutte.',
      },
      // The people of the series (D-224, request of the user of 2026-10-16): their cards out of Agenti, which keeps only who wears whom.
      {
        id: 'series-characters',
        slug: 'personaggi-delle-serie',
        title: 'Personaggi',
        behaviour: 'now',
        lead: 'I personaggi delle serie che gli agenti possono indossare: come appaiono, chi sono, come parlano, la scena delle chat private e le loro battute vere. Chi indossa chi si sceglie in Agenti → Aspetto.',
        example: 'apri Dr. Cox e premi «Genera 100 battute vere»: dal messaggio dopo, l’agente che lo indossa usa ogni tanto una sua frase vera della serie.',
      },
      // The user's profile (D-114, tappa A): facts one at a time, «Solo in casa» or «Condivisibile».
      {
        id: 'about-you',
        slug: 'su-di-te',
        title: 'Su di te',
        // Saved at once; only «Condivisibile» asks for confirmation, in the section itself: no lock.
        behaviour: 'now',
        lead: 'Cose stabili su di te che Arianna può ricordare, ognuna «Solo in casa» o «Condivisibile». Rendere condivisibile un fatto chiede conferma.',
        example: '«lavoro: sviluppatore web», Condivisibile: Arianna lo sa anche nelle conversazioni di lavoro; «città», Solo in casa: lo sa solo nelle conversazioni private.',
      },
      // The catalogs of Open Design (D-160) and of skills (D-161), out of Agenti (D-192).
      {
        id: 'skills',
        slug: 'skill-e-stili',
        title: 'Skill e stili',
        behaviour: 'action',
        lead: 'Testi pronti, scritti da altri, che gli agenti possono consultare: gli stili per il Designer e le skill, istruzioni per un lavoro preciso. Si scarica solo il testo, niente programmi. Qui importi anche le tue skill di Claude Code, private finché non le rendi condivisibili.',
        example: 'segui la raccolta «anthropics/skills», poi nella scheda Skill del Coder assegna quella per la revisione del codice.',
      },
      // The catalog of agents (D-079): roles from GitHub, right after the skills (choice of the user, 2026-10-13).
      {
        id: 'agents-catalog',
        slug: 'catalogo-agenti',
        title: 'Catalogo agenti',
        behaviour: 'action',
        lead: 'Ruoli pronti, scritti da altri, da sfogliare qui e presto da usare come punto di partenza in «+ Nuovo agente». Si scarica solo il testo dei ruoli e la licenza, niente programmi.',
        example: 'segui «msitarzewski/agency-agents», premi «Scarica» e poi «Usa questa versione»: i suoi ruoli si possono sfogliare qui sotto.',
      },
    ],
  },
  {
    group: 'Comunicazione',
    items: [
      {
        id: 'voice',
        slug: 'voce',
        title: 'Voce e chiamate',
        behaviour: 'now',
        lead: 'Parlare con Arianna a voce dal browser o dal telefono, e quando può chiamarti lei. Tutto resta sul Mac.',
        example: 'metti il silenzio dalle 21:00 alle 08:00: un promemoria delle 22 arriva come messaggio, senza squillo.',
      },
      {
        id: 'notifications',
        slug: 'notifiche',
        title: 'Notifiche',
        behaviour: 'now',
        lead: 'Quando Arianna ti avvisa se non stai guardando la chat. La notifica dice solo che c’è qualcosa, mai il testo.',
        example: 'spegni «Risposte nelle chat» e lascia «Approvazioni in attesa»: ti avvisa solo quando deve chiederti un sì.',
      },
      // The phones paired through Tailscale (D-292, stage B): only from the Mac.
      {
        id: 'devices',
        slug: 'dispositivi',
        title: 'Dispositivi',
        behaviour: 'now',
        lead: 'I telefoni che aprono Arianna da fuori casa, attraverso la VPN di Tailscale. Si abbinano con un codice mostrato qui e una passkey con Face ID; si gestiscono solo dal Mac.',
        example: 'premi «Nuovo codice», apri Arianna sull’iPhone e scrivi le 6 cifre: dopo Face ID il telefono compare qui. «Scollega» lo chiude subito.',
      },
      // The secretary (I-12, D-144).
      {
        id: 'secretary',
        slug: 'segretaria',
        title: 'Segretaria',
        behaviour: 'now',
        lead: 'Arianna ti ricorda gli impegni che le hai detto con il pulsante «Segretaria». Qui scegli quando.',
        example: 'alle 08:30 scrive «Oggi: chiamare Studio Verdi, consegna logo Gelateria»; se non c’è niente, non scrive.',
      },
    ],
  },
  {
    group: 'Lavoro',
    items: [
      {
        id: 'projects',
        slug: 'progetti',
        title: 'Progetti',
        behaviour: 'confirm',
        privacy: true,
        lead: 'Le cartelle su cui Claude e Codex possono lavorare. Per ognuna dici quanto è riservata: Pubblico (codice che potresti mostrare a chiunque) o Interno (lavoro tuo o di un cliente, non personale).',
        example: 'aggiungi «sito-verdi», Interno: il Coder può correggerne i file, ma non vede mai finanze o note private.',
      },
      // The rules of the projects (I-14, D-174): the common template; each project's own in the page Progetti.
      {
        id: 'project-rules',
        slug: 'regole-dei-progetti',
        title: 'Regole dei progetti',
        behaviour: 'now',
        lead: 'Le regole che Arianna dà a Claude e Codex all’inizio di ogni lavoro su un progetto. Un progetto può averne di sue, nella pagina Progetti.',
        example: '«Commenti in inglese. Niente firme tipo “generato da”.» Una riga che inizia con [solo Codex] vale solo per Codex.',
      },
    ],
  },
  {
    group: 'Privacy e uscite',
    items: [
      // Telegram is off by the user's choice (D-110, question 12): its card stays in SettingsPage, unreachable until an entry comes back.
      {
        id: 'executors',
        slug: 'claude-e-codex',
        title: 'Claude e Codex',
        behaviour: 'confirm',
        privacy: true,
        lead: 'Gli unici aiutanti che lavorano fuori da questo Mac, con i tuoi abbonamenti. Ricevono solo il testo del lavoro e i file dei progetti, mai dati privati.',
        example: 'accendi Codex: quando chiedi «correggi il modulo contatti di sito-verdi», Arianna può passarlo a Codex, che riceve la richiesta e i file di sito-verdi.',
      },
      // Links downloaded and summarized (D-154).
      {
        id: 'links',
        slug: 'link-da-riassumere',
        title: 'Link da riassumere',
        behaviour: 'confirm',
        privacy: true,
        lead: 'Quando salvi un link di questi siti in Pensieri, Arianna scarica la pagina e il modello del Mac la riassume. Il sito riceve solo l’indirizzo del link.',
        example: 'con x.com nell’elenco, un post salvato diventa «Mario annuncia la nuova versione del suo tema, uscita il 3 novembre».',
      },
      // Public pages the Coder on Claude reads by itself (D-262).
      {
        id: 'coder-sites',
        slug: 'siti-per-il-coder',
        title: 'Siti che il Coder può leggere',
        behaviour: 'confirm',
        privacy: true,
        lead: 'Quando lavora con Claude, il Coder può leggere una pagina web solo se l’indirizzo glielo scrivi tu nella richiesta, oppure se è di uno di questi siti. Ogni pagina passa dal controllo di Arianna e resta nel registro.',
        example: 'con nodejs.org nell’elenco, il Coder può aprire da solo la documentazione di Node mentre corregge il tuo progetto, senza che tu gli incolli il link.',
      },
    ],
  },
  {
    group: 'Sistema',
    items: [
      {
        id: 'servers',
        slug: 'server-dei-modelli',
        title: 'Server dei modelli',
        behaviour: 'confirm',
        privacy: true,
        lead: 'I programmi sul Mac che fanno girare i modelli e la voce. Vedono i dati privati, perciò un cambio chiede conferma.',
        example: 'se la chat smette di rispondere e qui oMLX «non risponde», premi Riavvia.',
      },
      // The theme (D-103), the mode of this browser (D-158) and what this installation is (D-098), in one entry.
      {
        id: 'system',
        slug: 'aspetto-e-installazione',
        title: 'Aspetto e installazione',
        behaviour: 'browser',
        lead: 'Il tema della chat (colori, sfondo e costumi, su tutti i dispositivi), chiaro o scuro in questo browser e cosa è questa installazione di Arianna.',
      },
    ],
  },
  {
    group: 'Informazioni',
    items: [
      { id: 'changelog', slug: 'novita', title: 'Novità', behaviour: 'read', lead: 'Cosa è cambiato a ogni versione. Passa sopra una riga per chiederne a GOD.' },
      // «Cosa è cambiato» (D-233, idea 11 of OpenWork): next to Novità, which tells the versions; this tells this installation.
      {
        id: 'changes',
        slug: 'cosa-e-cambiato',
        title: 'Cosa è cambiato',
        behaviour: 'read',
        lead: 'I cambiamenti di questa installazione, dal più recente: modelli, Claude e Codex, skill e stili, agenti, progetti, aspetto e versione. Solo nomi e versioni, mai il contenuto di chat o note.',
        example: 'dopo aver scaricato un modello e scelto il tema di Halloween, qui leggi «Modello sul Mac: qwen…» e «Tema cambiato: halloween», con il collegamento alla pagina dove si cambiano.',
      },
      // «Consumi» (D-093, idea 10 of OpenWork): counts and times only, read from the database of this Mac.
      {
        id: 'usage',
        slug: 'consumi',
        title: 'Consumi',
        behaviour: 'read',
        lead: 'Quanto ha lavorato Arianna, per modello e per tipo di compito: lavori, passi, deleghe, uscite verso il cloud, fallimenti e tempi. Solo conteggi, mai il testo dei lavori.',
        example: 'in «7 giorni» vedi che Claude Code · Claude Sonnet ha fatto 12 lavori con 1 fallito, e che il gateway ha bloccato 2 uscite.',
      },
      {
        id: 'dev-progress',
        slug: 'sviluppo',
        title: 'Sviluppo di Arianna',
        behaviour: 'read',
        lead: 'A che punto è Arianna e le domande che Claude Code ti fa. Rispondi qui: Claude Code legge la risposta alla prossima sessione e aggiorna i documenti.',
      },
    ],
  },
];

const ITEMS = SETTINGS_INDEX.flatMap((group) => group.items);

export interface ChosenSection {
  item: IndexItem;
  /** The address named it: on a narrow screen the section opens instead of the index. */
  explicit: boolean;
}

/**
 * Addresses of sections that became part of another or changed name:
 * Personaggi and Personalità are in Agenti (D-116); Modelli locali, Prove dei
 * modelli and Modelli cloud are in Modelli (D-137); the voice trial is a
 * button of Voce (D-066); Esecutori cloud and Etichette are «Claude e Codex»,
 * Server locali is «Server dei modelli», Domini approvati is «Link da
 * riassumere», Aspetto and Installazione are one entry (D-192).
 */
const MOVED: Record<string, string> = {
  personaggi: 'agenti',
  personalita: 'agenti',
  'modelli-locali': 'modelli',
  'prove-dei-modelli': 'modelli',
  'modelli-cloud': 'modelli',
  'provino-della-voce': 'voce',
  'esecutori-cloud': 'claude-e-codex',
  etichette: 'claude-e-codex',
  'server-locali': 'server-dei-modelli',
  'link-scaricati': 'link-da-riassumere',
  aspetto: 'aspetto-e-installazione',
  installazione: 'aspetto-e-installazione',
};

/** The section of a slug; none or unknown gives the first section. An old slug gives its new section. */
export function resolveSection(slug: string | undefined): ChosenSection {
  const moved = slug !== undefined && Object.hasOwn(MOVED, slug) ? MOVED[slug] : slug;
  const found = moved === undefined ? undefined : ITEMS.find((item) => item.slug === moved);
  const first = ITEMS[0];
  if (first === undefined) throw new Error('the settings index has no section');
  return found === undefined ? { item: first, explicit: false } : { item: found, explicit: true };
}

/** Where an entry of the index leads: its section. */
export function hrefOf(item: IndexItem): string {
  return `${SETTINGS_PATH}/${item.slug}`;
}

/**
 * The pages that became sections of the settings (D-192): «Novità» and
 * «Sviluppo di Arianna» kept their addresses, which now open their section.
 * The slug for such an address, or undefined.
 */
export function legacySection(pathname: string): string | undefined {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (path === CHANGELOG_PATH) return 'novita';
  if (path === DEV_PATH) return 'sviluppo';
  return undefined;
}

/** The parts of the settings (the `Section`s of lib/settings.ts) a section edits, if any. */
export const EDITED_BY: Record<string, readonly string[]> = {
  models: ['roles', 'sprites', 'cloudModels'],
  agents: ['characters', 'personas', 'agents', 'skills', 'participants'],
  voice: ['voice'],
  // The keys of the notifications with the chat closed (D-192), in [push] since D-292.
  notifications: ['notifications', 'push'],
  secretary: ['secretary'],
  executors: ['executors'],
  projects: ['projects'],
  'project-rules': ['projectRules'],
  servers: ['endpoints'],
  links: ['fetchSites'],
  'coder-sites': ['coderSites'],
};

/** A section holds edits not saved in any of its parts. */
export function sectionDirty(id: string, isChanged: (section: string) => boolean): boolean {
  return (EDITED_BY[id] ?? []).some(isChanged);
}

/** The titles of the sections left with unsaved edits, for the notice shown elsewhere. */
export function pendingTitles(current: string, isChanged: (section: string) => boolean): string[] {
  return ITEMS.filter((item) => item.id !== current && sectionDirty(item.id, isChanged)).map((item) => item.title);
}

/** What the save bar of a section says: how many parts changed, in Italian. */
export function unsavedText(count: number): string {
  return count === 1 ? '1 modifica non salvata' : `${String(count)} modifiche non salvate`;
}
