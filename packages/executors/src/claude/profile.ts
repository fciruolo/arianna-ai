// The confinement profile of `claude -p` (docs/PRIVACY-POLICY-SPEC.md, tasks
// 1.5 and 1.6, D-049 and D-050): the flags, the sandbox settings, the
// environment and what the binary must report in its `init` message. Checked
// on `claude --help` of 2.1.288 (`--no-session-persistence` on 2.1.292) and with real runs; the live contract and
// canary evals check them again.
import { isAbsolute, join, resolve, sep } from 'node:path';

import { checkMcpTools, MCP_SERVER_NAME, mcpToolId, type McpToolName } from '../mcp.ts';

/**
 * Built-in tools a run may be given. Bash runs inside the sandbox of
 * `claudeSettings` (D-050). Never WebFetch or WebSearch: they run outside the
 * sandbox, and web search is a gateway target of its own.
 */
export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] as const;
export type ClaudeTool = (typeof CLAUDE_TOOLS)[number];

/** Model aliases of the router (`sonnet`, `opus`, `fable`), passed to `--model` as they are unless the user named the model. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/**
 * An exact model name the user gave in `[cloud.models]` (D-071), e.g.
 * `claude-opus-5-5[1m]`: never starting with `-`, so that the binary never
 * reads it as a flag, and of the family of its alias. Same rules as
 * @arianna/config.
 */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;

/** What `--resume` takes: the session id the binary returned, never a credential. */
export const SESSION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** No MCP server, unless the run is given Arianna's own (`ProfileOptions.mcp`, 1.10, D-261). */
const NO_MCP = JSON.stringify({ mcpServers: {} });

/** Arianna's MCP server for one run (D-261): the file `prepareMcp` wrote, and the tools allowed of it. */
export interface McpProfile {
  /** Absolute path of the configuration file; it holds the token, the arguments only its path. */
  config: string;
  tools: readonly McpToolName[];
}

/** Absolute, real folders the sandbox rules name (see `claudeSettings`). */
export interface SandboxPaths {
  /** The working directory: readable even inside a denied folder. */
  workspace: string;
  /** Read besides the workspace: the toolchain, and the binary's own temp folder. */
  readable: readonly string[];
  /** Never read, even outside the user folders: ARIANNA_HOME and the shared temp folders. */
  denied: readonly string[];
}

export interface ProfileOptions {
  model: ClaudeModel;
  /** Passed to `--model` instead of the alias (`[cloud.models]`, D-071). */
  modelName?: string;
  tools: readonly ClaudeTool[];
  resume?: string;
  /**
   * False: the binary keeps no session on disk (`--no-session-persistence`,
   * with `-p` only, which every launch has), so nothing of the run stays in
   * the `projects` folder of the user's profile; such a session cannot be
   * resumed (D-136, incognito). Absent or true: saved, as before (D-049).
   */
  persistSession?: boolean;
  sandbox: SandboxPaths;
  /**
   * Folders the file tools may read besides the working directory
   * (`--add-dir`, which `--restricted` keeps them confined to): the read-only
   * copy of a project's notes (D-166). Each must be readable in `sandbox` too.
   */
  addDirs?: readonly string[];
  /** Arianna's MCP server (D-261); absent: no MCP server at all, as before. */
  mcp?: McpProfile;
}

function checkFolders(name: string, folders: unknown): readonly string[] {
  if (!Array.isArray(folders)) throw new TypeError(`claude: ${name} must be a list`);
  for (const path of folders as unknown[]) {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === sep) {
      throw new TypeError(`claude: ${name} folder ${JSON.stringify(path)} must be an absolute, normalized folder other than the root`);
    }
  }
  return folders as readonly string[];
}

