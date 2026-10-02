// Database logins (task 1.13, D-046). Two roles: the owner of the schema runs
// migrations and gives the application role its password; the core works as
// the application role, which reads and writes rows but cannot change the
// schema, disable a trigger, or update and delete the append-only tables.
// Passwords come from the vault; without `password` and `app_password` in
// arianna.toml the development defaults apply, for fake data only.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import type { AriannaConfig } from '@arianna/config';
import { createVault, type Secret } from '@arianna/vault';

import type { Sql } from './client.ts';
import { loadMigrations, migrate } from './migrate.ts';

/** Created by migration 0007; the name is fixed because migrations cannot read arianna.toml. */
export const APP_ROLE = 'arianna_app';

/** For a local database with fake data only: `pnpm arianna:doctor` fails while they are in use. */
export const DEV_PASSWORDS = { owner: 'arianna_dev', app: 'arianna_app_dev' } as const;

// Printable ASCII without spaces: PostgreSQL normalizes passwords with SASLprep,
// which leaves these unchanged, so the verifier computed here always matches.
const PASSWORD = /^[\x21-\x7e]+$/;

export interface DbLogin {
  user: string;
  /** A revealed vault secret, or a development default. */
  password: Secret | string;
  /** True for a development default. */
  development: boolean;
}

export interface DbLogins {
  owner: DbLogin;
  app: DbLogin;
}

export class LoginError extends Error {
  override name = 'LoginError';
}

export function passwordOf(login: DbLogin): string {
  return typeof login.password === 'string' ? login.password : login.password.reveal();
}

export type DbRole = keyof DbLogins;

type Resolve = (ref: string) => Promise<Secret>;

function vaultOf(config: AriannaConfig): Resolve {
  return (ref) => createVault({ data: config.paths.data }).resolve(ref);
}

/**
 * Resolves the login of one role; `resolve` reads the vault unless a test
 * passes its own. With real passwords the core resolves only `app`: the
 * owner's password, a superuser's, stays out of the long-running process.
 */
export async function resolveLogin(config: AriannaConfig, role: DbRole, resolve: Resolve = vaultOf(config)): Promise<DbLogin> {
  const user = role === 'owner' ? config.database.user : APP_ROLE;
  const ref = role === 'owner' ? config.database.password : config.database.appPassword;
  // The configuration sets both references or neither.
  if (ref === undefined) return { user, password: DEV_PASSWORDS[role], development: true };
  const login = { user, password: await resolve(ref), development: false };
  if (!PASSWORD.test(passwordOf(login))) throw new LoginError(`the ${role} password must be printable ASCII without spaces`);
  return login;
}

/** Both logins: for migrations, tests and the doctor. */
export async function resolveLogins(config: AriannaConfig, resolve: Resolve = vaultOf(config)): Promise<DbLogins> {
  return { owner: await resolveLogin(config, 'owner', resolve), app: await resolveLogin(config, 'app', resolve) };
}

/**
 * The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802 and
 * 7677). Sending the verifier instead of the password keeps the password out
 * of the statement, so a server that logs DDL never writes it.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Applies the pending migrations and lets the application role log in with
 * its password; `owner` must be connected as the owner. Returns the versions
 * applied.
 */
export async function prepareDatabase(owner: Sql, app: DbLogin): Promise<string[]> {
  const password = passwordOf(app);
  if (!PASSWORD.test(password)) throw new LoginError('the app password must be printable ASCII without spaces');
  const applied = await migrate(owner, loadMigrations());
  // The verifier is base64 with `$` and `:` only: nothing to escape. The lock
  // serializes concurrent callers (test files), which would otherwise collide
  // on the same pg_authid row.
  await owner.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('arianna.roles'))`;
    await tx.unsafe(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${scramVerifier(password)}'`);
  });
  return applied;
}
