// The confinement profile of `codex exec` (docs/PRIVACY-POLICY-SPEC.md, task
// 1.16, D-138): the flags, the permission profile of the sandbox and the
// environment. Checked on `codex exec --help` of 0.160.0 and with real runs
// (`codex sandbox` for the filesystem and network rules); the live contract and
// canary evals check them again.
import { isAbsolute, join, resolve, sep } from 'node:path';

import { MODEL_NAME, SESSION_REF } from '../claude/profile.ts';

/** The one alias of the router for ChatGPT's coding model (D-137). */
/**
 * The router aliases of Codex's models (D-141), like sonnet, opus and fable
 * for Claude: the binary knows only exact names (`gpt-6.1-sol`), so every
 * launch gets one, from `[cloud.models]` or the cloud catalog.
 */
export const CODEX_MODELS = ['luna', 'sol', 'astra'] as const;
export type CodexModel = (typeof CODEX_MODELS)[number];

/**
 * What a run may do in its workspace. Codex has no list of tools to close: it
 * reads and writes through its shell and its patch tool, both inside the
 * sandbox, so the access is set by the permission profile. `read`: the
 * workspace is read only; `write`: read and write.
 */
export const CODEX_ACCESS = ['read', 'write'] as const;
export type CodexAccess = (typeof CODEX_ACCESS)[number];

/**
 * Features of the binary turned off at every launch: each one reaches outside
 * the sandbox or the user's profile (connectors, browser, computer use, image
 * generation, plugins, hooks, memories, sub-agents, the snapshot of the user's
 * login shell). Every name is checked by the binary: an unknown one fails the
 * launch.
 */
export const CODEX_DISABLED_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'hooks',
  'plugins',
  'remote_plugin',
  'multi_agent',
  'memories',
  'view_image',
  'skill_mcp_dependency_install',
  'skill_search',
  'tool_suggest',
  'shell_snapshot',
  'workspace_dependencies',
  'worktrees',
  'realtime_conversation',
  'goals',
] as const;

/** The name of the permission profile Arianna defines on the command line. */
const PERMISSIONS = 'arianna';

/** Absolute, real folders the permission profile names (see `codexFilesystem`). */
export interface CodexSandboxPaths {
  /** The working directory: readable, and writable with `write`, even inside a denied folder. */
  workspace: string;
  /** Read besides the workspace and the system folders: the toolchain and the binary. */
  readable: readonly string[];
  /** Never read nor written, even where the system folders would open them: ARIANNA_HOME and the shared temp folders. */
  denied: readonly string[];
}

export interface CodexProfileOptions {
  model: CodexModel;
  /** Passed to `--model` (`[cloud.models]` or the cloud catalog, D-071, D-141): required, and of the alias's family. */
  modelName?: string;
  access: CodexAccess;
  resume?: string;
  /**
   * False: `--ephemeral`, the binary keeps no session file in the user's
   * profile, and the run cannot be resumed (D-136, incognito). Default true.
   */
  persistSession?: boolean;
  sandbox: CodexSandboxPaths;
}

/** A TOML key: the folders are written as basic strings, so nothing that would need escaping passes (quotes, backslashes, control characters). */
function tomlSafe(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const unit = path.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f || unit === 0x22 || unit === 0x5c) return false;
  }
  return true;
}

function checkFolders(name: string, folders: unknown): readonly string[] {
  if (!Array.isArray(folders)) throw new TypeError(`codex: ${name} must be a list`);
  for (const path of folders as unknown[]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === sep || !tomlSafe(path)) {
      throw new TypeError(`codex: ${name} folder ${JSON.stringify(path)} must be an absolute, normalized folder other than the root, without quotes or control characters`);
    }
  }
  return folders as readonly string[];
}

/**
 * The filesystem table of the permission profile, as an inline TOML table:
 * - `:minimal` reads the system folders the binary and its shell need (`/usr`,
 *   `/bin`, `/etc`, `/System`, `/Applications`…), never the user folders
 *   (`/Users`, `/Volumes`) nor `/opt` or `/Library`;
 * - the workspace is opened (`read` or `write`), and `readable` (toolchain,
 *   the binary) for reading;
 * - `denied` closes ARIANNA_HOME and the shared temp folders, which `:minimal`
 *   would otherwise leave readable and writable (`/tmp`);
 * - with `write`, the workspace's `.git` stays read only, as in Codex's own
 *   `workspace-write`: its configuration and hooks run later outside the
 *   sandbox (Arianna commits the changes itself, `commitChanges`).
 * The narrower rule wins: a workspace inside ARIANNA_HOME stays open.
 */
export function codexFilesystem(paths: CodexSandboxPaths, access: CodexAccess): string {
  const [workspace] = checkFolders('workspace', [paths.workspace]);
  const readable = checkFolders('readable', paths.readable);
  const denied = checkFolders('denied', paths.denied);
  if (denied.length === 0) throw new TypeError('codex: the sandbox needs the folders to deny (ARIANNA_HOME at least)');
  if (!(CODEX_ACCESS as readonly unknown[]).includes(access)) throw new TypeError(`codex: unknown access ${JSON.stringify(access)}`);
  const entries: [string, string][] = [
    [':minimal', 'read'],
    ...readable.map((folder): [string, string] => [folder, 'read']),
    ...denied.map((folder): [string, string] => [folder, 'deny']),
    [workspace as string, access],
    ...(access === 'write' ? [[`${workspace as string}/.git`, 'read'] as [string, string]] : []),
  ];
  // Later keys would be duplicates: TOML refuses them, and the binary with it.
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new TypeError('codex: a sandbox folder is listed twice');
  return `{${entries.map(([key, value]) => `"${key}"="${value}"`).join(', ')}}`;
}

