// Interactive Codex CLI on the development of Arianna, in the repository
// itself (`pnpm dev:codex`, D-143). The cloud executors are launched only from
// this package (CLAUDE.md): scripts/codex-dev.ts is a thin wrapper around
// `launchCodexDev`. The protections of the `codex exec` adapter (D-138) are
// reused where the interactive binary has them: the user's global instructions
// refuse the launch, `--strict-config`, the disabled features, no login shell,
// the core variables only in the shell, a clean environment, the verified
// version. Unlike the adapter the project's AGENTS.md is read (it carries the
// rules for Codex), so every file that could bend those rules is read only.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';

import { CODEX_DISABLED_FEATURES, codexEnv, userInstructionFiles } from './profile.ts';
import { codexSandboxFolders, codexToolchain } from './run.ts';

/** The version whose interactive options and permission profile were checked (D-143, with `codex sandbox`). */
export const CODEX_DEV_VERSION = '0.160.0';

/** The name of the permission profile, on the command line only. */
const PROFILE = 'arianna-dev';

/**
 * What confines the agents, or runs outside the sandbox when the user runs
 * `pnpm check` or a commit in a terminal: Codex reads it, never writes it,
 * whether it exists or not (a missing one cannot be created either).
 * `AGENTS.override.md` and `.codex/` would replace or extend the rules,
 * `CLAUDE.local.md` and `.mcp.json` those of Claude Code; `package.json`,
 * `.npmrc` and `eslint.config.js` decide what `pnpm check` runs.
 */
export const DEV_READ_ONLY = [
  '.git',
  '.githooks',
  '.claude',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  '.codex',
  '.agents',
  '.mcp.json',
  'package.json',
  '.npmrc',
  'eslint.config.js',
] as const;

/**
 * Denied whether they exist or not: they can appear while Codex runs (a note
 * captured in kb/inbox, a project's notes in kb/progetti, a model added from
 * Hugging Face), after `git status --ignored` has been read. The worktrees of
 * Claude Code's agents are other checkouts with their own data/, and git lists
 * them as untracked, not ignored.
 */
export const DEV_ALWAYS_DENIED = ['data', 'config/arianna.toml', 'config/models.user-catalog.yaml', 'kb/inbox', 'kb/progetti', 'repos', '.claude/worktrees'] as const;

/** Inside the denied data/: the tests write their temporary files here. */
const TEST_TMP = 'data/test-tmp';

/** Ignored by git but only build output: node_modules and the compiled chat stay open. */
const BUILD_OUTPUT = /(^|\/)(node_modules|dist)\/?$/;

/** The instruction files of Codex: outside the root AGENTS.md, none may exist in the repository. */
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'AGENTS.override.md']);

/** The paths git ignores, from `git status --ignored --porcelain -z` (relative), the build output left out: each one is denied. */
export function devIgnoredPaths(porcelainZ: string): string[] {
  return porcelainZ
    .split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3).replace(/\/$/, ''))
    .filter((path) => path !== '' && !BUILD_OUTPUT.test(path));
}

/**
 * Instruction files Codex would read besides the root AGENTS.md, from
 * `git ls-files -z --cached --others --exclude-standard`: the permission
 * profile has no patterns, so one in a subfolder is refused at launch instead.
 */
export function devStrayInstructionFiles(filesZ: string): string[] {
  return filesZ
    .split('\0')
    .filter((path) => path !== '' && path !== 'AGENTS.md' && (INSTRUCTION_FILES.has(posix.basename(path)) || path.startsWith('.codex/')));
}

/** A folder of the profile: absolute, normalized, not the root. Quotes and escapes are left to JSON.stringify. */
function checkFolder(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path === sep) throw new TypeError(`codex-dev: ${JSON.stringify(path)} must be an absolute, normalized folder other than the root`);
  return path;
}

/**
 * The filesystem table of the profile as an inline TOML table: the narrower
 * rule wins. Keys are JSON strings, which TOML reads as basic strings (a path
 * with a quote, a backslash or a control character stays one key).
 */
