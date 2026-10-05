import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalCase } from './types.ts';

export class CaseFileError extends Error {
  override name = 'CaseFileError';
}

function parseCase(line: string, where: string): EvalCase {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new CaseFileError(`${where}: not valid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CaseFileError(`${where}: expected an object`);
  }
  const { id, input, expect, tags, ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new CaseFileError(`${where}: unknown key(s) ${extra.join(', ')}`);
  if (typeof id !== 'string' || id === '') throw new CaseFileError(`${where}: "id" is required`);
  if (input === undefined) throw new CaseFileError(`${where}: "input" is required`);
  if (expect === undefined) throw new CaseFileError(`${where}: "expect" is required`);
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    throw new CaseFileError(`${where}: "tags" must be a list of strings`);
  }
  return { id, input, expect, tags };
}

/** Parses JSONL: one case per line, blank lines ignored. */
export function parseCases(text: string, file: string): EvalCase[] {
  return text.split('\n').flatMap((line, index) => {
    return line.trim() === '' ? [] : [parseCase(line, `${file}:${String(index + 1)}`)];
  });
}

/** Loads every `*.jsonl` file of a group folder; a missing folder means no cases. */
export function loadCases(groupDir: string): EvalCase[] {
  if (!existsSync(groupDir)) return [];
  const cases = readdirSync(groupDir)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .flatMap((file) => parseCases(readFileSync(join(groupDir, file), 'utf8'), file));

  const ids = cases.map((evalCase) => evalCase.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new CaseFileError(`${groupDir}: duplicate id ${duplicate}`);
  return cases;
}

/**
 * sha256 of the `*.jsonl` files of a group folder, names and contents in name
 * order: which cases a stored result was measured on (D-081). A missing folder
 * has the fingerprint of no files.
 */
export function casesFingerprint(groupDir: string): string {
  const hash = createHash('sha256');
  const files = existsSync(groupDir) ? readdirSync(groupDir).filter((file) => file.endsWith('.jsonl')).sort() : [];
  for (const file of files) {
    const body = readFileSync(join(groupDir, file));
    hash.update(`${file}\n${String(body.length)}\n`);
    hash.update(body);
  }
  return hash.digest('hex');
}
