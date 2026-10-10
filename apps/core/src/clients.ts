import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Label } from '@arianna/policy';

import {
  areaOf,
  changedFields,
  checkClient,
  checkContact,
  effectiveSdi,
  LOGO_EXTENSION,
  LOGO_TYPES,
  logoTypeOf,
  MAX_LOGO_BYTES,
  type Address,
  type ClientArea,
  type ClientFields,
  type ClientStatus,
  type ContactFields,
  type Issue,
  type LogoType,
} from './clients-format.ts';
import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';

/**
 * The clients (I-16, D-168, tappa C1): the registry with what an invoice
 * needs, the people of each client, the projects it has and its logo. All
 * of it is the user's and private (L2): it stays on this machine. The web
 * chat is local; the events carry ids and names of fields only, never the
 * data; nothing here is read by the orchestrator, the delegations, the work
 * diary or the indexing of kb/ (the rows live only in these tables, the
 * logos in data/clients).
 * The core never deletes (D-046): a client is archived, a contact or a link
 * to a project removed with removed_at.
 */

/** The name of a project as the containers of arianna.toml hold it (the same check as migration 0048). */
export const PROJECT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
/** Most contacts and projects of one client. */
export const MAX_CONTACTS = 50;
export const MAX_PROJECTS = 50;

export class ClientError extends Error {
  override name = 'ClientError';
  readonly code: 'not-found' | 'invalid' | 'conflict';
  /** The fields that did not pass, with why: the chat shows them next to each field. */
  readonly issues: Issue[];

