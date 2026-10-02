#!/usr/bin/env node
// PreToolUse hook: blocks file access outside the repository (exit code 2 = block).
const path = require('path');
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const root = process.cwd();
  const ti = input.tool_input || {};
  const target = ti.file_path || ti.path;
  if (target) {
    const abs = path.resolve(root, target);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      console.error(`Blocked: ${abs} is outside the repository (see CLAUDE.md privacy rules).`);
      process.exit(2);
    }
  }
  process.exit(0);
});
