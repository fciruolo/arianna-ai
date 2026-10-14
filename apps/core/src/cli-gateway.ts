import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILE, loadConfig, resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { cliPiiGuard, type PiiGuard } from './pii-guard.ts';

let guard: PiiGuard | undefined;

/**
 * The gateway of a command of the terminal that reads from GitHub (catalogs,
 * followed projects, characters): one L0 address or repository name towards
 * the web, checked as the core checks it, second scanner included (D-113).
 * There is no gateway_log without the core: a block rejects with its rule.
 */
export async function cliWebGateway(value: string, source: string): Promise<void> {
  if (guard === undefined) {
    const home = resolveHome();
    guard = cliPiiGuard(existsSync(join(home, CONFIG_FILE)) ? loadConfig() : undefined);
  }
  const decision = gatewayCheck([{ value, label: 'L0', source }], createContext('L0'), { kind: 'web' }, knownSecrets, await guard.scan([value]));
  if (decision.decision !== 'allow') throw new Error(`gateway ${decision.rule}: ${decision.reason}`);
}
