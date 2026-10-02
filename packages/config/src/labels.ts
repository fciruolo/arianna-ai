import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLabelRules, LABELS, PolicyError, type LabelRules } from '@arianna/policy';
import { parse as parseToml } from 'smol-toml';

import { resolveHome } from './home.ts';
import { asArray, asOneOf, asString, asTable, ConfigError, onlyKeys } from './validate.ts';

export const LABELS_FILE = join('config', 'labels.toml');

/** Parses `labels.toml`; the rules themselves are validated by `@arianna/policy`. */
export function parseLabelRules(text: string): LabelRules {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ConfigError(`labels.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = asTable(raw, 'labels.toml');
  onlyKeys(root, ['folder', 'source'], 'labels.toml');

  const folders = asArray(root.folder ?? [], 'folder').map((entry, index) => {
    const where = `folder[${String(index)}]`;
    const table = asTable(entry, where);
    onlyKeys(table, ['path', 'label'], where);
    return {
      path: asString(table.path, `${where}.path`),
      label: asOneOf(table.label, LABELS, `${where}.label`),
    };
  });

  const sources = asArray(root.source ?? [], 'source').map((entry, index) => {
    const where = `source[${String(index)}]`;
    const table = asTable(entry, where);
    onlyKeys(table, ['name', 'label'], where);
    return {
      name: asString(table.name, `${where}.name`),
      label: asOneOf(table.label, LABELS, `${where}.label`),
    };
  });

  try {
    return createLabelRules({ folders, sources });
  } catch (error) {
    if (error instanceof PolicyError) throw new ConfigError(`labels.toml: ${error.message}`);
    throw error;
  }
}

/** Reads `config/labels.toml` from ARIANNA_HOME. A missing file is an error, not an empty rule set. */
export function loadLabelRules(env: NodeJS.ProcessEnv = process.env): LabelRules {
  return parseLabelRules(readFileSync(join(resolveHome(env), LABELS_FILE), 'utf8'));
}
