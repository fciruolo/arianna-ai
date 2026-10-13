import {
  addMonthsToMonth,
  balanceSeries,
  categorize,
  cellText,
  FinanceImportError,
  findHeader,
  monthlyTotals,
  previewImport,
  previewStatement,
  readStatement,
  ruleFromConfirmation,
  runChecks,
  totalsByCategory,
  yearOverYear,
  type BalancePoint,
  type BankProfile,
  type Budget as AnalysisBudget,
  type CategorizedTransaction,
  type CategoryRule,
  type CategoryTotal,
  type Day,
  type FinanceAlert,
  type ImportPreview,
  type Month,
  type MonthTotal,
  type Statement,
  type YearOverYear,
} from '@arianna/finance';

import type { Queryable, Sql } from './db/client.ts';
import { appendEvent } from './events.ts';
import {
  currencyOf,
  DEFAULT_CATEGORIES,
  DEFAULT_TX_LIMIT,
  decodeFile,
  FinanceError,
  invalid,
  isId,
  lastDayOf,
  lineOf,
  MAX_ACCOUNT_NAME,
  MAX_BUDGET_CENTS,
  MAX_CATEGORY_NAME,
  MAX_FINGERPRINTS,
  MAX_FILE_NAME,
  MAX_RULE_MATCH,
  MAX_TX_LIMIT,
  monthOfDate,
  notFound,
  onlyFields,
  parseProfile,
  PREVIEW_ROWS,
  searchText,
  sheetOf,
  storedProfile,
} from './finance-format.ts';

/**
 * The expense tracker in the core (I-18, D-183): the operations of the
 * contract docs/FINANCE-API.md on the finance_* tables (migration 0056), with
 * the pure reading and analysis of @arianna/finance. Everything here is
 * private (L2, source finance:*) and stays on this machine: no function sends
 * anything anywhere, events carry ids and counts only, and the file of a
 * statement is read in memory and never stored.
 */

export interface Account {
  id: string;
  name: string;
  currency: string;
  profile: BankProfile | null;
  archived: boolean;
  transactions: number;
  lastBooked: Day | null;
}

export interface PreviewRowOut {
  line: number;
  booked: Day;
  value: Day | null;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
}

export interface Preview {
  kind: 'csv' | 'xlsx';
  sheets: string[] | null;
  sheet: string | null;
  profile: BankProfile | null;
  guessed: boolean;
  headerLine: number | null;
  header: string[];
  newestFirst: boolean;
  rows: PreviewRowOut[];
  duplicates: number;
  rejected: { line: number; code: string }[];
  totals: { count: number; income: number; expenses: number };
}

export interface ImportRecord {
  id: string;
  account: string;
  name: string;
  at: string;
  imported: number;
  duplicates: number;
  rejected: number;
}

export interface Tx {
  id: string;
  account: string;
  booked: Day;
  value: Day | null;
  description: string;
  amount: number;
  currency: string;
  balance: number | null;
  category: string | null;
  by: 'rule' | 'user' | null;
  importId: string;
  /** What the alerts name the movement by (FinanceAlert of @arianna/finance). */
  fingerprint: string;
}

export interface Category {
  id: string;
  name: string;
  kind: 'out' | 'in';
}

export interface Rule {
  id: string;
  match: string;
  category: string;
}

export interface Budget {
  category: string;
  monthly: number;
}

export interface Summary {
  months: MonthTotal[];
  categories: CategoryTotal[];
  balance: BalancePoint[];
  yearOverYear: YearOverYear | null;
}

// ---------------------------------------------------------------------------
// Categories at the first opening
// ---------------------------------------------------------------------------

/**
 * Writes the default categories once, at the first opening of the page or of
 * the agent: finance_settings remembers it, so that categories the user
 * deleted do not come back.
 */
