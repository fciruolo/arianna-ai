// A fake project container for trying I-11 (D-145) in development:
//   pnpm demo:container
// writes repos/progetto-test/ (outside git, like repos/demo) with the
// management folders Workplan, IM (with IM-32 and IM-33, D-167) and documenti
// holding invented notes, and
// two parts, progetto-test-admin and progetto-test-client, each its own git
// repository with one commit. Nothing real: every name and number is made up.
// An existing repos/progetto-test is left as it is.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveHome } from '@arianna/config';

function write(base: string, entries: Record<string, string>): void {
  for (const [path, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), content);
  }
}

const root = join(resolveHome(), 'repos', 'progetto-test');

// Two invented IM (D-167): the last one closed, the next one planned.
const ims: Record<string, string> = {
  'IM/IM-32.md': [
    '---', 'im: 32', 'data: 2026-10-08 10:00', 'stato: chiuso', '---', '',
    '# IM-32 · giovedì 8 ottobre 2026, 10:00', '',
    '## Lavori', '',
    '- [x] Pagamento con carta — Parte 1',
    '- [x] Pagina dei contratti: filtro per anno',
    '- [>] Esportazione degli ordini in CSV',
    '- [-] Tema scuro dell\'area riservata', '',
    '## Report', '',
    'Collegato il pagamento con carta (prima parte: carrello e conferma) e aggiunto il filtro per anno nella pagina dei contratti. L\'esportazione in CSV passa al prossimo incontro.', '',
    '## Note', '',
    '- Il cliente finto rinuncia al tema scuro per ora.',
    '- Per il prossimo IM chiede le fatture.', '',
  ].join('\n'),
  'IM/IM-33.md': [
    '---', 'im: 33', 'data: 2026-10-15 10:00', 'stato: previsto', '---', '',
    '# IM-33 · giovedì 15 ottobre 2026, 10:00', '',
    '## Lavori', '',
    '- [/] Pagamento con carta — Parte 2',
    '- [ ] Esportazione degli ordini in CSV',
    '- [ ] Fatture', '',
    '## Report', '',
    '## Note', '',
  ].join('\n'),
};

if (existsSync(root)) {
  // A container written before the IM: only the IM files that are missing are added.
  const missing = Object.fromEntries(Object.entries(ims).filter(([path]) => !existsSync(join(root, path))));
  write(root, missing);
  const added = Object.keys(missing).length;
  console.log(added === 0 ? `repos/progetto-test c'è già: lo lascio com'è.` : `repos/progetto-test c'è già: aggiunti ${String(added)} IM finti.`);
  process.exit(0);
}

const files: Record<string, string> = {
  'Workplan/piano-di-lavoro.md': '---\ntitle: "Piano di lavoro"\n---\n\nMilestone finte: pannello di amministrazione a maggio, portale clienti a giugno.\n',
  'Workplan/compensi.md': '---\nlabel: L2\ntitle: "Compensi"\n---\n\nNota privata inventata: preventivo di 1.234 euro al cliente finto Rossi Srl.\n',
  'IM/riunione-di-avvio.md': '---\ntitle: "Riunione di avvio"\n---\n\nIl cliente finto vuole il login con email e una pagina dei contratti.\n',
  ...ims,
  'documenti/contratto.md': '---\ntitle: "Contratto"\n---\n\nContratto inventato con Rossi Srl: durata dodici mesi.\n',
};
const parts: Record<string, Record<string, string>> = {
  'progetto-test-admin': { 'README.md': '# Pannello di amministrazione (finto)\n', 'package.json': '{ "name": "progetto-test-admin", "private": true, "scripts": { "saluta": "echo ciao dal pannello" } }\n' },
  'progetto-test-client': { 'README.md': '# Portale clienti (finto)\n', 'index.html': '<h1>Portale clienti finto</h1>\n' },
};

function git(cwd: string, ...args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  execFileSync('git', ['-c', 'user.name=Arianna', '-c', 'user.email=arianna@localhost', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: 'ignore',
  });
}

write(root, files);
for (const [part, entries] of Object.entries(parts)) {
  const dir = join(root, part);
  write(dir, entries);
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '--message', 'Inizio (dati finti)');
}
console.log('Scritto repos/progetto-test: Workplan, IM, documenti e due parti con il loro git.');
console.log('Per vederlo in Arianna: Impostazioni → Progetti, nome progetto-test, percorso repos/progetto-test, etichetta Interno.');
