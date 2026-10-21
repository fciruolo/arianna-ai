import { randomUUID } from 'node:crypto';

import type { Sql } from '../db/client.ts';
import { appendEvent } from '../events.ts';
import { writeBrowserLine, writeControlLine } from '../orchestrator/browser-tool.ts';
import type { ControlEnd, ConversationKind } from './screen.ts';

/**
 * «Nuova chat Privata» (D-281, choice of the user of 2026-10-21): when the
 * user gives the browser back in a work conversation where they made an
 * access (D-276), the core opens a Private conversation that takes the
 * browser. The work conversation stays as it is: it loses the browser and
 * reads a line, without the site, that points to the new chat. In the new
 * chat only the local model works, the browser is L2, and only what comes
 * from the site of the access and from the user enters it (the tools of
 * that chat, orchestrator.ts; the context marked with the site, D-281 in
 * docs/PRIVACY-POLICY-SPEC.md).
 */

/** The line of the work conversation (read by its model too): never the site, which says something of the user. */
export const HANDOFF_LINE =
  'Hai fatto l’accesso a un sito: il browser è passato a una nuova chat Privata, dove lavora solo il modello locale. Qui Arianna non usa più quel browser.';

/** The line of the work conversation when the Private chat could not be opened: the browser closed with its access. */
export const HANDOFF_FAILED_LINE = 'Il browser con il tuo accesso non è potuto passare a una chat Privata e si è chiuso: l’accesso è perso. Se serve, Arianna riapre il browser senza accesso.';

/** The first line of the Private chat, L2: it names the site. */
export function browserChatLine(site: string): string {
  return `Hai fatto l’accesso a ${site} e il browser è passato qui, in una chat Privata: lavora solo il modello locale di Arianna, che legge le pagine di ${site} e agisce nel browser, solo su quel sito. Prima di inviare dati al sito ti chiede «Invia / No». Scrivi cosa vuoi fare.`;
}

/** The title of the Private chat (it carries the clearance, L2). */
export function browserChatTitle(site: string): string {
  return `${site} · accesso`;
}

/** What handoff needs of the browser (AgentBrowser). */
export interface HandoffBrowser {
  accessOf(conversationId: string): string | null;
  handOver(from: string, to: string): Promise<string | null>;
  /** Closes the browser of a conversation (AgentBrowser.release). */
  release(conversationId: string): Promise<void>;
}

export interface HandoffEnv {
  sql: Sql;
  browser: HandoffBrowser;
  /** The kind of a conversation (conversationKindOf of screen.ts). */
  kind: (conversationId: string) => Promise<ConversationKind | null>;
}

/**
 * Passes the browser of the access of `from` to a new Private chat, then
 * writes the chat, its line, the line of the work conversation and the
 * events in one transaction. The id of the chat, or null when `from` holds no
 * browser with an access any more (closed meanwhile): then nothing is
 * written. When the chat cannot be written the browser is closed: it never
 * stays with a conversation that does not exist.
 */
export async function openBrowserChat(env: HandoffEnv, from: string): Promise<string | null> {
  if (env.browser.accessOf(from) === null) return null;
  const to = randomUUID();
  const site = await env.browser.handOver(from, to);
  if (site === null) return null;
  try {
    await env.sql.begin(async (tx) => {
      await tx`
        INSERT INTO conversations (id, mode, clearance, effective_label, title, browser_of)
        VALUES (${to}, 'private', 'L2'::privacy_label, 'L2'::privacy_label, ${browserChatTitle(site)}, ${from})`;
      await appendEvent(tx, { kind: 'conversation.created', label: 'L0', payload: { conversationId: to, mode: 'private', browser: true } });
      await writeBrowserLine(tx, to, browserChatLine(site), 'L2');
      await writeBrowserLine(tx, from, HANDOFF_LINE);
      await appendEvent(tx, { kind: 'browser.handoff', label: 'L0', payload: { from, to } });
    });
  } catch (error) {
    await env.browser.release(to).catch(() => undefined);
    throw error;
  }
  return to;
}

/**
 * A change of the control (BrowserScreens.onControl): given back in a work
 * conversation with an access, the browser passes to a new Private chat;
 * otherwise the lines of «Prendi il controllo». In the Private chat of an
 * access the line of a give back is the ordinary one: there Arianna reads
 * the page again.
 */
export async function afterControl(
  env: HandoffEnv,
  conversationId: string,
  change: { state: 'taken' } | { state: 'returned'; reason: ControlEnd },
): Promise<void> {
  const kind = await env.kind(conversationId);
  const access = kind === 'work' ? env.browser.accessOf(conversationId) : null;
  if (change.state === 'returned' && change.reason !== 'browser-closed' && access !== null) {
    try {
      if ((await openBrowserChat(env, conversationId)) !== null) return;
    } catch {
      // The chat could not be written (the work conversation erased meanwhile, the database): its browser is closed.
      console.warn('browser: the private chat of an access could not be opened');
      await env.browser.release(conversationId).catch(() => undefined);
      await writeBrowserLine(env.sql, conversationId, HANDOFF_FAILED_LINE);
      return;
    }
  }
  // Read again: the browser may have closed while the chat was opened.
  await writeControlLine(env.sql, conversationId, change, kind === 'work' ? env.browser.accessOf(conversationId) : null);
}
