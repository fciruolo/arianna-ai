import { randomBytes } from 'node:crypto';

import type { Sql } from '../../src/db/client.ts';

/** A string no other row holds: written everywhere an incognito conversation writes text (D-136). */
export function newCanary(): string {
  return `canarino${randomBytes(8).toString('hex')}`;
}

/**
 * Every text, varchar, json, jsonb or text[] column of the test schema that
 * holds `canary` somewhere, as `table.column`. The list of columns comes from
 * information_schema, so a table added later is scanned too.
 */
export async function canaryPlaces(owner: Sql, schema: string, canary: string): Promise<string[]> {
  const columns = await owner<{ table: string; column: string }[]>`
    SELECT c.table_name AS table, c.column_name AS column
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = ${schema} AND t.table_type = 'BASE TABLE'
      AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR c.udt_name IN ('_text', '_varchar', '_jsonb'))
    ORDER BY c.table_name, c.column_name`;
  if (columns.length === 0) throw new Error('no text column found: wrong schema?');
  const places: string[] = [];
  for (const { table, column } of columns) {
    const [row] = await owner.unsafe<{ found: boolean }[]>(
      `SELECT EXISTS (SELECT FROM "${table}" WHERE "${column}"::text LIKE $1) AS found`,
      [`%${canary}%`],
    );
    if (row?.found === true) places.push(`${table}.${column}`);
  }
  return places;
}
