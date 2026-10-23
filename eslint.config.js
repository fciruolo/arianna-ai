import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**', 'data/**', 'repos/**', 'kb/inbox/**', 'kb/progetti/**', '.claude/worktrees/**'] },
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
    // D-301: no-unsafe-enum-assignment walks every receiver type deeply: half of the rules' time, a third of
    // `pnpm lint`. It can only report where an enum type is reachable. Our own code has none (erasableSyntaxOnly
    // rejects `enum` in both tsconfigs) and no package imported outside the web chat has one in its types;
    // the web chat keeps the rule for three and vue. test/lint-scope.test.ts fails as soon as an enum type
    // can reach the code outside apps/hud: then this block must go. That test imports typescript (enums),
    // so the rule stays on for it.
    files: ['**/*.{ts,mts,cts}'],
    ignores: ['apps/hud/**', 'test/lint-scope.test.ts'],
    rules: { '@typescript-eslint/no-unsafe-enum-assignment': 'off' },
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
