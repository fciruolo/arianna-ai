/**
 * What a test file opens (a database, a fake server, a channel) and closes at
 * the end, so that the file always ends.
 *
 * Two ways a file of `pnpm test:db` used to hang after its tests:
 * - a `before` hook that outlives its timeout (the setup waits for the cluster
 *   lock while other runs migrate) fails the file, the `after` hook finds
 *   nothing to close, and the setup then finishes on its own: its pools,
 *   servers and loops keep the process alive;
 * - an `after` hook that fails or times out skips the hooks after it, and what
 *   they would have closed stays open.
 * `keep` closes at once what arrives after the teardown; `closeAll` tries
 * every close, each with a time limit, whatever happened to the ones before.
 */
export interface Teardown {
  /** Keeps `resource` for `closeAll`; after it, closes `resource` at once and throws. */
  keep<T>(resource: T, close: (resource: T) => Promise<void> | void): Promise<T>;
  /** Closes everything kept, the last kept first; throws the failures once all were tried. */
  closeAll(): Promise<void>;
}

/** Time a single close may take before the next one is tried. */
const CLOSE_MS = 30_000;

async function closeWithin(close: () => Promise<void> | void, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`a close took more than ${String(ms)} ms`));
    }, ms);
    // The limit itself must not keep the process alive.
    timer.unref();
  });
  try {
    await Promise.race([Promise.resolve().then(close), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createTeardown(closeMs = CLOSE_MS): Teardown {
  const kept: (() => Promise<void> | void)[] = [];
  let closed = false;
  return {
    async keep(resource, close) {
      if (closed) {
        await closeWithin(() => close(resource), closeMs).catch(() => undefined);
        throw new Error('the setup finished after the teardown: closed what it opened');
      }
      kept.push(() => close(resource));
      return resource;
    },
    async closeAll() {
      closed = true;
      const errors: unknown[] = [];
      for (const close of kept.splice(0).reverse()) {
        try {
          await closeWithin(close, closeMs);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'some closes failed');
    },
  };
}
