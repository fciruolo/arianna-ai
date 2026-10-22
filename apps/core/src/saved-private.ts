import { savedMatcher, type KnownPrivate, type SavedValue } from '@arianna/policy';

import { onClientsChanged } from './clients.ts';
import type { Queryable } from './db/client.ts';

/**
 * The private values the user saved (D-283), as the gateway compares them
 * in the agent's browser and in web.fetch instead of the second scanner: of
 * the clients not archived the name, the company name, first and last name
 * together, street with its number (each address), email, PEC, billing email,
 * phone and mobile, partita IVA, codice fiscale and IBAN; of the contacts not
 * removed the name, email, phone and mobile. Built from the database at the
 * start and after every change of a client or a contact, in memory only:
 * never written, never in an event or a log. The gateway gets references
 * (`client:<id>:email`); `savedEntry` says what a reference is, for the card
 * «Apri / No».
 */

/** What a reference is: the kind of the value and the client it belongs to. Never the value. */
export interface SavedEntry {
  kind: SavedKind;
  /** The display name of the client, for the card of the chat (L2, local). */
  client: string;
}

export const SAVED_KINDS = [
  'name',
  'legal-name',
  'person',
  'registered-address',
  'billing-address',
  'shipping-address',
  'email',
  'pec',
  'billing-email',
  'phone',
  'mobile',
  'vat-number',
  'tax-code',
  'iban',
  'contact-name',
  'contact-email',
  'contact-phone',
  'contact-mobile',
] as const;
export type SavedKind = (typeof SAVED_KINDS)[number];

export function isSavedKind(value: unknown): value is SavedKind {
  return SAVED_KINDS.some((kind) => kind === value);
}

interface ClientValues {
  id: string;
  displayName: string;
  legalName: string | null;
  firstName: string | null;
  lastName: string | null;
  registered: unknown;
  billing: unknown;
  shipping: unknown;
  email: string | null;
  pec: string | null;
  billingEmail: string | null;
  phone: string | null;
  mobile: string | null;
  vatNumber: string | null;
  taxCode: string | null;
  iban: string | null;
}

interface ContactValues {
  id: string;
  clientName: string;
  name: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

/** Street and number of an address of a client, together; nothing without both (a street alone is everywhere). */
function streetOf(address: unknown): string | undefined {
  if (typeof address !== 'object' || address === null) return undefined;
  const { street, number } = address as Record<string, unknown>;
  if (typeof street !== 'string' || typeof number !== 'string' || street.trim() === '' || number.trim() === '') return undefined;
  return `${street} ${number}`;
}

/** The saved values from the database, with what each reference is. */
export async function loadSavedValues(sql: Queryable): Promise<{ values: SavedValue[]; entries: Map<string, SavedEntry> }> {
  const clients = await sql<ClientValues[]>`
    SELECT id::text, display_name AS "displayName", legal_name AS "legalName", first_name AS "firstName", last_name AS "lastName",
      registered_address AS registered, billing_address AS billing, shipping_address AS shipping,
      email, pec, billing_email AS "billingEmail", phone, mobile, vat_number AS "vatNumber", tax_code AS "taxCode", iban
    FROM clients WHERE status <> 'archived'`;
  const contacts = await sql<ContactValues[]>`
    SELECT k.id::text, c.display_name AS "clientName", k.name, k.email, k.phone, k.mobile
    FROM client_contacts k JOIN clients c ON c.id = k.client_id
    WHERE k.removed_at IS NULL AND c.status <> 'archived'`;
  const values: SavedValue[] = [];
  const entries = new Map<string, SavedEntry>();
  const add = (owner: string, client: string, kind: SavedKind, value: string | null | undefined, phone = false): void => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const ref = `${owner}:${kind}`;
    values.push({ ref, value, ...(phone ? { phone: true } : {}) });
    entries.set(ref, { kind, client });
  };
  for (const row of clients) {
    const owner = `client:${row.id}`;
    const client = row.displayName;
    add(owner, client, 'name', row.displayName);
    add(owner, client, 'legal-name', row.legalName);
    // First and last name together only: a surname alone does not count.
    if (row.firstName !== null && row.lastName !== null) {
      add(owner, client, 'person', `${row.firstName} ${row.lastName}`);
      // As forms write it, surname first.
      add(owner, client, 'person', `${row.lastName} ${row.firstName}`);
    }
    add(owner, client, 'registered-address', streetOf(row.registered));
    add(owner, client, 'billing-address', streetOf(row.billing));
    add(owner, client, 'shipping-address', streetOf(row.shipping));
    add(owner, client, 'email', row.email);
    add(owner, client, 'pec', row.pec);
    add(owner, client, 'billing-email', row.billingEmail);
    add(owner, client, 'phone', row.phone, true);
    add(owner, client, 'mobile', row.mobile, true);
    add(owner, client, 'vat-number', row.vatNumber);
    // As sites write it, with the country in front («IT01234567890»).
    add(owner, client, 'vat-number', row.vatNumber === null ? null : `IT${row.vatNumber}`);
    add(owner, client, 'tax-code', row.taxCode);
    add(owner, client, 'iban', row.iban);
  }
  for (const row of contacts) {
    const owner = `contact:${row.id}`;
    add(owner, row.clientName, 'contact-name', row.name);
    add(owner, row.clientName, 'contact-email', row.email);
    add(owner, row.clientName, 'contact-phone', row.phone, true);
    add(owner, row.clientName, 'contact-mobile', row.mobile, true);
  }
  return { values, entries };
}

