import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { parseConfig } from '@arianna/config';
import { Secret, VaultError } from '@arianna/vault';

import { APP_ROLE, DEV_PASSWORDS, LoginError, passwordOf, resolveLogin, resolveLogins, scramVerifier } from '../src/db/logins.ts';

const BASE = `
[paths]
data = "data"

[database]
host = "127.0.0.1"
port = 54329
name = "arianna"
user = "arianna"
`;
const HOME = resolve('some-home');
const WITH_VAULT = parseConfig(`${BASE}password = "vault://db-owner"\napp_password = "vault://db-app"\n`, HOME);

const fakeVault = (values: Record<string, string>) => (ref: string): Promise<Secret> => {
  const value = values[ref];
  return value === undefined ? Promise.reject(new VaultError('decrypt-failed', `${ref}: failed`)) : Promise.resolve(new Secret(ref, value));
};

test('without passwords in arianna.toml the development defaults apply, and say so', async () => {
  const logins = await resolveLogins(parseConfig(BASE, HOME), () => Promise.reject(new Error('the vault must not be read')));
  assert.deepEqual(logins, {
    owner: { user: 'arianna', password: DEV_PASSWORDS.owner, development: true },
    app: { user: APP_ROLE, password: DEV_PASSWORDS.app, development: true },
  });
});

test('with vault references both passwords come from the vault, as secrets', async () => {
  const logins = await resolveLogins(WITH_VAULT, fakeVault({ 'vault://db-owner': 'owner-Pw-123456789', 'vault://db-app': 'app-Pw-987654321' }));
  assert.equal(logins.owner.development, false);
  assert.equal(logins.app.user, APP_ROLE);
  assert.ok(logins.owner.password instanceof Secret);
  assert.equal(passwordOf(logins.owner), 'owner-Pw-123456789');
  assert.equal(passwordOf(logins.app), 'app-Pw-987654321');
  // Printed or serialized, a login shows the reference only.
  assert.doesNotMatch(JSON.stringify(logins), /Pw-/);
});

test("the core resolves only the application role's password, never the owner's", async () => {
  const asked: string[] = [];
  const login = await resolveLogin(WITH_VAULT, 'app', (ref) => {
    asked.push(ref);
    return Promise.resolve(new Secret(ref, 'app-Pw-987654321'));
  });
  assert.deepEqual(asked, ['vault://db-app']);
  assert.equal(login.user, APP_ROLE);
});

test('a vault error stops the start, and a password PostgreSQL would normalize is refused', async () => {
  await assert.rejects(resolveLogins(WITH_VAULT, fakeVault({ 'vault://db-owner': 'owner-Pw-123456789' })), VaultError);
  await assert.rejects(
    resolveLogins(WITH_VAULT, fakeVault({ 'vault://db-owner': 'owner-Pw-123456789', 'vault://db-app': 'with space' })),
    (error: unknown) => error instanceof LoginError && /app password/.test(error.message) && !error.message.includes('with space'),
  );
  await assert.rejects(
    resolveLogins(WITH_VAULT, fakeVault({ 'vault://db-owner': 'pàssword-1234567', 'vault://db-app': 'app-Pw-987654321' })),
    LoginError,
  );
});

test('the SCRAM verifier has the form PostgreSQL stores and the keys of RFC 5802', () => {
  const salt = Buffer.from('0123456789abcdef');
  const verifier = scramVerifier('pencil', salt, 4096);
  assert.match(verifier, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.ok(!verifier.includes('pencil'));
  assert.ok(!verifier.includes("'"));

  // Recomputed by hand: StoredKey = H(HMAC(SaltedPassword, "Client Key")).
  const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256');
  const stored = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  assert.equal(verifier, `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`);

  // A fresh salt each time: two verifiers of the same password differ.
  assert.notEqual(scramVerifier('pencil'), scramVerifier('pencil'));
});
