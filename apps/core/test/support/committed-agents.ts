import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { AGENTS_DIR, loadAgents, type LoadedAgent } from '@arianna/agents';

/**
 * The cards of agents/ that git tracks, loaded as the core loads them. An
 * agent promoted from the Agents page (D-119) and not committed sits next to
 * them on this machine only: the tests are about the repository's cards.
 */
export function committedAgents(home: string): Map<string, LoadedAgent> {
  const listed = execFileSync('git', ['-C', home, 'ls-files', '--', `${AGENTS_DIR}/*.yaml`], { encoding: 'utf8' });
  const tracked = new Set(listed.split('\n').flatMap((line) => /\/([a-z][a-z0-9-]*)\.yaml$/.exec(line)?.[1] ?? []));
  return new Map([...loadAgents(join(home, AGENTS_DIR))].filter(([name]) => tracked.has(name)));
}
