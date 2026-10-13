// Interactive Codex CLI on the development of Arianna, in the repository
// itself (`pnpm dev:codex`, D-143). The cloud executors are launched only from
// this package (CLAUDE.md): scripts/codex-dev.ts is a thin wrapper around
// `codexDevLaunch` and `spawnCodexDev`. The protections of the `codex exec`
// adapter (D-138) are reused where the interactive binary has them: the
// user's global instructions refuse the launch, `--strict-config`, the
// disabled features, no login shell, the core variables only in the shell, a
// clean environment, the verified version. Unlike the adapter the user's
// config.toml is loaded (the interactive binary has no --ignore-user-config):
// what it could add is overridden or refuses the launch (`userConfigRefusals`).
// The project's AGENTS.md is read (it carries the rules for Codex), so the
// files that confine the agents are read only.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, posix, resolve, sep } from 'node:path';

import { parse } from 'smol-toml';

import { CODEX_DISABLED_FEATURES, codexEnv, userInstructionFiles } from './profile.ts';
import { codexSandboxFolders, codexToolchain } from './run.ts';

/** The version whose interactive options and permission profile were checked (D-143, with `codex sandbox`). */
export const CODEX_DEV_VERSION = '0.160.0';

/** The name of the permission profile, on the command line only. */
const PROFILE = 'arianna-dev';

/**
 * What confines the agents: Codex reads it, never writes it, whether it exists
 * or not (a missing one cannot be created either). `AGENTS.override.md`,
 * `.codex/` and `.agents/` would replace or extend the rules and skills of
 * Codex, `CLAUDE.local.md` and `.mcp.json` those of Claude Code, `.gitignore`
 * what the profile denies at the next launch; `package.json`, `.npmrc`,
 * `pnpm-workspace.yaml` and `eslint.config.js` are kept as they are because
 * the user reviews code, not tooling. This does not make `pnpm check` safe:
 * the tests and scripts Codex writes run outside the sandbox when the user
 * runs it, so the user reads Codex's diff first (AGENTS.md).
 */
export const DEV_READ_ONLY = [
  '.git',
  '.githooks',
  '.claude',
  '.gitignore',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  '.codex',
  '.agents',
  '.mcp.json',
  'package.json',
  '.npmrc',
  'pnpm-workspace.yaml',
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
/** The project configuration and the skills of Codex, at any depth. */
const CODEX_FOLDERS = /(^|\/)\.(codex|agents)\//;

/**
 * Keys of the user's `~/.codex/config.toml` that refuse the launch: they would
 * reach outside the profile (MCP servers, a notify program, another provider
 * or base URL, telemetry), add text to the prompt (instruction files), change
 * the permission profiles or the shell variables, or switch to a profile whose
 * values `-c` does not see. `developer_instructions` and `notify` are also
 * overridden with empty values, which `codex debug prompt-input` confirms for
 * the first.
 */
export const DEV_REFUSED_USER_KEYS = [
  'mcp_servers',
  'notify',
  'model_provider',
  'model_providers',
  'profile',
  'profiles',
  'model_instructions_file',
  'experimental_instructions_file',
  'instructions',
  'permissions',
  'sandbox_workspace_write',
  'shell_environment_policy',
  'otel',
  'chatgpt_base_url',
  'openai_base_url',
] as const;

/** The paths git ignores, from `git status --ignored --porcelain -z` (relative), the build output left out: each one is denied. */
export function devIgnoredPaths(porcelainZ: string): string[] {
  return porcelainZ
    .split('\0')
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3).replace(/\/$/, ''))
    .filter((path) => path !== '' && !BUILD_OUTPUT.test(path));
}

/**
 * Instruction files and folders Codex would read besides the root AGENTS.md,
 * from `git ls-files -z --cached --others --exclude-standard`: the permission
 * profile has no patterns, so one in a subfolder is refused at launch instead.
 */
export function devStrayInstructionFiles(filesZ: string): string[] {
  return filesZ.split('\0').filter((path) => path !== '' && path !== 'AGENTS.md' && (INSTRUCTION_FILES.has(posix.basename(path)) || CODEX_FOLDERS.test(path)));
}

/** The `.gitignore` files `git status --porcelain -z` shows changed or untracked: the denied paths come from them. */
export function devChangedGitignores(porcelainZ: string): string[] {
  return porcelainZ
    .split('\0')
    .filter((entry) => entry.length > 3 && !entry.startsWith('!! '))
    .map((entry) => entry.slice(3))
    .filter((path) => posix.basename(path) === '.gitignore');
}

