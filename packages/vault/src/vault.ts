// Minimal vault (task 1.14): one sops file encrypted with age in
// data/vault/secrets.yaml, read one key at a time with the official `sops`
// binary. The age key stays where sops looks for it by default, outside
// ARIANNA_HOME and outside the synced folder (docs/INSTALLER-PORTABILITY.md).
// Models and logs only ever see `vault://name`: the value is resolved here, by
// the process that uses it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Secret } from './secret.ts';

export const VAULT_DIR = 'vault';
export const VAULT_FILE = 'secrets.yaml';
export const VAULT_PREFIX = 'vault://';

/** A top-level key of the sops file: no nesting, nothing to quote in `--extract`. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * What sops gets from the environment of the core: where to find the key and
 * little else. No other secret the core may hold reaches the child.
 */
const PASSED_ENV = [
  'PATH',
  'HOME',
  'XDG_CONFIG_HOME',
  'TMPDIR',
  'SOPS_AGE_KEY_FILE',
  'SOPS_AGE_KEY',
  // A key kept by an external program (a password manager) or an SSH key.
  'SOPS_AGE_KEY_CMD',
  'SOPS_AGE_SSH_PRIVATE_KEY_FILE',
] as const;

export type VaultErrorCode = 'invalid-reference' | 'no-vault' | 'sops-missing' | 'decrypt-failed' | 'timeout' | 'too-large' | 'empty';

/** Messages carry the reference and a code, never sops output: it may quote the file. */
export class VaultError extends Error {
  override name = 'VaultError';
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The name in `vault://name`; throws on anything else. */
export function parseVaultRef(ref: unknown): string {
  if (typeof ref !== 'string' || !ref.startsWith(VAULT_PREFIX) || !NAME.test(ref.slice(VAULT_PREFIX.length))) {
    throw new VaultError('invalid-reference', 'not a vault reference: expected vault://<name> with a-z, 0-9, _ and -');
  }
  return ref.slice(VAULT_PREFIX.length);
}

export function isVaultRef(value: unknown): value is string {
  try {
    parseVaultRef(value);
    return true;
  } catch {
    return false;
  }
}

export interface VaultOptions {
  /** Absolute `data/` folder; the vault is `data/vault/secrets.yaml`. */
  data: string;
  /** The sops binary and leading arguments; `['sops']` by default. Tests pass a fake. */
  command?: readonly string[];
  /** Where PATH and the sops variables are taken from; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
  /** Per call; 10 seconds by default. */
  timeoutMs?: number;
}

export interface Vault {
  /** Absolute path of the encrypted file. */
  readonly file: string;
  /** Decrypts one secret. Each call runs sops: nothing is cached on disk or here. */
  resolve(ref: string): Promise<Secret>;
}

function childEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSED_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function run(command: readonly string[], args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  const [binary, ...leading] = command;
  if (binary === undefined) return Promise.reject(new VaultError('sops-missing', 'no sops command configured'));
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      [...leading, ...args],
      { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        if (error === null) {
          resolvePromise(stdout);
          return;
        }
        if (error.code === 'ENOENT') reject(new VaultError('sops-missing', 'sops is not installed or not on PATH'));
        // Checked before `killed`: Node also kills a child whose output is too large.
        else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new VaultError('too-large', 'the secret is larger than 1 MiB'));
        else if (error.killed) reject(new VaultError('timeout', 'sops did not answer in time'));
        else reject(new VaultError('decrypt-failed', 'sops could not decrypt the secret'));
      },
    );
  });
}

export function createVault(options: VaultOptions): Vault {
  const dir = join(options.data, VAULT_DIR);
  const file = join(dir, VAULT_FILE);
  const command = options.command ?? ['sops'];
  const env = childEnv(options.env ?? process.env);
  const timeout = options.timeoutMs ?? 10_000;

  return {
    file,
    async resolve(ref: string): Promise<Secret> {
      const name = parseVaultRef(ref);
      if (!existsSync(file)) throw new VaultError('no-vault', `no vault file for ${ref}: create it with pnpm vault:edit`);
      let value: string;
      try {
        value = await run(command, ['--decrypt', '--extract', `["${name}"]`, file], dir, env, timeout);
      } catch (error) {
        if (error instanceof VaultError) throw new VaultError(error.code, `${ref}: ${error.message}`);
        throw error;
      }
      // sops prints a string value exactly, without adding a newline (checked on 3.13.3).
      if (value === '') throw new VaultError('empty', `${ref} is empty`);
      return new Secret(ref, value);
    },
  };
}
