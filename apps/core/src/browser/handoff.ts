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
}

export interface HandoffEnv {
  sql: Sql;
  browser: HandoffBrowser;
  /** The kind of a conversation (conversationKindOf of screen.ts). */
  kind: (conversationId: string) => Promise<ConversationKind | null>;
}

/**
 * Opens the Private chat of the access of `from` and passes the browser to
 * it. Its id, or null when `from` holds no browser with an access any more
 * (closed meanwhile): then no chat is opened.
 */
export async function openBrowserChat(env: HandoffEnv, from: string): Promise<string | null> {
  const site = env.browser.accessOf(from);
  if (site === null) return null;
  const [row] = await env.sql<{ id: string }[]>`
    INSERT INTO conversations (mode, clearance, effective_label, title, browser_of)
    VALUES ('private', 'L2'::privacy_label, 'L2'::privacy_label, ${browserChatTitle(site)}, ${from})
    RETURNING id::text`;
  if (row === undefined) throw new Error('INSERT INTO conversations returned no row');
  const to = row.id;
  await appendEvent(env.sql, { kind: 'conversation.created', label: 'L0', payload: { conversationId: to, mode: 'private', browser: true } });
  const moved = await env.browser.handOver(from, to);
  if (moved === null) {
    // Closed between the two: the chat says so, the work conversation keeps the line of D-276.
    await writeBrowserLine(env.sql, to, 'Il browser si è chiuso prima di passare qui: l’accesso è perso. Se serve, rifallo da una conversazione di lavoro.');
    return null;
  }
  await writeBrowserLine(env.sql, to, browserChatLine(moved), 'L2');
  await writeBrowserLine(env.sql, from, HANDOFF_LINE);
  await appendEvent(env.sql, { kind: 'browser.handoff', label: 'L0', payload: { from, to } });
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
    if ((await openBrowserChat(env, conversationId)) !== null) return;
  }
  // Read again: the browser may have closed while the chat was opened.
  await writeControlLine(env.sql, conversationId, change, kind === 'work' ? env.browser.accessOf(conversationId) : null);
}
