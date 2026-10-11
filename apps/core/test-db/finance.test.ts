import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadAgent, type Answer, type LoadedAgent } from '@arianna/agents';
import { defaultCloudModels, loadConfig, parseLabelRules, resolveHome } from '@arianna/config';
import type { ChatRequest, LocalModel } from '@arianna/executors';
import { createContext, isFinanceContext, PolicyError } from '@arianna/policy';

import { requestDeclassify } from '../src/approvals.ts';
import { createConversation, postUserMessage, writeConversation } from '../src/conversations.ts';
import { directPolicyOf } from '../src/direct-chat.ts';
import { processStepJob, STEP_QUEUE, type StepExecutor } from '../src/engine.ts';
import { contextOf, outputSource } from '../src/finance-mark.ts';
import { passGateway } from '../src/gateway.ts';
import { completeJob, createJobQueue } from '../src/jobs.ts';
import { startLiveFeed } from '../src/live.ts';
import { noticeOf } from '../src/notifications.ts';
import { createKb } from '../src/orchestrator/kb.ts';
import { createOrchestrator } from '../src/orchestrator/orchestrator.ts';
import { runTool } from '../src/orchestrator/tools.ts';
import { startApiServer } from '../src/server/http.ts';
import { createTask, loadTask } from '../src/tasks.ts';
import { passToTelegram } from '../src/telegram/outgoing.ts';
import { canaryPlaces, newCanary } from './support/canary.ts';
import { useTestDatabase } from './support/database.ts';

const db = useTestDatabase();
const HOME = resolveHome({});
const CONFIG = loadConfig();

// Invented movements of an invented bank.
const STATEMENT = [
  'Banca Finta S.p.A. - Estratto conto',
  '',
  'Data contabile;Data valuta;Descrizione;Importo;Saldo',
  '02/09/2026;02/09/2026;Bar Fittizio Più;-1,20;998,80',
  '02/09/2026;02/09/2026;Bar Fittizio Più;-1,20;997,60',
  '03/09/2026;03/09/2026;"Stipendio Ditta Inventata, settembre";1.500,00;2.497,60',
  '05/09/2026;05/09/2026;Supermercato Immaginario;-80,00;2.417,60',
  '06/09/2026;06/09/2026;Errore;abc;',
  '',
].join('\n');
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