  constructor(code: 'not-found' | 'invalid' | 'conflict', message: string, issues: Issue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

export interface ClientContact extends ContactFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClientProject {
  /** The id of the link. */
  id: string;
  project: string;
  /** Still among the approved containers of arianna.toml. */
  approved: boolean;
  createdAt: string;
}

export interface ClientLogo {
  type: LogoType;
  /** The first 16 characters of the hash: changes the address of the image when the logo changes. */
  version: string;
}

/** A client in full, as the detail page shows it. */
export interface Client extends Omit<ClientFields, 'status'> {
  id: string;
  status: ClientStatus;
  area: ClientArea;
  /** The CodiceDestinatario the invoice will carry (effectiveSdi). */
  sdiEffective: string;
  logo: ClientLogo | null;
  label: Label;
  contacts: ClientContact[];
  projects: ClientProject[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** A client in the list. */
export interface ClientSummary {
  id: string;
  kind: ClientFields['kind'];
  status: ClientStatus;
  displayName: string;
  legalName: string | null;
  country: string;
  area: ClientArea;
  vatNumber: string | null;
  email: string | null;
  tags: string[];
  logo: ClientLogo | null;
  projects: string[];
  primaryContact: { name: string; email: string | null; phone: string | null } | null;
  updatedAt: string;
}

/** What may be named: the approved containers of arianna.toml (D-145). */
export interface ClientNames {
  projects: readonly string[];
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const CLIENT_COLUMNS = {
  kind: 'kind',
  status: 'status',
  displayName: 'display_name',
  legalName: 'legal_name',
  firstName: 'first_name',
  lastName: 'last_name',
  sector: 'sector',
  website: 'website',
  notes: 'notes',
  tags: 'tags',
  country: 'country',
  vatNumber: 'vat_number',
  taxCode: 'tax_code',
  euVatNumber: 'eu_vat_number',
  foreignTaxId: 'foreign_tax_id',
  vatRate: 'vat_rate',
  vatNature: 'vat_nature',
  splitPayment: 'split_payment',
  withholdingAgent: 'withholding_agent',
  sdiCode: 'sdi_code',
  pec: 'pec',
  ipaCode: 'ipa_code',
  cig: 'cig',
  cup: 'cup',
  registeredAddress: 'registered_address',
  billingAddress: 'billing_address',
  shippingAddress: 'shipping_address',
  billingEmail: 'billing_email',
  paymentMethod: 'payment_method',
  paymentDays: 'payment_days',
  paymentEndOfMonth: 'payment_end_of_month',
  currency: 'currency',
  invoiceLanguage: 'invoice_language',
  purchaseOrder: 'purchase_order',
  iban: 'iban',
  email: 'email',
  phone: 'phone',
  mobile: 'mobile',
} as const satisfies Record<keyof ClientFields, string>;

type ClientRow = Omit<ClientFields, 'status' | 'vatRate'> & {
  id: string;
  status: ClientStatus;
  /** numeric comes as text from postgres.js. */
  vatRate: string | null;
  logoType: LogoType | null;
  logoSha256: string | null;
  label: Label;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

function selectClient(sql: Queryable) {
  return sql`
    SELECT id::text, kind, status, display_name AS "displayName", legal_name AS "legalName", first_name AS "firstName", last_name AS "lastName",
      sector, website, notes, tags, country, vat_number AS "vatNumber", tax_code AS "taxCode", eu_vat_number AS "euVatNumber",
      foreign_tax_id AS "foreignTaxId", vat_rate::text AS "vatRate", vat_nature AS "vatNature", split_payment AS "splitPayment",
      withholding_agent AS "withholdingAgent", sdi_code AS "sdiCode", pec, ipa_code AS "ipaCode", cig, cup,
      registered_address AS "registeredAddress", billing_address AS "billingAddress", shipping_address AS "shippingAddress",
      billing_email AS "billingEmail", payment_method AS "paymentMethod", payment_days AS "paymentDays",
      payment_end_of_month AS "paymentEndOfMonth", currency, invoice_language AS "invoiceLanguage", purchase_order AS "purchaseOrder",
      iban, email, phone, mobile, logo_type AS "logoType", logo_sha256 AS "logoSha256", label,
      created_at AS "createdAt", updated_at AS "updatedAt", archived_at AS "archivedAt"
    FROM clients`;
}

function fieldsOf(row: ClientRow): ClientFields {
  const fields = {} as Record<keyof ClientFields, unknown>;
  for (const key of Object.keys(CLIENT_COLUMNS) as (keyof ClientFields)[]) fields[key] = row[key as keyof ClientRow];
  fields.status = row.status === 'archived' ? 'active' : row.status;
  fields.vatRate = row.vatRate === null ? null : Number(row.vatRate);
  return fields as ClientFields;
}

function logoOf(row: { logoType: LogoType | null; logoSha256: string | null }): ClientLogo | null {
  return row.logoType === null || row.logoSha256 === null ? null : { type: row.logoType, version: row.logoSha256.slice(0, 16) };
}

interface ContactRow extends ContactFields {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

function contactOf(row: ContactRow): ClientContact {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

const CONTACT_SELECT = 'id::text, name, role, email, phone, mobile, notes, is_primary AS "primary", created_at AS "createdAt", updated_at AS "updatedAt"';

async function loadRow(sql: Queryable, id: string, lock = false): Promise<ClientRow> {
  const [row] = lock
    ? await sql<ClientRow[]>`${selectClient(sql)} WHERE id = ${id} FOR UPDATE`
    : await sql<ClientRow[]>`${selectClient(sql)} WHERE id = ${id}`;
  if (row === undefined) throw new ClientError('not-found', 'no such client');
  return row;
}

function invalid(issues: Issue[]): ClientError {
  return new ClientError('invalid', `invalid field(s): ${issues.map((issue) => `${issue.field} (${issue.code})`).join(', ')}`, issues);
}

/** A unique index broken: the partita IVA of another client, a project of another client, a second primary contact. */
function conflictOf(error: unknown): ClientError | undefined {
  const known = error as { code?: string; constraint_name?: string };
  if (known.code !== '23505') return undefined;
  if (known.constraint_name === 'clients_vat_number_key') return new ClientError('conflict', 'another client has this partita IVA', [{ field: 'vatNumber', code: 'not-allowed' }]);
  if (known.constraint_name === 'client_projects_one_client') return new ClientError('conflict', 'the project belongs to another client');
  return new ClientError('conflict', 'the change conflicts with another row');
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw conflictOf(error) ?? error;
  }
}

/** The values of the fields as the columns of `clients` hold them. */
function columnsOf(sql: Queryable, fields: ClientFields): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(CLIENT_COLUMNS) as [keyof ClientFields, string][]) {
    const value = fields[key];
    values[column] = key === 'registeredAddress' || key === 'billingAddress' || key === 'shippingAddress' ? (value === null ? null : sql.json(value as Address as unknown as Record<string, string>)) : value;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Every client, archived included (the chat filters), by name. */
export async function listClients(sql: Queryable): Promise<ClientSummary[]> {
  const rows = await sql<(ClientRow & { projects: string[]; contactName: string | null; contactEmail: string | null; contactPhone: string | null })[]>`
    SELECT c.*,
      coalesce((SELECT array_agg(p.project ORDER BY p.project) FROM client_projects p WHERE p.client_id = c.id::uuid AND p.removed_at IS NULL), '{}') AS projects,
      k.name AS "contactName", k.email AS "contactEmail", coalesce(k.phone, k.mobile) AS "contactPhone"
    FROM (${selectClient(sql)}) c
    LEFT JOIN LATERAL (
      SELECT name, email, phone, mobile FROM client_contacts
      WHERE client_id = c.id::uuid AND removed_at IS NULL ORDER BY is_primary DESC, created_at, id LIMIT 1
    ) k ON true
    ORDER BY lower(c."displayName"), c.id`;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    displayName: row.displayName,
    legalName: row.legalName,
    country: row.country,
    area: areaOf(row.country),
    vatNumber: row.vatNumber,
    email: row.email,
    tags: row.tags,
    logo: logoOf(row),
    projects: row.projects,
    primaryContact: row.contactName === null ? null : { name: row.contactName, email: row.contactEmail, phone: row.contactPhone },
    updatedAt: row.updatedAt.toISOString(),
  }));
}

/** A client in full, with its contacts and projects. */
export async function readClient(sql: Queryable, id: string, names?: ClientNames): Promise<Client> {
  const row = await loadRow(sql, id);
  const contacts = await sql.unsafe<ContactRow[]>(`SELECT ${CONTACT_SELECT} FROM client_contacts WHERE client_id = $1 AND removed_at IS NULL ORDER BY is_primary DESC, created_at, id`, [id]);
  const projects = await sql<{ id: string; project: string; createdAt: Date }[]>`
    SELECT id::text, project, created_at AS "createdAt" FROM client_projects WHERE client_id = ${id} AND removed_at IS NULL ORDER BY project`;
  const fields = fieldsOf(row);
  return {
    ...fields,
    id: row.id,
    status: row.status,
    area: areaOf(fields.country),
    sdiEffective: effectiveSdi(fields),
    logo: logoOf(row),
    label: row.label,
    contacts: contacts.map(contactOf),
    projects: projects.map((item) => ({ id: item.id, project: item.project, approved: names === undefined || names.projects.includes(item.project), createdAt: item.createdAt.toISOString() })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** The client of a project, if one has it: what the page Progetti shows in its header. */
export async function clientOfProject(sql: Queryable, project: string): Promise<{ id: string; displayName: string; logo: ClientLogo | null } | null> {
  const [row] = await sql<{ id: string; displayName: string; logoType: LogoType | null; logoSha256: string | null }[]>`
    SELECT c.id::text, c.display_name AS "displayName", c.logo_type AS "logoType", c.logo_sha256 AS "logoSha256"
    FROM client_projects p JOIN clients c ON c.id = p.client_id
    WHERE p.project = ${project} AND p.removed_at IS NULL`;
  return row === undefined ? null : { id: row.id, displayName: row.displayName, logo: logoOf(row) };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** A new client: checked as a whole, private (L2), active or prospect. */
export async function createClient(sql: Sql, input: Record<string, unknown>): Promise<{ id: string }> {
  const checked = checkClient(input);
  if (!checked.ok) throw invalid(checked.issues);
  return guarded(() =>
    sql.begin(async (tx) => {
      const values = columnsOf(tx, checked.value);
      const [row] = await tx<{ id: string }[]>`INSERT INTO clients ${tx(values)} RETURNING id::text`;
      if (row === undefined) throw new Error('INSERT INTO clients returned no row');
      await appendEvent(tx, { kind: 'client.created', payload: { clientId: row.id } });
      return row;
    }),
  );
}

/** A change of some fields: merged over the client as it is and checked as a whole. An archived client is restored first. */
export async function updateClient(sql: Sql, id: string, input: Record<string, unknown>): Promise<{ id: string; changed: string[] }> {
  return guarded(() =>
    sql.begin(async (tx) => {
      const row = await loadRow(tx, id, true);
      if (row.status === 'archived') throw new ClientError('conflict', 'the client is archived: restore it first');
      const before = fieldsOf(row);
      const checked = checkClient(input, before);
      if (!checked.ok) throw invalid(checked.issues);
      const changed = changedFields(before, checked.value);
      if (changed.length === 0) return { id, changed: [] };
      const all = columnsOf(tx, checked.value);
      const values = Object.fromEntries(changed.map((key) => [CLIENT_COLUMNS[key], all[CLIENT_COLUMNS[key]]]));
      await tx`UPDATE clients SET ${tx(values)}, updated_at = now() WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'client.updated', payload: { clientId: id, fields: changed } });
      return { id, changed };
    }),
  );
}

/** "Archivia" and "Ripristina": an archived client leaves the list of the active ones, never the database. */
export async function archiveClient(sql: Sql, id: string, archived: boolean): Promise<{ id: string; status: ClientStatus }> {
  return guarded(() =>
    sql.begin(async (tx) => {
      const row = await loadRow(tx, id, true);
      if ((row.status === 'archived') === archived) return { id, status: row.status };
      // Restored, a client goes back to the status it had: the archive event keeps it (a word, not data).
      let status: ClientStatus = 'archived';
      if (!archived) {
        const [last] = await tx<{ from: string | null }[]>`
          SELECT payload ->> 'from' AS from FROM events WHERE kind = 'client.archived' AND payload ->> 'clientId' = ${id} ORDER BY id DESC LIMIT 1`;
        status = last?.from === 'prospect' ? 'prospect' : 'active';
      }
      await tx`UPDATE clients SET status = ${status}, archived_at = ${archived ? tx`now()` : null}, updated_at = now() WHERE id = ${id}`;
      await appendEvent(tx, { kind: archived ? 'client.archived' : 'client.restored', payload: archived ? { clientId: id, from: row.status } : { clientId: id } });
      return { id, status };
    }),
  );
}

async function touch(tx: Queryable, id: string): Promise<void> {
  await tx`UPDATE clients SET updated_at = now() WHERE id = ${id}`;
}

async function openClient(tx: Queryable, id: string): Promise<ClientRow> {
  const row = await loadRow(tx, id, true);
  if (row.status === 'archived') throw new ClientError('conflict', 'the client is archived: restore it first');
  return row;
}

/** A primary contact takes the place of the one before. */
async function clearPrimary(tx: Queryable, id: string, except: string | null): Promise<void> {
  await tx`UPDATE client_contacts SET is_primary = false, updated_at = now()
    WHERE client_id = ${id} AND is_primary AND removed_at IS NULL AND (${except}::uuid IS NULL OR id <> ${except}::uuid)`;
}

export async function addContact(sql: Sql, id: string, input: Record<string, unknown>): Promise<ClientContact> {
  const checked = checkContact(input);
  if (!checked.ok) throw invalid(checked.issues);
  const contact = checked.value;
  return sql.begin(async (tx) => {
    await openClient(tx, id);
    const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM client_contacts WHERE client_id = ${id} AND removed_at IS NULL`;
    if ((count?.count ?? 0) >= MAX_CONTACTS) throw new ClientError('conflict', `a client holds ${String(MAX_CONTACTS)} contacts at most`);
    if (contact.primary) await clearPrimary(tx, id, null);
    const [row] = await tx.unsafe<ContactRow[]>(
      `INSERT INTO client_contacts (client_id, name, role, email, phone, mobile, notes, is_primary) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${CONTACT_SELECT}`,
      [id, contact.name, contact.role, contact.email, contact.phone, contact.mobile, contact.notes, contact.primary],
    );
    if (row === undefined) throw new Error('INSERT INTO client_contacts returned no row');
    await touch(tx, id);
    await appendEvent(tx, { kind: 'client.contact.added', payload: { clientId: id, contactId: row.id } });
    return contactOf(row);
  });
}

export async function updateContact(sql: Sql, id: string, contactId: string, input: Record<string, unknown>): Promise<ClientContact> {
  return sql.begin(async (tx) => {
    await openClient(tx, id);
    const [current] = await tx.unsafe<ContactRow[]>(`SELECT ${CONTACT_SELECT} FROM client_contacts WHERE id = $1 AND client_id = $2 AND removed_at IS NULL FOR UPDATE`, [contactId, id]);
    if (current === undefined) throw new ClientError('not-found', 'no such contact');
    const base: ContactFields = { name: current.name, role: current.role, email: current.email, phone: current.phone, mobile: current.mobile, notes: current.notes, primary: current.primary };
    const checked = checkContact(input, base);
    if (!checked.ok) throw invalid(checked.issues);
    const contact = checked.value;
    if (contact.primary && !current.primary) await clearPrimary(tx, id, contactId);
    const [row] = await tx.unsafe<ContactRow[]>(
      `UPDATE client_contacts SET name = $3, role = $4, email = $5, phone = $6, mobile = $7, notes = $8, is_primary = $9, updated_at = now()
       WHERE id = $1 AND client_id = $2 RETURNING ${CONTACT_SELECT}`,
      [contactId, id, contact.name, contact.role, contact.email, contact.phone, contact.mobile, contact.notes, contact.primary],
    );
    if (row === undefined) throw new ClientError('not-found', 'no such contact');
    await touch(tx, id);
    await appendEvent(tx, { kind: 'client.contact.changed', payload: { clientId: id, contactId } });
    return contactOf(row);
  });
}

export async function removeContact(sql: Sql, id: string, contactId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await openClient(tx, id);
    const [row] = await tx<{ id: string }[]>`
      UPDATE client_contacts SET removed_at = now(), is_primary = false, updated_at = now()
      WHERE id = ${contactId} AND client_id = ${id} AND removed_at IS NULL RETURNING id::text`;
    if (row === undefined) throw new ClientError('not-found', 'no such contact');
    await touch(tx, id);
    await appendEvent(tx, { kind: 'client.contact.removed', payload: { clientId: id, contactId } });
  });
}

/** Links an approved project to the client: a project belongs to one client at most. */
export async function linkProject(sql: Sql, id: string, project: unknown, names: ClientNames): Promise<ClientProject> {
  if (typeof project !== 'string' || !PROJECT_NAME.test(project) || !names.projects.includes(project)) {
    throw new ClientError('invalid', 'unknown project', [{ field: 'project', code: 'format' }]);
  }
  return guarded(() =>
    sql.begin(async (tx) => {
      await openClient(tx, id);
      const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM client_projects WHERE client_id = ${id} AND removed_at IS NULL`;
      if ((count?.count ?? 0) >= MAX_PROJECTS) throw new ClientError('conflict', `a client has ${String(MAX_PROJECTS)} projects at most`);
      const [row] = await tx<{ id: string; createdAt: Date }[]>`
        INSERT INTO client_projects (client_id, project) VALUES (${id}, ${project}) RETURNING id::text, created_at AS "createdAt"`;
      if (row === undefined) throw new Error('INSERT INTO client_projects returned no row');
      await touch(tx, id);
      await appendEvent(tx, { kind: 'client.project.linked', payload: { clientId: id, linkId: row.id } });
      return { id: row.id, project, approved: true, createdAt: row.createdAt.toISOString() };
    }),
  );
}

export async function unlinkProject(sql: Sql, id: string, linkId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await loadRow(tx, id, true);
    const [row] = await tx<{ id: string }[]>`
      UPDATE client_projects SET removed_at = now() WHERE id = ${linkId} AND client_id = ${id} AND removed_at IS NULL RETURNING id::text`;
    if (row === undefined) throw new ClientError('not-found', 'no such project of the client');
    await touch(tx, id);
    await appendEvent(tx, { kind: 'client.project.unlinked', payload: { clientId: id, linkId } });
  });
}

// ---------------------------------------------------------------------------
// The logo: data/clients/<id>/logo.<png|jpg|webp>
// ---------------------------------------------------------------------------

function logoPath(dir: string, id: string, type: LogoType): string {
  return join(dir, id, `logo.${LOGO_EXTENSION[type]}`);
}

/** The folder of a client's files, created private; never a link. */
function clientFolder(dir: string, id: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('data/clients is not a folder');
  const folder = join(dir, id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!lstatSync(folder).isDirectory()) throw new Error('the folder of a client is not a folder');
  return folder;
}

/** The other logos of the client, gone after a new one or "Togli". */
function removeLogos(dir: string, id: string, keep: LogoType | null): void {
  for (const type of LOGO_TYPES) {
    if (type === keep) continue;
    try {
      unlinkSync(logoPath(dir, id, type));
    } catch {
      // Not there.
    }
  }
}

/**
 * The logo writes of each client, one after the other: two uploads of
 * different types must not cross between the commit and the rename (the
 * database would name a file the other one removed). The core is one process.
 */
const logoQueues = new Map<string, Promise<unknown>>();

async function oneLogoAtATime<T>(id: string, work: () => Promise<T>): Promise<T> {
  const before = logoQueues.get(id) ?? Promise.resolve();
  const turn = before.then(work, work);
  const settled = turn.catch(() => undefined);
  logoQueues.set(id, settled);
  try {
    return await turn;
  } finally {
    if (logoQueues.get(id) === settled) logoQueues.delete(id);
  }
}

/**
 * The logo, from the chat as base64: PNG, JPEG or WebP by its first bytes
 * (never SVG, which can carry a script), 1 MB at most. Written to a new file
 * (O_EXCL, O_NOFOLLOW, 0600), recorded with its hash, then moved in place of
 * the old one: a rename replaces a link without following it.
 */
export async function setLogo(sql: Sql, dir: string, id: string, input: { type?: unknown; data?: unknown }): Promise<ClientLogo> {
  if (typeof input.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new ClientError('invalid', 'data must be base64', [{ field: 'logo', code: 'type' }]);
  if (input.data.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4) throw new ClientError('invalid', 'the logo is 1 MB at most', [{ field: 'logo', code: 'too-long' }]);
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length > MAX_LOGO_BYTES) throw new ClientError('invalid', 'the logo is 1 MB at most', [{ field: 'logo', code: 'too-long' }]);
  const type = logoTypeOf(bytes);
  if (type === undefined) throw new ClientError('invalid', 'the logo must be a PNG, JPEG or WebP image', [{ field: 'logo', code: 'format' }]);
  if (input.type !== undefined && input.type !== type) throw new ClientError('invalid', 'the type does not match the image', [{ field: 'logo', code: 'format' }]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return oneLogoAtATime(id, () => writeLogo(sql, dir, id, type, bytes, sha256));
}

async function writeLogo(sql: Sql, dir: string, id: string, type: LogoType, bytes: Buffer, sha256: string): Promise<ClientLogo> {
  await loadRow(sql, id);
  const folder = clientFolder(dir, id);
  const temporary = join(folder, `.logo-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    await sql.begin(async (tx) => {
      await openClient(tx, id);
      await tx`UPDATE clients SET logo_type = ${type}, logo_sha256 = ${sha256}, updated_at = now() WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'client.logo.set', payload: { clientId: id } });
    });
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  renameSync(temporary, logoPath(dir, id, type));
  removeLogos(dir, id, type);
  return { type, version: sha256.slice(0, 16) };
}

export async function removeLogo(sql: Sql, dir: string, id: string): Promise<void> {
  await oneLogoAtATime(id, async () => {
    const had = await sql.begin(async (tx) => {
      const row = await openClient(tx, id);
      if (row.logoType === null) return false;
      await tx`UPDATE clients SET logo_type = NULL, logo_sha256 = NULL, updated_at = now() WHERE id = ${id}`;
      await appendEvent(tx, { kind: 'client.logo.removed', payload: { clientId: id } });
      return true;
    });
    if (had) removeLogos(dir, id, null);
  });
}

/** The bytes of the logo, checked against the hash recorded: neither the folder nor the file may be a link. */
export async function readLogo(sql: Queryable, dir: string, id: string): Promise<{ type: LogoType; bytes: Buffer }> {
  const row = await loadRow(sql, id);
  if (row.logoType === null || row.logoSha256 === null) throw new ClientError('not-found', 'no logo');
  const path = logoPath(dir, id, row.logoType);
  let bytes: Buffer;
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, id)).isDirectory() || !lstatSync(path).isFile()) throw new Error('not a file');
    bytes = readFileSync(path);
  } catch {
    throw new ClientError('not-found', 'the logo is missing');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== row.logoSha256) throw new ClientError('conflict', 'the logo has changed on disk');
  return { type: row.logoType, bytes };
}