export async function ensureCategories(sql: Sql): Promise<void> {
  const [done] = await sql`SELECT 1 FROM finance_settings`;
  if (done !== undefined) return;
  await sql.begin(async (tx) => {
    const [seeded] = await tx`INSERT INTO finance_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING RETURNING 1`;
    if (seeded === undefined) return;
    for (const category of DEFAULT_CATEGORIES) {
      await tx`INSERT INTO finance_categories (name, kind) VALUES (${category.name}, ${category.kind}) ON CONFLICT DO NOTHING`;
    }
    await appendEvent(tx, { kind: 'finance.categories.seeded', label: 'L0', payload: { count: DEFAULT_CATEGORIES.length } });
  });
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const ACCOUNT_COLUMNS = `a.id::text, a.name, a.currency, a.profile, a.archived,
  (SELECT count(*)::int FROM finance_transactions t WHERE t.account_id = a.id) AS transactions,
  (SELECT max(t.booked)::text FROM finance_transactions t WHERE t.account_id = a.id) AS "lastBooked"`;

interface AccountRow extends Omit<Account, 'profile'> {
  profile: unknown;
}

function accountOf(row: AccountRow): Account {
  return { ...row, profile: storedProfile(row.profile) };
}

export async function listAccounts(sql: Queryable): Promise<Account[]> {
  const rows = await sql.unsafe<AccountRow[]>(`SELECT ${ACCOUNT_COLUMNS} FROM finance_accounts a ORDER BY a.archived, lower(a.name), a.created_at`);
  return rows.map(accountOf);
}

async function loadAccount(sql: Queryable, id: string, lock = false): Promise<Account> {
  if (!isId(id)) throw notFound('account');
  if (lock) await sql`SELECT 1 FROM finance_accounts WHERE id = ${id} FOR UPDATE`;
  const [row] = await sql.unsafe<AccountRow[]>(`SELECT ${ACCOUNT_COLUMNS} FROM finance_accounts a WHERE a.id = $1`, [id]);
  if (row === undefined) throw notFound('account');
  return accountOf(row);
}

export async function createAccount(sql: Sql, body: Record<string, unknown>): Promise<Account> {
  onlyFields(body, ['name', 'currency']);
  const name = lineOf(body.name, MAX_ACCOUNT_NAME, 'name');
  const currency = currencyOf(body.currency);
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`INSERT INTO finance_accounts (name, currency) VALUES (${name}, ${currency}) RETURNING id::text`;
    if (row === undefined) throw new Error('INSERT INTO finance_accounts returned no row');
    await appendEvent(tx, { kind: 'finance.account.created', label: 'L0', payload: { accountId: row.id } });
    return loadAccount(tx, row.id);
  });
}