/** A path as a literal in a gitignore-style pattern of a permission rule. */
function globEscape(path: string): string {
  return path.replace(/[\\*?[\]{}!#]/g, (char) => `\\${char}`);
}

/**
 * The settings passed with `--settings`, which hold under `--restricted`
 * (D-050):
 * - the file tools refuse reads outside the working directory in every mode
 *   (as `--restricted` does too), and `bypassPermissions` cannot be turned on;
 * - Bash and what it starts run in the operating system's sandbox, or not at
 *   all (`failIfUnavailable`), never retried outside it
 *   (`allowUnsandboxedCommands: false`), with no command excluded;
 * - reads of sandboxed commands: `blockReadsOutsideWorkingDirectories` closes
 *   the home directory and the other user roots (`/Users`, `/home`,
 *   `/Volumes`…); `denied` closes ARIANNA_HOME and the shared temp folders
 *   wherever they are; the workspace and `readable` are opened again (the
 *   narrower rule wins). What stays readable: the system folders (`/usr`,
 *   `/etc`, `/opt`, `/Library`…) and the toolchain;
 * - writes: only the workspace and the binary's temp folder, never the
 *   workspace's `.git` (I-14, D-174: the agents never commit, the user does),
 *   closed for Bash in the sandbox and for the file tools by a deny rule;
 * - no network: an empty allowlist that refuses instead of asking, no local
 *   binding (on macOS the loopback services, database and local model
 *   included, stay out of reach), no Unix sockets.
 *
 * With Arianna's MCP server (`mcp`, D-261), which runs without `--safe-mode`,
 * also every hook off (`disableAllHooks`) and no auto memory
 * (`autoMemoryEnabled: false`), two of the things `--safe-mode` turned off.
 */
export function claudeSettings(paths: SandboxPaths, options: { mcp?: boolean } = {}): string {
  const workspace = checkFolders('workspace', [paths.workspace]);
  const readable = checkFolders('readable', paths.readable);
  const denied = checkFolders('denied', paths.denied);
  if (denied.length === 0) throw new TypeError('claude: the sandbox needs the folders to deny (ARIANNA_HOME at least)');
  const git = join(paths.workspace, '.git');
  return JSON.stringify({
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: 'disable',
      // `//` starts an absolute path; the rule covers every file tool that writes.
      deny: [`Edit(/${globEscape(git)}/**)`, `Edit(/${globEscape(git)})`],
    },
    ...(options.mcp === true ? { disableAllHooks: true, autoMemoryEnabled: false } : {}),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: { denyRead: [...denied], allowRead: [...workspace, ...readable], denyWrite: [git] },
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [], allowAllUnixSockets: false },
    },
  });
}

/**
 * The arguments of every launch. The prompt is not among them: it goes on
 * stdin, where other users of the machine cannot read it with `ps`.
 *
 * - `--tools` is the closed list of tools that exist in the session,
 *   `--allowedTools` the same list allowed without asking, and `dontAsk` with
 *   `--permission-prompts none` denies anything else instead of waiting.
 * - `--restricted` ignores user, project and local settings files (their hooks,
 *   permissions and MCP servers), keeps the file tools inside the working
 *   directory and refuses `bypassPermissions`; `--safe-mode` turns off CLAUDE.md,
 *   skills, installed plugins, hooks and custom agents; `--strict-mcp-config`
 *   with an empty `--mcp-config` drops every MCP server, the personal connectors
 *   included. With Arianna's server (D-261) `--mcp-config` names its file
 *   instead, still with `--strict-mcp-config`; its tools are added to
 *   `--allowedTools` one by one, by exact name (`mcp__arianna__<tool>`, never
 *   a wildcard), and not to `--tools`, which on 2.1.303 lists "the built-in
 *   set" only: the server's tools exist because the server lists them, and
 *   are allowed only by name.
 * - Without Arianna's server, `--safe-mode`. With it, not: the 2.1.303
 *   binary, read with `strings`, drops under `--safe-mode` every
 *   `--mcp-config` server whose type is not `sdk` ("ignored (safe mode)").
 *   What `--safe-mode` turned off is closed one by one instead (D-261):
 *   `--setting-sources ''` loads no settings file (user, project, local: the
 *   skills, agents, output styles, plugins and hooks they bring; `--restricted`
 *   does the same, said twice), `claudeSettings` turns hooks and auto memory
 *   off, `MCP_LAUNCH_ENV` the rest (CLAUDE.md, memories, workflows, bundled
 *   skills, the plugins' MCP servers, claude.ai connectors, tool search); and
 *   the `init` check stops the run if anything of the user's profile came in
 *   all the same (agents, output style, memory paths, skills, plugins).
 * - `--settings` carries the sandbox and the read block (`claudeSettings`).
 * - `--no-session-persistence` when the session must not be saved (D-136):
 *   never together with `--resume`.
 * - `--add-dir` only for the read-only copy of a project's notes (D-166), a
 *   folder the sandbox reads too. `--add-dir` may load a CLAUDE.md of its
 *   folder even under `--safe-mode`: the copy never holds one (`checkCoderNote`);
 *   with Arianna's server `CLAUDE_CODE_DISABLE_CLAUDE_MDS` closes it too.
 * - Never `--bare`: it needs an API key, and Arianna uses the subscription (D-002).
 */
