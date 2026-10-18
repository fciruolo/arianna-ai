import { loadConfig, type AriannaConfig } from '@arianna/config';

/**
 * `config/arianna.toml` whose only role is a local orchestrator, in place of
 * the `[roles]` of this installation: `pnpm arianna:init --defaults` writes
 * none (D-048), and without it the router has no local candidate, so a
 * delegation to an agent on the local model closes with "no local model can
 * take this step now". The id is not served by anything: the tests answer
 * with a scripted model.
 */
export function configWithLocalModel(): AriannaConfig {
  return { ...loadConfig(), roles: { orchestrator: 'test-orchestrator' } };
}
