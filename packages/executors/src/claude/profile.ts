// The confinement profile of `claude -p` (docs/PRIVACY-POLICY-SPEC.md, task
// 1.5, D-049): the flags, the environment and what the binary must report in
// its `init` message. Flag names checked on `claude --help` of 2.1.288 and
// with two real runs; the live contract eval checks them again.

/**
 * Built-in tools a run may be given. No Bash, WebFetch or WebSearch until the
 * sandbox of task 1.6 exists: without it a command can read outside the
 * workspace and reach the network, the local services included.
 */
export const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as const;
export type ClaudeTool = (typeof CLAUDE_TOOLS)[number];

/** Model aliases of the router (`sonnet`, `opus`, `fable`), passed to `--model` as they are. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

/** What `--resume` takes: the session id the binary returned, never a credential. */
export const SESSION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** No MCP server until Arianna's own (task 1.6). */
const NO_MCP = JSON.stringify({ mcpServers: {} });

export interface ProfileOptions {
  model: ClaudeModel;
  tools: readonly ClaudeTool[];
  resume?: string;
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
 *   included.
 * - Never `--bare`: it needs an API key, and Arianna uses the subscription (D-002).
 */
export function claudeArgs(options: ProfileOptions): string[] {
  const tools = checkTools(options.tools);
  if (!(CLAUDE_MODELS as readonly string[]).includes(options.model)) {
    throw new TypeError(`claude: unknown model ${JSON.stringify(options.model)}`);
  }
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    options.model,
    '--tools',
    tools.join(','),
  ];
  if (tools.length > 0) args.push('--allowedTools', tools.join(','));
  args.push(
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--mcp-config',
    NO_MCP,
    '--strict-mcp-config',
    '--restricted',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-chrome',
  );
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

/** The only variables the binary inherits: it finds its login from HOME, and nothing else leaks in. */
const INHERITED = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR'] as const;

/**
 * A clean environment (rule 7): no secret of the core (database passwords, the
 * age key of sops, an `ANTHROPIC_API_KEY` that would bill an API account), no
 * proxy, no `NODE_OPTIONS`. Non-essential traffic (telemetry, error reports,
 * updates) is switched off.
 */
export function claudeEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  env.LANG = 'en_US.UTF-8';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
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
}

const isEmptyList = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.length === 0);

/**
 * What in the `init` message contradicts the profile; empty when it holds.
 * The flags are the protection, this is the alarm: a newer binary that
 * ignored one of them would show it here, and the run is stopped.
 * Names only, never values: the result goes to logs.
 */
export function profileViolations(init: InitReport, expected: { cwd: string; tools: readonly ClaudeTool[] }): string[] {
  const violations: string[] = [];
  if (init.cwd !== expected.cwd) violations.push('cwd');
  const tools = Array.isArray(init.tools) ? [...(init.tools as unknown[])].map(String).sort() : undefined;
  if (tools === undefined || tools.join(',') !== [...expected.tools].sort().join(',')) violations.push('tools');
  // Required, not just empty: a binary that renamed the field would silence the alarm.
  if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length > 0) violations.push('mcp_servers');
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
  return violations;
}
