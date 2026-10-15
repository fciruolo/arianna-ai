import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The key of a local server the core starts (D-221). Without one oMLX answers
 * anybody on loopback, browser pages included (its CORS allows every origin):
 * they could use the model, set the password of its admin panel and from
 * there turn on logs that hold the prompts. The core gives every server it
 * starts a key (OMLX_API_KEY in its environment, never on the command line,
 * which `ps` shows) and sends it on every request.
 *
 * The key lives in data/<id>.key, readable by this user only, and outlives
 * the core: `pnpm eval:models`, a separate process, reads it too, and a
 * server left running by a core that died still accepts the next one.
 */

/** 32 random bytes as base64url, as `createLocalKey` writes them. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function keyFile(dataDir: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new TypeError(`invalid endpoint id ${JSON.stringify(id)}`);
  return join(dataDir, `${id}.key`);
}

/** The key of endpoint `id`, or undefined when there is none (or the file is not one). */
export function readLocalKey(dataDir: string, id: string): string | undefined {
  try {
    const key = readFileSync(keyFile(dataDir, id), 'utf8').trim();
    return KEY_PATTERN.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key of endpoint `id`, created when missing or not valid. A file
 * readable by others is tightened to 0600 first: the key is as private as the
 * prompts it guards.
 */
export function ensureLocalKey(dataDir: string, id: string): string {
  const file = keyFile(dataDir, id);
  const existing = readLocalKey(dataDir, id);
  if (existing !== undefined) {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    return existing;
  }
  const key = randomBytes(32).toString('base64url');
  // A new file, never an old one (or a link) whose looser mode would show the key before a chmod.
  rmSync(file, { force: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * For `createLocalModel`: the key of each endpoint, read at every request.
 * `managed` says which endpoints the core starts: one it only watches is
 * not its own and never gets the key, even when an old data/<id>.key is left.
 */
export function localKeys(dataDir: string, managed: (id: string) => boolean = () => true): (id: string) => string | undefined {
  return (id) => (ID_PATTERN.test(id) && managed(id) ? readLocalKey(dataDir, id) : undefined);
}

/** The header that carries a key, or none. */
export function authorization(key: string | undefined): Record<string, string> {
  return key === undefined ? {} : { authorization: `Bearer ${key}` };
}
