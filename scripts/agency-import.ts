// Read-only importer of the agency-agents catalog (D-079, first part):
//   pnpm agency:import                            the index only
//   pnpm agency:import --propose <slug> [...]     also these proposals
//   pnpm agency:import --propose-all              also a proposal for every agent
//   ... --force                                   regenerate existing proposals
// Reads the clone in data/catalogs/agency-agents/ (made by the user), writes
// data/catalogs/agency-agents.index.json and the proposals in
// data/agency/proposed/ (L2, like all of data/). Never writes into agents/,
// never runs anything from the clone, never touches the network.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  AGENCY_CLONE_DIR,
  AGENCY_INDEX_FILE,
  AGENCY_PROPOSED_DIR,
  AgencyError,
  readAgencyLock,
  readCloneHead,
  sanitizeForTerminal as safe,
  scanCatalog,
  verifyCloneHead,
  writeAgencyIndex,
  writeProposals,
} from '@arianna/agents';
import { resolveHome } from '@arianna/config';

const USAGE = 'Uso: pnpm agency:import [--propose <slug> ...] [--propose-all] [--force]';

let parsed;
try {
  parsed = parseArgs({
    options: {
      propose: { type: 'string', multiple: true },
      'propose-all': { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
const { values } = parsed;
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

const home = resolveHome();
const clone = join(home, AGENCY_CLONE_DIR);

try {
  const lock = readAgencyLock(home);
  if (!existsSync(clone)) {
    console.error(
      [
        `Manca il clone del catalogo in ${AGENCY_CLONE_DIR}/.`,
        'Lo fai tu (serve la rete), una volta, dalla cartella di Arianna:',
        `  git clone ${lock.repository} ${AGENCY_CLONE_DIR}`,
        `  git -C ${AGENCY_CLONE_DIR} checkout ${lock.commit}`,
        `Poi completa lo sha in config/agency.lock con quello di \`git -C ${AGENCY_CLONE_DIR} rev-parse HEAD\`:\nfinché il lock ha lo sha corto l'importazione rifiuta. Infine rilancia pnpm agency:import.`,
        'Nessuno script del repository va eseguito: serve solo il testo.',
      ].join('\n'),
    );
    process.exit(1);
  }
  const head = readCloneHead(clone);
  // Refuses another commit, and a lock not yet completed with the full sha.
  verifyCloneHead(head, lock);
  const origin = { repository: lock.repository, commit: head };

  const scan = scanCatalog(clone);
  const index = writeAgencyIndex(join(home, AGENCY_INDEX_FILE), scan, origin);
  console.log(`Indice: ${String(index.agents.length)} agenti in ${String(scan.divisions.length)} divisioni, scritto in ${AGENCY_INDEX_FILE}.`);
  if (scan.rejected.length > 0) {
    console.log(`Scartati ${String(scan.rejected.length)} file:`);
    for (const { path, reason } of scan.rejected) console.log(`  ${safe(path)}: ${safe(reason)}`);
  }
  if (scan.skipped.length > 0) console.log(`Ignorati (link simbolici o file speciali): ${scan.skipped.map(safe).join(', ')}`);

  const wanted = values['propose-all'] === true ? scan.entries : scan.entries.filter((entry) => values.propose?.includes(entry.slug));
  const missing = (values.propose ?? []).filter((slug) => !scan.entries.some((entry) => entry.slug === slug));
  if (missing.length > 0) {
    console.error(`Non nel catalogo: ${missing.map(safe).join(', ')}`);
    process.exit(1);
  }
  if (wanted.length > 0) {
    const result = writeProposals(home, join(home, AGENCY_PROPOSED_DIR), wanted, origin, { force: values.force === true });
    if (result.written.length > 0) {
      console.log(`Proposte (disattivate, da approvare) in ${AGENCY_PROPOSED_DIR}/: ${result.written.join(', ')}`);
    }
    const reasons: Record<string, string> = {
      'an active card in agents/ has this name': 'esiste già una scheda attiva con questo nome in agents/',
      'a proposal already exists (--force regenerates it)': 'la proposta esiste già (--force la rigenera)',
    };
    for (const { slug, reason } of result.skipped) console.log(`  saltata ${safe(slug)}: ${reasons[reason] ?? safe(reason)}`);
  }
} catch (error) {
  if (!(error instanceof AgencyError)) throw error;
  console.error(`Importazione rifiutata: ${safe(error.message)}`);
  process.exit(1);
}
