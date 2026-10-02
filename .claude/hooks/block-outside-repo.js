#!/usr/bin/env node
// PreToolUse hook: blocks file access outside the repository (exit code 2 = block).
// File tools are checked strictly. Bash is checked heuristically: it catches
// mistakes, it is not a sandbox (see docs/SECURITY.md).
const fs = require('fs');
const os = require('os');
const path = require('path');

// For Bash only: locations that may hold personal data.
const SENSITIVE_ROOTS = ['/Users', '/home', '/root', '/Volumes', '/mnt', '/media'];
const GLOB_CHARS = /[*?[{]/;

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

function block(abs) {
  console.error(`Blocked: ${abs} is outside the repository (see CLAUDE.md privacy rules).`);
  process.exit(2);
}

function checkFileTool(root, base, ti) {
  const targets = [ti.file_path, ti.path, ti.notebook_path].filter(Boolean);
  if (typeof ti.pattern === 'string' && /^(\/|~|\.\.)/.test(ti.pattern)) {
    // Glob pattern anchored outside the working directory: check its fixed prefix.
    targets.push(ti.pattern.split(GLOB_CHARS)[0]);
  }
  for (const target of targets) {
    const abs = resolve(base, target);
    if (!inside(root, abs)) block(abs);
  }
}

function checkBash(root, base, command) {
  const home = realpath(os.homedir());
  const tokens = command.split(/[\s;|&<>()'"`=:,]+/).filter(Boolean);
  for (const token of tokens) {
    const looksLikePath =
      token.startsWith('/') || token.startsWith('~') || /^\$\{?HOME\}?/.test(token) ||
      token === '..' || token.includes('../');
    if (!looksLikePath) continue;
    const abs = resolve(base, token);
    if (inside(root, abs)) continue;
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
  if (typeof ti.command === 'string') checkBash(root, base, ti.command);
  checkFileTool(root, base, ti);
  process.exit(0);
});
