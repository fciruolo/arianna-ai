// Texts of the adopted catalogs that the second scanner does not read (D-250,
// correcting D-113): the block of skills and styles the core writes for an
// agent from the files of Open Design and of the followed skill repositories.
// Public text of third parties, downloaded at a known commit, never written by
// the user: Rizzo-PII took brand names in it («xAI», «Stripe», «Figma») for
// persons and stopped every brief that carried the style.
//
// Recognized by content, never by source or label alone: the core marks the
// exact text it composed, with the source of the fragment it goes in, and the
// gateway skips the second scanner only for a fragment whose source, label L0
// and exact text were marked. One character more, another source, another
// label: read as before. Every other rule of the gateway (scanner, vault,
// labels, finance) reads these fragments as always.
import { PolicyError } from './errors.ts';
import { sha256Hex } from './payload.ts';

/** The source of the skills block of an agent (`skills:<agent>`), the only one a catalog text may go in. */
export const CATALOG_SOURCE = /^skills:[a-z0-9][a-z0-9_-]{0,63}$/;

/** Marks kept: the oldest is forgotten first. A brief passes the gateway right after its block is written. */
export const MAX_CATALOG_TEXTS = 1024;

/** Hashes of `source NUL text`, in the order they were marked (a Set keeps it). */
const marked = new Set<string>();

function keyOf(source: string, text: string): string {
  return sha256Hex(`${source}\u0000${text}`);
}

/**
 * Marks `text` as composed by the core from the adopted catalogs, for the
 * fragment of `source` alone. Only the code that read the catalog files calls
 * it, with the block exactly as it will be sent.
 */
export function markCatalogText(source: string, text: string): void {
  if (typeof source !== 'string' || !CATALOG_SOURCE.test(source)) throw new PolicyError('markCatalogText: not the source of a skills block');
  if (typeof text !== 'string' || text === '') throw new PolicyError('markCatalogText: no text');
  const key = keyOf(source, text);
  // Marked again: it becomes the newest.
  marked.delete(key);
  marked.add(key);
  while (marked.size > MAX_CATALOG_TEXTS) {
    const oldest = marked.values().next().value;
    if (oldest === undefined) break;
    marked.delete(oldest);
  }
}

/** Every mark forgotten: for tests. */
export function forgetCatalogTexts(): void {
  marked.clear();
}

/** Whether this fragment is a marked catalog text: its source, label L0, a string value equal to the marked text. */
export function isCatalogFragment(fragment: unknown): boolean {
  if (typeof fragment !== 'object' || fragment === null) return false;
  const { value, label, source } = fragment as { value?: unknown; label?: unknown; source?: unknown };
  if (typeof source !== 'string' || !CATALOG_SOURCE.test(source) || label !== 'L0' || typeof value !== 'string' || value === '') return false;
  return marked.has(keyOf(source, value));
}

/** By position, the fragments the second scanner does not read (D-250). */
export function piiExemptions(payload: readonly unknown[]): boolean[] {
  return Array.isArray(payload) ? payload.map(isCatalogFragment) : [];
}

/** The texts the second scanner reads: an exempt fragment as an empty text, so positions stay. */
export function piiScanTexts(texts: readonly string[], exempt: readonly boolean[]): string[] {
  return texts.map((text, index) => (exempt[index] === true ? '' : text));
}
