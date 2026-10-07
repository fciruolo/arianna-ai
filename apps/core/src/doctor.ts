// First `arianna doctor` (task 1.13, D-046): the checks that must pass before
// real data enters the database. Each check says what it found, never a
// secret: vault errors carry the reference and a code, PostgreSQL errors only
// their code. The installer (task 1.17) adds models, executors and folders.
import type { AriannaConfig } from '@arianna/config';
import type { Secret } from '@arianna/vault';

import { connect, type Sql } from './db/client.ts';
import { APP_ROLE, DEV_PASSWORDS, passwordOf, resolveLogins, type DbLogin, type DbLogins } from './db/logins.ts';
import { loadMigrations, migrationStatus } from './db/migrate.ts';
import { verifyEventChain } from './events.ts';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DoctorOptions {
  config: AriannaConfig;
  /** Reads the vault unless a test passes its own. */
  resolve?: (ref: string) => Promise<Secret>;
  /** Schema to check instead of `public`; used by tests. */
  schema?: string;
}

const INVALID_PASSWORD = '28P01';
// docs/SECURITY.md asks for random passwords of this length.
const MIN_PASSWORD = 24;
// pg_trigger.tgtype bit for UPDATE (TRIGGER_TYPE_UPDATE in PostgreSQL).
const TRIGGER_ON_UPDATE = 16;

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String(error.code);
  return error instanceof Error ? error.name : 'unknown error';
}

/** Runs every check; a check that cannot run because an earlier one failed is reported as failed. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const { config } = options;
  const checks: DoctorCheck[] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const at = options.schema === undefined ? {} : { schema: options.schema };

  let logins: DbLogins;
  try {
    logins = await resolveLogins(config, options.resolve);
  } catch (error) {
    // VaultError and LoginError messages name the reference, never the value.
    add('database.passwords', false, error instanceof Error ? error.message : 'the passwords could not be read');
    add('database', false, 'not checked: no passwords');
    return checks;
  }
  add('database.passwords', ...passwordsVerdict(logins));

  const owner = connect(config, logins.owner, at);
  const app = connect(config, logins.app, at);
  try {
    try {
      await owner`SELECT 1`;
    } catch (error) {
      add('database.owner', false, `the owner cannot log in (${errorCode(error)})`);
      return checks;
    }
    add('database.owner', true, `${logins.owner.user} logs in`);

    await checkDefaultsRejected(config, logins, checks, at);
    // A database never migrated (or the wrong schema) fails the check, not the doctor.
    for (const [id, check] of [
      ['database.migrations', checkMigrations],
      ['database.app-role', checkAppRole],
    ] as const) {
      try {
        await check(owner, checks);
      } catch (error) {
        add(id, false, `not checked (${errorCode(error)})`);
      }
    }

    try {
      const chain = await verifyEventChain(app);
      add('events.chain', chain.ok, chain.ok ? 'intact, read as the application role' : `broken at event ${chain.brokenAt}`);
    } catch (error) {
      add('events.chain', false, `not checked: the application role cannot read it (${errorCode(error)})`);
    }
  } finally {
    await app.end();
    await owner.end();
  }
  return checks;
}

function passwordsVerdict(logins: DbLogins): [boolean, string] {
  if (logins.owner.development) {
    return [false, 'development defaults: set database.password and database.app_password in arianna.toml (vault references)'];
  }
  const owner = passwordOf(logins.owner);
  const app = passwordOf(logins.app);
  const problems = [
    owner.length < MIN_PASSWORD ? 'the owner password is short' : '',
    app.length < MIN_PASSWORD ? 'the app password is short' : '',
    owner === app ? 'the two passwords are the same' : '',
  ].filter((part) => part !== '');
  return problems.length === 0
    ? [true, `from the vault, at least ${String(MIN_PASSWORD)} characters, different`]
    : [false, `${problems.join('; ')} (at least ${String(MIN_PASSWORD)} random characters, two different secrets)`];
}

/** The development passwords must not open the database, whatever the configuration says. */
async function checkDefaultsRejected(
  config: AriannaConfig,
  logins: DbLogins,
  checks: DoctorCheck[],
  at: { schema?: string },
): Promise<void> {
  const accepted: string[] = [];
  const unknown: string[] = [];
  const tries: DbLogin[] = [
    { user: logins.owner.user, password: DEV_PASSWORDS.owner, development: true },
    { user: APP_ROLE, password: DEV_PASSWORDS.app, development: true },
  ];
  for (const login of tries) {
    const sql = connect(config, login, at);
    try {
      await sql`SELECT 1`;
      accepted.push(login.user);
    } catch (error) {
      if (errorCode(error) !== INVALID_PASSWORD) unknown.push(`${login.user} (${errorCode(error)})`);
    } finally {
      await sql.end();
    }
  }
  const ok = accepted.length === 0 && unknown.length === 0;
  checks.push({
    id: 'database.default-passwords',
    ok,
    detail: ok
      ? 'rejected for both roles'
      : [
          accepted.length > 0 ? `still accepted for ${accepted.join(', ')}` : '',
          unknown.length > 0 ? `not verified for ${unknown.join(', ')}` : '',
        ]
          .filter((part) => part !== '')
          .join('; '),
  });
}

