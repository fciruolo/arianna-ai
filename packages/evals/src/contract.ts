// Contract of the claude -p and codex exec adapters against the real binaries
// (tasks 1.5 and 1.16, docs/EVALS.md): a trivial task, a file read in the
// workspace, a resumed session, a timeout. Consumes quota: `pnpm eval:live`
// only. The quota error cannot be caused on purpose; the tests check it on a
// recorded stream.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@arianna/config';
import {
  ClaudeError,
  CodexError,
  createClaudeExecutor,
  createCodexExecutor,
  prepareWorkspace,
  type ClaudeExecutor,
  type ClaudeTool,
  type CodexAccess,
  type CodexExecutor,
  type PreparedWorkspace,
} from '@arianna/executors';
import { createContext, createLabelRules, gatewayCheck, markLogged, secretMatcher, type Target } from '@arianna/policy';

import type { Evaluate } from './types.ts';

/** The cloud executors the live evals run. */
export const LIVE_EXECUTORS = ['claude', 'codex'] as const;
export type LiveExecutor = (typeof LIVE_EXECUTORS)[number];

export const liveTarget = (id: LiveExecutor): Target => ({ kind: 'executor', id, locality: 'cloud' });

/** A failure of either adapter, with what the evals read of it. */
export const isRunError = (error: unknown): error is ClaudeError | CodexError => error instanceof ClaudeError || error instanceof CodexError;

/** What the live evals read of arianna.toml: the enabled executors, ARIANNA_HOME and the data folder. */
export function liveConfig(): { executors: readonly string[]; home: string; data: string } {
  const config = loadConfig();
  return { executors: config.cloud.executors, home: config.home, data: config.paths.data };
}

export function requireEnabled(executors: readonly string[], id: LiveExecutor): void {
  if (!executors.includes(id)) {
    throw new Error(`${id} is not in [cloud] executors of config/arianna.toml: enable it with pnpm arianna:init --reconfigure`);
  }
}

export interface ContractStep {
  prompt: string;
  /** claude: the tools of the step. */
  tools?: ClaudeTool[];
  /** codex: what the step may do in the workspace; default read. */
  access?: CodexAccess;
  /** Resume the session of the previous step. */
  resume?: boolean;
  timeoutMs?: number;
}

export interface ContractInput {
  /** Default claude. */
  executor?: LiveExecutor;
  steps: ContractStep[];
}

export interface ContractStepActual {
  ok: boolean;
  /** Whether the workspace differs from its commit after the step. */
  changed: boolean;
  text?: string;
  error?: string;
  violations?: string[];
}

/** The fake repository the runs work in: L1 by its folder rule, in the allowlist. */
const README = '# Fake site\n\nA repository with fake content for the contract eval.\n';

export interface ScratchWorkspace {
  /** The scratch ARIANNA_HOME; removed by `remove`. */
  home: string;
  prepare: () => Promise<PreparedWorkspace>;
  remove: () => void;
}

/**
 * A fake ARIANNA_HOME under `data/evals/` with one allowlisted repository,
 * `repos/fixture` (L1), committed with `files` (README.md by default), and
 * `kb/private` as L2 for the canary.
 */
