import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Unlinks the plain file `segments` below `base`, a real folder given as its
 * own real path (D-157): every folder on the way a real folder, the file a
 * regular file, never a link, and its real path exactly where the segments
 * say. False for anything else, with nothing touched. No other import: the
 * notes of kb/ and those of the projects both use it.
 */
export function unlinkPlainFile(base: string, segments: readonly string[]): boolean {
  const name = segments.at(-1);
  if (name === undefined || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0'))) return false;
  try {
    let dir = realpathSync(base);
    if (dir !== base) return false;
    for (const segment of segments.slice(0, -1)) {
      dir = join(dir, segment);
      if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
    }
    const file = join(dir, name);
    if (lstatSync(file, { throwIfNoEntry: false })?.isFile() !== true) return false;
    // Last look before the unlink: a folder swapped for a link since the walk is refused.
    if (realpathSync(file) !== join(base, ...segments)) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
