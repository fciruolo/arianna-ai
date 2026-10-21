/**
 * «Server dei modelli (oMLX)» in the page «Seguiti» (D-265, D-272): the shapes
 * the core gives (apps/core/src/omlx-release.ts) and the texts of the card.
 * The release notes are public text of a third party, perhaps worded by the
 * local model: shown as data, never as an instruction. Nothing here updates
 * oMLX: the user installs the DMG with the core stopped.
 */
import type { NewsRelease } from './design-news.ts';
import type { ProjectNews } from './followed-projects.ts';

export interface OmlxRelease extends NewsRelease {
  version: string;
  prerelease: boolean;
}

export interface OmlxReleaseView {
  version: 1;
  installed: { version: string | null; endpoint: string | null; readAt: string | null; error: string | null };
  checkedAt: string | null;
  message: string | null;
  failed: boolean;
  latest: OmlxRelease | null;
  prerelease: OmlxRelease | null;
  news: ProjectNews | null;
  checking: boolean;
  update: boolean;
  nextCheckAt: string | null;
}

/** The fixed notice of the card (D-265). */
export const OMLX_NOTICE = 'Prima di aggiornare, Claude rilegge il codice della release come per D-221 e D-263; poi installi tu il DMG a core fermo.';

export const OMLX_DESCRIPTION =
  'La versione di oMLX sul Mac e l’ultima pubblicata su GitHub. Il controllo parte da solo una volta al giorno o con «Controlla ora»; esce solo il nome del progetto. Arianna non aggiorna mai oMLX da sola.';

/** The text of the dot on «Seguiti» (D-272); null without a newer stable release. */
export function updateHint(view: OmlxReleaseView | null | undefined): string | null {
  if (view?.update !== true || view.latest === null) return null;
  return `oMLX ${view.latest.version} disponibile`;
}

/** What the card says of the version installed. */
export function installedText(view: OmlxReleaseView): string {
  if (view.installed.version !== null) return view.installed.version;
  if (view.installed.readAt === null) return 'non ancora letta';
  return 'non leggibile';
}

/** One line under the two versions: newer, up to date, or why it is not known. */
export function statusText(view: OmlxReleaseView): { text: string; tone: 'accent' | 'ok' | 'muted' } {
  if (view.update && view.latest !== null) return { text: `C’è una versione più nuova: ${view.latest.version}.`, tone: 'accent' };
  if (view.latest === null) return { text: view.checkedAt === null ? 'Ultima release non ancora controllata.' : 'Nessuna release stabile trovata su GitHub.', tone: 'muted' };
  if (view.installed.version === null) return { text: 'Non so dire se è aggiornato: la versione installata non si legge.', tone: 'muted' };
  return { text: 'oMLX è aggiornato.', tone: 'ok' };
}

/** The pre-release after the newest stable one, as information only. */
export function prereleaseText(view: OmlxReleaseView): string | null {
  if (view.prerelease === null) return null;
  return `In prova: ${view.prerelease.version} (pre-release, non conta come aggiornamento).`;
}

/** When the core looked last and will look next. */
export function scheduleText(view: OmlxReleaseView, format: (iso: string | null) => string): string {
  if (view.checking) return 'Controllo in corso…';
  if (view.checkedAt === null) return 'Mai controllato: il primo controllo parte da solo poco dopo l’avvio.';
  return `Controllato il ${format(view.checkedAt)} · prossimo controllo automatico dal ${format(view.nextCheckAt)}`;
}

/** The address of the release to read: the newest stable one, else the list of releases. */
export function releaseLink(view: OmlxReleaseView): string {
  return view.latest?.url ?? 'https://github.com/jundot/omlx/releases';
}
