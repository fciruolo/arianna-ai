// The certificate of the remote port in mode tls = "own" (D-292), run by hand:
//   pnpm remote:cert [--force]
// reads [server.remote].host of arianna.toml, makes with the system's openssl
// a root EC P-256 that can sign only for that name, signs the leaf of the
// name, erases the root's private key and leaves in data/remote/ the leaf,
// its key (0600) and the public root for the iPhone. Refuses while the
// current certificate is valid for more than 60 days, unless --force.
import { readFileSync } from 'node:fs';

import { loadConfigOrExit, remotePaths } from '@arianna/config';

import { findOpenssl, generateCertificate, loadRemoteTls, renewRefusal } from '../apps/core/src/remote-cert.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--force')) fail('Uso: pnpm remote:cert [--force]');
const force = args.includes('--force');

const config = loadConfigOrExit();
const remote = config.server.remote;
if (remote === undefined) fail('Manca [server.remote] in config/arianna.toml: scrivi prima host (il nome *.ts.net del Mac), poi rilancia. Passi in docs/SECURITY.md.');
if (remote.tls !== 'own') fail('Con tls = "tailscale" il certificato lo fa Tailscale: questo comando serve solo con tls = "own".');

const paths = remotePaths(config.paths.data);
let existing: string | undefined;
try {
  existing = readFileSync(paths.cert, 'utf8');
} catch {
  existing = undefined;
}
const now = new Date();
const refusal = renewRefusal(existing, now, force);
if (refusal !== undefined) fail(refusal);

try {
  generateCertificate({ openssl: findOpenssl(), paths, host: remote.host, now });
} catch (error) {
  // Only the kind: the output of openssl stays out of the terminal log.
  fail(`openssl non è riuscito (${error instanceof Error ? error.name : 'errore'}): nessun certificato scritto, i file temporanei sono stati cancellati.`);
}
const check = loadRemoteTls(paths, remote.host, now);
if (!check.ok) fail(`Il certificato scritto non passa il controllo: ${check.problem}`);

console.log(`Certificato per ${remote.host} scritto in data/remote (vale ${String(check.daysLeft)} giorni). La chiave della radice è stata cancellata.`);
console.log('');
console.log('Sull\'iPhone:');
console.log(`  1. Manda data/remote/arianna-root.crt all'iPhone con AirDrop e apri il file: iOS dice «Profilo scaricato».`);
console.log('  2. Impostazioni → Profilo scaricato → Installa (codice dell\'iPhone).');
console.log('  3. Impostazioni → Generali → Info → Impostazioni attendibilità certificati → attiva la radice «Arianna root».');
console.log('     Un rinnovo crea una radice nuova: togli la vecchia (Generali → VPN e gestione dispositivi) e installa questa.');
console.log('');
console.log('Su questo Mac, una volta sola (Tailscale inoltra in TCP senza aprire il traffico):');
console.log(`  tailscale serve --bg --tcp=443 tcp://127.0.0.1:${String(remote.port)}`);
console.log('Poi riavvia il core e lancia pnpm arianna:doctor.');