interface Api {
  base: string;
  send: (method: string, path: string, body?: unknown) => Promise<Response>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the shape of the answer, said by the caller
  json: <T>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

async function withApi(work: (api: Api) => Promise<void>): Promise<void> {
  const live = await startLiveFeed(db().sql);
  const server = await startApiServer({ sql: db().sql, live, host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${String(server.port)}`;
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- as in Api
  const json = async <T>(method: string, path: string, body?: unknown) => {
    const response = await send(method, path, body);
    return { status: response.status, body: (await response.json()) as T };
  };
  try {
    await work({ base, send, json });
  } finally {
    await server.close();
    await live.close();
  }
}

interface Tx {
  id: string;
  description: string;
  amount: number;
  category: string | null;
  by: string | null;
  fingerprint: string;
  importId: string;
}

test('the routes of the Finances: accounts, preview, import, duplicates, movements, rules, budgets, summary, undo', async () => {
  const canary = newCanary();
  await withApi(async ({ send, json }) => {
    // The common categories at the first opening, once.
    const first = await json<{ categories: { id: string; name: string; kind: string }[] }>('GET', '/api/finance/categories');
    assert.equal(first.status, 200);
    assert.ok(first.body.categories.some((category) => category.name === 'Spesa' && category.kind === 'out'));
    assert.ok(first.body.categories.some((category) => category.name === 'Stipendio' && category.kind === 'in'));
    const spesa = first.body.categories.find((category) => category.name === 'Spesa');
    assert.ok(spesa !== undefined);
    const again = await json<{ categories: unknown[] }>('GET', '/api/finance/categories');
    assert.equal(again.body.categories.length, first.body.categories.length);

    // Accounts: a line of 1-80 characters, EUR without a currency, unknown fields refused.
    assert.deepEqual((await json('POST', '/api/finance/accounts', { name: '' })).body, { error: 'invalid' });
    assert.equal((await json('POST', '/api/finance/accounts', { name: 'Conto', iban: 'x' })).status, 400);
    const created = await json<{ account: { id: string; currency: string; profile: unknown; transactions: number; archived: boolean } }>('POST', '/api/finance/accounts', { name: 'Conto Finto' });
    assert.equal(created.status, 201);
    const account = created.body.account;
    assert.equal(account.currency, 'EUR');
    assert.equal(account.profile, null);
    assert.equal(account.transactions, 0);

    // The preview: guessed profile, rows, the rejected one with its code; nothing saved.
    const file = STATEMENT.replace('Supermercato Immaginario', `Supermercato Immaginario ${canary}`);
    const preview = await json<{ preview: { kind: string; guessed: boolean; headerLine: number; header: string[]; rows: { line: number; amount: number; description: string }[]; rejected: { line: number; code: string }[]; duplicates: number; totals: { count: number; income: number; expenses: number }; profile: unknown; sheets: unknown } }>(
      'POST',
      '/api/finance/imports/preview',
      { account: account.id, name: 'settembre.csv', data: b64(file) },
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.kind, 'csv');
    assert.equal(preview.body.preview.sheets, null);
    assert.equal(preview.body.preview.guessed, true);
    assert.equal(preview.body.preview.headerLine, 3);
    assert.deepEqual(preview.body.preview.header, ['Data contabile', 'Data valuta', 'Descrizione', 'Importo', 'Saldo']);
    assert.deepEqual(preview.body.preview.rows.map((row) => row.amount), [-120, -120, 150000, -8000]);
    assert.deepEqual(preview.body.preview.rejected, [{ line: 8, code: 'bad-amount' }]);
    assert.deepEqual(preview.body.preview.totals, { count: 4, income: 150000, expenses: 8240 });
    assert.equal((await json<{ transactions: unknown[] }>('GET', '/api/finance/transactions')).body.transactions.length, 0);

    // Errors of the import: a missing profile, an .xls, a profile that does not fit, a file above 10 MiB.
    assert.deepEqual((await json('POST', '/api/finance/imports', { account: account.id, name: 'settembre.csv', data: b64(file) })).body, { error: 'invalid' });
    assert.deepEqual((await json('POST', '/api/finance/imports/preview', { account: account.id, name: 'vecchio.xls', data: b64('x') })).body, { error: 'xls' });
    const wrong = { ...(preview.body.preview.profile as Record<string, unknown>), booked: 'Giorno' };
    assert.deepEqual((await json('POST', '/api/finance/imports/preview', { account: account.id, name: 'settembre.csv', data: b64(file), profile: wrong })), { status: 400, body: { error: 'profile-mismatch' } });
    const huge = await json('POST', '/api/finance/imports/preview', { account: account.id, name: 'grande.csv', data: 'A'.repeat(14 * 1024 * 1024) });
    assert.deepEqual(huge, { status: 413, body: { error: 'too-large' } });
    assert.equal((await json('POST', '/api/finance/imports/preview', { account: '00000000-0000-4000-8000-000000000000', name: 'a.csv', data: b64(file) })).status, 404);
    // An error on a line of the file says the line.
    const broken = await json<{ error: string; line?: number }>('POST', '/api/finance/imports/preview', { account: account.id, name: 'rotto.csv', data: b64(`Data;Descrizione;Importo\n01/09/2026;${'x'.repeat(10_001)};-1,00\n`) });
    assert.equal(broken.status, 400);
    assert.deepEqual(broken.body, { error: 'cell-too-long', line: 2 });

    // Columns not recognized: no error, the header to choose them by hand.
    const unknown = await json<{ preview: { profile: unknown; guessed: boolean; header: string[]; rows: unknown[] } }>('POST', '/api/finance/imports/preview', {
      account: account.id,
      name: 'strano.csv',
      data: b64('Quando;Cosa;Quanto\n01/09/2026;Qualcosa;-1,00\n'),
    });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.preview.profile, null);
    assert.equal(unknown.body.preview.guessed, false);
    assert.deepEqual(unknown.body.preview.header, ['Quando', 'Cosa', 'Quanto']);
    assert.deepEqual(unknown.body.preview.rows, []);

    // The import with the confirmed profile: saved, the profile remembered, the file not kept.
    const profile = preview.body.preview.profile;
    const imported = await json<{ import: { id: string; account: string; name: string; at: string; imported: number; duplicates: number; rejected: number } }>('POST', '/api/finance/imports', {
      account: account.id,
      name: 'settembre.csv',
      data: b64(file),
      profile,
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.import.imported, 4);
    assert.equal(imported.body.import.duplicates, 0);
    assert.equal(imported.body.import.rejected, 1);
    assert.equal(imported.body.import.account, account.id);
    assert.match(imported.body.import.at, /^\d{4}-\d{2}-\d{2}T/);
    const accounts = await json<{ accounts: { id: string; profile: unknown; transactions: number; lastBooked: string }[] }>('GET', '/api/finance/accounts');
    const stored = accounts.body.accounts.find((item) => item.id === account.id);
    assert.ok(stored !== undefined);
    assert.deepEqual(stored.profile, profile);
    assert.equal(stored.transactions, 4);
    assert.equal(stored.lastBooked, '2026-09-05');

    // The same file again: every row a duplicate, nothing new.
    const second = await json<{ preview: { duplicates: number; rows: unknown[] } }>('POST', '/api/finance/imports/preview', { account: account.id, name: 'settembre.csv', data: b64(file), profile });
    assert.equal(second.body.preview.duplicates, 4);
    assert.equal(second.body.preview.rows.length, 0);
    const twice = await json<{ import: { id: string; imported: number; duplicates: number } }>('POST', '/api/finance/imports', { account: account.id, name: 'settembre.csv', data: b64(file), profile });
    assert.equal(twice.body.import.imported, 0);
    assert.equal(twice.body.import.duplicates, 4);
    const imports = await json<{ imports: { id: string }[] }>('GET', `/api/finance/imports?account=${account.id}`);
    assert.equal(imports.body.imports.length, 2);

    // Movements: newest first, search without case or accents, by fingerprint.
    const all = await json<{ transactions: Tx[]; total: number }>('GET', `/api/finance/transactions?account=${account.id}`);
    assert.equal(all.body.total, 4);
    assert.equal(all.body.transactions[0]?.amount, -8000);
    assert.match(all.body.transactions.at(0)?.fingerprint ?? '', /^[0-9a-f]{64}$/);
    const found = await json<{ transactions: Tx[]; total: number }>('GET', '/api/finance/transactions?q=FITTIZIO%20piu');
    assert.equal(found.body.total, 2);
    const byPrint = await json<{ transactions: Tx[]; total: number }>('GET', `/api/finance/transactions?fingerprints=${found.body.transactions.map((row) => row.fingerprint).join(',')}`);
    assert.equal(byPrint.body.total, 2);
    assert.equal((await json('GET', '/api/finance/transactions?fingerprints=nonsense')).status, 400);
    assert.equal((await json('GET', '/api/finance/transactions?limit=501')).status, 400);
    assert.equal((await json('GET', '/api/finance/transactions?from=ieri')).status, 400);
    const page = await json<{ transactions: Tx[]; total: number }>('GET', '/api/finance/transactions?limit=1&offset=1');
    assert.equal(page.body.transactions.length, 1);
    assert.equal(page.body.total, 4);

    // The user's category, with the rule proposed from it: the other coffee follows.
    const coffee = found.body.transactions[0];
    assert.ok(coffee !== undefined);
    const bar = await json<{ category: { id: string } }>('POST', '/api/finance/categories', { name: 'Bar', kind: 'out' });
    assert.equal(bar.status, 201);
    assert.equal((await json('POST', '/api/finance/categories', { name: 'bar', kind: 'out' })).status, 409);
    assert.equal((await json('POST', '/api/finance/categories', { name: 'X', kind: 'both' })).status, 400);
    const set = await json<{ transaction: Tx; rule: { id: string; match: string; category: string } | null }>('PATCH', `/api/finance/transactions/${coffee.id}`, { category: bar.body.category.id, rule: true });
    assert.equal(set.status, 200);
    assert.equal(set.body.transaction.by, 'user');
    assert.ok(set.body.rule !== null);
    assert.equal(set.body.rule.category, bar.body.category.id);
    const coffees = await json<{ transactions: Tx[] }>('GET', `/api/finance/transactions?category=${bar.body.category.id}`);
    assert.deepEqual(coffees.body.transactions.map((row) => row.by).sort(), ['rule', 'user']);
    assert.equal((await json('PATCH', `/api/finance/transactions/${coffee.id}`, { category: '00000000-0000-4000-8000-000000000000' })).status, 400);
    assert.equal((await json('PATCH', `/api/finance/transactions/${coffee.id}`, {})).status, 400);
    const rules = await json<{ rules: { id: string }[] }>('GET', '/api/finance/rules');
    assert.equal(rules.body.rules.length, 1);
    const uncategorized = await json<{ total: number }>('GET', '/api/finance/transactions?uncategorized=1');
    assert.equal(uncategorized.body.total, 2);

    // A rule of the user applied at once.
    const groceries = await json<{ rule: { id: string } }>('POST', '/api/finance/rules', { match: 'supermercato immaginario', category: spesa.id });
    assert.equal(groceries.status, 201);
    assert.equal((await json<{ total: number }>('GET', `/api/finance/transactions?category=${spesa.id}`)).body.total, 1);
    const removed = await send('DELETE', `/api/finance/rules/${groceries.body.rule.id}`);
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), '');
    assert.equal((await json<{ total: number }>('GET', `/api/finance/transactions?category=${spesa.id}`)).body.total, 0);
    assert.equal((await send('DELETE', `/api/finance/rules/${groceries.body.rule.id}`)).status, 404);

    // Budgets.
    assert.equal((await json('PUT', `/api/finance/budgets/${bar.body.category.id}`, { monthly: 0 })).status, 400);
    assert.equal((await json('PUT', `/api/finance/budgets/${bar.body.category.id}`, { monthly: 1.5 })).status, 400);
    const budget = await json<{ budget: { category: string; monthly: number } }>('PUT', `/api/finance/budgets/${bar.body.category.id}`, { monthly: 200 });
    assert.deepEqual(budget.body.budget, { category: bar.body.category.id, monthly: 200 });
    assert.deepEqual((await json<{ budgets: unknown[] }>('GET', '/api/finance/budgets')).body.budgets, [{ category: bar.body.category.id, monthly: 200 }]);

    // Summary and checks: computed by @arianna/finance, the budget of the coffees over its limit.
    const summary = await json<{ months: { month: string; income: number; expenses: number }[]; categories: { category: string | null; expenses: number }[]; balance: { day: string; balance: number }[]; yearOverYear: unknown }>(
      'GET',
      `/api/finance/summary?account=${account.id}&from=2026-09-01&to=2026-09-30`,
    );
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body.months.map((month) => [month.month, month.income, month.expenses]), [['2026-09', 150000, 8240]]);
    assert.ok(summary.body.categories.some((item) => item.category === bar.body.category.id && item.expenses === 240));
    assert.deepEqual(summary.body.balance.at(-1), { day: '2026-09-05', balance: 241760, source: 'bank' });
    assert.notEqual(summary.body.yearOverYear, null);
    const everywhere = await json<{ balance: unknown[] }>('GET', '/api/finance/summary?from=2026-09-01&to=2026-09-30');
    assert.deepEqual(everywhere.body.balance, []);
    assert.equal((await json('GET', '/api/finance/summary?from=2026-10-01&to=2026-09-01')).status, 400);
    const alerts = await json<{ alerts: { kind: string; state?: string }[] }>('GET', '/api/finance/alerts?month=2026-09');
    assert.ok(alerts.body.alerts.some((alert) => alert.kind === 'budget' && alert.state === 'over'));
    assert.equal((await json('GET', '/api/finance/alerts?month=settembre')).status, 400);

    // A category goes: its movements stay without one, its rule and budget go with it.
    assert.equal((await send('DELETE', `/api/finance/categories/${bar.body.category.id}`)).status, 204);
    assert.equal((await json<{ rules: unknown[] }>('GET', '/api/finance/rules')).body.rules.length, 0);
    assert.deepEqual((await json<{ budgets: unknown[] }>('GET', '/api/finance/budgets')).body.budgets, []);
    assert.equal((await json<{ total: number }>('GET', '/api/finance/transactions?uncategorized=1')).body.total, 4);

    // Rename and archive.
    const renamed = await json<{ account: { name: string; archived: boolean } }>('PATCH', `/api/finance/accounts/${account.id}`, { name: 'Conto Rinominato', archived: true });
    assert.deepEqual([renamed.body.account.name, renamed.body.account.archived], ['Conto Rinominato', true]);
    assert.equal((await json('PATCH', `/api/finance/accounts/${account.id}`, { currency: 'USD' })).status, 400);

    // Undo the first import: its movements go; the second one had none.
    assert.equal((await send('DELETE', `/api/finance/imports/${imported.body.import.id}`)).status, 204);
    assert.equal((await json<{ total: number }>('GET', '/api/finance/transactions')).body.total, 0);
    assert.equal((await send('DELETE', `/api/finance/imports/${imported.body.import.id}`)).status, 404);
    assert.equal((await send('DELETE', `/api/finance/imports/${twice.body.import.id}`, { why: 1 })).status, 400);
  });

  // The movement's text is only in the finance tables: never in events or logs.
  const { owner, schema } = db();
  const places = await canaryPlaces(owner, schema, canary);
  assert.deepEqual(places, []);
});

test('the finance tables: no DELETE for the core, movements and imports frozen, labels never below L2', async () => {
  const { sql, owner } = db();
  const [account] = await sql<{ id: string }[]>`INSERT INTO finance_accounts (name) VALUES ('Guardia') RETURNING id::text`;
  assert.ok(account !== undefined);
  const [record] = await sql<{ id: string }[]>`INSERT INTO finance_imports (account_id, name, imported, duplicates, rejected) VALUES (${account.id}, 'a.csv', 1, 0, 0) RETURNING id::text`;
  assert.ok(record !== undefined);
  const print = 'a'.repeat(64);
  await sql`INSERT INTO finance_transactions (account_id, import_id, booked, description, search, amount, currency, fingerprint)
    VALUES (${account.id}, ${record.id}, '2026-09-01', 'Finto', 'finto', -100, 'EUR', ${print})`;
  await assert.rejects(sql`INSERT INTO finance_transactions (account_id, import_id, booked, description, search, amount, currency, fingerprint)
    VALUES (${account.id}, ${record.id}, '2026-09-02', 'Altro', 'altro', -100, 'EUR', ${print})`, /finance_transactions_fingerprint_key/);
  await assert.rejects(sql`DELETE FROM finance_transactions`, /permission denied/);
  await assert.rejects(sql`DELETE FROM finance_imports`, /permission denied/);
  await assert.rejects(sql`DELETE FROM finance_accounts`, /permission denied/);
  await assert.rejects(sql`UPDATE finance_transactions SET amount = 1`, /only its category changes/);
  await assert.rejects(sql`UPDATE finance_imports SET imported = 2`, /permission denied/);
  await assert.rejects(owner`UPDATE finance_imports SET imported = 2`, /never changes/);
  await assert.rejects(sql`UPDATE finance_accounts SET label = 'L1'`, /check constraint|cannot go down/);
  await assert.rejects(sql`INSERT INTO finance_accounts (name, label) VALUES ('Sotto', 'L1')`, /check constraint/);
  await assert.rejects(sql`SELECT finance_delete('everything', ${record.id}::uuid)`, /unknown kind/);
  await assert.rejects(sql`SELECT finance_delete('rule', ${record.id}::uuid)`, /does not exist/);
  // Only the core's role and the owner may run it.
  const [grant] = await owner<{ public: boolean }[]>`SELECT has_function_privilege('public', 'finance_delete(text, uuid)', 'EXECUTE') AS public`;
  assert.equal(grant?.public, false);
});

const financeAgent = (): LoadedAgent => loadAgent(join(HOME, 'agents'), 'finanze');

async function financeConversation() {
  const agent = financeAgent();
  const policy = directPolicyOf('finanze', agent, { claude: true, codex: true });
  assert.ok(policy !== undefined);
  assert.equal(policy.finance, true);
  assert.deepEqual(policy.modes, ['private']);
  assert.equal(policy.cloud, false);
  return createConversation(db().sql, { mode: 'private', agent: { name: policy.agent, modes: policy.modes, project: policy.project, finance: true } });
}

test('the finance mark: a conversation of the Finances is born marked, its tasks too; the mark never goes away', async () => {
  const { sql } = db();
  const agent = financeAgent();
  const policy = directPolicyOf('finanze', agent, { claude: true, codex: true });
  assert.ok(policy !== undefined);
  // Never a work conversation.
  await assert.rejects(
    sql.begin((tx) => writeConversation(tx, { mode: 'work', project: 'demo', projects: ['demo'], agent: { name: 'finanze', modes: ['work', 'private'], project: false, finance: true } })),
    /private conversation/,
  );
  const conversation = await financeConversation();
  assert.equal(conversation.finance, true);
  assert.equal(conversation.effectiveLabel, 'L2');
  const { task } = await postUserMessage(sql, conversation.id, 'Dove spendo di più?');
  assert.equal(task.finance, true);
  assert.equal(task.effectiveLabel, 'L2');
  assert.equal(task.assignee, 'finanze');
  // The agent answers with its tools on the local model: no delegation is opened.
  const [delegations] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM task_delegations WHERE task_id = ${task.id}`;
  assert.equal(delegations?.count, 0);
  // A card born from it is marked, and so is a run of it, which never runs in the cloud.
  const child = await createTask(sql, { title: 'Figlio', parentId: task.id, clearance: 'L2' });
  assert.equal(child.finance, true);
  await assert.rejects(sql`INSERT INTO runs (task_id, step, agent, executor, locality) VALUES (${task.id}, 1, 'finanze', 'claude', 'cloud')`, /runs_finance_local|runs_cloud_at_most_l1/);
  await assert.rejects(sql`UPDATE tasks SET finance = false WHERE id = ${task.id}`, /never goes away/);
  await assert.rejects(sql`UPDATE conversations SET finance = false WHERE id = ${conversation.id}`, /never goes away/);
  // A work conversation can never be marked.
  const work = await createConversation(sql, { mode: 'work', project: 'demo', projects: ['demo'] });
  await assert.rejects(sql`UPDATE conversations SET finance = true WHERE id = ${work.id}`, /conversations_finance_private/);
});

test('a marked task: Claude, a cloud delegation and Telegram refused by the gateway (rule finance), nothing declassified', async () => {
  const { sql } = db();
  const conversation = await financeConversation();
  const { task: posted } = await postUserMessage(sql, conversation.id, 'Quanto ho speso al bar a settembre?');
  const task = await loadTask(sql, posted.id);
  assert.ok(task !== undefined);
  const context = contextOf(task, task.effectiveLabel);
  assert.equal(isFinanceContext(context), true);
  const text = 'Hai speso 2,40 € al Bar Fittizio';
  // A step towards Claude, and a cloud delegation of the Coder: the brief of the task stays here.
  const claude = await passGateway(sql, [{ value: text, label: 'L1', source: outputSource(task, `task:${task.id}`) }], context, { kind: 'executor', id: 'claude', locality: 'cloud' }, { taskId: task.id });
  assert.equal(claude.decision, 'block');
  const codex = await passGateway(sql, [{ value: 'brief', label: 'L0', source: `task:${task.id}` }], context, { kind: 'executor', id: 'codex', locality: 'cloud' }, { taskId: task.id });
  assert.equal(codex.decision, 'block');
  // Telegram and push: only the reference may go, never the text.
  const telegram = await passToTelegram(sql, [{ text, label: 'L0', source: `message:1` }], context, { taskId: task.id });
  assert.equal(telegram.ok, false);
  const rules = await sql<{ rule: string; target: string }[]>`SELECT rule, target_kind || ':' || target AS target FROM gateway_log WHERE task_id = ${task.id} ORDER BY id`;
  assert.deepEqual(rules.map((row) => row.rule), ['finance', 'finance', 'finance']);
  // The local model and the web chat take it.
  const local = await passGateway(sql, [{ value: text, label: 'L2', source: outputSource(task, `task:${task.id}`) }], context, { kind: 'executor', id: 'local', locality: 'local' }, { taskId: task.id });
  assert.equal(local.decision, 'allow');
  // No declassification, even asked.
  await assert.rejects(requestDeclassify(sql, { value: text, label: 'L2', source: `task:${task.id}` }, 'L1', context, { taskId: task.id }), PolicyError);
  // A notice is a kind and an id, whatever the conversation.
  assert.deepEqual(noticeOf({ kind: 'message.created', taskId: task.id, payload: { role: 'assistant', conversationId: conversation.id, messageId: '1' } }), { kind: 'reply', conversationId: conversation.id });
  // The same text from an unmarked private task leaves for the cloud only within its label: the mark is what stops it here.
  const plain = await passGateway(sql, [{ value: 'ciao', label: 'L0', source: 'task:x' }], createContext('L2', 'L1'), { kind: 'executor', id: 'claude', locality: 'cloud' });
  assert.equal(plain.decision, 'allow');
});

test('a finance tool marks the task and its conversation; in a work conversation it reads nothing', async () => {
  const { sql } = db();
  const kb = createKb({ home: HOME, rules: parseLabelRules('') });
  const privateChat = await createConversation(sql, { mode: 'private' });
  const { task } = await postUserMessage(sql, privateChat.id, 'Riepilogo spese');
  assert.equal(task.finance, false);
  const result = await sql.begin((tx) => runTool('finance.summary', {}, { sql: tx, kb, task, context: contextOf(task, task.effectiveLabel), autonomy: 'A1' }));
  assert.equal(result.label, 'L2');
  assert.doesNotMatch(result.text, /^error/);
  assert.equal((await loadTask(sql, task.id))?.finance, true);
  const [marked] = await sql<{ finance: boolean }[]>`SELECT finance FROM conversations WHERE id = ${privateChat.id}`;
  assert.equal(marked?.finance, true);

  const work = await createConversation(sql, { mode: 'work', project: 'demo', projects: ['demo'] });
  const { task: workTask } = await postUserMessage(sql, work.id, 'Riepilogo spese');
  const refused = await sql.begin((tx) => runTool('finance.search', { text: 'bar' }, { sql: tx, kb, task: workTask, context: contextOf(workTask, workTask.effectiveLabel), autonomy: 'A1' }));
  assert.match(refused.text, /^error: finance\.search: finance data is read only in a private conversation/);
  assert.equal((await loadTask(sql, workTask.id))?.finance, false);
});

test('the agent of the Finances answers with figures from its tools, on the local model only', async () => {
  const { sql } = db();
  const [account] = await sql<{ id: string }[]>`INSERT INTO finance_accounts (name) VALUES ('Conto Agente') RETURNING id::text`;
  assert.ok(account !== undefined);
  const [record] = await sql<{ id: string }[]>`INSERT INTO finance_imports (account_id, name, imported, duplicates, rejected) VALUES (${account.id}, 'b.csv', 1, 0, 0) RETURNING id::text`;
  assert.ok(record !== undefined);
  await sql`INSERT INTO finance_transactions (account_id, import_id, booked, description, search, amount, currency, fingerprint)
    VALUES (${account.id}, ${record.id}, '2026-08-10', 'Palestra Inventata', 'palestra inventata', -4500, 'EUR', ${'b'.repeat(64)})`;

  const conversation = await financeConversation();
  const { task } = await postUserMessage(sql, conversation.id, 'Quanto ho speso in palestra?');
  const answers: Answer[] = [
    { action: 'call', tool: 'finance.search', arguments: { text: 'palestra' } },
    { action: 'reply', text: 'In palestra hai speso 45,00 €.' },
  ];
  const requests: ChatRequest[] = [];
  const model: LocalModel = {
    chat(request) {
      requests.push(request);
      const next = answers[requests.length - 1];
      if (next === undefined) return Promise.reject(new Error('no answer scripted'));
      const value = JSON.stringify(request.schema?.schema).includes('"thought"') ? { thought: 'Cerco.', ...next } : next;
      return Promise.resolve({ text: JSON.stringify(value), value, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 }, endpoint: 'stub', model: 'stub', durationMs: 1 });
    },
  };
  const agents = new Map([['finanze', financeAgent()]]);
  const executor: StepExecutor = createOrchestrator({
    sql,
    agents,
    kb: createKb({ home: HOME, rules: parseLabelRules('') }),
    model: () => model,
    settings: () => ({ ...CONFIG, cloud: { executors: [], models: defaultCloudModels() } }),
    rules: parseLabelRules(''),
  });
  const queue = createJobQueue(sql);
  for (let guard = 0; guard < 10; guard += 1) {
    const job = await queue.claim(STEP_QUEUE, 'finance-worker');
    if (job === undefined) break;
    if (job.payload.taskId !== task.id) {
      await completeJob(sql, job.id, 'finance-worker');
      continue;
    }
    await processStepJob(sql, executor, job, 'finance-worker', { allowedActions: () => [], agentLimits: () => ({ maxSteps: 12, maxMinutes: 10 }) });
  }
  // The tools offered: the finance ones and the question, never a delegation or a plan.
  const offered = JSON.stringify(requests[0]?.schema?.schema);
  assert.match(offered, /finance\.summary/);
  assert.doesNotMatch(offered, /task\.delegate|task\.plan/);
  // The second call read the movement the core found, with its amount written by code.
  assert.match(JSON.stringify(requests[1]?.messages), /45,00 €/);
  const [answer] = await sql<{ body: string; label: string }[]>`SELECT body, label FROM messages WHERE task_id = ${task.id} AND role = 'assistant'`;
  assert.equal(answer?.body, 'In palestra hai speso 45,00 €.');
  assert.equal(answer.label, 'L2');
  const runs = await sql<{ locality: string; finance: boolean }[]>`SELECT locality, finance FROM runs WHERE task_id = ${task.id}`;
  assert.ok(runs.length > 0);
  assert.ok(runs.every((run) => run.locality === 'local' && run.finance));
  // Every text that passed the gateway for it went to a local target, with the mark.
  const log = await sql<{ target: string; decision: string }[]>`SELECT target_kind || ':' || target AS target, decision FROM gateway_log WHERE task_id = ${task.id}`;
  assert.ok(log.every((row) => row.decision === 'allow' && (row.target === 'executor:local' || row.target === 'channel:web')), JSON.stringify(log));
});
