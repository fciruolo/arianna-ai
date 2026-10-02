// The user's commands for the vault (task 1.14), run by hand in a terminal:
//   node scripts/vault.ts init <age recipient>   writes data/vault/.sops.yaml
//   node scripts/vault.ts edit                   opens data/vault/secrets.yaml in $EDITOR through sops
// The age key is the user's: generate it once with `age-keygen -o <file>` where
// sops looks by default (or point SOPS_AGE_KEY_FILE at it), outside ARIANNA_HOME.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@arianna/config';
import { VAULT_DIR, VAULT_FILE } from '@arianna/vault';

const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;

const dir = join(loadConfig().paths.data, VAULT_DIR);
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
} else {
  console.error('Usage: node scripts/vault.ts <init <age1...>|edit>');
  process.exit(2);
}
