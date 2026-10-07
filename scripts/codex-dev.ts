// `pnpm dev:codex`: Codex CLI on the development of Arianna, in this folder
// (D-143). The binary reads the whole disk with its default modes (D-138):
// here it runs under a permission profile that opens the repository, keeps
// .git and the rules that confine the agents read only (commits are approved
// by the user, outside the sandbox), denies everything git ignores (data/,
// kb/inbox, config/arianna.toml, repos/…: unlabelled, so L2) except the build
// output and data/test-tmp for the tests, and reads only the toolchain besides. Codex
// asks before any command outside the sandbox (approval on request). The
// rules of the project come from AGENTS.md. Extra arguments go to `codex`,
// e.g. `pnpm dev:codex --model gpt-…`; `--print` only prints the arguments.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveHome } from '@arianna/config';
import { codexToolchain } from '@arianna/executors';

/** The name of the permission profile, on the command line only. */
const PROFILE = 'arianna-dev';

/** What confines the agents: Codex reads it, never rewrites it. */
export const READ_ONLY = ['.git', '.githooks', '.claude', 'CLAUDE.md', 'AGENTS.md'] as const;
/** Ignored by git but only build output: node_modules and the compiled chat stay open. */
const BUILD_OUTPUT = /(^|\/)(node_modules|dist)\/?$/;

/** The paths git ignores (`git status --ignored`, relative), the build output left out: each one is denied. */
export function ignoredPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3).replace(/\/$/, ''))
    .filter((path) => path !== '' && !BUILD_OUTPUT.test(path));
}

/** The filesystem table of the profile as an inline TOML table: the narrower rule wins. */
export function devFilesystem(home: string, readable: readonly string[], ignored: readonly string[]): string {
  const denied = new Set(['data', 'config/arianna.toml', ...ignored]);
  const entries: [string, string][] = [
    [':minimal', 'read'],
    ...readable.map((folder): [string, string] => [folder, 'read']),
    [home, 'write'],
    ...READ_ONLY.filter((path) => !denied.has(path)).map((path): [string, string] => [join(home, path), 'read']),
    ...[...denied].map((path): [string, string] => [join(home, path), 'deny']),
    [join(home, 'data', 'test-tmp'), 'write'],
  ];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new TypeError('codex-dev: a folder is listed twice');
  return `{${entries.map(([key, value]) => `"${key}"="${value}"`).join(', ')}}`;
}

/** The arguments of `codex`: the profile, approvals on request, no web search, the repository as working folder. */
export function devArgs(home: string, readable: readonly string[], ignored: readonly string[], extra: readonly string[]): string[] {
  return [
    '-c',
    `default_permissions="${PROFILE}"`,
    '-c',
    `permissions.${PROFILE}.filesystem=${devFilesystem(home, readable, ignored)}`,
    '-c',
    'approval_policy="on-request"',
    '-c',
    'web_search="disabled"',
    '--cd',
    home,
    ...extra,
  ];
}

function main(): void {
  const home = realpathSync(resolveHome(process.env));
  // pnpm comes through corepack, which keeps its copies here.
  const corepack = process.env.COREPACK_HOME ?? join(homedir(), '.cache', 'node', 'corepack');
  // The OpenSSL configuration node reads when pnpm loads crypto, next to the toolchain's prefix.
  const openssl = codexToolchain()
    .map((folder) => join(folder, '..', 'etc', 'openssl@3'))
    .concat(join(process.execPath, '..', '..', '..', '..', '..', 'etc', 'openssl@3'));
  const readable = [...new Set([...codexToolchain(), ...[corepack, ...openssl].filter((folder) => existsSync(folder)).map((folder) => realpathSync(folder))])];
  const extra = process.argv.slice(2).filter((arg) => arg !== '--print');
  const ignored = ignoredPaths(execFileSync('git', ['-C', home, 'status', '--ignored', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }));
  const args = devArgs(home, readable, ignored, extra);
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(args, null, 2));
    return;
  }
  const child = spawn('codex', args, { stdio: 'inherit', cwd: home });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (import.meta.main) main();
