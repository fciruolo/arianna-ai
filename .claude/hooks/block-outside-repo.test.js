// Run with: node --test .claude/hooks/block-outside-repo.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const hook = path.join(__dirname, 'block-outside-repo.js');
const root = path.resolve(__dirname, '..', '..');

function run(toolInput, raw) {
  const res = spawnSync('node', [hook], {
    input: raw ?? JSON.stringify({ cwd: root, tool_input: toolInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  });
  return res.status;
}

const ALLOW = 0;
const BLOCK = 2;

test('file tools: paths inside the repository are allowed', () => {
  assert.strictEqual(run({ file_path: 'docs/SPEC.md' }), ALLOW);
  assert.strictEqual(run({ file_path: path.join(root, 'docs', 'new-file.md') }), ALLOW);
  assert.strictEqual(run({ pattern: '**/*.ts', path: root }), ALLOW);
});

test('file tools: paths outside the repository are blocked', () => {
  assert.strictEqual(run({ file_path: '/etc/hosts' }), BLOCK);
  assert.strictEqual(run({ file_path: '../outside.txt' }), BLOCK);
  assert.strictEqual(run({ file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }), BLOCK);
  assert.strictEqual(run({ notebook_path: '/tmp/x.ipynb' }), BLOCK);
});

test('grep and glob: search roots and anchored patterns outside are blocked', () => {
  assert.strictEqual(run({ pattern: 'secret', path: '/etc' }), BLOCK);
  assert.strictEqual(run({ pattern: '~/Documents/**/*.pdf' }), BLOCK);
  assert.strictEqual(run({ pattern: '../**/*.md' }), BLOCK);
});

test('bash: commands inside the repository and system paths are allowed', () => {
  assert.strictEqual(run({ command: 'pnpm test' }), ALLOW);
  assert.strictEqual(run({ command: `ls ${root}/docs > /dev/null` }), ALLOW);
  assert.strictEqual(run({ command: 'git commit -m "0.1: add /api route"' }), ALLOW);
  assert.strictEqual(run({ command: '/usr/bin/env node --version' }), ALLOW);
});

test('bash: commands naming personal locations outside the repository are blocked', () => {
  assert.strictEqual(run({ command: 'cat ~/Documents/fattura.pdf' }), BLOCK);
  assert.strictEqual(run({ command: 'cp $HOME/.ssh/id_rsa .' }), BLOCK);
  assert.strictEqual(run({ command: 'ls ../../' }), BLOCK);
  assert.strictEqual(run({ command: 'tar -cf out.tar --directory=/Volumes/nas/archive .' }), BLOCK);
  assert.strictEqual(run({ command: 'cd .. && ls' }), BLOCK);
});

test('unreadable input fails closed', () => {
  assert.strictEqual(run(null, 'not json'), BLOCK);
});
