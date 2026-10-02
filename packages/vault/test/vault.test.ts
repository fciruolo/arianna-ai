// The vault against a fake sops (test/fixtures/fake-sops.ts), in a scratch
// data/ folder under data/test-tmp. sops.test.ts runs the real binaries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { inspect } from 'node:util';

import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { createVault, isVaultRef, knownSecrets, parseVaultRef, Secret, VaultError, type VaultOptions } from '@arianna/vault';

const FAKE_SOPS = join(import.meta.dirname, 'fixtures', 'fake-sops.ts');
const DATA = join(resolveHome({}), 'data', 'test-tmp', `vault-${randomUUID()}`);
const FAKE_TOKEN = 'fake-vault-token-7c21e0';

mkdirSync(join(DATA, 'vault'), { recursive: true });
writeFileSync(join(DATA, 'vault', 'secrets.yaml'), JSON.stringify({ 'demo-token': FAKE_TOKEN, blank: '' }));

after(() => {
  rmSync(DATA, { recursive: true, force: true });
});

function vault(options: Partial<VaultOptions> = {}): ReturnType<typeof createVault> {
  return createVault({ data: DATA, command: [process.execPath, FAKE_SOPS], env: { PATH: process.env.PATH }, ...options });
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected a VaultError ${code}`);
}

describe('vault references', () => {
  it('accepts vault://<name> with lowercase letters, digits, _ and -', () => {
    assert.equal(parseVaultRef('vault://demo-token'), 'demo-token');
    assert.equal(parseVaultRef('vault://db_password2'), 'db_password2');
    assert.equal(isVaultRef('vault://telegram-bot'), true);
  });

  it('rejects other schemes, nesting, quotes and uppercase', () => {
    for (const ref of ['demo-token', 'vault://', 'vault://a/b', 'vault://a"]', 'vault://Token', 'vault://-x', 'file://x', 42]) {
      assert.equal(isVaultRef(ref), false, String(ref));
    }
    assert.throws(() => parseVaultRef('vault://a"]'), VaultError);
  });
});

describe('createVault', () => {
  it('resolves a secret whose value comes out only through reveal()', async () => {
    const secret = await vault().resolve('vault://demo-token');
    assert.ok(secret instanceof Secret);
    assert.equal(secret.reveal(), FAKE_TOKEN);
    assert.equal(secret.ref, 'vault://demo-token');
    assert.equal(String(secret), 'vault://demo-token');
    assert.equal(`Bearer ${String(secret)}`, 'Bearer vault://demo-token');
    assert.equal(JSON.stringify({ token: secret }), '{"token":"vault://demo-token"}');
    assert.equal(inspect({ token: secret }), '{ token: Secret(vault://demo-token) }');
    assert.ok(!Object.values(secret).includes(FAKE_TOKEN));
  });

  it('registers a revealed value, so the gateway blocks it even toward the local model', async () => {
    const secret = await vault().resolve('vault://demo-token');
    assert.deepEqual(knownSecrets.find(`header ${secret.reveal()}`), ['vault://demo-token']);
    const decision = gatewayCheck(
      [{ value: `use ${secret.reveal()}`, label: 'L2', source: 'test' }],
      createContext('L2'),
      { kind: 'executor', id: 'omlx', locality: 'local' },
      knownSecrets,
    );
    assert.equal(decision.decision, 'block');
    assert.equal(decision.rule, 'secret');
  });

  it('passes sops only PATH, HOME and the sops variables', async () => {
    const env = { PATH: process.env.PATH, HOME: '/nonexistent', SOPS_AGE_KEY_FILE: 'k', OTHER_TOKEN: 'x', NODE_OPTIONS: '' };
    const names = JSON.parse((await vault({ env }).resolve('vault://env')).reveal()) as string[];
    assert.ok(!names.includes('OTHER_TOKEN'));
    assert.ok(!names.includes('NODE_OPTIONS'));
    assert.ok(names.includes('SOPS_AGE_KEY_FILE'));
  });

  it('rejects an invalid reference before running sops', async () => {
    await rejectsWith(vault({ command: ['/nonexistent/sops'] }).resolve('vault://a/b'), 'invalid-reference');
  });

  it('reports a failure without the output of sops', async () => {
    const error = await rejectsWith(vault().resolve('vault://fail'), 'decrypt-failed');
    assert.ok(!error.message.includes('fake-stderr'));
    await rejectsWith(vault().resolve('vault://missing'), 'decrypt-failed');
  });

  it('refuses an empty value', async () => {
    await rejectsWith(vault().resolve('vault://blank'), 'empty');
  });

  it('says when the vault file or sops is missing', async () => {
    await rejectsWith(createVault({ data: join(DATA, 'nowhere'), command: [process.execPath, FAKE_SOPS] }).resolve('vault://demo-token'), 'no-vault');
    await rejectsWith(vault({ command: [join(DATA, 'no-sops-here')] }).resolve('vault://demo-token'), 'sops-missing');
  });

  it('stops a sops that does not answer', async () => {
    await rejectsWith(vault({ timeoutMs: 300 }).resolve('vault://hang'), 'timeout');
  });
});
