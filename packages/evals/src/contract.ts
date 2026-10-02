// Contract of the claude -p adapter against the real binary (task 1.5,
// docs/EVALS.md): a trivial task, a file read in the workspace, a resumed
// session, a timeout. Consumes quota: `pnpm eval:live` only. The quota error
// cannot be caused on purpose; the tests check it on a recorded stream.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '@arianna/config';
import {
  ClaudeError,
  createClaudeExecutor,
  prepareWorkspace,
  type ClaudeExecutor,
  type ClaudeTool,
  type PreparedWorkspace,
} from '@arianna/executors';
import { createContext, createLabelRules, gatewayCheck, markLogged, secretMatcher } from '@arianna/policy';

import type { Evaluate } from './types.ts';

export interface ContractStep {
  prompt: string;
  tools?: ClaudeTool[];
  /** Resume the session of the previous step. */
  resume?: boolean;
  timeoutMs?: number;
}

export interface ContractInput {
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

function scratchWorkspace(data: string): { prepare: () => Promise<PreparedWorkspace>; remove: () => void } {
  const home = join(data, 'evals', `contract-${randomUUID()}`);
  const repo = join(home, 'repos', 'fixture');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'README.md'), README);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
  const rules = createLabelRules({ folders: [{ path: 'repos', label: 'L1' }], sources: [] });
  return {
    prepare: () => prepareWorkspace({ home, data: join(home, 'data'), repo: 'repos/fixture', runId: 'contract', allowlist: ['repos/fixture'], rules }),
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

/** Runs the steps in one workspace, each prompt through the gateway as an L1 brief. */
export function createContractEvaluator(executor: () => ClaudeExecutor, data: () => string): Evaluate {
  return async (input) => {
    const { steps } = input as ContractInput;
    const scratch = scratchWorkspace(data());
    try {
      const workspace = await scratch.prepare();
      const path = workspace.path;
      if (path === undefined) throw new Error('the contract workspace was blocked');
      const actual: ContractStepActual[] = [];
      let sessionRef: string | undefined;
      for (const step of steps) {
        const brief = gatewayCheck([{ value: step.prompt, label: 'L1', source: 'eval:contract' }], createContext('L1'), { kind: 'executor', id: 'claude', locality: 'cloud' }, secretMatcher([]));
        // No database here: the eval stands in for passGateway's row.
        markLogged(brief);
        const options = {
          brief,
          workspace,
          model: 'sonnet' as const,
          tools: step.tools ?? [],
          limits: { timeoutMs: step.timeoutMs ?? 180_000, maxTurns: 10 },
        };
        const resume = step.resume === true ? sessionRef : undefined;
        try {
          const result = await (resume === undefined ? executor().start(options) : executor().resume({ ...options, sessionRef: resume })).result;
          sessionRef = result.sessionRef;
          actual.push({ ok: true, changed: changed(path), text: result.text });
        } catch (error) {
          if (!(error instanceof ClaudeError)) throw error;
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

/** The real binary, enabled only if `[cloud] executors` names it. */
export function contract(): Evaluate {
  let executor: ClaudeExecutor | undefined;
  let data = '';
  const ready = () => {
    if (executor === undefined) {
      const config = loadConfig();
      if (!config.cloud.executors.includes('claude')) {
        throw new Error('claude is not in [cloud] executors of config/arianna.toml: enable it with pnpm arianna:init --reconfigure');
      }
      executor = createClaudeExecutor({ enabled: config.cloud.executors });
      data = config.paths.data;
    }
    return executor;
  };
  return createContractEvaluator(ready, () => {
    ready();
    return data;
  });
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