/** The keys of the user's config.toml that refuse the launch (names only: the values are never returned). */
export function userConfigRefusals(text: string): string[] {
  let config: Record<string, unknown>;
  try {
    config = parse(text);
  } catch {
    return ['(config.toml non leggibile come TOML)'];
  }
  // The built-in provider of the subscription is the only one that passes.
  return DEV_REFUSED_USER_KEYS.filter((key) => key in config && !(key === 'model_provider' && config[key] === 'openai'));
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
 * `readOnly` adds paths found at launch (the nested `.gitignore` files).
 */
export function devFilesystem(home: string, readable: readonly string[], ignored: readonly string[], readOnly: readonly string[] = []): string {
  checkFolder(home);
  const denied = new Set<string>([...DEV_ALWAYS_DENIED, ...ignored]);
  const kept = [...new Set<string>([...DEV_READ_ONLY, ...readOnly])].filter((path) => !denied.has(path));
  const entries: [string, string][] = [
    [':minimal', 'read'],
    ...readable.map((folder): [string, string] => [checkFolder(folder), 'read']),
    [home, 'write'],
    ...kept.map((path): [string, string] => [join(home, path), 'read']),
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
 * The configuration options (`--strict-config` and `-c`), shared by the
 * launch and by the check of the MCP servers:
 * - the whole permission profile, filesystem (`devFilesystem`) and network
 *   (off: no network, loopback included), as one table; the user's config may
 *   not define `[permissions]` (`userConfigRefusals`), so nothing merges in;
 * - `approval_policy="never"`: a command the sandbox refuses fails, nothing is
 *   proposed to run outside it. Code written by Codex would run there without
 *   the sandbox, and its output would go back to the cloud. `untrusted` is
 *   refused by 0.160.0 ("no longer supported");
 * - `--strict-config`: an unknown key, from `-c` too, fails the launch;
 * - the features of the adapter turned off, no login shell, the core
 *   variables only in the shell, git without the user's configuration, no web
 *   search, no update check, no analytics or feedback, no skills in the
 *   prompt, no developer instructions nor notify program from the user's
 *   config.
 */
export function devConfigArgs(home: string, readable: readonly string[], ignored: readonly string[], readOnly: readonly string[] = []): string[] {
  return [
    '--strict-config',
    '-c',
    `default_permissions="${PROFILE}"`,
    '-c',
    `permissions.${PROFILE}={filesystem=${devFilesystem(home, readable, ignored, readOnly)}, network={enabled=false}}`,
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
    'developer_instructions=""',
    '-c',
    'notify=[]',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'feedback.enabled=false',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  ];
}

/** The arguments of the interactive `codex`: the configuration, the repository as working folder, the user's model and prompt. */
export function devArgs(home: string, readable: readonly string[], ignored: readonly string[], extra: readonly string[], readOnly: readonly string[] = []): string[] {
  const { options, prompt } = devExtraArgs(extra);
  return [...devConfigArgs(home, readable, ignored, readOnly), '--cd', home, ...options, ...prompt];
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

/** The MCP servers `codex mcp list --json` reports enabled (names only). */
export function devEnabledMcpServers(json: string): string[] {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return ['(elenco dei server MCP illeggibile)'];
  }
  if (!Array.isArray(list)) return ['(elenco dei server MCP illeggibile)'];
  return list.filter((server: { enabled?: unknown; name?: unknown }) => server.enabled !== false).map((server: { name?: unknown }) => String(server.name));
}

export interface CodexDevLaunch {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * Checks the machine and builds the launch, writing nothing; throws, with an
 * Italian message, what refuses it: another version of the binary, the user's
 * global instructions, refused keys of the user's config.toml or an enabled
 * MCP server, instruction files in the repository besides the root AGENTS.md,
 * a `.gitignore` changed or untracked against HEAD, a readable folder that
 * would open the user's files.
 */
export function codexDevLaunch(repository: string, extra: readonly string[], from: NodeJS.ProcessEnv = process.env): CodexDevLaunch {
  const home = realpathSync(repository);
  const env = devEnv(from);
  const userHome = from.HOME ?? '';
  const codex = (args: string[]): string => execFileSync('codex', args, { encoding: 'utf8', env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
  let version: string;
  try {
    version = codex(['--version']);
  } catch (cause) {
    throw new Error('codex-dev: `codex` non si avvia (è installato e nel PATH?)', { cause });
  }
  if (!devVersionOk(version)) {
    throw new Error(`codex-dev: codex ${version.trim()} non è la versione verificata ${CODEX_DEV_VERSION}: va riverificato il profilo (D-143) prima di usarlo`);
  }
  if (userHome !== '' && userInstructionFiles(userHome).some((file) => existsSync(file))) {
    throw new Error('codex-dev: ci sono istruzioni globali di Codex nella cartella .codex della home (AGENTS.md o AGENTS.override.md): andrebbero nel prompt; spostale prima di lanciare');
  }
  // CODEX_HOME is not passed on (codexEnv): the binary reads the config of HOME.
  const userConfig = join(userHome, '.codex', 'config.toml');
  if (userHome !== '' && existsSync(userConfig)) {
    const refused = userConfigRefusals(readFileSync(userConfig, 'utf8'));
    if (refused.length > 0) {
      throw new Error(`codex-dev: il config.toml di Codex nella home ha chiavi che uscirebbero dal profilo o cambierebbero le regole: ${refused.join(', ')}. Toglile (o spostale) prima di lanciare`);
    }
  }
  const git = (args: string[]): string => execFileSync('git', ['-C', home, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const stray = devStrayInstructionFiles(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  // Ignored or untracked ones too: the root override, the project configuration and skills of Codex.
  for (const name of ['AGENTS.override.md', '.codex', '.agents']) if (existsSync(join(home, name)) && !stray.some((path) => path === name || path.startsWith(`${name}/`))) stray.push(name);
  if (stray.length > 0) {
    throw new Error(`codex-dev: file di istruzioni per Codex oltre ad AGENTS.md nella radice (${stray.join(', ')}): toglili prima di lanciare`);
  }
  const gitignores = devChangedGitignores(git(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.gitignore', ':(glob)**/.gitignore']));
  if (gitignores.length > 0) {
    throw new Error(`codex-dev: ${gitignores.join(', ')} cambiato o non tracciato rispetto a HEAD: decide cosa il profilo nega, committalo o annullalo prima di lanciare`);
  }
  const nestedGitignores = git(['ls-files', '-z', '--', ':(glob)**/.gitignore'])
    .split('\0')
    .filter((path) => path !== '' && path !== '.gitignore');
  const ignored = devIgnoredPaths(git(['status', '--ignored', '--porcelain', '-z', '--untracked-files=normal']));
  // pnpm comes through corepack, which keeps its copies in the home.
  const corepack = join(userHome, '.cache', 'node', 'corepack');
  const toolchain = codexToolchain(env);
  // The OpenSSL configuration node reads when pnpm loads crypto: `<prefix>/etc/openssl@3` of Homebrew, next to the
  // toolchain's folders or five levels above the node binary (`<prefix>/Cellar/node@24/<version>/bin/node`).
  const openssl = [...toolchain.map((folder) => join(folder, '..', 'etc', 'openssl@3')), resolve(process.execPath, '..', '..', '..', '..', '..', 'etc', 'openssl@3')];
  const extraReadable = [corepack, ...openssl].filter((folder) => isAbsolute(folder) && existsSync(folder)).map((folder) => realpathSync(folder));
  // The adapter's check: no readable folder may open the user's files, the repository or a shared temp folder.
  const { readable } = codexSandboxFolders({ home, env, readable: [...new Set([...toolchain, ...extraReadable])] });
  // The MCP servers the binary would start, from every configuration layer it reads, with these options.
  // `codex mcp` refuses --strict-config: the launch itself checks the keys.
  let listed: string;
  try {
    listed = codex([...devConfigArgs(home, readable, ignored, nestedGitignores).slice(1), 'mcp', 'list', '--json']);
  } catch (cause) {
    throw new Error('codex-dev: `codex mcp list` non risponde: non posso verificare che non parta nessun server MCP', { cause });
  }
  const servers = devEnabledMcpServers(listed);
  if (servers.length > 0) {
    throw new Error(`codex-dev: Codex avvierebbe dei server MCP (${servers.join(', ')}): toglili dalla sua configurazione (mcp_servers) prima di lanciare`);
  }
  return { args: devArgs(home, readable, ignored, extra, nestedGitignores), env, cwd: home };
}

/** Launches the interactive binary with the launch of `codexDevLaunch`, attached to the terminal. */
export function spawnCodexDev(launch: CodexDevLaunch): ChildProcess {
  // The tests write under data/test-tmp, inside the denied data/: made here, the sandbox could not.
  mkdirSync(join(launch.cwd, TEST_TMP), { recursive: true });
  return spawn('codex', launch.args, { stdio: 'inherit', cwd: launch.cwd, env: launch.env });
}