export function claudeArgs(options: ProfileOptions): string[] {
  const tools = checkTools(options.tools);
  if (!(CLAUDE_MODELS as readonly string[]).includes(options.model)) {
    throw new TypeError(`claude: unknown model ${JSON.stringify(options.model)}`);
  }
  if (options.modelName !== undefined && (typeof options.modelName !== 'string' || !MODEL_NAME.test(options.modelName))) {
    throw new TypeError('claude: the model name is not a model name');
  }
  // The router and its budget approval see the alias: the name stays in its family (D-071).
  if (options.modelName !== undefined && !new RegExp(`^(claude-)?${options.model}(?![A-Za-z0-9])`).test(options.modelName)) {
    throw new TypeError(`claude: the model name is not of the ${options.model} family`);
  }
  const mcp = checkMcp(options.mcp);
  const addDirs = checkFolders('addDirs', options.addDirs ?? []);
  for (const folder of addDirs) {
    if (!options.sandbox.readable.includes(folder)) throw new TypeError('claude: a folder given to the file tools must be readable in the sandbox');
  }
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // The answer and the thinking as they are written (D-249): `stream_event` lines, read by ClaudeStream.
    '--include-partial-messages',
    '--model',
    options.modelName ?? options.model,
    '--tools',
    tools.join(','),
  ];
  const allowed = [...tools, ...(mcp?.tools.map(mcpToolId) ?? [])];
  if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
  args.push(
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--mcp-config',
    mcp?.config ?? NO_MCP,
    '--strict-mcp-config',
    '--settings',
    claudeSettings(options.sandbox, { mcp: mcp !== undefined }),
    '--restricted',
    // An empty value of its own, never read as the next flag.
    ...(mcp === undefined ? ['--safe-mode'] : ['--setting-sources', '']),
    '--disable-slash-commands',
    '--no-chrome',
  );
  // `--add-dir=<folder>`: one value per flag, never read as the start of a list.
  for (const folder of addDirs) args.push(`--add-dir=${folder}`);
  const persist: unknown = options.persistSession === undefined ? true : options.persistSession;
  // Types do not hold at runtime: a value that is not a boolean must not read as "saved".
  if (typeof persist !== 'boolean') throw new TypeError('claude: persistSession must be a boolean');
  if (!persist) {
    // Nothing was saved to resume, and the run must not save the session it would resume into (D-136).
    if (options.resume !== undefined) throw new TypeError('claude: a run whose session is not saved cannot resume a session');
    args.push('--no-session-persistence');
  }
  if (options.resume !== undefined) {
    if (!SESSION_REF.test(options.resume)) throw new TypeError('claude: the session to resume is not a session id');
    args.push('--resume', options.resume);
  }
  return args;
}

function checkTools(tools: readonly ClaudeTool[]): readonly ClaudeTool[] {
  // Types do not hold at runtime: tool lists also come from agent cards.
  const list: unknown = tools;
  if (!Array.isArray(list)) throw new TypeError('claude: tools must be a list');
  for (const tool of list as unknown[]) {
    if (!(CLAUDE_TOOLS as readonly unknown[]).includes(tool)) throw new TypeError(`claude: tool ${JSON.stringify(tool)} is not allowed`);
  }
  if (new Set(list).size !== list.length) throw new TypeError('claude: a tool is listed twice');
  return tools;
}

function checkMcp(mcp: McpProfile | undefined): McpProfile | undefined {
  if (mcp === undefined) return undefined;
  // Types do not hold at runtime; the path is a file, never a JSON string or a flag.
  const given: unknown = mcp;
  if (typeof given !== 'object' || given === null) throw new TypeError('claude: mcp must be an object');
  const { config, tools } = given as Record<string, unknown>;
  if (typeof config !== 'string' || !isAbsolute(config) || resolve(config) !== config || config === sep) {
    throw new TypeError('claude: the MCP configuration must be an absolute, normalized file');
  }
  return { config, tools: checkMcpTools(tools) };
}

/**
 * Set for a run with Arianna's MCP server, which runs without `--safe-mode`
 * (D-261): each one turns off something `--safe-mode` did, read in the
 * 2.1.303 binary. `ENABLE_TOOL_SEARCH=false`: with MCP tools the binary may
 * defer them behind a `ToolSearch` tool of its own (on by default for the
 * first-party API), one more tool outside the closed list; off, they load up
 * front and `init` lists exactly the tools allowed.
 */
export const MCP_LAUNCH_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_ORG_MEMORY: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_CODE_SKILL: '1',
  CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  ENABLE_TOOL_SEARCH: 'false',
});

/** The only variables the binary inherits: it finds its login from HOME, and nothing else leaks in. */
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR'] as const;

/**
 * A clean environment (rule 7): no secret of the core (database passwords, the
 * age key of sops, an `ANTHROPIC_API_KEY` that would bill an API account), no
 * proxy, no `NODE_OPTIONS`. Non-essential traffic (telemetry, error reports,
 * updates) is switched off.
 */
