// The user's commands for the vault (task 1.14), run by hand in a terminal:
//   node scripts/vault.ts init <age recipient>   writes data/vault/.sops.yaml
//   node scripts/vault.ts edit                   opens data/vault/secrets.yaml in $EDITOR through sops
//   node scripts/vault.ts master                 asks the master password twice, prints its hash (D-187)
// The age key is the user's: generate it once with `age-keygen -o <file>` where
// sops looks by default (or point SOPS_AGE_KEY_FILE at it), outside ARIANNA_HOME.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfigOrExit } from '@arianna/config';
import { hashMasterPassword, MIN_MASTER_PASSWORD, VAULT_DIR, VAULT_FILE } from '@arianna/vault';

const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

const dir = join(loadConfigOrExit().paths.data, VAULT_DIR);
const [command, recipient] = process.argv.slice(2);

if (command === 'init') {
  if (recipient === undefined || !RECIPIENT.test(recipient)) {
    console.error('Usage: node scripts/vault.ts init <age1... public key> (from age-keygen -y <key file>)');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const rules = join(dir, '.sops.yaml');
  if (existsSync(rules)) {
    console.error(`${rules} exists already: edit it by hand to change recipients`);
    process.exit(1);
  }
  // A public key: not a secret, but it lives with the vault, outside git.
  writeFileSync(rules, `creation_rules:\n  - path_regex: ${VAULT_FILE.replace('.', '\\.')}$\n    age: ${recipient}\n`);
  console.log(`Wrote ${rules}. Now run: pnpm vault:edit`);
} else if (command === 'edit') {
  if (!existsSync(join(dir, '.sops.yaml')) && !existsSync(join(dir, VAULT_FILE))) {
    console.error('No vault yet: run pnpm vault:init <age1... public key> first');
    process.exit(1);
  }
  // sops finds .sops.yaml from the working directory; keys are top-level, `name: value`.
  const result = spawnSync('sops', [VAULT_FILE], { cwd: dir, stdio: 'inherit' });
  if (result.error !== undefined) console.error(`sops: ${result.error.message}`);
  process.exitCode = result.status ?? 1;
} else if (command === 'master') {
  // Only the hash is printed: the user pastes it into the vault with pnpm vault:edit.
  if (!process.stdin.isTTY) {
    console.error('Run pnpm vault:master in a terminal: the password is typed, never piped');
    process.exit(2);
  }
  const first = await askHidden(`Master password (almeno ${String(MIN_MASTER_PASSWORD)} caratteri): `);
  const second = await askHidden('Ripetila: ');
  if (first !== second) {
    console.error('Le due password sono diverse: niente impronta.');
    process.exit(1);
  }
  try {
    const hash = await hashMasterPassword(first);
    console.log('\nAggiungi questa riga al vault con pnpm vault:edit (sostituisce quella di prima, se c’era):\n');
    console.log(`master-password-hash: "${hash}"`);
  } catch (error) {
    console.error(error instanceof RangeError ? error.message : String(error));
    process.exit(1);
  }
} else {
  console.error('Usage: node scripts/vault.ts <init <age1...>|edit|master>');
  process.exit(2);
}

/** A line typed on the terminal without echo. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let typed = '';
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\r' || char === '\n' || char === '\u0004') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(typed);
          return;
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    input.on('data', onData);
  });
}
