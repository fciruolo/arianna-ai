import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', 'data/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // node:test's test/describe/it/suite return promises that are safe to ignore.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
    },
  },
  {
    // Worklet and service worker of the web chat (D-066): plain scripts with their own globals.
    files: ['apps/hud/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { AudioWorkletProcessor: 'readonly', registerProcessor: 'readonly', self: 'readonly', clients: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
  },
  {
    // Claude Code hook scripts: plain CommonJS (see .claude/hooks/package.json).
    files: ['.claude/hooks/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', process: 'readonly', console: 'readonly', __dirname: 'readonly' },
    },
  },
);