export function claudeEnv(from: NodeJS.ProcessEnv, options: { mcp?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  env.LANG = 'en_US.UTF-8';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  if (options.mcp === true) Object.assign(env, MCP_LAUNCH_ENV);
  return env;
}

/** The fields of the `init` message the profile is checked against. */
export interface InitReport {
  cwd: unknown;
  tools: unknown;
  mcp_servers: unknown;
  permissionMode: unknown;
  apiKeySource: unknown;
  skills?: unknown;
  slash_commands?: unknown;
  plugins?: unknown;
  /** Checked with Arianna's MCP server only (D-261), where `--safe-mode` is off. */
  agents?: unknown;
  output_style?: unknown;
  memory_paths?: unknown;
  plugin_errors?: unknown;
  mcp_server_errors?: unknown;
}

/**
 * The agents built into the binary, as `init` names them (2.1.288 recorded
 * the first four; the other two are built in too). Any other is the user's
 * or a project's, loaded because `--safe-mode` is off (D-261).
 */
export const CLAUDE_BUILTIN_AGENTS = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup', 'claude-code-guide'] as const;
/** The output style of a session with none of the user's. */
const DEFAULT_OUTPUT_STYLE = 'default';

/** None; or, with Arianna's server, that one alone and connected (other fields of the entry may come and go). */
function mcpServersHold(servers: unknown[], arianna: boolean): boolean {
  if (!arianna) return servers.length === 0;
  const [server] = servers;
  return (
    servers.length === 1 &&
    typeof server === 'object' &&
    server !== null &&
    (server as { name?: unknown }).name === MCP_SERVER_NAME &&
    (server as { status?: unknown }).status === 'connected'
  );
}

const isEmptyList = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * What in the `init` message contradicts the profile; empty when it holds.
 * The flags are the protection, this is the alarm: a newer binary that
 * ignored one of them would show it here, and the run is stopped.
 * Names only, never values: the result goes to logs.
 *
 * With `mcp` (D-261) the only server is Arianna's, connected, and the tools
 * are the built-in ones plus exactly the server's tools allowed: another
 * server, a server's tool not given (a `ToolSearch` that defers them
 * included) or a server that failed to connect breaks the profile. Since
 * such a run has no `--safe-mode`, also: an agent not built in, an output
 * style other than the default (the field is required), memory paths, plugin
 * errors (a plugin tried to load) and MCP server errors.
 */
export function profileViolations(init: InitReport, expected: { cwd: string; tools: readonly ClaudeTool[]; mcp?: readonly McpToolName[] }): string[] {
  const violations: string[] = [];
  if (init.cwd !== expected.cwd) violations.push('cwd');
  const tools = Array.isArray(init.tools) ? [...(init.tools as unknown[])].map(String).sort() : undefined;
  const expectedTools = [...expected.tools, ...(expected.mcp ?? []).map(mcpToolId)].sort();
  if (tools === undefined || tools.join(',') !== expectedTools.join(',')) violations.push('tools');
  // Required, not just empty: a binary that renamed the field would silence the alarm.
  if (
    !Array.isArray(init.mcp_servers) ||
    !mcpServersHold(init.mcp_servers as unknown[], expected.mcp !== undefined) ||
    (expected.mcp !== undefined && !isEmptyList(init.mcp_server_errors))
  ) {
    violations.push('mcp_servers');
  }
  if (init.permissionMode !== 'dontAsk') violations.push('permissionMode');
  // `none`: the subscription login. Any other source is an API key, billed apart (D-002).
  if (init.apiKeySource !== 'none') violations.push('apiKeySource');
  if (!isEmptyList(init.skills)) violations.push('skills');
  if (!isEmptyList(init.slash_commands)) violations.push('slash_commands');
  // Plugins built into the binary stay; any installed one is the user's profile leaking in.
  const plugins = init.plugins;
  if (
    plugins !== undefined &&
    (!Array.isArray(plugins) || !plugins.every((plugin) => typeof plugin === 'object' && plugin !== null && (plugin as { path?: unknown }).path === 'builtin'))
  ) {
    violations.push('plugins');
  }
  if (expected.mcp !== undefined) {
    // Plugins that did not load still tried: the user's profile is in.
    if (!isEmptyList(init.plugin_errors) && !violations.includes('plugins')) violations.push('plugins');
    const agents = init.agents;
    // Required: a binary that renamed the field would let a user's agent in unseen.
    if (!Array.isArray(agents) || !agents.every((agent) => (CLAUDE_BUILTIN_AGENTS as readonly unknown[]).includes(agent))) violations.push('agents');
    if (init.output_style !== DEFAULT_OUTPUT_STYLE) violations.push('output_style');
    // Optional: 2.1.303 does not report it at all (tried live); when present it must be empty.
    const memory = init.memory_paths;
    if (memory !== undefined && !(typeof memory === 'object' && memory !== null && !Array.isArray(memory) && Object.keys(memory).length === 0)) violations.push('memory_paths');
  }
  return violations;
}
