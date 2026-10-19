// Arianna's own MCP server for `claude -p` (task 1.10, D-261): the core serves
// a few read-only tools (skills, and the knowledge base for the Coder) on a
// listener of its own on loopback, with a Bearer token for one run. Here only
// the launch side: the configuration file the binary reads with `--mcp-config`,
// written for one run and removed after it. The token lives only in that file,
// never in the arguments (`ps` shows them to every user of the machine); the
// core revokes it when the run ends.
import { lstatSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { RUN_ID } from './workspace.ts';

/** The folder of the configuration files under `data/` (0700): ARIANNA_HOME, closed to sandboxed commands. */
export const MCP_DIR = 'mcp';
/** The name of a configuration file: `<runId>.mcp.json`. */
const CONFIG_FILE = /^([a-z0-9][a-z0-9-]{0,63})\.mcp\.json$/;

/** The server's name in the configuration: the binary prefixes its tools with it (`mcp__arianna__…`). */
export const MCP_SERVER_NAME = 'arianna';
/** Every tool the server may expose; a run gets a subset. All read only. */
export const MCP_TOOL_NAMES = ['list_skills', 'get_skill', 'kb_search', 'kb_read'] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface McpEndpoint {
  /** `http://127.0.0.1:<port>/mcp`, nothing else. */
  url: string;
  /** The Bearer token of this run: base64url, at least 256 bits. */
  token: string;
  /** The tools this run may call: not empty, no duplicates. */
  tools: readonly McpToolName[];
}

/** A configuration ready for a run; only those made by `prepareMcp` are accepted by a launch. */
export interface PreparedMcp {
  /** Absolute, real path of the configuration file. */
  readonly path: string;
  readonly tools: readonly McpToolName[];
}

/** Loopback only, plain HTTP (the listener is local), one fixed path; no credentials, query or fragment. */
const ENDPOINT_URL = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/mcp$/;
/** 43 characters of base64url are 32 random bytes. */
const TOKEN = /^[A-Za-z0-9_-]{43,512}$/;

// Configurations made here, and only these, can be given to a run: a literal object could name any file.
const made = new WeakMap<PreparedMcp, { path: string; tools: readonly McpToolName[] }>();

/** The file and the tools of a configuration `prepareMcp` made; undefined for anything else. */
export function preparedMcp(mcp: unknown): { path: string; tools: readonly McpToolName[] } | undefined {
  return typeof mcp === 'object' && mcp !== null ? made.get(mcp as PreparedMcp) : undefined;
}

/** The name the binary gives a tool of the server, allowed by exact name (never a wildcard). */
export function mcpToolId(tool: McpToolName): string {
  if (!(MCP_TOOL_NAMES as readonly unknown[]).includes(tool)) throw new TypeError(`mcp: unknown tool ${JSON.stringify(tool)}`);
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

/** Checks a list of tools of the server: types do not hold at runtime. */
export function checkMcpTools(tools: unknown): readonly McpToolName[] {
  if (!Array.isArray(tools) || tools.length === 0) throw new TypeError('mcp: tools must be a list that is not empty');
  for (const tool of tools as unknown[]) {
    if (!(MCP_TOOL_NAMES as readonly unknown[]).includes(tool)) throw new TypeError(`mcp: unknown tool ${JSON.stringify(tool)}`);
  }
  if (new Set(tools).size !== tools.length) throw new TypeError('mcp: a tool is listed twice');
  return tools as readonly McpToolName[];
}

function checkEndpoint(endpoint: McpEndpoint): { url: string; token: string; tools: readonly McpToolName[] } {
  const given: unknown = endpoint;
  if (typeof given !== 'object' || given === null) throw new TypeError('mcp: the endpoint must be an object');
  const { url, token, tools } = given as Record<string, unknown>;
  const port = typeof url === 'string' ? ENDPOINT_URL.exec(url)?.[1] : undefined;
  if (port === undefined || Number(port) > 65_535) throw new TypeError('mcp: the url must be http://127.0.0.1:<port>/mcp');
  // Never echoed: the message goes to logs.
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new TypeError('mcp: the token must be at least 43 characters of base64url');
  return { url: url as string, token, tools: Object.freeze([...checkMcpTools(tools)]) };
}

/**
 * Writes `<dir>/<runId>.mcp.json`, 0600, with `wx`: never over a file, never
 * through a link; a file already there belongs to another run and is never
 * touched. `dir` is made if missing (0700). It must be where sandboxed
 * commands cannot read (under ARIANNA_HOME, outside the workspace): the
 * launch checks it.
 */
export async function prepareMcp(dir: string, runId: string, endpoint: McpEndpoint): Promise<PreparedMcp> {
  if (typeof dir !== 'string' || !isAbsolute(dir) || resolve(dir) !== dir || dir === sep) throw new TypeError('mcp: dir must be an absolute, normalized folder other than the root');
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new TypeError(`mcp: invalid run id ${JSON.stringify(runId)}`);
  const { url, token, tools } = checkEndpoint(endpoint);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The sandbox rules and the launch's checks name real paths (`/var` is `/private/var` on macOS).
  const path = join(await realpath(dir), `${runId}.mcp.json`);
  const config = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } };
  await writeFile(path, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  const prepared: PreparedMcp = Object.freeze({ path, tools });
  made.set(prepared, { path, tools });
  return prepared;
}

/** Removes the file of a configuration; again, or when it is gone, does nothing. The token is revoked by the core. */
export async function releaseMcp(prepared: PreparedMcp): Promise<void> {
  const known = preparedMcp(prepared);
  if (known === undefined) throw new TypeError('mcp: not a configuration made by prepareMcp');
  await rm(known.path, { force: true });
}

/**
 * Removes the configuration files a core that stopped mid-run left in `dir`
 * (their tokens died with it), at the start of the core: only names of the
 * form `<runId>.mcp.json`, a link removed as a link, never followed; a
 * folder or anything else is left. A missing `dir` is nothing to do.
 * Returns how many it removed.
 */
export async function removeStaleMcp(dir: string): Promise<number> {
  if (typeof dir !== 'string' || !isAbsolute(dir) || resolve(dir) !== dir || dir === sep) throw new TypeError('mcp: dir must be an absolute, normalized folder other than the root');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const match = CONFIG_FILE.exec(name);
    if (match?.[1] === undefined || !RUN_ID.test(match[1])) continue;
    const path = join(dir, name);
    const stats = await lstat(path).catch(() => undefined);
    if (stats === undefined || !(stats.isFile() || stats.isSymbolicLink())) continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Where Claude Code reads the settings an administrator manages on macOS, as
 * named by the binary (2.1.303): the files of /Library/Application
 * Support/ClaudeCode and the MDM profiles. A run with the server has no
 * `--safe-mode`, and `--setting-sources ''` does not turn these off: their
 * hooks or servers would run inside it.
 */
export function claudeManagedPaths(user: string = currentUser()): string[] {
  const root = '/Library/Application Support/ClaudeCode';
  const plist = 'com.anthropic.claudecode.plist';
  return [
    join(root, 'managed-settings.json'),
    join(root, 'managed-settings.d'),
    join(root, 'managed-mcp.json'),
    join('/Library/Managed Preferences', plist),
    ...(user === '' ? [] : [join('/Library/Managed Preferences', user, plist)]),
  ];
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/**
 * True when any of `paths` exists (a link counts, even broken): the run then
 * goes without the server (D-261). Existence only: never read. A path that
 * cannot be checked for another reason counts as there.
 */
export function claudeManagedSettingsPresent(paths: readonly string[] = claudeManagedPaths()): boolean {
  return paths.some((path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR';
    }
  });
}