export function scratchWorkspace(data: string, files: Record<string, string> = { 'README.md': README }, name = 'contract'): ScratchWorkspace {
  const home = join(data, 'evals', `${name}-${randomUUID()}`);
  const repo = join(home, 'repos', 'fixture');
  mkdirSync(repo, { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--allow-empty', '--message', 'fixture');
  const rules = createLabelRules({
    folders: [
      { path: 'repos', label: 'L1' },
      { path: 'kb/private', label: 'L2' },
    ],
    sources: [],
  });
  return {
    home,
    prepare: () => prepareWorkspace({ home, data: join(home, 'data'), repo: 'repos/fixture', runId: name, allowlist: ['repos/fixture'], rules }),
    remove: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function changed(workspace: string): boolean {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const status = execFileSync('git', ['-C', workspace, 'status', '--porcelain', '--untracked-files=all'], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });
  return status.trim() !== '';
}

/** How the evaluator reaches each executor: built on first use, so that a disabled one fails only its own cases. */
export interface LiveExecutors {
  claude: () => ClaudeExecutor;
  codex?: () => CodexExecutor;
}

/** Runs the steps in one workspace, each prompt through the gateway as an L1 brief. */
export function createContractEvaluator(reach: LiveExecutors, data: () => string): Evaluate {
  return async (input) => {
    const { steps, executor: id = 'claude' } = input as ContractInput;
    const scratch = scratchWorkspace(data());
    try {
      const workspace = await scratch.prepare();
      const path = workspace.path;
      if (path === undefined) throw new Error('the contract workspace was blocked');
      const actual: ContractStepActual[] = [];
      let sessionRef: string | undefined;
      for (const step of steps) {
        const brief = gatewayCheck([{ value: step.prompt, label: 'L1', source: 'eval:contract' }], createContext('L1'), liveTarget(id), secretMatcher([]));
        // No database here: the eval stands in for passGateway's row.
        markLogged(brief);
        const limits = { timeoutMs: step.timeoutMs ?? 180_000, maxTurns: 10 };
        const resume = step.resume === true ? sessionRef : undefined;
        try {
          let result: { sessionRef: string; text: string };
          if (id === 'codex') {
            const codex = reach.codex?.();
            if (codex === undefined) throw new Error('the contract evaluator has no codex executor');
            const options = { brief, workspace, model: 'codex' as const, access: step.access ?? ('read' as const), limits };
            result = await (resume === undefined ? codex.start(options) : codex.resume({ ...options, sessionRef: resume })).result;
          } else {
            const options = { brief, workspace, model: 'sonnet' as const, tools: step.tools ?? [], limits };
            result = await (resume === undefined ? reach.claude().start(options) : reach.claude().resume({ ...options, sessionRef: resume })).result;
          }
          sessionRef = result.sessionRef;
          actual.push({ ok: true, changed: changed(path), text: result.text });
        } catch (error) {
          if (!isRunError(error)) throw error;
          sessionRef = error.sessionRef ?? sessionRef;
          actual.push({ ok: false, changed: changed(path), error: error.kind, ...(error.violations.length === 0 ? {} : { violations: [...error.violations] }) });
        }
      }
      return actual;
    } finally {
      scratch.remove();
    }
  };
}

/** The real binaries, each enabled only if `[cloud] executors` names it. */
export function contract(): Evaluate {
  let config: ReturnType<typeof liveConfig> | undefined;
  let claude: ClaudeExecutor | undefined;
  let codex: CodexExecutor | undefined;
  const ready = () => (config ??= liveConfig());
  return createContractEvaluator(
    {
      claude: () => {
        const { executors, home } = ready();
        requireEnabled(executors, 'claude');
        return (claude ??= createClaudeExecutor({ enabled: executors, home }));
      },
      codex: () => {
        const { executors, home } = ready();
        requireEnabled(executors, 'codex');
        return (codex ??= createCodexExecutor({ enabled: executors, home }));
      },
    },
    () => ready().data,
  );
}

const normalize = (text: string): string => text.trim().replace(/[.!]+$/, '').toLowerCase();

/**
 * Each step as expected: `{ text }` an answer equal to it (case, spaces and a
 * final full stop aside), `{ error }` a failure of that kind, `{ changed }`
 * the workspace changed or not (a write the permissions must refuse).
 */
export function matchesContract(actual: unknown, expect: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expect) || actual.length !== expect.length) return false;
  return expect.every((wanted: { text?: string; error?: string; changed?: boolean }, index) => {
    const got = actual[index] as ContractStepActual;
    if (wanted.changed !== undefined && got.changed !== wanted.changed) return false;
    if (wanted.error !== undefined) return !got.ok && got.error === wanted.error;
    return got.ok && (wanted.text === undefined || normalize(got.text ?? '') === normalize(wanted.text));
  });
}