interface Loaded {
  known: KnownPrivate;
  entries: Map<string, SavedEntry>;
}

let loaded: Loaded | null = null;
let running: Promise<void> | null = null;
let again = false;
let stop: (() => void) | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
/** After a failed load: the values are forgotten (fail closed) and loaded again after this long. */
export const RETRY_MS = 30_000;

/**
 * The matcher the gateway gets from passGateway. Before the first load it
 * throws, and the gateway refuses (fail closed): no page goes unchecked.
 */
export const knownPrivate: KnownPrivate = {
  find(text: string): string[] {
    if (loaded === null) throw new Error('the saved private values are not loaded yet');
    return loaded.known.find(text);
  },
};

/** What a reference is, while it is still saved; undefined for one that is gone. */
export function savedEntry(ref: string): SavedEntry | undefined {
  return loaded?.entries.get(ref);
}

/** Whether a change came while the values were loading (read through a function: the load awaits). */
const changedMeanwhile = (): boolean => again;

/** Builds the values again from the database; one load at a time, a change during a load loads once more after it. */
export function refreshSavedPrivate(sql: Queryable): Promise<void> {
  if (running !== null) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const { values, entries } = await loadSavedValues(sql);
        loaded = { known: savedMatcher(values), entries };
      } while (changedMeanwhile());
    } catch (error) {
      // An old list would miss what just changed: nothing is compared until a load succeeds, and one is tried again.
      loaded = null;
      if (retry === null) {
        retry = setTimeout(() => {
          retry = null;
          refreshSavedPrivate(sql).catch(() => undefined);
        }, RETRY_MS);
        retry.unref();
      }
      throw error;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** At the start of the core: the first load, then a new one after every change of the clients. */
export async function startSavedPrivate(sql: Queryable, report: (error: unknown) => void): Promise<void> {
  stop?.();
  stop = onClientsChanged(() => { refreshSavedPrivate(sql).catch(report); });
  await refreshSavedPrivate(sql);
}

/** Tests without a database: these values, as if loaded. */
export function useSavedValues(values: readonly SavedValue[], entries: ReadonlyMap<string, SavedEntry> = new Map()): void {
  loaded = { known: savedMatcher(values), entries: new Map(entries) };
}

/** Tests: forgets the values and the listener, as before the start. */
export function resetSavedPrivate(): void {
  if (retry !== null) clearTimeout(retry);
  retry = null;
  stop?.();
  stop = null;
  loaded = null;
  again = false;
}
