// The master password (I-11, tappa P5, D-187): it approves the exceptional
// release of a private note. The vault holds only its scrypt hash (key
// `master-password-hash`), written by the user with `pnpm vault:master` and
// `pnpm vault:edit`: the core checks a password without knowing it, and no
// agent can set or change it.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const MASTER_PASSWORD_REF = 'vault://master-password-hash';
/** Shortest password accepted when the hash is made. */
export const MIN_MASTER_PASSWORD = 10;
/** Longest password checked: a longer one is refused before scrypt runs. */
export const MAX_MASTER_PASSWORD = 1024;

const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Highest cost read back from a hash (2^17 · 8 · 128 bytes = 128 MiB, p ≤ 2): a hand-written one cannot make the core spend minutes or gigabytes. */
const MAX_LOG_N = 17;
const HASH = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9+/]{22}(?:==)?)\$([A-Za-z0-9+/]{43}=?)$/;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_BYTES, { ...options, maxmem: 256 * (options.N ?? 1) * (options.r ?? 1) + 1024 * 1024 }, (error, key) => {
      if (error === null) resolve(key);
      else reject(error);
    });
  });
}

/** `scrypt$<log2 N>$<r>$<p>$<salt>$<key>`, base64: the value for `master-password-hash`. */
export async function hashMasterPassword(password: string): Promise<string> {
  if (password.length < MIN_MASTER_PASSWORD) throw new RangeError(`the master password needs at least ${String(MIN_MASTER_PASSWORD)} characters`);
  if (password.length > MAX_MASTER_PASSWORD) throw new RangeError('the master password is too long');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, PARAMS);
  return `scrypt$${String(Math.log2(PARAMS.N))}$${String(PARAMS.r)}$${String(PARAMS.p)}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** True when `hash` reads as one `hashMasterPassword` wrote, within the costs the core accepts. */
export function isMasterPasswordHash(hash: string): boolean {
  const match = HASH.exec(hash.trim());
  if (match === null) return false;
  const [logN, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return logN >= 14 && logN <= MAX_LOG_N && r >= 1 && r <= 8 && p >= 1 && p <= 2;
}

/**
 * True when `password` is the one of `hash`. A hash that does not read as
 * one of `hashMasterPassword` throws: the vault holds something else.
 */
export async function verifyMasterPassword(hash: string, password: string): Promise<boolean> {
  const match = isMasterPasswordHash(hash) ? HASH.exec(hash.trim()) : null;
  if (match === null) throw new RangeError('master-password-hash is not a hash written by pnpm vault:master');
  if (password === '' || password.length > MAX_MASTER_PASSWORD) return false;
  const salt = Buffer.from(match[4] ?? '', 'base64');
  const expected = Buffer.from(match[5] ?? '', 'base64');
  if (expected.length !== KEY_BYTES) throw new RangeError('master-password-hash is not a hash written by pnpm vault:master');
  const key = await derive(password, salt, { N: 2 ** Number(match[1]), r: Number(match[2]), p: Number(match[3]) });
  return timingSafeEqual(key, expected);
}
