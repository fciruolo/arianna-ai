/**
 * GOD (D-127): Arianna developed from inside Arianna. What the page of GOD
 * reads from the core (GET /api/god) and the texts it shows, in Italian.
 */

import type { GodQuota } from './god-work.ts';

/** The agent of GOD's chat (agents/god.yaml). */
export const GOD_AGENT = 'god';

export interface GodClone {
  /** The folder of the clone, relative to the home of Arianna. */
  path: string;
  exists: boolean;
  /** Why it is not a development copy; absent when it is one. */
  refusal?: string;
  branch?: string;
  head?: string;
  /** Commits of the installation's main the clone does not have yet. */
  behind?: number;
  /** Files changed and not committed in the clone. */
  dirty?: number;
}

export interface GodConversation {
  id: string;
  title: string | null;
  workspace: string | null;
  model: string | null;
  lastAt: string;
}

export interface GodStatus {
  project: 'missing' | 'wrong-path' | 'ok';
  /** The part GOD's chat opens on: `arianna:main`. */
  workspace: string;
  /** The container of the clones: `repos/arianna`. */
  container: string;
  main: GodClone;
  available: boolean;
  conversations: GodConversation[];
  /** Absent from an older core. */
  quota?: GodQuota;
}

/** What stops a new conversation with GOD now, in words for the user; null when nothing does. */
export function godBlocker(status: GodStatus): string | null {
  if (status.project === 'missing') return `Registra il progetto: Impostazioni → Progetti, nome arianna, percorso ${status.container}, etichetta Interno.`;
  if (status.project === 'wrong-path') return `Il progetto arianna deve puntare a ${status.container}: correggilo in Impostazioni → Progetti.`;
  if (!status.main.exists) return 'Il clone non c’è ancora: premi «Crea il clone» (o lancia pnpm god:clone).';
  if (status.main.refusal !== undefined) return `Il clone non si può usare: ${status.main.refusal}.`;
  if (!status.available) return 'GOD non può rispondere ora: accendi Claude o Codex in Impostazioni → Modelli.';
  return null;
}

/** One line about the clone GOD reads. */
export function cloneText(clone: GodClone): string {
  if (!clone.exists) return `${clone.path}: non c’è ancora.`;
  if (clone.refusal !== undefined) return `${clone.path}: ${clone.refusal}.`;
  const parts = [clone.path];
  if (clone.branch !== undefined) parts.push(`ramo ${clone.branch}`);
  if (clone.head !== undefined) parts.push(`commit ${clone.head.slice(0, 7)}`);
  if (clone.behind !== undefined) parts.push(clone.behind === 0 ? 'allineato al main dell’installazione' : `${String(clone.behind)} commit indietro rispetto al main`);
  if (clone.dirty !== undefined && clone.dirty > 0) parts.push(`${String(clone.dirty)} file cambiati`);
  return parts.join(' · ');
}

/** The context a conversation with GOD starts from: an earlier conversation ("Riassumi e riparti") or an entry of "Novità" (I-6). */
export interface GodCarry {
  body: string;
  /** The conversation it restarts from, or null. */
  from: string | null;
  /** The version of the entry of "Novità" it starts from (X.Y.Z or `unreleased`), or null; absent from an older core. */
  changelog?: string | null;
}

/** Which entry of "Novità" "Parlane con GOD" is about: the core finds it again in CHANGELOG.md of main. */
export interface ChangelogRef {
  version: string | null;
  section: string;
  text: string;
}

/**
 * Why "Parlane con GOD" is off, in words for the user; null when it is on.
 * `status` null: the core did not answer about GOD (an older core, or an error).
 */
export function discussBlocker(status: GodStatus | null): string | null {
  if (status === null) return 'GOD non risponde: apri la pagina GOD per vedere perché.';
  if (status.project === 'ok' && !status.main.exists) return 'Il clone di GOD non c’è ancora: crealo dalla pagina GOD.';
  return godBlocker(status);
}

/** One line on where a conversation with GOD starts from. */
export function carryOriginText(carry: GodCarry): string {
  const version = carry.changelog ?? null;
  if (version === null) return 'Riparte da una conversazione precedente.';
  return version === 'unreleased' ? 'Parte da una voce delle Novità non ancora rilasciata.' : `Parte da una voce delle Novità, versione ${version}.`;
}
