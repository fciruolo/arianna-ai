// Labels from folder and source rules (config/labels.toml, docs/PRIVACY-POLICY-SPEC.md).
import { posix } from 'node:path';

import { PolicyError } from './errors.ts';
import { isLabel, maxLabel, type Label } from './labels.ts';

export interface FolderRule {
  /** Relative to ARIANNA_HOME, with `/` separators. */
  path: string;
  label: Label;
}

export interface SourceRule {
  name: string;
  label: Label;
}

export interface LabelRules {
  readonly folders: readonly FolderRule[];
  readonly sources: readonly SourceRule[];
}

const DEFAULT: Label = 'L2';

/**
 * Normal form of a path relative to ARIANNA_HOME: NFC, no `.`, `..`, double or
 * trailing slashes. The empty string is home itself. Paths that are absolute
 * or leave home are rejected: there is no rule that could label them.
 */
function normalizePath(path: string, where: string): string {
  if (path === '') throw new PolicyError(`${where}: empty path`);
  const nfc = path.normalize('NFC');
  if (posix.isAbsolute(nfc)) throw new PolicyError(`${where}: absolute path ${JSON.stringify(path)}`);
  const normalized = posix.normalize(nfc).replace(/\/+$/, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new PolicyError(`${where}: ${JSON.stringify(path)} is outside ARIANNA_HOME`);
  }
  return normalized === '.' ? '' : normalized;
}

// Disks on macOS ignore letter case, Linux disks do not: a lookup must be safe on both.
// Upper then lower case also folds expansions such as ß -> ss and ﬀ -> ff.
function fold(path: string): string {
  return path.toUpperCase().toLowerCase();
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Label of the most specific folder rule containing `path`, L2 if none does. */
function mostSpecific(folders: readonly FolderRule[], path: string, key: (path: string) => string): Label {
  const target = key(path);
  let best: { length: number; label: Label } | undefined;
  for (const rule of folders) {
    // Compare lengths in the form being matched: folding can change them.
    const folder = key(rule.path);
    if (within(target, folder) && (best === undefined || folder.length > best.length)) {
      best = { length: folder.length, label: rule.label };
    }
  }
  return best?.label ?? DEFAULT;
}

/** Validates and normalizes rules. Order does not matter: the most specific folder wins. */
export function createLabelRules(input: { folders: readonly FolderRule[]; sources: readonly SourceRule[] }): LabelRules {
  const seenFolders = new Set<string>();
  const folders = input.folders.map((rule, index): FolderRule => {
    const where = `folder rule ${String(index + 1)}`;
    if (!isLabel(rule.label)) throw new PolicyError(`${where}: invalid label ${JSON.stringify(rule.label)}`);
    const path = normalizePath(rule.path, where);
    if (path === '') {
      throw new PolicyError(`${where}: a rule for all of ARIANNA_HOME would switch off default-deny`);
    }
    if (seenFolders.has(fold(path))) throw new PolicyError(`${where}: duplicate rule for ${JSON.stringify(path)}`);
    seenFolders.add(fold(path));
    return { path, label: rule.label };
  });

  const seenSources = new Set<string>();
  const sources = input.sources.map((rule, index): SourceRule => {
    const where = `source rule ${String(index + 1)}`;
    if (!isLabel(rule.label)) throw new PolicyError(`${where}: invalid label ${JSON.stringify(rule.label)}`);
    if (rule.name === '') throw new PolicyError(`${where}: empty name`);
    if (seenSources.has(rule.name)) throw new PolicyError(`${where}: duplicate rule for ${JSON.stringify(rule.name)}`);
    seenSources.add(rule.name);
    return { name: rule.name, label: rule.label };
  });

  return Object.freeze({ folders: Object.freeze(folders), sources: Object.freeze(sources) });
}

/**
 * Label of a file from the folder rules; L2 when no rule contains it (default-deny).
 * `path` is relative to ARIANNA_HOME. Symbolic links are not followed here: the
 * caller labels the path it actually reads.
 *
 * The lookup runs twice, matching letter case exactly and ignoring it, and keeps
 * the higher label: a different spelling can raise a label, never lower it.
 *
 * A `..` segment is rejected: after a symbolic link it points somewhere the
 * text of the path does not show. A real path (`realpath`) never contains one.
 */
export function labelForPath(rules: LabelRules, path: string): Label {
  if (path.split('/').includes('..')) {
    throw new PolicyError(`path: ${JSON.stringify(path)} has a ".." segment, label the real path instead`);
  }
  const normalized = normalizePath(path, 'path');
  return maxLabel(
    mostSpecific(rules.folders, normalized, (p) => p),
    mostSpecific(rules.folders, normalized, fold),
  );
}

/**
 * Label of a KB page: the header (`label:`) can raise the folder label, never
 * lower it. `declared` is undefined or null when the page has no header label.
 * A header that is present but not a valid label (`l3`, `L3 `) counts as L3:
 * the author meant some label, and reading it as L2 could downgrade a secret.
 */
export function labelForKbPage(rules: LabelRules, path: string, declared: unknown): Label {
  const folder = labelForPath(rules, path);
  if (declared === undefined || declared === null) return folder;
  return maxLabel(folder, isLabel(declared) ? declared : 'L3');
}

/** Label of data from a source (e.g. `web`, `mail`); L2 for a source without a rule. */
export function labelForSource(rules: LabelRules, name: string): Label {
  return rules.sources.find((rule) => rule.name === name)?.label ?? DEFAULT;
}
