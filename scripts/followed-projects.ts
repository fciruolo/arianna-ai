// The projects followed for ideas from the terminal (D-202), the same steps as
// Impostazioni → Sviluppo di Arianna → Progetti seguiti:
//   pnpm projects:followed [list]          the projects followed, the release last seen, the last news
//   pnpm projects:followed add <url>       follows https://github.com/<owner>/<repo> (reads nothing)
//   pnpm projects:followed remove <url>    stops following it and deletes what was kept
//   pnpm projects:followed check <url>     reads its releases from the public API of GitHub
// Only the name of the repository leaves, in the address, checked by the policy of
// the gateway; never a clone, never code of the project run. The command has no
// local model (the core groups the news with it): it writes the raw list by kind.
// The core and the command share a busy file per project.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import type { NewsGroup } from '../apps/core/src/design-news.ts';
import { CatalogError } from '../apps/core/src/git-catalog.ts';
import { createFollowedProjects, MAX_PROJECTS, type ProjectView } from '../apps/core/src/followed-projects.ts';
import { createGithubClient } from '../apps/core/src/github-api.ts';

const USAGE = 'Uso: pnpm projects:followed [list|add <url>|remove <url>|check <url>]';
const GROUP_TEXT: Record<NewsGroup, string> = { feat: 'Funzioni', fix: 'Correzioni', styles: 'Stili', skills: 'Skill', other: 'Altro' };

const projects = createFollowedProjects({
  dir: join(resolveHome(), 'data', 'catalogs'),
  get: createGithubClient(),
  gateway: (address) => {
    const decision = gatewayCheck([{ value: address, label: 'L0', source: 'cli:followed-projects' }], createContext('L0'), { kind: 'web' }, knownSecrets);
    return decision.decision === 'allow' ? Promise.resolve() : Promise.reject(new Error(`gateway ${decision.rule}: ${decision.reason}`));
  },
  noModel: 'dal terminale le novità non passano dal modello locale',
});

function print(list: ProjectView[], full: boolean): void {
  console.log(`Progetti seguiti (al più ${String(MAX_PROJECTS)} oltre a Open Design):`);
  for (const project of list) {
    if (project.catalog) {
      console.log(`${project.page} — col catalogo degli stili: novità con pnpm design:catalog update`);
      continue;
    }
    console.log(`${project.page}${project.seen === null ? ' — mai controllato' : ` — ultima release vista ${safe(project.seen)}`}`);
    if (project.checkedAt !== null) console.log(`  Ultimo controllo ${project.checkedAt}: ${safe(project.message ?? '')}`);
    const news = project.news;
    if (!full || news === null) continue;
    console.log(`  Novità ${safe(news.from ?? '?')} → ${safe(news.to)} (${news.source === 'model' ? 'raggruppate dal modello locale' : 'elenco dei commit'}):`);
    if (news.message !== null) console.log(`    ${safe(news.message)}`);
    let group: NewsGroup | null = null;
    for (const item of news.items) {
      if (item.group !== null && item.group !== group) {
        group = item.group;
        console.log(`    ${GROUP_TEXT[group]}:`);
      }
      console.log(`    - ${safe(item.title)}${item.summary === '' ? '' : `: ${safe(item.summary)}`} [${item.commits.map((commit) => commit.short).join(', ')}]`);
    }
    if (news.truncated) console.log(`    (${String(news.commits)} commit in tutto: elencati solo i più recenti)`);
    if (news.items.length > 0) console.log('    Per sceglierle: Impostazioni → Sviluppo di Arianna → Progetti seguiti.');
  }
}

const [command = 'list', url] = process.argv.slice(2);
try {
  if (command === 'list') {
    print(projects.list(), true);
  } else if (url === undefined) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (command === 'add') {
    projects.add(url);
    print(projects.list(), false);
  } else if (command === 'remove') {
    projects.remove(url);
    print(projects.list(), false);
  } else if (command === 'check') {
    projects.check(url);
    await projects.idle();
    print(projects.list(), true);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof CatalogError ? safe(error.message) : error);
  process.exitCode = 1;
}