/**
 * The arguments of every launch. The prompt is not among them: `-` reads it
 * from stdin, where other users of the machine cannot read it with `ps`.
 *
 * - `--strict-config` refuses any configuration key the binary does not know,
 *   those of `-c` included: a newer binary that renamed one fails the launch
 *   instead of ignoring it.
 * - `--ignore-user-config` and `--ignore-rules`: nothing of the user's
 *   `config.toml` (MCP servers, connectors, profiles, trust of projects) nor of
 *   the exec policies; the login still comes from the user's Codex folder.
 *   A project's own `.codex/config.toml` is not loaded either: without the
 *   user's configuration no project is trusted.
 * - No instruction files and no skills in the prompt, as `--safe-mode` does for
 *   claude: `project_doc_max_bytes=0` drops the project's `AGENTS.md` (planted
 *   text), `skills.include_instructions=false` the user's skills and the
 *   bundled ones. The user's global `AGENTS.md` has no switch: the executor
 *   refuses to launch while it exists (`userInstructionFiles`).
 * - The permission profile `arianna` (`codexFilesystem`) is the default; it
 *   has no network table, so commands have no network, loopback included.
 * - `approval_policy="never"`: nothing waits for a person, what the sandbox
 *   refuses fails; `web_search="disabled"`; no login shell (the user's shell
 *   files stay unread); the shell gets only the core variables of the
 *   environment, plus git without the user's or the system's configuration.
 * - `--ephemeral` when the session must not be saved (D-136): never together
 *   with `resume`.
 * - Never `--dangerously-bypass-approvals-and-sandbox`, `--oss` nor an API key.
 */
/**
 * A Codex name stays in the family of its alias (`sol`, `gpt-6.1-sol`): the
 * router and the records see the alias, so `luna = "gpt-6-astra"` would run
 * the strongest model on the cheapest tier. Same rule as inFamily of
 * @arianna/config.
 */
export function codexInFamily(model: CodexModel, name: string): boolean {
  return new RegExp(`^gpt-[0-9][0-9.]*-${model}$`).test(name);
}

export function codexArgs(options: CodexProfileOptions): string[] {
  if (!(CODEX_MODELS as readonly string[]).includes(options.model)) {
    throw new TypeError(`codex: unknown model ${JSON.stringify(options.model)}`);
  }
  // Without an exact name the binary would run its default model under any alias: the records would lie (D-141).
  if (options.modelName === undefined) throw new TypeError(`codex: no exact model name for ${options.model}`);
  if (typeof options.modelName !== 'string' || !MODEL_NAME.test(options.modelName)) {
    throw new TypeError('codex: the model name is not a model name');
  }
  if (!codexInFamily(options.model, options.modelName)) throw new TypeError(`codex: ${options.modelName} is not a ${options.model} model`);
  const persist: unknown = options.persistSession === undefined ? true : options.persistSession;
  // Types do not hold at runtime: a value that is not a boolean must not read as "saved".
  if (typeof persist !== 'boolean') throw new TypeError('codex: persistSession must be a boolean');
  if (!persist && options.resume !== undefined) throw new TypeError('codex: a run whose session is not saved cannot resume a session');
  if (options.resume !== undefined && (typeof options.resume !== 'string' || !SESSION_REF.test(options.resume))) {
    throw new TypeError('codex: the session to resume is not a session id');
  }
  const permissions = codexPermissionArgs(options.sandbox, options.access);
  const args = ['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules'];
  if (!persist) args.push('--ephemeral');
  // `exec resume` takes neither: the working directory is the process's own.
  if (options.resume === undefined) args.push('--color', 'never', '--cd', options.sandbox.workspace);
  args.push('--model', options.modelName);
  args.push(
    ...permissions,
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'skills.bundled.enabled=false',
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
    'history.persistence="none"',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'feedback.enabled=false',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  );
  if (options.resume !== undefined) args.push('resume', options.resume);
  args.push('-');
  return args;
}

/**
 * The permission profile as `-c` overrides: the same for `codex exec` and for
 * `codex sandbox`, which the canary eval uses to run commands under the exact
 * rules of a run without a model.
 */
export function codexPermissionArgs(paths: CodexSandboxPaths, access: CodexAccess): string[] {
  return ['-c', `default_permissions="${PERMISSIONS}"`, '-c', `permissions.${PERMISSIONS}.filesystem=${codexFilesystem(paths, access)}`];
}

/**
 * The user's global instructions for Codex, which the binary puts in every
 * prompt and no option turns off: unlabelled user files, so L2, that would go
 * to the cloud without the gateway. Paths only, never read.
 */
export function userInstructionFiles(home: string): string[] {
  return ['AGENTS.md', 'AGENTS.override.md'].map((name) => join(home, '.codex', name));
}

/** The only variables the binary inherits: it finds its login from HOME, and nothing else leaks in. */
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR'] as const;

/**
 * A clean environment (rule 7): no secret of the core, no `OPENAI_API_KEY`
 * that would bill an API account instead of the subscription (D-002), no
 * `CODEX_HOME` pointing elsewhere, no proxy, no `NODE_OPTIONS`.
 */
export function codexEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  env.LANG = 'en_US.UTF-8';
  return env;
}
