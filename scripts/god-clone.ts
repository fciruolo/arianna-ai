// The clone GOD works on (D-127):
//   pnpm god:clone
// creates repos/arianna/main from this repository (no network), or updates it:
// fetch from the installation and, when it is on main with nothing changed, a
// fast-forward. Refuses a clone that is not a development copy (data of an
// installation, the passwords of the database). Then says how to register the
// project `arianna` in Arianna, if it is not there yet.
import { join } from 'node:path';

import { sanitizeForTerminal as safe } from '@arianna/agents';
import { loadConfig, resolveHome, type AriannaConfig } from '@arianna/config';

import { GOD_CONTAINER, GOD_PROJECT, GodCloneError, syncGodClone } from '../apps/core/src/god/clone.ts';

const home = resolveHome();
let config: AriannaConfig | undefined;
try {
  config = loadConfig();
} catch {
  // Without config/arianna.toml (a fresh clone): the default data folder.
}
const data = config?.paths.data ?? join(home, 'data');

try {
  const { created, forwarded, state } = await syncGodClone(home, data);
  if (created) console.log(`Creato ${state.path}: clone di questo repository, solo ciò che è in git (niente data/, niente config/arianna.toml).`);
  else if (forwarded) console.log(`${state.path} aggiornato all'ultimo main dell'installazione.`);
  else console.log(`${state.path} c'è già: scaricati i commit nuovi${state.branch === undefined ? '' : `, ramo ${safe(state.branch)}`}${state.dirty !== undefined && state.dirty > 0 ? `, ${String(state.dirty)} file cambiati non toccati` : ''}.`);
  if (state.behind !== undefined && state.behind > 0) console.log(`Indietro di ${String(state.behind)} commit rispetto al main dell'installazione (il clone ha lavoro suo: aggiornalo a mano).`);
} catch (error) {
  if (!(error instanceof GodCloneError)) throw error;
  console.error(`Il clone di GOD non si può usare: ${safe(error.message)}`);
  process.exit(1);
}

const project = config?.projects.find((item) => item.name === GOD_PROJECT);
if (project === undefined) {
  console.log(`Per usarlo in Arianna: Impostazioni → Progetti, nome ${GOD_PROJECT}, percorso ${GOD_CONTAINER}, etichetta Interno. Poi la voce GOD nella barra laterale.`);
} else if (project.path !== GOD_CONTAINER) {
  console.log(`Attenzione: il progetto ${GOD_PROJECT} punta a ${safe(project.path)}, non a ${GOD_CONTAINER}: GOD lavora solo nel contenitore ${GOD_CONTAINER}.`);
} else {
  console.log(`Il progetto ${GOD_PROJECT} è registrato: la voce GOD nella barra laterale apre la sua chat.`);
}
