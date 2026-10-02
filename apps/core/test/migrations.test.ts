import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { loadMigrations, MigrationError } from '../src/db/migrate.ts';

// Scratch folder inside data/ (never in git), removed after each test.
function withMigrationFiles(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
  mkdirSync(dir, { recursive: true });
  try {
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test('the committed migrations load in version order', () => {
  const migrations = loadMigrations();
  assert.ok(migrations.length > 0);
  assert.equal(migrations[0]?.version, '0001');
  const versions = migrations.map((migration) => migration.version);
  assert.deepEqual(versions, versions.toSorted());
});

test('migrations are sorted by version and fingerprinted', () => {
  const files = { '0002_second.sql': 'SELECT 2;', '0001_first.sql': 'SELECT 1;' };
  withMigrationFiles(files, (dir) => {
    const migrations = loadMigrations(dir);
    assert.deepEqual(
      migrations.map((migration) => [migration.version, migration.name]),
      [
        ['0001', 'first'],
        ['0002', 'second'],
      ],
    );
    assert.match(migrations[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(migrations[0]?.sha256, migrations[1]?.sha256);
  });
});

test('files that are not migrations are ignored, badly named ones are rejected', () => {
  withMigrationFiles({ '0001_first.sql': 'SELECT 1;', 'README.md': 'notes' }, (dir) => {
    assert.equal(loadMigrations(dir).length, 1);
  });
  withMigrationFiles({ 'first.sql': 'SELECT 1;' }, (dir) => {
    assert.throws(() => loadMigrations(dir), MigrationError);
  });
});

test('a migration cannot end the transaction it runs in', () => {
  withMigrationFiles({ '0001_first.sql': 'CREATE TABLE a (id int);\nCOMMIT;\n' }, (dir) => {
    assert.throws(() => loadMigrations(dir), MigrationError);
  });
  // A plpgsql block uses BEGIN without a semicolon and is allowed.
  const block = 'DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\n';
  withMigrationFiles({ '0001_first.sql': block }, (dir) => {
    assert.equal(loadMigrations(dir).length, 1);
  });
});

test('two migrations with the same version are rejected', () => {
  withMigrationFiles({ '0001_first.sql': 'SELECT 1;', '0001_again.sql': 'SELECT 1;' }, (dir) => {
    assert.throws(() => loadMigrations(dir), MigrationError);
  });
});
