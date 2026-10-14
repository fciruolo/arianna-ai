// The characters of pixel-agents from the terminal (D-206), the same step as the
// button of Impostazioni → Agenti → Aspetto:
//   pnpm characters:pixel-agents   downloads their PNG sheets and licence into data/characters/pixel-agents
// Only the name of the repository leaves, in the address, checked by the policy of
// the gateway; nothing else of the repository is read or run. The drawings are for
// personal use only: data/ is out of git, and the pack goes before sharing the folder.
import { join } from 'node:path';

import { resolveHome } from '@arianna/config';

import { cliWebGateway } from '../apps/core/src/cli-gateway.ts';
import { createGithubClient, GithubError } from '../apps/core/src/github-api.ts';
import { downloadPixelAgents, PIXEL_AGENTS_PACK } from '../apps/core/src/pixel-agents-pack.ts';

if (process.argv.length > 2) {
  console.error('Uso: pnpm characters:pixel-agents');
  process.exit(2);
}

const home = resolveHome();
try {
  const result = await downloadPixelAgents({
    dirs: { original: join(home, 'apps', 'hud', 'characters', 'originali'), data: join(home, 'data', 'characters') },
    get: createGithubClient(),
    gateway: (address) => cliWebGateway(address, 'cli:pixel-agents'),
  });
  console.log(`${result.replaced ? 'Aggiornati' : 'Scaricati'} ${String(result.characters)} personaggi in data/characters/${PIXEL_AGENTS_PACK}, con la licenza.`);
  console.log('Solo per uso personale: da togliere prima di condividere la cartella. Si assegnano in Impostazioni → Agenti → Aspetto.');
  process.exit(0);
} catch (error) {
  const limited = error instanceof GithubError && error.code === 'limited';
  console.error(limited ? 'GitHub limita le richieste senza account (60 l’ora): riprova fra un’ora.' : `Download non riuscito: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
