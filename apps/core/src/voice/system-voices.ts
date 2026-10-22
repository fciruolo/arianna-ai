import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The voices of macOS (D-290): `say -v '?'` lists the installed ones, one per
 * line, as `Federica (Premium)  it_IT    # Ciao! Mi chiamo Federica.`. Only
 * names leave this module: the list says nothing about the user.
 */
export const SAY = '/usr/bin/say';

const LINE = /^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]{2,4}\s+#/;

/** The names of a `say -v '?'` listing; pure, for the tests. */
export function parseVoiceList(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    const name = LINE.exec(line)?.[1]?.trim();
    return name === undefined || name === '' ? [] : [name];
  });
}

export type ListVoices = () => Promise<string>;

const listWithSay: ListVoices = () =>
  new Promise((resolve, reject) => {
    // An empty environment: `say` needs nothing of the core's.
    execFile(SAY, ['-v', '?'], { timeout: 10_000, env: {}, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`say -v ? failed: ${error.code === undefined ? 'error' : String(error.code)}`));
    });
  });

/**
 * The installed system voices, read again at most once a minute. The pages ask
 * at each request: the list is kept and refreshed in the background, so a
 * request never waits on `say`. Off macOS (no /usr/bin/say): always empty.
 */
export function systemVoices(options: { list?: ListVoices; available?: boolean; maxAgeMs?: number; now?: () => number } = {}): { names: () => readonly string[]; refresh: () => Promise<void> } {
  const available = options.available ?? (process.platform === 'darwin' && existsSync(SAY));
  const list = options.list ?? listWithSay;
  const maxAge = options.maxAgeMs ?? 60_000;
  const now = options.now ?? Date.now;
  let names: readonly string[] = [];
  let readAt = -Infinity;
  let reading: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (!available) return Promise.resolve();
    reading ??= list()
      .then((text) => {
        names = parseVoiceList(text);
      })
      .catch(() => {
        // `say` failed: no voice until the next try.
        names = [];
      })
      .finally(() => {
        readAt = now();
        reading = undefined;
      });
    return reading;
  };
  return {
    names: () => {
      if (now() - readAt >= maxAge) void refresh();
      return names;
    },
    refresh,
  };
}