export function devFilesystem(home: string, readable: readonly string[], ignored: readonly string[]): string {
  checkFolder(home);
  const denied = new Set<string>([...DEV_ALWAYS_DENIED, ...ignored]);
  const entries: [string, string][] = [
    [':minimal', 'read'],
    ...readable.map((folder): [string, string] => [checkFolder(folder), 'read']),
    [home, 'write'],
    ...DEV_READ_ONLY.filter((path) => !denied.has(path)).map((path): [string, string] => [join(home, path), 'read']),
    ...[...denied].map((path): [string, string] => [join(home, path), 'deny']),
    [join(home, TEST_TMP), 'write'],
  ];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new TypeError('codex-dev: a folder is listed twice');
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(', ')}}`;
}

/** Same rule as MODEL_NAME of the claude profile: a model name, nothing that reads as an option. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The arguments the user may add: a model (`-m`, `--model`), `--no-alt-screen`
 * and a prompt, which goes after `--` so that it can never be read as a
 * subcommand (`exec`, `apply`, `mcp`…). Everything else is refused, the
 * dangerous ones first among them: the bypass of approvals and sandbox or of
 * the hooks' trust, `-s`/`--sandbox`, `--search`, `-p`/`--profile`,
 * `--add-dir`, `-c` (which could replace the permission profile or the
 * approvals).
 */
export function devExtraArgs(extra: readonly string[]): { options: string[]; prompt: string[] } {
  const options: string[] = [];
  const prompt: string[] = [];
  for (let index = 0; index < extra.length; index += 1) {
    const arg = extra[index] as string;
    if (arg === '-m' || arg === '--model') {
      const name = extra[index + 1];
      if (name === undefined || !MODEL.test(name)) throw new TypeError(`codex-dev: ${arg} vuole il nome di un modello`);
      options.push('--model', name);
      index += 1;
    } else if (arg.startsWith('--model=') && MODEL.test(arg.slice('--model='.length))) {
      options.push('--model', arg.slice('--model='.length));
    } else if (arg === '--no-alt-screen') {
      options.push(arg);
    } else if (!arg.startsWith('-') && prompt.length === 0) {
      prompt.push(arg);
    } else {
      throw new TypeError(`codex-dev: argomento non ammesso ${JSON.stringify(arg)}: si accettano solo --model <nome>, --no-alt-screen e un testo iniziale`);
    }
  }
  return { options, prompt: prompt.length === 0 ? [] : ['--', ...prompt] };
}

/**
 * The arguments of `codex`:
 * - the permission profile (`devFilesystem`), with no network table: commands
 *   have no network;
 * - `approval_policy="never"`: a command the sandbox refuses fails, nothing is
 *   proposed to run outside it. Code written by Codex would run there without
 *   the sandbox, and its output would go back to the cloud. `untrusted` is
 *   refused by 0.160.0 ("no longer supported");
 * - `--strict-config`: an unknown key, from `-c` too, fails the launch;
 * - the features of the adapter turned off, no login shell, the core
 *   variables only in the shell, git without the user's configuration, no web
 *   search, no update check, no analytics or feedback, no skills in the prompt.
 * Unlike the adapter: the user's `config.toml` is loaded (the interactive
 * binary has no `--ignore-user-config`) and the project's AGENTS.md is read.
 */
export function devArgs(home: string, readable: readonly string[], ignored: readonly string[], extra: readonly string[]): string[] {
  const { options, prompt } = devExtraArgs(extra);
  return [
    '--strict-config',
    '-c',
    `default_permissions="${PROFILE}"`,
    '-c',
    `permissions.${PROFILE}.filesystem=${devFilesystem(home, readable, ignored)}`,
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'allow_login_shell=false',
    '-c',
    'shell_environment_policy.inherit="core"',
    '-c',
    'shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1"}',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'skills.bundled.enabled=false',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'feedback.enabled=false',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--cd',
    home,
    ...options,
    ...prompt,
  ];
}

/** Terminal variables the interactive screen needs, besides those of `codexEnv`. */
const TERMINAL = ['TERM', 'COLORTERM', 'TERM_PROGRAM'] as const;

/** The environment of the binary: the adapter's clean one (no OPENAI_API_KEY, NODE_OPTIONS, proxies, CODEX_HOME), the terminal, git without the user's configuration. */
export function devEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env = codexEnv(from);
  for (const key of TERMINAL) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

/** `codex --version` output: `codex-cli 0.160.0`. */
export function devVersionOk(output: string): boolean {
  return output.trim() === `codex-cli ${CODEX_DEV_VERSION}`;
}

export interface CodexDevLaunch {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * Checks the machine and builds the launch; throws, with an Italian message,
 * what refuses it: another version of the binary, the user's global
 * instructions, instruction files in the repository besides the root
 * AGENTS.md, a readable folder that would open the user's files.
 */
export function codexDevLaunch(repository: string, extra: readonly string[], from: NodeJS.ProcessEnv = process.env): CodexDevLaunch {
  const home = realpathSync(repository);
  const env = devEnv(from);
  const userHome = from.HOME ?? '';
  let version: string;
  try {
    version = execFileSync('codex', ['--version'], { encoding: 'utf8', env });
  } catch (cause) {
    throw new Error('codex-dev: `codex` non si avvia (è installato e nel PATH?)', { cause });
  }
  if (!devVersionOk(version)) {
    throw new Error(`codex-dev: codex ${version.trim()} non è la versione verificata ${CODEX_DEV_VERSION}: va riverificato il profilo (D-143) prima di usarlo`);
  }
  if (userHome !== '' && userInstructionFiles(userHome).some((file) => existsSync(file))) {
    throw new Error("codex-dev: ci sono istruzioni globali di Codex nella cartella .codex della home (AGENTS.md o AGENTS.override.md): andrebbero nel prompt; spostale prima di lanciare");
  }
  const git = (args: string[]): string => execFileSync('git', ['-C', home, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const stray = devStrayInstructionFiles(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  // Untracked and ignored ones too: the root override and the project configuration of Codex.
  for (const name of ['AGENTS.override.md', '.codex']) if (existsSync(join(home, name)) && !stray.includes(name)) stray.push(name);
  if (stray.length > 0) {
    throw new Error(`codex-dev: file di istruzioni per Codex oltre ad AGENTS.md nella radice (${stray.join(', ')}): toglili prima di lanciare`);
  }
  const ignored = devIgnoredPaths(git(['status', '--ignored', '--porcelain', '-z', '--untracked-files=normal']));
  // pnpm comes through corepack, which keeps its copies in the home; the OpenSSL configuration node reads when pnpm loads crypto.
  const corepack = join(userHome, '.cache', 'node', 'corepack');
  const toolchain = codexToolchain(env);
  const openssl = [...toolchain.map((folder) => join(folder, '..', 'etc', 'openssl@3')), resolve(process.execPath, '..', '..', '..', '..', '..', 'etc', 'openssl@3')];
  const extraReadable = [corepack, ...openssl].filter((folder) => isAbsolute(folder) && existsSync(folder)).map((folder) => realpathSync(folder));
  // The adapter's check: no readable folder may open the user's files, the repository or a shared temp folder.
  const { readable } = codexSandboxFolders({ home, env, readable: [...new Set([...toolchain, ...extraReadable])] });
  const args = devArgs(home, readable, ignored, extra);
  // The tests write under data/test-tmp, inside the denied data/: made here, the sandbox could not.
  mkdirSync(join(home, TEST_TMP), { recursive: true });
  return { args, env, cwd: home };
}

/** Launches the interactive binary with the launch of `codexDevLaunch`, attached to the terminal. */
export function spawnCodexDev(launch: CodexDevLaunch): ChildProcess {
  return spawn('codex', launch.args, { stdio: 'inherit', cwd: launch.cwd, env: launch.env });
}
