// The catalog of agents from the terminal (D-079), the same steps as the
// section «Catalogo agenti» of the settings:
//   pnpm agents:catalog [list]          the sources followed, what is adopted and what waits
//   pnpm agents:catalog add <url>       follows https://github.com/<owner>/<repo> (downloads nothing)
//   pnpm agents:catalog remove <url>    stops following it and deletes its files
//   pnpm agents:catalog update <url>    downloads its newest commit (only the role files and the license)
//   pnpm agents:catalog adopt <url>     adopts the version waiting
//   pnpm agents:catalog discard <url>   deletes the version waiting
// Only the address of the repository leaves, checked by the policy of the
// gateway; nothing of the clone runs. The core and the command share the busy
// file of each source: while one downloads, adopts or discards, the other refuses.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { createAgentsCatalog, type AgentsStatus } from '../apps/core/src/agents-catalog.ts';
import { CatalogError } from '../apps/core/src/git-catalog.ts';
import { parseSourceUrl } from '../apps/core/src/source-catalogs.ts';

const USAGE = 'Uso: pnpm agents:catalog [list|add <url>|remove <url>|update <url>|adopt <url>|discard <url>]';

const catalog = createAgentsCatalog({
  dir: join(resolveHome(), 'data', 'catalogs'),
  recover: false,
  gateway: (repository) => {
    const decision = gatewayCheck([{ value: repository, label: 'L0', source: 'cli:agents-catalog' }], createContext('L0'), { kind: 'web' }, knownSecrets);
    return decision.decision === 'allow' ? Promise.resolve() : Promise.reject(new Error(`${decision.rule}: ${decision.reason}`));
  },
});

const MIB = 1024 * 1024;

/** The divisions of the roles in use, with how many each. */
function divisionsOf(source: string): string {
  const counts = new Map<string, number>();
  for (const role of catalog.list().roles) if (role.source === source) counts.set(role.division, (counts.get(role.division) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([division, count]) => `${safe(division)} ${String(count)}`)
    .join(', ');
}

function print(status: AgentsStatus): void {
  if (status.sources.length === 0) console.log('Nessuna sorgente di agenti seguita.');
  for (const source of status.sources) {
    // Before the first download nothing is known of the license: no warning yet.
    const license =
      source.license === null
        ? 'licenza: si saprà al primo download'
        : (source.license.name ?? (source.license.file === null ? 'ATTENZIONE: nessuna licenza alla radice' : `vedi ${source.license.file}`));
    console.log(`${source.page} — ${safe(license)}`);
    if (source.adopted === null) console.log('  In uso: nessuna versione (non ancora scaricata)');
    else {
      console.log(`  In uso: commit ${source.adopted.commit.slice(0, 12)} del ${source.adopted.committedAt ?? '?'}, ${String(source.adopted.roles)} ruoli in ${String(source.adopted.divisions)} divisioni`);
      const divisions = divisionsOf(source.id);
      if (divisions !== '') console.log(`    ${divisions}`);
      if (source.adopted.rejected > 0) console.log(`    ${String(source.adopted.rejected)} file scartati`);
    }
    if (source.pending !== null) {
      const { diff } = source.pending;
      console.log(`  In attesa: commit ${source.pending.commit.slice(0, 12)}, ${String(source.pending.roles)} ruoli (${String(source.pending.rejected)} file scartati)`);
      console.log(`    ${String(diff.added)} nuovi, ${String(diff.changed)} modificati, ${String(diff.removed)} tolti`);
      console.log(`    pnpm agents:catalog adopt ${source.page} per usarla, discard per scartarla`);
    }
    if (source.queued) console.log('  In coda: scarica appena finisce il download in corso');
    if (source.queueError !== null) console.log(`  Uscita dalla coda senza scaricare: ${safe(source.queueError)}`);
    if (source.job?.status === 'failed') console.log(`  Ultimo download non riuscito: ${safe(source.job.error ?? '')}`);
  }
  for (const item of status.ignored) console.log(`Ignorata in sources.json: ${safe(item.entry)} (${safe(item.reason)})`);
  if (status.suggestions.length > 0) console.log(`Suggerite: ${status.suggestions.map((item) => item.page).join(', ')}`);
  const { limits } = status;
  console.log(`Sorgenti ${String(limits.sources)} su ${String(limits.maxSources)}; spazio ${(limits.bytes / MIB).toFixed(1)} MiB su ${String(Math.round(limits.maxBytes / MIB))} MiB.`);
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
    const pending = catalog.status().sources.find((item) => item.id === id)?.pending;
    if (pending === null || pending === undefined) throw new CatalogError('not-found', 'nessuna versione in attesa: prima pnpm agents:catalog update');
    print(catalog.adopt(url, pending.commit));
  } else if (command === 'discard') {
    print(catalog.discard(url));
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  if (!(error instanceof CatalogError)) throw error;
  console.error(`Rifiutato: ${safe(error.message)}`);
  process.exitCode = 1;
}
