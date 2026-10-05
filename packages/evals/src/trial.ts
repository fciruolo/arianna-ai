import type { LocalEndpointConfig } from '@arianna/config';

/** The alias the orchestrator cases ask for (`createOrchestratorEvaluator`). */
export const TRIAL_ALIAS = 'local-large';

/**
 * The endpoints of a trial of a catalog model (D-081): those of arianna.toml
 * that serve `local-large` (all of them when none does), with that alias, and
 * only it, on the candidate. Used by the core and by `--model` of the CLI.
 */
export function trialEndpoints(endpoints: readonly LocalEndpointConfig[], modelId: string): LocalEndpointConfig[] {
  const serving = endpoints.filter((endpoint) => endpoint.models[TRIAL_ALIAS] !== undefined);
  return (serving.length > 0 ? serving : endpoints).map(({ id, url }) => ({ id, url, models: { [TRIAL_ALIAS]: modelId } }));
}
