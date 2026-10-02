// The vault with the real sops and age, on a throwaway key and fake values.
// Skipped when the binaries are not installed (brew install sops age).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { createVault, VaultError } from '@arianna/vault';

function installed(binary: string): boolean {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = installed('sops') && installed('age-keygen') ? false : 'sops or age-keygen not installed';
const DATA = join(resolveHome({}), 'data', 'test-tmp', `sops-${randomUUID()}`);
const FAKE_TOKEN = 'fake-sops-token-0b5d93';

after(() => {
  rmSync(DATA, { recursive: true, force: true });
});

it('decrypts one key of a sops file encrypted with age', { skip }, async () => {
  const dir = join(DATA, 'vault');
  mkdirSync(dir, { recursive: true });
  const key = join(DATA, 'age-key.txt');
  execFileSync('age-keygen', ['-o', key], { stdio: 'ignore' });
  const recipient = execFileSync('age-keygen', ['-y', key], { encoding: 'utf8' }).trim();
  const plain = join(dir, 'secrets.plain.yaml');
  writeFileSync(plain, `demo-token: ${FAKE_TOKEN}\nother: fake-other-value\nmulti: |-\n  fake-line-one\n  fake-line-two\nkept: |\n  fake-kept-line\n`);
  const encrypted = execFileSync('sops', ['--encrypt', '--age', recipient, plain], { cwd: dir, encoding: 'utf8' });
  rmSync(plain);
  assert.ok(!encrypted.includes(FAKE_TOKEN));
  writeFileSync(join(dir, 'secrets.yaml'), encrypted);

  const env = { PATH: process.env.PATH, SOPS_AGE_KEY_FILE: key };
  const secret = await createVault({ data: DATA, env }).resolve('vault://demo-token');
  assert.equal(secret.reveal(), FAKE_TOKEN);
  // Values come back exactly, their own newlines included.
  assert.equal((await createVault({ data: DATA, env }).resolve('vault://multi')).reveal(), 'fake-line-one\nfake-line-two');
  assert.equal((await createVault({ data: DATA, env }).resolve('vault://kept')).reveal(), 'fake-kept-line\n');

  await assert.rejects(createVault({ data: DATA, env }).resolve('vault://missing'), VaultError);
  // Without the key, nothing decrypts.
  const noKey = { PATH: process.env.PATH, SOPS_AGE_KEY_FILE: join(DATA, 'no-key.txt'), HOME: DATA };
  await assert.rejects(createVault({ data: DATA, env: noKey }).resolve('vault://demo-token'), VaultError);
});
