#!/usr/bin/env node
// PreToolUse hook: blocks file access outside the repository (exit code 2 = block).
// File tools are checked strictly. Bash is checked heuristically: it catches
// mistakes, it is not a sandbox (see docs/SECURITY.md).
// Read-only exceptions (D-059): absolute paths listed one per line in
// .claude/read-allow.local (outside git). Read, Grep and Glob may open them;
// Bash may name them only in read-only commands; every write stays blocked.
const fs = require('fs');
const os = require('os');
const path = require('path');

// For Bash only: locations that may hold personal data.
const SENSITIVE_ROOTS = ['/Users', '/home', '/root', '/Volumes', '/mnt', '/media'];
const GLOB_CHARS = /[*?[{]/;
const READ_TOOLS = ['Read', 'Grep', 'Glob'];
// Bash programs allowed on read-only paths; find, sed and sort are narrowed below.
const READ_COMMANDS = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'tree', 'file', 'stat', 'du', 'find', 'sed', 'sort'];

// Resolves symlinks on the nearest existing ancestor, so not-yet-created files work too.
function realpath(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(root, abs) {
  return abs === root || abs.startsWith(root + path.sep);
}

function expandHome(token) {
  const home = os.homedir();
  if (token === '~' || token.startsWith('~/')) return home + token.slice(1);
  if (token.startsWith('~')) return path.join(path.dirname(home), token.slice(1)); // ~otheruser
  return token.replace(/^\$\{?HOME\}?/, home);
}

function resolve(base, token) {
  return realpath(path.resolve(base, expandHome(token)));
}

// An entry that contains the home directory (or is the filesystem root) is ignored:
// the exception is for a single folder, never for the user's whole home.
function readAllowRoots(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.claude', 'read-allow.local'), 'utf8');
  } catch {
    return [];
  }
  const home = realpath(os.homedir());
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && path.isAbsolute(line))
    .map((line) => realpath(line))
    .filter((abs) => abs !== path.parse(abs).root && !inside(abs, home));
}

// Heuristic: every command in the line is a reading program, find cannot run or
// delete, sed cannot edit in place, and output is redirected only to /dev/null.
function readOnlyCommand(command) {
  if (/[`$]\(|`/.test(command)) return false;
  if (/>/.test(command.replace(/\d?>\s*\/dev\/null/g, ''))) return false;
  const segments = command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
  return segments.every((seg) => {
    const [prog, ...args] = seg.split(/\s+/);
    if (!READ_COMMANDS.includes(prog)) return false;
    if (prog === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(a))) return false;
    if (prog === 'sed' && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) return false;
    if (prog === 'sort' && args.some((a) => /^-[a-zA-Z]*o|^--output/.test(a))) return false;
    return true;
  });
}

function block(abs) {
  console.error(`Blocked: ${abs} is outside the repository (see CLAUDE.md privacy rules).`);
  process.exit(2);
}

function checkFileTool(root, base, ti, readable) {
  const targets = [ti.file_path, ti.path, ti.notebook_path].filter(Boolean);
  if (typeof ti.pattern === 'string' && /^(\/|~|\.\.)/.test(ti.pattern)) {
    // Glob pattern anchored outside the working directory: check its fixed prefix.
    targets.push(ti.pattern.split(GLOB_CHARS)[0]);
  }
  for (const target of targets) {
    const abs = resolve(base, target);
    if (inside(root, abs)) continue;
    if (readable.some((r) => inside(r, abs))) continue;
    block(abs);
  }
}

function checkBash(root, base, command, readAllow) {
  const home = realpath(os.homedir());
  const readOnly = readOnlyCommand(command);
  const tokens = command.split(/[\s;|&<>()'"`=:,]+/).filter(Boolean);
  for (const token of tokens) {
    const looksLikePath =
      token.startsWith('/') || token.startsWith('~') || /^\$\{?HOME\}?/.test(token) ||
      token === '..' || token.includes('../');
    if (!looksLikePath) continue;
    const abs = resolve(base, token);
    if (inside(root, abs)) continue;
    if (readAllow.some((r) => inside(r, abs))) {
      if (readOnly) continue;
      block(abs);
    }
    if (inside(home, abs) || SENSITIVE_ROOTS.some((r) => inside(r, abs))) block(abs);
  }
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    console.error('Blocked: unreadable hook input (fail-closed).');
    process.exit(2);
  }
  const root = realpath(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const base = input.cwd || root;
  const ti = input.tool_input || {};
  const readAllow = readAllowRoots(root);
  if (typeof ti.command === 'string') checkBash(root, base, ti.command, readAllow);
  checkFileTool(root, base, ti, READ_TOOLS.includes(input.tool_name) ? readAllow : []);
  process.exit(0);
});
