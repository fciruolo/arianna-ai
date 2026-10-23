import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { listFiles, ROOT } from './support/files.ts';

// D-301: eslint.config.js turns @typescript-eslint/no-unsafe-enum-assignment off outside apps/hud. That is safe
// only while no enum type can reach that code: our own sources cannot declare one (erasableSyntaxOnly), so
// this test follows every package that code imports, with the packages their types import in turn, and
// fails when one of them declares an enum. Then the rule's block in eslint.config.js must go.
// This file imports typescript, which has enums: eslint.config.js keeps the rule on here.
const SELF = 'test/lint-scope.test.ts';

// Declarations only, at the start of a line or after `;`, `{` or `}` (minified .d.ts): JSDoc lines start
// with `*`, so a comment that mentions an enum does not match.
const ENUM = /(?:^|[;{}])\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m;

/** Every module a source imports, re-exports, loads with import() or references with `/// <reference types>`. */
export function importedModules(source: string): string[] {
  const info = ts.preProcessFile(source, true, true);
  return [...info.importedFiles, ...info.typeReferenceDirectives].map((ref) => ref.fileName);
}

/** The package a bare specifier names, or null for node: builtins, the workspace packages outside the web chat and paths. */
export function externalPackage(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  if (specifier.startsWith('@arianna/') && specifier !== '@arianna/hud' && !specifier.startsWith('@arianna/hud/')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The real folder of a package as Node would find it from `fromDir`, or null when it is not installed there. */
function packageDir(name: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

function declarationFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return declarationFiles(path);
    return /\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

/** Packages that declare an enum in their types, among `roots` (resolved from `fromDir`) and the packages their types import. */
function packagesWithEnums(roots: Iterable<string>, fromDir: string): string[] {
  const pending = [...roots].map((name) => ({ name, fromDir }));
  const seen = new Set<string>();
  const offenders: string[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    // A package without its own types gets them from @types (ws), so both are read when present.
    const typesName = next.name.startsWith('@') ? `@types/${next.name.slice(1).replace('/', '__')}` : `@types/${next.name}`;
    for (const name of next.name.startsWith('@types/') ? [next.name] : [next.name, typesName]) {
      const dir = packageDir(name, next.fromDir);
      if (dir === null || seen.has(dir)) continue;
      seen.add(dir);
      for (const file of declarationFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        if (ENUM.test(source)) offenders.push(`${name}: ${file.slice(dir.length + 1)}`);
        for (const specifier of importedModules(source)) {
          const imported = externalPackage(specifier);
          if (imported !== null) pending.push({ name: imported, fromDir: dir });
        }
      }
    }
  }
  return offenders;
}

test('importedModules finds every kind of import, and not the ones in strings', () => {
  const source = [
    '/// <reference types="m0" />',
    'import {',
    "  a, // it's",
    "} from 'm1';",
    "type T = typeof import ('m2');",
    "const x = 1; await import('m3');",
    "export * from 'm4';",
    "import type { Y } from 'm5';",
    'const s = "import z from \'not-a-module\'";',
  ].join('\n');
  assert.deepEqual(importedModules(source).sort(), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
});

test('externalPackage keeps external packages and the web chat, and skips builtins, workspace packages and paths', () => {
  assert.equal(externalPackage('three/addons/controls.js'), 'three');
  assert.equal(externalPackage('@vue/shared/dist'), '@vue/shared');
  assert.equal(externalPackage('@arianna/hud'), '@arianna/hud');
  for (const specifier of ['node:path', '@arianna/policy', './x.ts', '../../hud/src/lib/themes.ts']) assert.equal(externalPackage(specifier), null);
});

test('packagesWithEnums sees an enum in the types a package re-exports, and none in an enum-free package', () => {
  // vue's own types have no enum, but they re-export @vue/shared and @vue/runtime-core, which do.
  assert.notDeepEqual(packagesWithEnums(['vue'], join(ROOT, 'apps', 'hud')), []);
  assert.deepEqual(packagesWithEnums(['smol-toml'], join(ROOT, 'packages', 'config')), []);
});

// The web chat files that code outside it imports (characters, src/lib) bring their own imports along.
test('no enum type reaches the code outside the web chat (D-301)', () => {
  const pending = listFiles().filter((file) => /\.[cm]?ts$/.test(file) && !file.startsWith('apps/hud/') && file !== SELF);
  const seen = new Set(pending);
  const packages = new Map<string, Set<string>>();
  const missing: string[] = [];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (!existsSync(join(ROOT, file))) {
      missing.push(file);
      continue;
    }
    for (const specifier of importedModules(readFileSync(join(ROOT, file), 'utf8'))) {
      const name = externalPackage(specifier);
      if (name !== null) {
        const from = dirname(join(ROOT, file));
        const names = packages.get(from) ?? new Set<string>();
        packages.set(from, names.add(name));
      } else if (specifier.startsWith('.')) {
        const target = posix.join(posix.dirname(file), specifier);
        if (/\.[cm]?ts$/.test(target) && !seen.has(target)) {
          seen.add(target);
          pending.push(target);
        }
      }
    }
  }
  assert.deepEqual(missing, [], 'relative imports of files that do not exist');
  // @types/node is global (tsconfig "types"): it counts as imported everywhere.
  const offenders = [...packagesWithEnums(['@types/node'], ROOT), ...[...packages].flatMap(([from, names]) => packagesWithEnums(names, from))];
  assert.deepEqual([...new Set(offenders)], []);
});
