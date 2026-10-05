/**
 * The index of the settings page (D-105): entries grouped by subject, one
 * section shown at a time on the right, chosen by the address
 * (`/impostazioni/<slug>`) so that a reload and the back button keep it.
 * Pure: the page and the address use it, it decides.
 */
import { CHANGELOG_PATH, DEV_PATH, SETTINGS_PATH, VOICE_TRIAL_PATH } from './route.ts';

/** How a section takes effect, as checked in the code of the core (settings-page.ts, D-071). */
export type SectionBehaviour = 'now' | 'restart' | 'confirm' | 'read' | 'action';

export const BEHAVIOUR_TEXT: Record<SectionBehaviour, string> = {
  now: 'Vale subito',
  restart: 'Vale dopo il riavvio del nucleo',
  confirm: 'Chiede conferma prima di salvare',
  read: 'Solo lettura',
  action: 'Non cambia le impostazioni: avvia prove in background',
};

export interface IndexItem {
  /** The id of the card in the page. */
  id: string;
  /** The last part of the address. */
  slug: string;
  title: string;
  behaviour: SectionBehaviour;
  /** Lets data out of this computer: the index shows a lock. */
  privacy?: boolean;
  /** A page of its own instead of a section: its address. */
  page?: string;
}

export interface IndexGroup {
  group: string;
  items: IndexItem[];
}

export const PRIVACY_HINT = 'Fa uscire dati: chiede conferma';

export const SETTINGS_INDEX: readonly IndexGroup[] = [
  {
    group: 'Modelli',
    items: [
      { id: 'roles', slug: 'modelli-locali', title: 'Modelli locali', behaviour: 'now' },
      { id: 'model-evals', slug: 'prove-dei-modelli', title: 'Prove dei modelli', behaviour: 'action' },
      { id: 'cloud-models', slug: 'modelli-cloud', title: 'Modelli cloud', behaviour: 'now' },
    ],
  },
  {
    group: 'Agenti e voce',
    items: [
      { id: 'agents', slug: 'agenti', title: 'Agenti', behaviour: 'now' },
      { id: 'voice', slug: 'voce', title: 'Voce', behaviour: 'now' },
      { id: 'voice-trial', slug: 'provino-della-voce', title: 'Provino della voce', behaviour: 'now', page: VOICE_TRIAL_PATH },
    ],
  },
  {
    group: 'Collegamenti',
    items: [
      { id: 'executors', slug: 'esecutori-cloud', title: 'Esecutori cloud', behaviour: 'confirm', privacy: true },
      { id: 'telegram', slug: 'telegram', title: 'Telegram', behaviour: 'confirm', privacy: true },
      { id: 'projects', slug: 'progetti', title: 'Progetti', behaviour: 'confirm', privacy: true },
      { id: 'servers', slug: 'server-locali', title: 'Server locali', behaviour: 'confirm', privacy: true },
    ],
  },
  {
    group: 'Sistema',
    items: [
      { id: 'labels', slug: 'etichette', title: 'Etichette', behaviour: 'read' },
      { id: 'installation', slug: 'installazione', title: 'Installazione', behaviour: 'read' },
      { id: 'dev-progress', slug: 'sviluppo', title: 'Sviluppo di Arianna', behaviour: 'read', page: DEV_PATH },
      { id: 'changelog', slug: 'novita', title: 'Novità', behaviour: 'read', page: CHANGELOG_PATH },
    ],
  },
];

const ITEMS = SETTINGS_INDEX.flatMap((group) => group.items);
const SECTIONS = ITEMS.filter((item) => item.page === undefined);

export interface ChosenSection {
  item: IndexItem;
  /** The address named it: on a narrow screen the section opens instead of the index. */
  explicit: boolean;
}

/** Addresses of sections that became part of another (D-116): Personaggi and Personalità are in Agenti. */
const MOVED: Record<string, string> = { personaggi: 'agenti', personalita: 'agenti' };

/** The section of a slug; none, unknown or a page of its own gives the first section. */
export function resolveSection(slug: string | undefined): ChosenSection {
  const moved = slug !== undefined && Object.hasOwn(MOVED, slug) ? MOVED[slug] : slug;
  const found = moved === undefined ? undefined : SECTIONS.find((item) => item.slug === moved);
  const first = SECTIONS[0];
  if (first === undefined) throw new Error('the settings index has no section');
  return found === undefined ? { item: first, explicit: false } : { item: found, explicit: true };
}

/** Where an entry of the index leads: its section, or its own page. */
export function hrefOf(item: IndexItem): string {
  return item.page ?? `${SETTINGS_PATH}/${item.slug}`;
}

/** The parts of the settings (the `Section`s of lib/settings.ts) a section edits, if any. */
export const EDITED_BY: Record<string, readonly string[]> = {
  roles: ['roles'],
  'cloud-models': ['cloudModels'],
  agents: ['characters', 'personas', 'agents'],
  voice: ['voice'],
  executors: ['executors'],
  telegram: ['telegram'],
  projects: ['projects'],
  servers: ['endpoints'],
};

/** A section holds edits not saved in any of its parts. */
export function sectionDirty(id: string, isChanged: (section: string) => boolean): boolean {
  return (EDITED_BY[id] ?? []).some(isChanged);
}

/** The titles of the sections left with unsaved edits, for the notice shown elsewhere. */
export function pendingTitles(current: string, isChanged: (section: string) => boolean): string[] {
  return SECTIONS.filter((item) => item.id !== current && sectionDirty(item.id, isChanged)).map((item) => item.title);
}
