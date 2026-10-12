import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CloudTextError, type AskCloudText } from './cloud-text.ts';

/**
 * The examples of the styles of Open Design (I-20, D-185, choice of the
 * user): for each style a landing page and a presentation of three slides,
 * written by Claude Sonnet without tools from the DESIGN.md (public text),
 * kept in data/catalogs/open-design.examples/<slug>/ with the sha256 of the
 * DESIGN.md they were made from. Made on request (one style) or for all the
 * missing ones, one at a time in the background; a style whose DESIGN.md did
 * not change is never made again. The pages are shown only in the isolated
 * frames of the Studio (no network, no access to the chat).
 */

export const EXAMPLES_DIR = 'open-design.examples';
/** Largest page kept: the Studio frames take 3 MiB, a page is much less. */
export const MAX_EXAMPLE_BYTES = 400 * 1024;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export type ExampleKind = 'landing' | 'deck';

/** What Sonnet reads first: our fixed instructions, L0. */
export const EXAMPLE_PROMPT = [
  'You write two example pages that show a visual design system, for a gallery where a user compares styles before choosing one.',
  'Follow the design system below closely: its colors, typography, spacing, corners, components and mood. Use realistic invented content for a fictional small Italian company (text in Italian), never a real brand name.',
  'Rules for both pages: one self-contained HTML document each, with inline <style> only; no external resources at all (no links to fonts, CDNs, images or scripts: the pages are shown offline); no JavaScript; no <img> with a URL: draw any illustration with CSS or inline SVG; fonts by name with good system fallbacks.',
  'Page 1, a landing page: header with navigation, a large hero with a call to action, a section of three features as cards, a pricing or highlights section, a footer.',
  'Page 2, a presentation of exactly three slides: each slide is a <section data-slide> filling the viewport (16:9), with a title in <h1> or <h2>; slide 1 is the cover, slide 2 has bullet points, slide 3 has a few figures or a closing message.',
  'Answer with exactly this format and nothing else:',
  '=====LANDING=====',
  '<the whole HTML of page 1>',
  '=====DECK=====',
  '<the whole HTML of page 2>',
].join('\n');

export interface ExampleMeta {
  sha256: string;
  at: string;
}

export interface ExamplesStatus {
  /** By slug: the examples kept, with the sha256 of the DESIGN.md they come from and whether it is still the current one. */
  examples: Record<string, ExampleMeta & { current: boolean }>;
  queue: string[];
  running: string | null;
  /** The last failure by slug, in words. */
  failed: Record<string, string>;
  /** Why the queue stopped (Claude out of quota), or null. */
  stopped: string | null;
}

export interface ExampleSource {
  list(): { styles: readonly { slug: string }[] };
  styleText(slug: string): { text: string };
}

export interface StyleExamples {
  status(): ExamplesStatus;
  /** Queues one style (again only if its DESIGN.md changed, or with `force`). */
  generate(slug: unknown): ExamplesStatus;
  /** Queues every style without a current example. */
  generateMissing(): ExamplesStatus;
  read(slug: unknown, kind: unknown): string;
  /** The background work, for the tests. */
  idle(): Promise<void>;
}

export class StyleExampleError extends Error {
  override name = 'StyleExampleError';
  readonly code: 'invalid' | 'not-found';

