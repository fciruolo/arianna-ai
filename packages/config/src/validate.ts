export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Table = Record<string, unknown>;

export function asTable(value: unknown, where: string): Table {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where}: expected a table`);
  }
  return value as Table;
}

/** Unknown keys are rejected so that typos never become silent defaults. */
export function onlyKeys(table: Table, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(table).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${where}: unknown key(s) ${unknown.join(', ')}`);
  }
}

export function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`${where}: expected a non-empty string`);
  }
  return value;
}

export function asInteger(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${where}: expected an integer between ${String(min)} and ${String(max)}`);
  }
  return value;
}

export function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError(`${where}: expected a list`);
  return value as unknown[];
}

export function asOneOf<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new ConfigError(`${where}: expected one of ${allowed.join(', ')}`);
  }
  return found;
}
