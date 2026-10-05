// `@arianna/evals/library` (D-081): what the core needs to run a trial of a
// model, without the live groups (contract, canary) that launch `claude`.
export { casesFingerprint, loadCases } from './cases.ts';
export { createOrchestratorGroup, type OrchestratorGroupOptions } from './orchestrator-group.ts';
export { caseErrorCode, runGroup, type RunHooks } from './runner.ts';
export { TRIAL_ALIAS, trialEndpoints } from './trial.ts';
export type { CaseResult, EvalCase, EvalGroup, GroupReport } from './types.ts';
