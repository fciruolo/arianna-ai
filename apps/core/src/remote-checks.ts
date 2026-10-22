/**
 * The doctor's checks of the remote port (D-292). `tailscale serve status
 * --json` must publish on the tailnet only the remote port, as the mode of
 * `[server.remote] tls` wants, and never through Funnel (the public
 * Internet). The doctor only reads: `tailscale serve` is the user's to run.
 * Details in Italian: they tell the user what to do.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { remotePaths, type AriannaConfig, type RemoteServerConfig } from '@arianna/config';

import type { DoctorCheck } from './doctor.ts';
import { checkCertificate, WARN_DAYS } from './remote-cert.ts';

/** The binary of the official app, then the one in PATH (installed by the app or by Homebrew). */
export const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** The `tailscale serve` command each mode wants. */
export function serveCommand(remote: Pick<RemoteServerConfig, 'port' | 'tls'>): string {
  return remote.tls === 'own'
    ? `tailscale serve --bg --tcp=443 tcp://127.0.0.1:${String(remote.port)}`
    : `tailscale serve --bg --https=443 http://127.0.0.1:${String(remote.port)}`;
}

type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Table) : undefined;
}

function keys(value: unknown): string[] {
  return Object.keys(table(value) ?? {});
}

/**
 * The verdict on the output of `tailscale serve status --json` (pure). The
 * configuration and the foreground sessions (`Foreground`) count alike:
 * anything published beyond the one entry of the mode is refused.
 */
export function analyzeServeStatus(json: unknown, remote: Pick<RemoteServerConfig, 'host' | 'port' | 'tls'>): DoctorCheck {
  const id = 'remote.tailscale';
  const fail = (detail: string): DoctorCheck => ({ id, ok: false, detail });
  const root = table(json);
  if (root === undefined) return fail('tailscale serve status --json non ha dato un oggetto JSON');
  const configs = [root, ...Object.values(table(root.Foreground) ?? {}).map(table).filter((item): item is Table => item !== undefined)];
  const command = serveCommand(remote);

  for (const config of configs) {
    const funnel = table(config.AllowFunnel) ?? {};
    if (Object.values(funnel).some((on) => on === true)) {
      return fail('Funnel è attivo: il Mac è raggiungibile da Internet. Spegnilo con «tailscale funnel reset» e lascia solo serve');
    }
  }
  if (configs.some((config) => keys(config.Services).length > 0)) return fail('tailscale serve pubblica anche servizi della tailnet (Services): lascia solo la porta remota');

  const tcp = new Map<string, Table>();
  const web = new Map<string, Table>();
  for (const config of configs) {
    for (const [port, entry] of Object.entries(table(config.TCP) ?? {})) tcp.set(port, table(entry) ?? {});
    for (const [name, entry] of Object.entries(table(config.Web) ?? {})) web.set(name.toLowerCase(), table(entry) ?? {});
  }
  if (tcp.size === 0 && web.size === 0) return fail(`tailscale serve non pubblica niente: lancia ${command}`);

  const target = `127.0.0.1:${String(remote.port)}`;
  const forward = tcp.get('443');
  const handlers = table(web.get(`${remote.host}:443`)?.Handlers);
  const ownShape = forward !== undefined && forward.TCPForward === target;
  const tailscaleShape = handlers !== undefined && table(handlers['/'])?.Proxy === `http://${target}`;

  if (remote.tls === 'own') {
    if (!ownShape && tailscaleShape) {
      return fail(`Tailscale è configurato per tls = "tailscale" (HTTPS col suo certificato), ma arianna.toml dice tls = "own": lancia «tailscale serve reset», poi ${command}`);
    }
    if (!ownShape) return fail(`tailscale serve non inoltra la porta 443 a ${target}: lancia ${command}`);
    if (forward.TerminateTLS !== undefined || forward.HTTPS === true || forward.HTTP === true) {
      return fail(`Tailscale apre il traffico della 443 invece di inoltrarlo in TCP: lancia «tailscale serve reset», poi ${command}`);
    }
    if (tcp.size > 1 || web.size > 0) return fail(`tailscale serve pubblica anche altro oltre alla porta remota: lancia «tailscale serve reset», poi ${command}`);
    return { id, ok: true, detail: `la 443 della tailnet va in TCP a ${target}, senza Funnel` };
  }

  if (!tailscaleShape && ownShape) {
    return fail(`Tailscale inoltra in TCP (tls = "own"), ma arianna.toml dice tls = "tailscale": lancia «tailscale serve reset», poi ${command}`);
  }
  if (!tailscaleShape) return fail(`tailscale serve non manda https://${remote.host} a http://${target}: lancia ${command}`);
  const onlyHttps = tcp.size === 1 && forward !== undefined && forward.HTTPS === true && forward.TCPForward === undefined;
  if (!onlyHttps || web.size > 1 || keys(handlers).length > 1) {
    return fail(`tailscale serve pubblica anche altro oltre alla porta remota: lancia «tailscale serve reset», poi ${command}`);
  }
  return { id, ok: true, detail: `https://${remote.host} va a http://${target}, senza Funnel` };
}

