// The catalog of skills from the terminal (D-161), the same steps as Impostazioni → Agenti:
//   pnpm skills:catalog [list]          the sources followed, what is adopted and what waits
//   pnpm skills:catalog add <url>       follows https://github.com/<owner>/<repo> (downloads nothing)
//   pnpm skills:catalog remove <url>    stops following it and deletes its files
//   pnpm skills:catalog update <url>    downloads its newest commit (only SKILL.md and licenses)
//   pnpm skills:catalog adopt <url>     adopts the version waiting
//   pnpm skills:catalog discard <url>   deletes the version waiting
//   pnpm skills:catalog import-claude   copies (again) your own skills of Claude Code: SKILL.md and licenses only (D-255)
//   pnpm skills:catalog remove-claude   deletes that copy
//   pnpm skills:catalog share-claude <slug>     marks one of them shareable with the agents in the cloud (L1)
//   pnpm skills:catalog private-claude <slug>   makes it private again (L2, the default)
// Your own skills are read from the skills folder of the configuration of Claude Code (CLAUDE_CONFIG_DIR, else .claude
// in the home); only names and counts are printed, never a text.
// Only the address of the repository leaves, checked by the policy of the gateway;
// nothing of the clone runs. The core and the command share the busy file of each
// source: while one downloads, adopts or discards, the other refuses.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { resolveHome, userHomeOf } from '@arianna/config';

import type { ClaudeSkillsStatus } from '../apps/core/src/claude-skills.ts';

import { cliWebGateway } from '../apps/core/src/cli-gateway.ts';
import { CatalogError } from '../apps/core/src/git-catalog.ts';
import { createSkillsCatalog, parseSourceUrl, type SkillsStatus } from '../apps/core/src/skills-catalog.ts';

const USAGE = 'Uso: pnpm skills:catalog [list|add <url>|remove <url>|update <url>|adopt <url>|discard <url>|import-claude|remove-claude|share-claude <slug>|private-claude <slug>]';

const catalog = createSkillsCatalog({
  dir: join(resolveHome(), 'data', 'catalogs'),
  recover: false,
  gateway: (repository) => cliWebGateway(repository, 'cli:skills-catalog'),
  claudeConfig: { env: process.env, home: userHomeOf() },
});
const claude = catalog.claude;

/** Your own skills of Claude Code: names, counts and labels, never a text (D-255). */
function printClaude(status: ClaudeSkillsStatus): void {
  if (!status.imported) {
    console.log('Claude Code (le tue skill): non importate. pnpm skills:catalog import-claude per copiarle.');
    return;
  }
  const shared = status.skills.filter((skill) => skill.label === 'L1').length;
  console.log(`Claude Code (le tue skill) — ${String(status.skills.length)} skill, ${String(shared)} condivisibili col cloud, importate il ${status.importedAt ?? '?'}`);
  for (const skill of status.skills) console.log(`  ${safe(skill.slug)} — ${skill.label === 'L1' ? 'condivisibile (L1)' : 'privata (L2)'}`);
  if (status.rejected.length > 0) console.log(`  ${String(status.rejected.length)} cartelle scartate: ${status.rejected.map((item) => `${safe(item.path)} (${safe(item.reason)})`).join(', ')}`);
}

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
  for (const item of status.ignored) console.log(`Ignorata in sources.json: ${safe(item.entry)} (${safe(item.reason)})`);
  if (status.suggestions.length > 0) console.log(`Suggerite: ${status.suggestions.map((item) => item.page).join(', ')}`);
}

const [command = 'list', url] = process.argv.slice(2);
try {
  if (command === 'list' || command === 'status') {
    print(catalog.status());
    if (claude !== undefined) printClaude(claude.status());
  } else if (command === 'import-claude' && claude !== undefined) {
    printClaude(claude.import());
  } else if (command === 'remove-claude' && claude !== undefined) {
    printClaude(claude.remove());
    console.log('Copia tolta: la cartella di Claude Code resta com’è.');
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
  } else if ((command === 'share-claude' || command === 'private-claude') && claude !== undefined) {
    // From the terminal the text in the copy now is the one shared: `pnpm skills:catalog` shows it in the page to read first.
    printClaude(claude.share(url, command === 'share-claude', claude.status().skills.find((skill) => skill.slug === url)?.sha256));
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof CatalogError ? safe(error.message) : error);
  process.exitCode = 1;
}
