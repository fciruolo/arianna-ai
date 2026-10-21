import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The image of the agent's browser (D-264). `pnpm browser:build` builds it
 * from apps/core/browser/Dockerfile and writes what it built in
 * config/browser-image.lock (outside git: the id of a local build differs
 * from one machine to another). The core runs only that id, never a tag, so
 * a tag moved by someone else is not picked up.
 */

export const BROWSER_IMAGE_LOCK = 'config/browser-image.lock';
export const BROWSER_SECCOMP = 'apps/core/browser/seccomp.json';
export const BROWSER_DOCKERFILE_DIR = 'apps/core/browser';
/** Images older than this are reported by the doctor: Debian moves Chromium every 2-4 weeks. */
export const BROWSER_IMAGE_MAX_AGE_DAYS = 30;

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export type BrowserImageLock = {
  /** Id of the built image, "sha256:<64 hex>". */
  image: string;
  /** When it was built, ISO 8601. */
  builtAt: string;
  /** Chromium version inside, e.g. "155.0.8059.79". */
  chromium: string;
  /** Date of the snapshot.debian.org archive, e.g. "20261020T000000Z". */
  snapshot: string;
  /** Base image by digest, as in the FROM line. */
  base: string;
};

export function isImageId(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_ID.test(value);
}

/** Checks the shape of a lock; anything else is no lock at all. */
export function parseBrowserImageLock(text: string): BrowserImageLock | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const lock = value as Record<string, unknown>;
  const { image, builtAt, chromium, snapshot, base } = lock;
  if (!isImageId(image)) return null;
  if (typeof builtAt !== 'string' || Number.isNaN(Date.parse(builtAt))) return null;
  if (typeof chromium !== 'string' || !/^\d+(\.\d+){1,3}$/.test(chromium)) return null;
  if (typeof snapshot !== 'string' || !/^\d{8}T\d{6}Z$/.test(snapshot)) return null;
  if (typeof base !== 'string' || !/^[a-z0-9./:-]+@sha256:[0-9a-f]{64}$/.test(base)) return null;
  return { image, builtAt, chromium, snapshot, base };
}

/** The lock of this installation, or null when it is missing or broken. */
export function readBrowserImageLock(home: string): BrowserImageLock | null {
  let text: string;
  try {
    text = readFileSync(join(home, BROWSER_IMAGE_LOCK), 'utf8');
  } catch {
    return null;
  }
  return parseBrowserImageLock(text);
}

export function browserSeccompPath(home: string): string {
  return join(home, BROWSER_SECCOMP);
}

/** Whole days since the build, for the doctor. */
export function browserImageAgeDays(lock: BrowserImageLock, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(lock.builtAt)) / 86_400_000);
}
