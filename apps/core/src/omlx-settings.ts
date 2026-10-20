// How the core recognises an oMLX command and the one setting it writes in
// oMLX's settings.json (D-221, D-263). The doctor (install-checks.ts) reads
// the same command the same way.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Whether a command starts oMLX: `omlx serve`, by path or through a launcher
 * (`uvx omlx serve`), or the wrapper inside the macOS app
 * (`/Applications/oMLX.app/Contents/MacOS/omlx-cli serve`), which 0.7 no
 * longer links into /opt/homebrew/bin, or what that wrapper runs
 * (`python3 -m omlx.cli serve`): a command naming any of them must not escape
 * the checks.
 */
export function startsOmlx(command: readonly string[]): boolean {
  const serve = command.indexOf('serve');
  if (serve <= 0) return false;
  const before = command.slice(0, serve);
  if (before.some((arg) => /(^|\/)omlx(-cli)?$/.test(arg))) return true;
  const module = before.findIndex((arg, index) => arg === '-m' && before[index + 1] === 'omlx.cli');
  return module > 0 && before.slice(0, module).some((arg) => /(^|\/)python(3(\.\d+)?)?$/.test(arg));
}

/**
 * The value of `flag` in a command (`--flag x` or `--flag=x`): the last one,
 * as a command-line parser applies it; null for a flag without a value;
 * undefined without the flag.
 */
export function flagValue(command: readonly string[], flag: string): string | null | undefined {
  let value: string | null | undefined;
  for (const [index, arg] of command.entries()) {
    if (arg === flag) {
      const next = command[index + 1];
      value = next === undefined || next.startsWith('-') ? null : next;
    } else if (arg.startsWith(`${flag}=`)) {
      const given = arg.slice(flag.length + 1);
      value = given === '' ? null : given;
    }
  }
  return value;
}

/**
 * The `--base-path` of an oMLX command when it is inside data/, as a path
 * under the real data/; undefined otherwise (no flag, no value, outside
 * data/, data/ itself). Every part below data/ is looked at with lstat: a
 * link, dangling or not, counts as outside (data/omlx pointing at the home
 * folder of oMLX, or at nothing yet), and so does a part that is not a
 * folder. Parts that do not exist yet are fine: oMLX creates them.
 */
export function omlxBaseInsideData(home: string, data: string, command: readonly string[]): string | undefined {
  const base = flagValue(command, '--base-path');
  if (base === undefined || base === null) return undefined;
  const target = resolve(home, base);
  const realData = existsSync(data) ? realpathSync(data) : resolve(data);
  for (const root of new Set([resolve(data), realData])) {
    const inside = relative(root, target);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) continue;
    let path = root;
    for (const part of inside.split(sep)) {
      path = join(path, part);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        break; // Not there yet: the rest is created by oMLX (or by the core).
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    }
    return join(realData, inside);
  }
  return undefined;
}

/**
 * Whether `file` is safe to read as oMLX's own settings: missing, or a
 * regular file that is not a link (one could point anywhere, D-263).
 */
export function plainFileOrMissing(file: string): 'missing' | 'file' | 'other' {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return 'missing';
  }
  return stat.isFile() && !stat.isSymbolicLink() ? 'file' : 'other';
}

export type HfCacheResult = 'not-omlx' | 'outside-data' | 'already-off' | 'written' | 'unreadable';

/**
 * Turns off oMLX's discovery of models in the Hugging Face cache of the home
 * folder (D-263): `huggingface.hf_cache_enabled: false` in
 * `<base-path>/settings.json`, before the core starts the server. Only for a
 * command that starts oMLX with a --base-path inside data/. A missing file is
 * created with that key alone (oMLX fills in the defaults of every other
 * section, settings.py `_load_from_file`); an existing one keeps every other
 * key, through a temporary file renamed over it with the same permissions. A
 * file that is not a JSON object is left as it is, and the doctor fails on
 * it. No other file of oMLX is touched.
 */
export function ensureOmlxHfCacheOff(home: string, data: string, command: readonly string[]): HfCacheResult {
  if (!startsOmlx(command)) return 'not-omlx';
  const base = omlxBaseInsideData(home, data, command);
  if (base === undefined) return 'outside-data';
  const file = join(base, 'settings.json');
  let settings: Record<string, unknown> = {};
  let mode = 0o600;
  const kind = plainFileOrMissing(file);
  // A link or anything but a regular file is never read nor replaced.
  if (kind === 'other') return 'unreadable';
  if (kind === 'file') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch {
      return 'unreadable';
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unreadable';
    settings = parsed as Record<string, unknown>;
    const section = settings.huggingface;
    if (section !== undefined && (typeof section !== 'object' || section === null || Array.isArray(section))) return 'unreadable';
    if ((section as Record<string, unknown> | undefined)?.hf_cache_enabled === false) return 'already-off';
    mode = statSync(file).mode & 0o777;
  }
  const next = { ...settings, huggingface: { ...((settings.huggingface as Record<string, unknown> | undefined) ?? {}), hf_cache_enabled: false } };
  const temporary = `${file}.arianna-${String(process.pid)}.tmp`;
  // oMLX creates its folder at the first start; the core may come first.
  mkdirSync(base, { recursive: true, mode: 0o700 });
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode, flag: 'wx' });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return 'written';
}