export async function updateAccount(sql: Sql, id: string, body: Record<string, unknown>): Promise<Account> {
  onlyFields(body, ['name', 'archived']);
  const name = body.name === undefined ? undefined : lineOf(body.name, MAX_ACCOUNT_NAME, 'name');
  if (body.archived !== undefined && typeof body.archived !== 'boolean') throw invalid('archived must be true or false');
  const archived = body.archived;
  return sql.begin(async (tx) => {
    await loadAccount(tx, id, true);
    await tx`
      UPDATE finance_accounts SET name = coalesce(${name ?? null}, name), archived = coalesce(${archived ?? null}::boolean, archived), updated_at = now()
      WHERE id = ${id}`;
    await appendEvent(tx, { kind: 'finance.account.updated', label: 'L0', payload: { accountId: id, fields: Object.keys(body) } });
    return loadAccount(tx, id);
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface ImportRequest {
  account: string;
  name: string;
  bytes: Uint8Array;
  profile?: BankProfile;
  sheet?: string | number;
}

function importRequest(body: Record<string, unknown>, profileRequired: boolean): ImportRequest {
  onlyFields(body, ['account', 'name', 'data', 'profile', 'sheet']);
  if (!isId(body.account)) throw notFound('account');
  const name = lineOf(body.name, MAX_FILE_NAME, 'name');
  const bytes = decodeFile(body.data);
  const profile = body.profile === undefined || body.profile === null ? undefined : parseProfile(body.profile);
  if (profileRequired && profile === undefined) throw invalid('profile is required to import');
  const sheet = sheetOf(body.sheet);
  return { account: body.account, name, bytes, ...(profile === undefined ? {} : { profile }), ...(sheet === undefined ? {} : { sheet }) };
}

/** A FinanceImportError as the contract answers it: its code, 413 for a file too large. */
function importError(error: unknown): never {
  if (error instanceof FinanceImportError) throw new FinanceError(error.code, error.code === 'too-large' ? 413 : 400, error.code, error.line);
  throw error;
}

async function fingerprintsOf(sql: Queryable, account: string): Promise<Set<string>> {
  const rows = await sql<{ fingerprint: string }[]>`SELECT fingerprint FROM finance_transactions WHERE account_id = ${account}`;
  return new Set(rows.map((row) => row.fingerprint));
}

/** The header row the profile (or the guess) finds in the statement, for the columns the page shows. */
function headerOf(statement: Statement, profile: BankProfile | undefined): { line: number; cells: string[] } | undefined {
  const index = findHeader(statement.rows, profile);
  // No row names the columns: the first non-empty one, so that the user chooses them by hand.
  const row = index === null ? (profile === undefined ? statement.rows[0] : undefined) : statement.rows[index];
  if (row === undefined) return undefined;
  return { line: row.line, cells: row.cells.map((cell) => cellText(cell).trim()) };
}

function previewOut(preview: ImportPreview, header: string[]): Preview {
  return {
    kind: preview.kind,
    sheets: preview.source.kind === 'xlsx' ? preview.source.sheets : null,
    sheet: preview.source.kind === 'xlsx' ? preview.source.sheet : null,
    profile: preview.profile,
    guessed: preview.guessed,
    headerLine: preview.headerLine,
    header,
    newestFirst: preview.newestFirst,
    rows: preview.rows.slice(0, PREVIEW_ROWS).map(({ line, transaction }) => ({
      line,
      booked: transaction.booked,
      value: transaction.value,
      description: transaction.description,
      amount: transaction.amount,
      currency: transaction.currency,
      balance: transaction.balance,
    })),
    duplicates: preview.duplicates.length,
    rejected: preview.rejected.map(({ line, reason }) => ({ line, code: reason })),
    totals: preview.totals,
  };
}

/**
 * The preview of an import: nothing is saved. Without a profile the columns
 * are guessed; when they cannot be, the preview has no profile and gives the
 * header, so that the user chooses the columns by hand.
 */
export async function previewFile(sql: Sql, body: Record<string, unknown>): Promise<Preview> {
  const request = importRequest(body, false);
  const account = await loadAccount(sql, request.account);
  const existing = await fingerprintsOf(sql, account.id);
  // The file is read once (an .xlsx is unzipped and parsed once): the header and the preview come from the same rows.
  let statement: Statement | undefined;
  try {
    statement = readStatement(request.bytes, request.name, request.sheet === undefined ? {} : { sheet: request.sheet });
    const header = headerOf(statement, request.profile);
    const preview = previewStatement(statement, {
      account: account.id,
      existing,
      currency: account.currency,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
    });
    return previewOut(preview, header?.cells ?? []);
  } catch (error) {
    // Columns not recognized, or no row that names them: not an error, the user chooses the columns by hand.
    if (statement !== undefined && error instanceof FinanceImportError && (error.code === 'unknown-columns' || error.code === 'no-header') && request.profile === undefined) {
      const header = headerOf(statement, undefined);
      if (header !== undefined) {
        return {
          kind: statement.kind,
          sheets: statement.source.kind === 'xlsx' ? statement.source.sheets : null,
          sheet: statement.source.kind === 'xlsx' ? statement.source.sheet : null,
          profile: null,
          guessed: false,
          headerLine: header.line,
          header: header.cells,
          newestFirst: false,
          rows: [],
          duplicates: 0,
          rejected: [],
          totals: { count: 0, income: 0, expenses: 0 },
        };
      }
    }
    return importError(error);
  }
}

interface NewRow {
  ord: number;
  booked: Day;
  value_date: Day | null;
  description: string;
  search: string;
  amount: number;
  currency: string;
  balance: number | null;
  fingerprint: string;
  category_id: string | null;
  category_by: 'rule' | null;
}

const INSERT_BATCH = 2_000;

/**
 * Imports a statement with the profile the user confirmed: the new movements
 * are saved in chronological order, with the categories of the user's rules;
 * the ones already in the account are skipped; the profile is remembered on
 * the account. The file is not kept. One import at a time per account (the
 * account row is locked).
 */
export async function importFile(sql: Sql, body: Record<string, unknown>): Promise<ImportRecord> {
  const request = importRequest(body, true);
  return sql.begin(async (tx) => {
    const account = await loadAccount(tx, request.account, true);
    const existing = await fingerprintsOf(tx, account.id);
    let preview: ImportPreview;
    try {
      preview = previewImport(request.bytes, request.name, {
        account: account.id,
        existing,
        currency: account.currency,
        ...(request.profile === undefined ? {} : { profile: request.profile }),
        ...(request.sheet === undefined ? {} : { sheet: request.sheet }),
      });
    } catch (error) {
      return importError(error);
    }
    const rules = await rulesForAnalysis(tx);
    const categorized = categorize(
      preview.rows.map((row) => row.transaction),
      rules,
    );
    // The account is locked and its fingerprints read under the lock, and a file never repeats one:
    // every new row goes in, so the counts are known before the rows.
    const [saved] = await tx<ImportRecord[]>`
      INSERT INTO finance_imports (account_id, name, imported, duplicates, rejected)
      VALUES (${account.id}, ${request.name}, ${categorized.length}, ${preview.duplicates.length}, ${preview.rejected.length})
      RETURNING id::text, account_id::text AS account, name,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, imported, duplicates, rejected`;
    if (saved === undefined) throw new Error('INSERT INTO finance_imports returned no row');
    for (let start = 0; start < categorized.length; start += INSERT_BATCH) {
      const batch: NewRow[] = categorized.slice(start, start + INSERT_BATCH).map((transaction, index) => ({
        ord: start + index,
        booked: transaction.booked,
        value_date: transaction.value,
        description: transaction.description.slice(0, 2000),
        search: searchText(transaction.description).slice(0, 4000),
        amount: transaction.amount,
        currency: transaction.currency,
        balance: transaction.balance,
        fingerprint: transaction.fingerprint,
        category_id: transaction.category,
        category_by: transaction.by === 'rule' ? 'rule' : null,
      }));
      await tx`
        INSERT INTO finance_transactions (account_id, import_id, booked, value_date, description, search, amount, currency, balance, fingerprint, category_id, category_by)
        SELECT ${account.id}::uuid, ${saved.id}::uuid, r.booked, r.value_date, r.description, r.search, r.amount, r.currency, r.balance, r.fingerprint, r.category_id, r.category_by
        FROM jsonb_to_recordset(${tx.json(batch as never)}) AS r(
          ord int, booked date, value_date date, description text, search text, amount bigint, currency text, balance bigint,
          fingerprint text, category_id uuid, category_by text)
        ORDER BY r.ord`;
    }
    await tx`UPDATE finance_accounts SET profile = ${tx.json(preview.profile as never)}, updated_at = now() WHERE id = ${account.id}`;
    await appendEvent(tx, {
      kind: 'finance.imported',
      label: 'L0',
      payload: { accountId: account.id, importId: saved.id, imported: saved.imported, duplicates: saved.duplicates, rejected: saved.rejected },
    });
    return saved;
  });
}

const IMPORT_COLUMNS = `i.id::text, i.account_id::text AS account, i.name,
  to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, i.imported, i.duplicates, i.rejected`;

export async function listImports(sql: Queryable, account: string | null): Promise<ImportRecord[]> {
  if (account !== null && account !== '' && !isId(account)) throw notFound('account');
  const rows = await sql.unsafe<ImportRecord[]>(
    `SELECT ${IMPORT_COLUMNS} FROM finance_imports i WHERE ($1::uuid IS NULL OR i.account_id = $1::uuid) ORDER BY i.created_at DESC, i.id`,
    [account === null || account === '' ? null : account],
  );
  return [...rows];
}

/** Undoes an import: its movements go with it (finance_delete). */
export async function undoImport(sql: Sql, id: string): Promise<void> {
  if (!isId(id)) throw notFound('import');
  await sql.begin(async (tx) => {
    const [row] = await tx<{ account: string }[]>`SELECT account_id::text AS account FROM finance_imports WHERE id = ${id}`;
    if (row === undefined) throw notFound('import');
    const removed = await financeDelete(tx, 'import', id);
    await appendEvent(tx, { kind: 'finance.import.undone', label: 'L0', payload: { accountId: row.account, importId: id, removed } });
  });
}

async function financeDelete(tx: Queryable, kind: 'import' | 'category' | 'rule' | 'budget', id: string): Promise<number> {
  try {
    const [row] = await tx<{ count: number }[]>`SELECT finance_delete(${kind}, ${id}::uuid) AS count`;
    return row?.count ?? 0;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'P0002') throw notFound(kind);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

const TX_COLUMNS = `t.id::text, t.account_id::text AS account, t.booked::text AS booked, t.value_date::text AS value, t.description,
  t.amount::float8 AS amount, t.currency, t.balance::float8 AS balance, t.category_id::text AS category, t.category_by AS by, t.import_id::text AS "importId", t.fingerprint`;

export interface TxQuery {
  account?: string;
  from?: Day;
  to?: Day;
  category?: string;
  uncategorized?: boolean;
  q?: string;
  /** The movements of an alert, by fingerprint (at most MAX_FINGERPRINTS). */
  fingerprints?: readonly string[];
  limit?: number;
  offset?: number;
}

/** A page of movements, newest first, with the total that match. */
export async function listTransactions(sql: Queryable, query: TxQuery): Promise<{ transactions: Tx[]; total: number }> {
  if (query.account !== undefined && !isId(query.account)) throw notFound('account');
  if (query.category !== undefined && !isId(query.category)) throw invalid('category must be the id of a category');
  const limit = query.limit ?? DEFAULT_TX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TX_LIMIT) throw invalid(`limit must be 1-${String(MAX_TX_LIMIT)}`);
  const offset = query.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) throw invalid('offset must be 0 or more');
  const q = query.q === undefined ? null : searchText(query.q);
  const where = `($1::uuid IS NULL OR t.account_id = $1::uuid) AND ($2::date IS NULL OR t.booked >= $2::date) AND ($3::date IS NULL OR t.booked <= $3::date)
    AND ($4::uuid IS NULL OR t.category_id = $4::uuid) AND (NOT $5::boolean OR t.category_id IS NULL)
    AND ($6::text IS NULL OR $6::text = '' OR strpos(t.search, $6::text) > 0)
    AND ($7::text[] IS NULL OR t.fingerprint = ANY ($7::text[]))`;
  const fingerprints = query.fingerprints === undefined ? null : [...query.fingerprints];
  if (fingerprints !== null && (fingerprints.length > MAX_FINGERPRINTS || fingerprints.some((item) => !/^[0-9a-f]{64}$/.test(item)))) {
    throw invalid(`fingerprints must list 1-${String(MAX_FINGERPRINTS)} fingerprints`);
  }
  const params = [query.account ?? null, query.from ?? null, query.to ?? null, query.category ?? null, query.uncategorized === true, q, fingerprints];
  const [count] = await sql.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM finance_transactions t WHERE ${where}`, params as never);
  const rows = await sql.unsafe<Tx[]>(
    `SELECT ${TX_COLUMNS} FROM finance_transactions t WHERE ${where} ORDER BY t.booked DESC, t.seq DESC LIMIT $8 OFFSET $9`,
    [...params, limit, offset] as never,
  );
  return { transactions: [...rows], total: count?.total ?? 0 };
}

async function loadTransaction(sql: Queryable, id: string): Promise<Tx> {
  if (!isId(id)) throw notFound('transaction');
  const [row] = await sql.unsafe<Tx[]>(`SELECT ${TX_COLUMNS} FROM finance_transactions t WHERE t.id = $1`, [id]);
  if (row === undefined) throw notFound('transaction');
  return row;
}

async function assertCategory(sql: Queryable, id: unknown): Promise<string> {
  if (!isId(id)) throw invalid('category must be the id of a category');
  const [row] = await sql`SELECT 1 FROM finance_categories WHERE id = ${id}`;
  if (row === undefined) throw invalid('category must be the id of a category');
  return id;
}

/**
 * The category the user chose for a movement (`by: 'user'`, kept by every
 * rule). With `rule: true`, also the rule `ruleFromConfirmation` proposes,
 * applied to the movements without a category of the user.
 */
export async function setTransactionCategory(sql: Sql, id: string, body: Record<string, unknown>): Promise<{ transaction: Tx; rule: Rule | null }> {
  onlyFields(body, ['category', 'rule']);
  if (!('category' in body)) throw invalid('category is required (an id, or null)');
  if (body.rule !== undefined && typeof body.rule !== 'boolean') throw invalid('rule must be true or false');
  return sql.begin(async (tx) => {
    const current = await loadTransaction(tx, id);
    const category = body.category === null ? null : await assertCategory(tx, body.category);
    await tx`
      UPDATE finance_transactions SET category_id = ${category}, category_by = ${category === null ? null : 'user'}
      WHERE id = ${id}`;
    let rule: Rule | null = null;
    if (body.rule === true && category !== null) {
      const proposal = ruleFromConfirmation(
        { account: current.account, booked: current.booked, value: current.value, description: current.description, amount: current.amount, currency: current.currency, balance: current.balance, fingerprint: '' },
        category,
      );
      if (proposal !== null) {
        rule = await addRule(tx, proposal.match.slice(0, MAX_RULE_MATCH), category);
        await recategorize(tx);
      }
    }
    await appendEvent(tx, { kind: 'finance.transaction.categorized', label: 'L0', payload: { transactionId: id, rule: rule?.id ?? null } });
    return { transaction: await loadTransaction(tx, id), rule };
  });
}

// ---------------------------------------------------------------------------
// Categories, rules, budgets
// ---------------------------------------------------------------------------

export async function listCategories(sql: Queryable): Promise<Category[]> {
  const rows = await sql<Category[]>`SELECT id::text, name, kind FROM finance_categories ORDER BY kind DESC, lower(name), created_at`;
  return [...rows];
}

function uniqueName<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    if ((error as { code?: unknown }).code === '23505') throw new FinanceError('conflict', 409, 'a category with this name exists');
    throw error;
  });
}

export async function createCategory(sql: Sql, body: Record<string, unknown>): Promise<Category> {
  onlyFields(body, ['name', 'kind']);
  const name = lineOf(body.name, MAX_CATEGORY_NAME, 'name');
  if (body.kind !== 'out' && body.kind !== 'in') throw invalid('kind must be out or in');
  const kind = body.kind;
  return uniqueName(() =>
    sql.begin(async (tx) => {
      const [row] = await tx<Category[]>`INSERT INTO finance_categories (name, kind) VALUES (${name}, ${kind}) RETURNING id::text, name, kind`;
      if (row === undefined) throw new Error('INSERT INTO finance_categories returned no row');
      await appendEvent(tx, { kind: 'finance.category.created', label: 'L0', payload: { categoryId: row.id } });
      return row;
    }),
  );
}

export async function updateCategory(sql: Sql, id: string, body: Record<string, unknown>): Promise<Category> {
  onlyFields(body, ['name']);
  if (!isId(id)) throw notFound('category');
  const name = body.name === undefined ? undefined : lineOf(body.name, MAX_CATEGORY_NAME, 'name');
  return uniqueName(() =>
    sql.begin(async (tx) => {
      const [row] = await tx<Category[]>`
        UPDATE finance_categories SET name = coalesce(${name ?? null}, name) WHERE id = ${id} RETURNING id::text, name, kind`;
      if (row === undefined) throw notFound('category');
      await appendEvent(tx, { kind: 'finance.category.updated', label: 'L0', payload: { categoryId: id } });
      return row;
    }),
  );
}

/** A category goes; its movements stay without one, its rules and budget go with it. */
export async function deleteCategory(sql: Sql, id: string): Promise<void> {
  if (!isId(id)) throw notFound('category');
  await sql.begin(async (tx) => {
    const cleared = await financeDelete(tx, 'category', id);
    await appendEvent(tx, { kind: 'finance.category.deleted', label: 'L0', payload: { categoryId: id, cleared } });
  });
}

/** In the order `matchRule` breaks ties on: the oldest first. */
async function rulesForAnalysis(sql: Queryable): Promise<CategoryRule[]> {
  const rows = await sql<CategoryRule[]>`SELECT id::text, match, category_id::text AS category FROM finance_rules ORDER BY created_at, id`;
  return [...rows];
}

export async function listRules(sql: Queryable): Promise<Rule[]> {
  return rulesForAnalysis(sql);
}

async function addRule(tx: Queryable, match: string, category: string): Promise<Rule> {
  const [same] = await tx<Rule[]>`
    SELECT id::text, match, category_id::text AS category FROM finance_rules WHERE lower(match) = lower(${match}) AND category_id = ${category} LIMIT 1`;
  if (same !== undefined) return same;
  const [row] = await tx<Rule[]>`
    INSERT INTO finance_rules (match, category_id) VALUES (${match}, ${category}) RETURNING id::text, match, category_id::text AS category`;
  if (row === undefined) throw new Error('INSERT INTO finance_rules returned no row');
  await appendEvent(tx, { kind: 'finance.rule.created', label: 'L0', payload: { ruleId: row.id, categoryId: category } });
  return row;
}

/**
 * The rules applied again to every movement (categorize of @arianna/finance):
 * the user's own choices stay; the others follow the rules, or have none.
 * Returns how many movements changed.
 */
export async function recategorize(tx: Queryable): Promise<number> {
  const rules = await rulesForAnalysis(tx);
  const rows = await tx<{ id: string; description: string; category: string | null; by: 'rule' | 'user' | null }[]>`
    SELECT id::text, description, category_id::text AS category, category_by AS by FROM finance_transactions WHERE category_by IS DISTINCT FROM 'user'`;
  const changed: { id: string; category_id: string | null; category_by: 'rule' | null }[] = [];
  for (const row of rows) {
    const [next] = categorize(
      [{ account: '', booked: '1970-01-01', value: null, description: row.description, amount: 0, currency: 'EUR', balance: null, fingerprint: '', category: row.category, by: row.by }],
      rules,
    );
    if (next === undefined) continue;
    if (next.category !== row.category || next.by !== row.by) changed.push({ id: row.id, category_id: next.category, category_by: next.by === 'rule' ? 'rule' : null });
  }
  for (let start = 0; start < changed.length; start += INSERT_BATCH) {
    const batch = changed.slice(start, start + INSERT_BATCH);
    await tx`
      UPDATE finance_transactions t SET category_id = r.category_id, category_by = r.category_by
      FROM jsonb_to_recordset(${tx.json(batch)}) AS r(id uuid, category_id uuid, category_by text)
      WHERE t.id = r.id AND t.category_by IS DISTINCT FROM 'user'`;
  }
  return changed.length;
}

export async function createRule(sql: Sql, body: Record<string, unknown>): Promise<Rule> {
  onlyFields(body, ['match', 'category']);
  const match = lineOf(body.match, MAX_RULE_MATCH, 'match');
  return sql.begin(async (tx) => {
    const category = await assertCategory(tx, body.category);
    const rule = await addRule(tx, match, category);
    await recategorize(tx);
    return rule;
  });
}

export async function deleteRule(sql: Sql, id: string): Promise<void> {
  if (!isId(id)) throw notFound('rule');
  await sql.begin(async (tx) => {
    await financeDelete(tx, 'rule', id);
    const changed = await recategorize(tx);
    await appendEvent(tx, { kind: 'finance.rule.deleted', label: 'L0', payload: { ruleId: id, changed } });
  });
}

export async function listBudgets(sql: Queryable): Promise<Budget[]> {
  const rows = await sql<Budget[]>`SELECT category_id::text AS category, monthly::float8 AS monthly FROM finance_budgets ORDER BY category_id`;
  return [...rows];
}

export async function setBudget(sql: Sql, category: string, body: Record<string, unknown>): Promise<Budget> {
  onlyFields(body, ['monthly']);
  if (!isId(category)) throw notFound('category');
  const monthly = body.monthly;
  if (typeof monthly !== 'number' || !Number.isSafeInteger(monthly) || monthly <= 0 || monthly > MAX_BUDGET_CENTS) {
    throw invalid('monthly must be a positive number of cents');
  }
  return sql.begin(async (tx) => {
    const [exists] = await tx`SELECT 1 FROM finance_categories WHERE id = ${category}`;
    if (exists === undefined) throw notFound('category');
    const [row] = await tx<Budget[]>`
      INSERT INTO finance_budgets (category_id, monthly) VALUES (${category}, ${monthly})
      ON CONFLICT (category_id) DO UPDATE SET monthly = EXCLUDED.monthly, updated_at = now()
      RETURNING category_id::text AS category, monthly::float8 AS monthly`;
    if (row === undefined) throw new Error('INSERT INTO finance_budgets returned no row');
    await appendEvent(tx, { kind: 'finance.budget.set', label: 'L0', payload: { categoryId: category } });
    return row;
  });
}

export async function deleteBudget(sql: Sql, category: string): Promise<void> {
  if (!isId(category)) throw notFound('budget');
  await sql.begin(async (tx) => {
    await financeDelete(tx, 'budget', category);
    await appendEvent(tx, { kind: 'finance.budget.deleted', label: 'L0', payload: { categoryId: category } });
  });
}

// ---------------------------------------------------------------------------
// Summary and checks
// ---------------------------------------------------------------------------

/** Every movement for the analysis (of one account, or of all), oldest first. */
export async function analysisRows(sql: Queryable, account?: string, until?: Day): Promise<CategorizedTransaction[]> {
  const rows = await sql<CategorizedTransaction[]>`
    SELECT account_id::text AS account, booked::text AS booked, value_date::text AS value, description, amount::float8 AS amount,
      currency, balance::float8 AS balance, fingerprint, category_id::text AS category, category_by AS by
    FROM finance_transactions
    WHERE (${account ?? null}::uuid IS NULL OR account_id = ${account ?? null}::uuid)
      AND (${until ?? null}::date IS NULL OR booked <= ${until ?? null}::date)
    ORDER BY booked, seq`;
  return [...rows];
}

export interface SummaryQuery {
  account?: string;
  /** First day, included. */
  from?: Day;
  /** Last day, included. */
  to?: Day;
}

/**
 * Totals per month and per category, the balance of one account and the last
 * month against the same month a year before, all computed by
 * @arianna/finance. Without a range, the last 12 months; without an account,
 * all of them and no balance (it is per account).
 */
export async function summary(sql: Queryable, query: SummaryQuery, now: Date = new Date()): Promise<Summary> {
  if (query.account !== undefined) await loadAccount(sql, query.account);
  const toDay = query.to ?? (query.from !== undefined ? lastDayOf(addMonthsToMonth(query.from.slice(0, 7), 11)) : lastDayOf(monthOfDate(now)));
  const fromDay = query.from ?? `${addMonthsToMonth(toDay.slice(0, 7), -11)}-01`;
  if (fromDay > toDay) throw invalid('from must not be after to');
  const rows = await analysisRows(sql, query.account, toDay);
  const inRange = rows.filter((row) => row.booked >= fromDay);
  // The latest month with movements in the range (else the month of `to`) against the same month a year before:
  // "the last 12 months" end with the current month, often still empty.
  const latest = inRange.reduce<string | undefined>((max, row) => (max === undefined || row.booked > max ? row.booked : max), undefined);
  const previous = yearOverYear(rows, (latest ?? toDay).slice(0, 7));
  return {
    months: monthlyTotals(inRange, { from: fromDay.slice(0, 7), to: toDay.slice(0, 7) }),
    categories: totalsByCategory(inRange, { from: fromDay, to: toDay }),
    balance: query.account === undefined ? [] : balanceSeries(rows).filter((point) => point.day >= fromDay),
    yearOverYear: previous.previous.count === 0 && previous.current.count === 0 ? null : previous,
  };
}

/** The checks of a month (runChecks), with the saved budgets; the whole history is the reference. */
export async function alerts(sql: Queryable, month: Month | undefined, now: Date = new Date()): Promise<FinanceAlert[]> {
  const asked = month ?? monthOfDate(now);
  const rows = await analysisRows(sql, undefined, lastDayOf(asked));
  const budgets: AnalysisBudget[] = await listBudgets(sql);
  return runChecks(rows, { month: asked, budgets });
}