  constructor(code: StyleExampleError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** One page as Sonnet wrote it, checked: a whole HTML document, no resource from the network, not too large. */
export function checkedPage(raw: string): string | undefined {
  const page = raw
    .trim()
    .replace(/^```(?:html)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim()
    // What a model adds out of habit (a font from a CDN, a small script) goes: the page stays, without it.
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/@import[^;]*;/gi, '')
    // A link of the invented page to a site goes nowhere.
    .replace(/\bhref\s*=\s*(["'])\s*(?:https?:|\/\/)[^"']*\1/gi, 'href="#"');
  if (!/^(<!doctype html[^>]*>\s*)?<html[\s>]/i.test(page) || !/<\/html>\s*$/i.test(page)) return undefined;
  if (Buffer.byteLength(page) > MAX_EXAMPLE_BYTES) return undefined;
  // The frames block the network anyway; a page that still asks for it is not what was asked.
  if (/<(?:script|iframe|object|embed|base)\b|\bon[a-z]+\s*=|\b(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)|url\(\s*["']?\s*(?:https?:|\/\/)/i.test(page)) return undefined;
  return page;
}

/** The two pages of an answer, or undefined when it is not in the format. */
export function parseExamples(answer: string): { landing: string; deck: string } | undefined {
  const match = /=====LANDING=====\s*([\s\S]*?)\s*=====DECK=====\s*([\s\S]*)$/.exec(answer);
  if (match === null) return undefined;
  const landing = checkedPage(match[1] ?? '');
  const deck = checkedPage(match[2] ?? '');
  if (landing === undefined || deck === undefined || !/<section\b[^>]*\bdata-slide\b/i.test(deck)) return undefined;
  return { landing, deck };
}

export function createStyleExamples(options: { dir: string; source: ExampleSource; ask: AskCloudText; onEvent?: (kind: string, payload: Record<string, string | number>) => void }): StyleExamples {
  const root = join(options.dir, EXAMPLES_DIR);
  const queue: string[] = [];
  const failed = new Map<string, string>();
  let running: string | null = null;
  let stopped: string | null = null;
  let work: Promise<void> = Promise.resolve();

  const folderOf = (slug: string): string => join(root, slug);

  function metaOf(slug: string): ExampleMeta | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(folderOf(slug), 'meta.json'), 'utf8')) as Partial<ExampleMeta>;
      return typeof parsed.sha256 === 'string' && typeof parsed.at === 'string' ? { sha256: parsed.sha256, at: parsed.at } : undefined;
    } catch {
      return undefined;
    }
  }

  function currentSha(slug: string): string | undefined {
    try {
      return sha256(options.source.styleText(slug).text);
    } catch {
      return undefined;
    }
  }

  function isCurrent(slug: string): boolean {
    const meta = metaOf(slug);
    return meta !== undefined && meta.sha256 === currentSha(slug);
  }

  function status(): ExamplesStatus {
    const examples: ExamplesStatus['examples'] = {};
    for (const { slug } of options.source.list().styles) {
      const meta = metaOf(slug);
      if (meta !== undefined) examples[slug] = { ...meta, current: meta.sha256 === currentSha(slug) };
    }
    return { examples, queue: [...queue], running, failed: Object.fromEntries(failed), stopped };
  }

  function known(slug: unknown): string {
    if (typeof slug !== 'string' || !SLUG.test(slug)) throw new StyleExampleError('invalid', 'invalid style');
    if (!options.source.list().styles.some((style) => style.slug === slug)) throw new StyleExampleError('not-found', 'no such style in the catalog');
    return slug;
  }

  async function make(slug: string): Promise<void> {
    const text = options.source.styleText(slug).text;
    const answer = await options.ask({
      parts: [
        { text: EXAMPLE_PROMPT, source: 'arianna:style-example' },
        { text, source: `open-design:style:${slug}` },
      ],
      purpose: `esempio dello stile ${slug} di Open Design`,
    });
    const pages = parseExamples(answer);
    if (pages === undefined) throw new Error('la risposta non era nel formato chiesto o chiedeva risorse dalla rete');
    // Written aside, then swapped in: a half-written example is never shown.
    mkdirSync(root, { recursive: true });
    const temporary = join(root, `.${slug}.${String(Date.now())}`);
    mkdirSync(temporary);
    try {
      writeFileSync(join(temporary, 'landing.html'), pages.landing);
      writeFileSync(join(temporary, 'deck.html'), pages.deck);
      writeFileSync(join(temporary, 'meta.json'), `${JSON.stringify({ sha256: sha256(text), at: new Date().toISOString() })}\n`);
      rmSync(folderOf(slug), { recursive: true, force: true });
      renameSync(temporary, folderOf(slug));
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    options.onEvent?.('design.example', { style: slug, landing: pages.landing.length, deck: pages.deck.length });
  }

  function pump(): void {
    if (running !== null) return;
    const next = queue.shift();
    if (next === undefined) return;
    running = next;
    work = make(next)
      .then(
        () => {
          failed.delete(next);
        },
        (error: unknown) => {
          failed.set(next, error instanceof Error ? error.message : 'errore');
          // Out of quota: the rest waits for the user, it would only fail too.
          if (error instanceof CloudTextError && (error.code === 'quota' || error.code === 'unavailable')) {
            stopped = error.message;
            queue.length = 0;
          }
        },
      )
      .finally(() => {
        running = null;
        pump();
      });
  }

  function enqueue(slugs: readonly string[]): void {
    stopped = null;
    for (const slug of slugs) if (slug !== running && !queue.includes(slug)) queue.push(slug);
    pump();
  }

  return {
    status,
    generate(raw) {
      enqueue([known(raw)]);
      return status();
    },
    generateMissing() {
      enqueue(options.source.list().styles.map((style) => style.slug).filter((slug) => !isCurrent(slug)));
      return status();
    },
    read(raw, kind) {
      const slug = known(raw);
      if (kind !== 'landing' && kind !== 'deck') throw new StyleExampleError('invalid', 'kind must be landing or deck');
      const path = join(folderOf(slug), `${kind}.html`);
      const stats = (() => {
        try {
          return lstatSync(path);
        } catch {
          return undefined;
        }
      })();
      if (stats?.isFile() !== true || stats.size > MAX_EXAMPLE_BYTES) throw new StyleExampleError('not-found', 'no example for this style yet');
      return readFileSync(path, 'utf8');
    },
    async idle() {
      while (running !== null || queue.length > 0) await work;
    },
  };
}