/** Runs `binary args` with a minimal environment and a timeout; stdout, or a rejection. */
export type TailscaleRunner = (binary: string, args: string[]) => Promise<string>;

const runTailscale: TailscaleRunner = (binary, args) =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    execFile(binary, args, { timeout: 10_000, encoding: 'utf8', maxBuffer: 1024 * 1024, env }, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`${binary} is missing or failed`));
    });
  });

/** The certificate of mode `own` as the core will read it: SAN, root, key, days left. */
export function remoteCertCheck(data: string, host: string, now: Date): DoctorCheck {
  const paths = remotePaths(data);
  if (![paths.cert, paths.key, paths.root].every((path) => existsSync(path))) {
    return { id: 'remote.cert', ok: false, detail: 'manca il certificato in data/remote: lancia pnpm remote:cert' };
  }
  const check = checkCertificate(
    { cert: readFileSync(paths.cert, 'utf8'), root: readFileSync(paths.root, 'utf8'), key: readFileSync(paths.key, 'utf8') },
    host,
    now,
  );
  if (!check.ok) return { id: 'remote.cert', ok: false, detail: `${check.problem}: lancia pnpm remote:cert` };
  if (check.daysLeft <= WARN_DAYS) return { id: 'remote.cert', ok: false, detail: `il certificato scade fra ${String(check.daysLeft)} giorni: lancia pnpm remote:cert` };
  return { id: 'remote.cert', ok: true, detail: `per ${host}, firmato dalla radice, vale ancora ${String(check.daysLeft)} giorni` };
}

/**
 * The checks of `[server.remote]`: none needed without it (one passing check
 * says so), else Tailscale and, in mode `own`, the certificate.
 */
export async function remoteChecks(
  config: Pick<AriannaConfig, 'server' | 'paths'>,
  options: { run?: TailscaleRunner; exists?: (path: string) => boolean; now?: Date } = {},
): Promise<DoctorCheck[]> {
  const remote = config.server.remote;
  if (remote === undefined) return [{ id: 'remote.tailscale', ok: true, detail: 'nessun accesso dal telefono: [server.remote] non è in arianna.toml (D-292)' }];
  const run = options.run ?? runTailscale;
  const exists = options.exists ?? existsSync;
  const checks: DoctorCheck[] = [];
  const binary = exists(TAILSCALE_APP) ? TAILSCALE_APP : 'tailscale';
  let output: string | undefined;
  try {
    output = await run(binary, ['serve', 'status', '--json']);
  } catch {
    checks.push({ id: 'remote.tailscale', ok: false, detail: 'Tailscale non risponde: installa l\'app di Tailscale dal Mac App Store o da tailscale.com, accedi e riprova' });
  }
  if (output !== undefined) {
    let json: unknown;
    try {
      // An empty output is an empty configuration.
      json = output.trim() === '' ? {} : JSON.parse(output);
    } catch {
      json = undefined;
    }
    checks.push(analyzeServeStatus(json, remote));
  }
  if (remote.tls === 'own') checks.push(remoteCertCheck(config.paths.data, remote.host, options.now ?? new Date()));
  return checks;
}
