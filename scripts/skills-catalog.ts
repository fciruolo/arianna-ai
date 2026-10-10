// The catalog of skills from the terminal (D-161), the same steps as Impostazioni → Agenti:
//   pnpm skills:catalog [list]          the sources followed, what is adopted and what waits
//   pnpm skills:catalog add <url>       follows https://github.com/<owner>/<repo> (downloads nothing)
//   pnpm skills:catalog remove <url>    stops following it and deletes its files
//   pnpm skills:catalog update <url>    downloads its newest commit (only SKILL.md and licenses)
//   pnpm skills:catalog adopt <url>     adopts the version waiting
//   pnpm skills:catalog discard <url>   deletes the version waiting
// Only the address of the repository leaves, checked by the policy of the gateway;
// nothing of the clone runs. The core and the command share the busy file of each
// source: while one downloads, adopts or discards, the other refuses.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { CatalogError } from '../apps/core/src/git-catalog.ts';
import { createSkillsCatalog, parseSourceUrl, type SkillsStatus } from '../apps/core/src/skills-catalog.ts';

const USAGE = 'Uso: pnpm skills:catalog [list|add <url>|remove <url>|update <url>|adopt <url>|discard <url>]';

const catalog = createSkillsCatalog({
  dir: join(resolveHome(), 'data', 'catalogs'),
  recover: false,
  gateway: (repository) => {
    const decision = gatewayCheck([{ value: repository, label: 'L0', source: 'cli:skills-catalog' }], createContext('L0'), { kind: 'web' }, knownSecrets);
    return decision.decision === 'allow' ? Promise.resolve() : Promise.reject(new Error(`${decision.rule}: ${decision.reason}`));
  },
});

function print(status: SkillsStatus): void {
  if (status.sources.length === 0) console.log('Nessuna sorgente di skill seguita.');
  for (const source of status.sources) {
    const license = source.license?.name ?? (source.license?.file === null || source.license === null ? 'nessuna licenza alla radice' : `vedi ${source.license.file}`);
    console.log(`${source.page}${source.readOnly ? ' (si aggiorna con pnpm design:catalog)' : ''} — ${safe(license)}`);
    if (source.adopted === null) console.log('  In uso: nessuna versione (non ancora scaricata)');
    else console.log(`  In uso: commit ${source.adopted.commit.slice(0, 12)} del ${source.adopted.committedAt ?? '?'}, ${String(source.adopted.skills)} skill`);
    if (source.pending !== null) {
      const { diff } = source.pending;
      console.log(`  In attesa: commit ${source.pending.commit.slice(0, 12)}, ${String(source.pending.skills)} skill (${String(source.pending.rejected)} file scartati)`);
      console.log(`    ${String(diff.added)} nuove, ${String(diff.changed)} cambiate, ${String(diff.removed)} tolte`);
      console.log(`    pnpm skills:catalog adopt ${source.page} per usarla, discard per scartarla`);
    }
    if (source.job?.status === 'failed') console.log(`  Ultimo download non riuscito: ${safe(source.job.error ?? '')}`);
  }
  if (status.suggestions.length > 0) console.log(`Suggerite: ${status.suggestions.map((item) => item.page).join(', ')}`);
}

const [command = 'list', url] = process.argv.slice(2);
try {
  if (command === 'list' || command === 'status') {
    print(catalog.status());
  } else if (url === undefined) {
    console.error(USAGE);
    process.exitCode = 2;
  } else if (command === 'add') {
    print(catalog.add(url));
  } else if (command === 'remove') {
    print(catalog.remove(url));
  } else if (command === 'update') {
    const started = Date.now();
    catalog.update(url);
    await catalog.idle();
    const id = parseSourceUrl(url).id;
    const source = catalog.status().sources.find((item) => item.id === id);
    if (source?.job?.status === 'failed') throw new CatalogError('failed', source.job.error ?? 'download failed');
    console.log(source?.job?.outcome === 'unchanged' ? 'Nessuna novità: la versione in uso è la più recente.' : `Scaricato in ${String(Math.round((Date.now() - started) / 1000))} s.`);
    print(catalog.status());
  } else if (command === 'adopt') {
    const id = parseSourceUrl(url).id;
    print(catalog.adopt(url, catalog.status().sources.find((item) => item.id === id)?.pending?.commit));
  } else if (command === 'discard') {
    print(catalog.discard(url));
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof CatalogError ? safe(error.message) : error);
  process.exitCode = 1;
}
