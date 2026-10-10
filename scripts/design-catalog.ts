// The catalog of Open Design from the terminal (D-160), the same steps as Impostazioni → Agenti:
//   pnpm design:catalog [status]    what is adopted and what waits, with the comparison
//   pnpm design:catalog update      downloads the newest commit into data/catalogs/open-design.next
//   pnpm design:catalog adopt       adopts the version waiting (swap of the folders, lock)
//   pnpm design:catalog discard     deletes the version waiting
// Only the fixed address of the repository leaves, checked by the policy of the
// gateway; nothing of the clone runs. Run it while the core is not downloading too.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { resolveHome } from '@arianna/config';
import { createContext, gatewayCheck } from '@arianna/policy';
import { knownSecrets } from '@arianna/vault';

import { createDesignCatalog, DesignCatalogError, type CatalogStatus, type KindChanges } from '../apps/core/src/design-catalog.ts';

const USAGE = 'Uso: pnpm design:catalog [status|update|adopt|discard]';

const catalog = createDesignCatalog({
  dir: join(resolveHome(), 'data', 'catalogs'),
  gateway: (repository) => {
    const decision = gatewayCheck([{ value: repository, label: 'L0', source: 'cli:design-catalog' }], createContext('L0'), { kind: 'web' }, knownSecrets);
    return decision.decision === 'allow' ? Promise.resolve() : Promise.reject(new Error(`${decision.rule}: ${decision.reason}`));
  },
});

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