async function checkMigrations(owner: Sql, checks: DoctorCheck[]): Promise<void> {
  const files = loadMigrations();
  const { pending, edited, missing } = await migrationStatus(owner, files);
  const problems = [
    pending.length > 0 ? `pending ${pending.join(', ')}` : '',
    edited.length > 0 ? `edited after being applied ${edited.join(', ')}` : '',
    missing.length > 0 ? `applied without a file ${missing.join(', ')}` : '',
  ].filter((part) => part !== '');
  checks.push({
    id: 'database.migrations',
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${String(files.length)} applied` : problems.join('; '),
  });
}

/** The application role can work on rows and nothing else (migration 0007). */
async function checkAppRole(owner: Sql, checks: DoctorCheck[]): Promise<void> {
  const problems: string[] = [];
  const [role] = await owner<
    { super: boolean; createRole: boolean; createDb: boolean; replication: boolean; bypassRls: boolean; login: boolean }[]
  >`
    SELECT rolsuper AS super, rolcreaterole AS "createRole", rolcreatedb AS "createDb",
           rolreplication AS replication, rolbypassrls AS "bypassRls", rolcanlogin AS login
    FROM pg_roles WHERE rolname = ${APP_ROLE}`;
  if (role === undefined) {
    checks.push({ id: 'database.app-role', ok: false, detail: `${APP_ROLE} does not exist: run pnpm db:migrate` });
    return;
  }
  const attributes = Object.entries({ ...role, login: !role.login })
    .filter(([, value]) => value)
    .map(([name]) => (name === 'login' ? 'no LOGIN' : name));
  if (attributes.length > 0) problems.push(`attributes: ${attributes.join(', ')}`);

  // A member of another role inherits its privileges (the owner's, for one).
  const memberOf = await owner<{ name: string }[]>`
    SELECT r.rolname AS name FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles a ON a.oid = m.member
    WHERE a.rolname = ${APP_ROLE}`;
  if (memberOf.length > 0) problems.push(`member of ${memberOf.map((row) => row.name).join(', ')}`);

  const [owned] = await owner<{ count: number }[]>`
    SELECT ((SELECT count(*) FROM pg_class WHERE relowner = a.oid)
         + (SELECT count(*) FROM pg_proc WHERE proowner = a.oid)
         + (SELECT count(*) FROM pg_type WHERE typowner = a.oid)
         + (SELECT count(*) FROM pg_namespace WHERE nspowner = a.oid))::int AS count
    FROM pg_roles a WHERE a.rolname = ${APP_ROLE}`;
  if ((owned?.count ?? 0) > 0) problems.push(`owns ${String(owned?.count)} object(s)`);

  const [scope] = await owner<{ create: boolean; temp: boolean }[]>`
    SELECT has_schema_privilege(${APP_ROLE}, current_schema(), 'CREATE') AS create,
           has_database_privilege(${APP_ROLE}, current_database(), 'TEMPORARY') AS temp`;
  if (scope?.create === true) problems.push('can create objects in the schema');
  // A temporary table would shadow a table read by a trigger function.
  if (scope?.temp === true) problems.push('can create temporary tables');

  const tables = await owner<
    { name: string; select: boolean; update: boolean; forbidden: boolean; writes: boolean; appendOnly: boolean }[]
  >`
    SELECT c.relname AS name,
           has_table_privilege(${APP_ROLE}, c.oid, 'SELECT') AS select,
           has_table_privilege(${APP_ROLE}, c.oid, 'UPDATE') AS update,
           has_table_privilege(${APP_ROLE}, c.oid, 'DELETE, TRUNCATE, TRIGGER, REFERENCES, MAINTAIN') AS forbidden,
           has_table_privilege(${APP_ROLE}, c.oid, 'INSERT, UPDATE') AS writes,
           EXISTS (SELECT FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname LIKE '%\\_append\\_only'
                   AND (t.tgtype & ${TRIGGER_ON_UPDATE}) <> 0) AS "appendOnly"
    FROM pg_class c
    WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema()) AND c.relkind IN ('r', 'p')
    ORDER BY c.relname`;
  const names = (filter: (table: (typeof tables)[number]) => boolean): string =>
    tables.filter(filter).map((table) => table.name).join(', ');
  const unreadable = names((table) => !table.select);
  const forbidden = names((table) => table.forbidden);
  const rewritable = names((table) => table.appendOnly && table.update);
  if (unreadable !== '') problems.push(`cannot read ${unreadable}`);
  if (forbidden !== '') problems.push(`may delete, truncate, maintain or add triggers on ${forbidden}`);
  if (rewritable !== '') problems.push(`may update append-only ${rewritable}`);
  if (names((table) => table.name === 'schema_migrations' && table.writes) !== '') problems.push('may write schema_migrations');

  // A function that runs as its owner gives the core the owner's hands: only the purges of D-057 and D-136 may, and the locks of the second.
  const definers = await owner<{ name: string }[]>`
    SELECT p.proname AS name FROM pg_proc p
    WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
      AND p.prosecdef AND has_function_privilege(${APP_ROLE}, p.oid, 'EXECUTE')
      AND p.oid IS DISTINCT FROM to_regprocedure('purge_conversation(uuid)')
      AND p.oid IS DISTINCT FROM to_regprocedure('purge_incognito(uuid)')
      AND p.oid IS DISTINCT FROM to_regprocedure('lock_incognito(uuid)')
    ORDER BY p.proname`;
  if (definers.length > 0) problems.push(`may run as the owner through ${definers.map((row) => row.name).join(', ')}`);
  for (const purgeName of ['purge_conversation', 'purge_incognito', 'lock_incognito']) {
    const [purge] = await owner<{ public: boolean; pinned: boolean }[]>`
      SELECT has_function_privilege('public', p.oid, 'EXECUTE') AS public,
             EXISTS (SELECT FROM unnest(coalesce(p.proconfig, '{}')) setting WHERE setting LIKE 'search\\_path=%pg\\_temp') AS pinned
      FROM pg_proc p WHERE p.oid = to_regprocedure(${`${purgeName}(uuid)`})`;
    if (purge?.public === true) problems.push(`anyone may run ${purgeName}`);
    if (purge !== undefined && !purge.pinned) problems.push(`${purgeName} has no fixed search_path`);
  }

  // Without USAGE an insert into a bigserial table fails.
  const sequences = await owner<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_class c
    WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
      -- CASE, because the planner may call the function before testing relkind.
      AND CASE WHEN c.relkind = 'S' THEN NOT has_sequence_privilege(${APP_ROLE}, c.oid, 'USAGE') ELSE false END
    ORDER BY c.relname`;
  if (sequences.length > 0) problems.push(`cannot use sequence ${sequences.map((row) => row.name).join(', ')}`);

  checks.push({
    id: 'database.app-role',
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${APP_ROLE}: rows only, ${String(tables.length)} tables` : problems.join('; '),
  });
}
