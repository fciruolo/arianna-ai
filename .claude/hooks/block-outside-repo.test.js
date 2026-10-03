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

// Read-only exceptions (D-059): a throwaway project whose .claude/read-allow.local
// lists one outside folder.
const fs = require('node:fs');

function withReadAllow(lines, fn) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-')));
  const project = path.join(tmp, 'project');
  const allowed = path.join(tmp, 'allowed');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(project, '.claude', 'read-allow.local'), lines(allowed).join('\n'));
  const exec = (toolName, toolInput) =>
    spawnSync('node', [hook], {
      input: JSON.stringify({ cwd: project, tool_name: toolName, tool_input: toolInput }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      encoding: 'utf8',
    }).status;
  try {
    fn(exec, allowed, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('read-allow: Read, Grep and Glob may open a listed folder', () => {
  withReadAllow((a) => ['# reference repository', a], (exec, allowed) => {
    assert.strictEqual(exec('Read', { file_path: path.join(allowed, 'README.md') }), ALLOW);
    assert.strictEqual(exec('Grep', { pattern: 'voice', path: allowed }), ALLOW);
    assert.strictEqual(exec('Glob', { pattern: `${allowed}/**/*.ts` }), ALLOW);
  });
});

test('read-allow: writes, other folders and unlisted tools stay blocked', () => {
  withReadAllow((a) => [a], (exec, allowed, tmp) => {
    assert.strictEqual(exec('Edit', { file_path: path.join(allowed, 'README.md') }), BLOCK);
    assert.strictEqual(exec('Write', { file_path: path.join(allowed, 'x.ts') }), BLOCK);
    assert.strictEqual(exec(undefined, { file_path: path.join(allowed, 'README.md') }), BLOCK);
    assert.strictEqual(exec('Read', { file_path: path.join(tmp, 'other.txt') }), BLOCK);
    assert.strictEqual(exec('Read', { file_path: '/etc/hosts' }), BLOCK);
  });
});

test('read-allow: entries that contain the home directory are ignored', () => {
  withReadAllow(() => ['/', os.homedir(), 'relative/path'], (exec) => {
    assert.strictEqual(exec('Read', { file_path: '/etc/hosts' }), BLOCK);
    assert.strictEqual(exec('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }), BLOCK);
  });
});

test('read-allow: bash may name a listed folder only in read-only commands', () => {
  withReadAllow((a) => [a], (exec, allowed) => {
    assert.strictEqual(exec('Bash', { command: `ls -la ${allowed}` }), ALLOW);
    assert.strictEqual(exec('Bash', { command: `find ${allowed} -name '*.ts' | head -50` }), ALLOW);
    assert.strictEqual(exec('Bash', { command: `sed -n 1,80p ${allowed}/a.ts 2>/dev/null` }), ALLOW);
    assert.strictEqual(exec('Bash', { command: `find ${allowed} -type f | sort` }), ALLOW);
    assert.strictEqual(exec('Bash', { command: `sort -o ${allowed}/a.ts ${allowed}/a.ts` }), BLOCK);
    assert.strictEqual(exec('Bash', { command: `cat ${allowed}/a.ts > copy.ts` }), BLOCK);
    assert.strictEqual(exec('Bash', { command: `rm ${allowed}/a.ts` }), BLOCK);
    assert.strictEqual(exec('Bash', { command: `find ${allowed} -delete` }), BLOCK);
    assert.strictEqual(exec('Bash', { command: `sed -i '' s/a/b/ ${allowed}/a.ts` }), BLOCK);
    assert.strictEqual(exec('Bash', { command: `ls ${allowed} && touch ${allowed}/x` }), BLOCK);
    assert.strictEqual(exec('Bash', { command: `cat $(echo ${allowed}/a.ts)` }), BLOCK);
  });
});
