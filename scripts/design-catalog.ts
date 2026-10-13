// The catalog of Open Design from the terminal (D-160), the same steps as Impostazioni → Agenti:
//   pnpm design:catalog [status]    what is adopted and what waits, with the comparison
//   pnpm design:catalog update      downloads the newest commit into data/catalogs/open-design.next
//   pnpm design:catalog adopt       adopts the version waiting (swap of the folders, lock)
//   pnpm design:catalog discard     deletes the version waiting
// Only the fixed address of the repository leaves, checked by the policy of the
// gateway; nothing of the clone runs. After an update with a new version, the news
// of Open Design (I-21, D-186) from the public API of GitHub, as the raw list by kind. The core and the command share the busy file
// data/catalogs/open-design.busy: while one downloads, adopts or discards, the other
// refuses; `status` only reads and repairs nothing.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { createDesignCatalog, DesignCatalogError, type CatalogStatus, type KindChanges } from '../apps/core/src/design-catalog.ts';
import type { DesignNews, NewsGroup } from '../apps/core/src/design-news.ts';
import { createGithubClient } from '../apps/core/src/github-api.ts';

const USAGE = 'Uso: pnpm design:catalog [status|update|adopt|discard]';

/** Only the policy check from the command, as for the repository: the address is all that leaves. */
function webGateway(source: string): (address: string) => Promise<void> {
  return (address) => {
    const decision = gatewayCheck([{ value: address, label: 'L0', source }], createContext('L0'), { kind: 'web' }, knownSecrets);
    return decision.decision === 'allow' ? Promise.resolve() : Promise.reject(new Error(`${decision.rule}: ${decision.reason}`));
  };
}

const catalog = createDesignCatalog({
  dir: join(resolveHome(), 'data', 'catalogs'),
  recover: false,
  gateway: webGateway('cli:design-catalog'),
  // The news of Open Design (I-21, D-186): from the public API of GitHub; the command has no
  // local model (the core groups them with it), so it writes the raw list by kind.
  news: { get: createGithubClient(), gateway: webGateway('cli:design-news'), noModel: 'dal terminale le novità non passano dal modello locale' },
});

const GROUP_TEXT: Record<NewsGroup, string> = { feat: 'Funzioni', fix: 'Correzioni', styles: 'Stili', skills: 'Skill', other: 'Altro' };

function printNews(news: DesignNews | null): void {
  if (news === null) return;
  console.log(`Novità di Open Design (${news.source === 'model' ? 'raggruppate dal modello locale' : 'elenco dei commit'}):`);
  if (news.message !== null) console.log(`  ${safe(news.message)}`);
  for (const release of news.releases) console.log(`  Rilascio ${safe(release.name)} (${release.publishedAt ?? '?'})`);
  let group: NewsGroup | null = null;
  for (const item of news.items) {
    if (item.group !== null && item.group !== group) {
      group = item.group;
      console.log(`  ${GROUP_TEXT[group]}:`);
    }
    console.log(`  - ${safe(item.title)}${item.summary === '' ? '' : `: ${safe(item.summary)}`} [${item.commits.map((commit) => commit.short).join(', ')}]`);
  }
  if (news.truncated) console.log(`  (${String(news.commits)} commit in tutto: elencati solo i più recenti)`);
  if (news.items.length > 0) console.log('  Per sceglierle: Impostazioni → Sviluppo di Arianna → Novità di Open Design.');
}

function changesText(changes: KindChanges, noun: string): string {
  return `${String(changes.added)} ${noun} nuovi, ${String(changes.changed)} cambiati, ${String(changes.removed)} tolti`;
}

function print(status: CatalogStatus): void {
  console.log(`Repository: ${status.page} (licenza ${status.license.name}${status.license.copyright === null ? '' : `, ${safe(status.license.copyright)}`})`);
  if (status.adopted === null) console.log('In uso: nessuna versione (il catalogo non è ancora stato scaricato)');
  else console.log(`In uso: commit ${status.adopted.commit.slice(0, 12)} del ${status.adopted.committedAt ?? '?'}, ${String(status.adopted.styles)} stili e ${String(status.adopted.skills)} skill, adottato il ${status.adopted.adoptedAt}`);
  if (status.pending !== null) {
    const { pending } = status;
    console.log(`In attesa: commit ${pending.commit.slice(0, 12)} del ${pending.committedAt ?? '?'}, ${String(pending.styles)} stili e ${String(pending.skills)} skill (${String(pending.rejected)} file scartati)`);
    console.log(`  ${changesText(pending.diff.styles, 'stili')}`);
    console.log(`  ${changesText(pending.diff.skills, 'skill')}`);
    console.log('  pnpm design:catalog adopt per usarla, discard per scartarla');
    printNews(pending.news);
  }
  if (status.job?.status === 'failed') console.log(`Ultimo download non riuscito: ${safe(status.job.error ?? '')}`);
}

const command = process.argv[2] ?? 'status';
try {
  if (command === 'status') {
    print(catalog.status());
  } else if (command === 'update') {
    const started = Date.now();
    catalog.update();
    await catalog.idle();
    const status = catalog.status();
    if (status.job?.status === 'failed') throw new DesignCatalogError('failed', status.job.error ?? 'download failed');
    console.log(status.job?.outcome === 'unchanged' ? 'Nessuna novità: la versione in uso è la più recente.' : `Scaricato in ${String(Math.round((Date.now() - started) / 1000))} s.`);
    print(status);
  } else if (command === 'adopt') {
    print(catalog.adopt(catalog.status().pending?.commit));
  } else if (command === 'discard') {
    print(catalog.discard());
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof DesignCatalogError ? safe(error.message) : error);
  process.exitCode = 1;
}
