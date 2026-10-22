/**
 * The certificate of the remote port in mode `tls = "own"` (D-292): the core
 * ends TLS itself and Tailscale only forwards TCP, so no certificate of the
 * Mac's name goes to the public Certificate Transparency logs.
 *
 * `pnpm remote:cert` (scripts/remote-cert.ts) runs the system's openssl with
 * the plan built here: a root EC P-256 that can sign only for the one name
 * (`nameConstraints`), the leaf of the name, then the root's private key is
 * erased. The phone trusts the root; a renewal makes a new root. The core and
 * the doctor check the result with `node:crypto` only.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RemotePaths } from '@arianna/config';

/** Root valid 27 months; the leaf 800 days, never past the root. */
export const ROOT_MONTHS = 27;
export const LEAF_DAYS = 800;
/** `pnpm remote:cert` refuses to renew a leaf with more days than this left, without --force. */
export const RENEW_AFTER_DAYS = 60;
/** The doctor warns below this. */
export const WARN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `now` to `to`, rounded down; negative once past. */
export function daysUntil(to: Date, now: Date): number {
  return Math.floor((to.getTime() - now.getTime()) / DAY_MS);
}

/** `now` plus `months` calendar months, in UTC. */
export function addMonths(now: Date, months: number): Date {
  const next = new Date(now.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

/** The days of the root and of the leaf, counted from `now` as openssl does with -days. */
export function validityDays(now: Date): { root: number; leaf: number } {
  const root = daysUntil(addMonths(now, ROOT_MONTHS), now);
  return { root, leaf: Math.min(LEAF_DAYS, root) };
}

export interface OpensslStep {
  /** Arguments of openssl, never a secret: the keys are files of the temporary folder. */
  args: string[];
}

export interface CertPlan {
  /** Files to write in the temporary folder before the steps: the openssl configurations. */
  files: { name: string; text: string }[];
  steps: OpensslStep[];
  /** What the steps leave in the temporary folder. */
  out: { rootKey: string; root: string; key: string; cert: string };
}

/**
 * The openssl steps for `host`, with every file in `tmp`. Accepted by the
 * OpenSSL of Homebrew and by the LibreSSL of macOS (/usr/bin/openssl).
 * `serial`: the serial numbers, random by default.
 */
export function certPlan(host: string, tmp: string, now: Date, serial: () => string = () => randomBytes(16).toString('hex')): CertPlan {
  const days = validityDays(now);
  const file = (name: string): string => join(tmp, name);
  const rootConf = [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    'x509_extensions = v3_root',
    '[dn]',
    `CN = Arianna root for ${host}`,
    '[v3_root]',
    'basicConstraints = critical,CA:TRUE,pathlen:0',
    'keyUsage = critical,keyCertSign,cRLSign',
    `nameConstraints = critical,permitted;DNS:${host}`,
    'subjectKeyIdentifier = hash',
    '',
  ].join('\n');
  const leafConf = [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    `CN = ${host}`,
    '[v3_leaf]',
    'basicConstraints = CA:FALSE',
    'keyUsage = critical,digitalSignature',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = DNS:${host}`,
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid',
    '',
  ].join('\n');
  const out = { rootKey: file('root.key'), root: file('arianna-root.crt'), key: file('server.key'), cert: file('server.crt') };
  return {
    files: [
      { name: 'root.cnf', text: rootConf },
      { name: 'leaf.cnf', text: leafConf },
    ],
    steps: [
      { args: ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', out.rootKey] },
      {
        args: ['req', '-x509', '-new', '-sha256', '-key', out.rootKey, '-days', String(days.root), '-set_serial', `0x${serial()}`, '-config', file('root.cnf'), '-out', out.root],
      },
      { args: ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', out.key] },
      { args: ['req', '-new', '-sha256', '-key', out.key, '-config', file('leaf.cnf'), '-out', file('server.csr')] },
      {
        args: [
          'x509', '-req', '-sha256', '-in', file('server.csr'), '-CA', out.root, '-CAkey', out.rootKey, '-set_serial', `0x${serial()}`,
          '-days', String(days.leaf), '-extfile', file('leaf.cnf'), '-extensions', 'v3_leaf', '-out', out.cert,
        ],
      },
    ],
    out,
  };
}

/**
 * Why `pnpm remote:cert` does not renew now (Italian, for the terminal), or
 * undefined: a certificate valid for more than RENEW_AFTER_DAYS stays, unless
 * --force (a new root must be installed on the phone again).
 */
export function renewRefusal(existing: string | undefined, now: Date, force: boolean): string | undefined {
  if (force || existing === undefined) return undefined;
  let left: number;
  try {
    left = daysUntil(new Date(new X509Certificate(existing).validTo), now);
  } catch {
    return undefined;
  }
  if (left <= RENEW_AFTER_DAYS) return undefined;
  return `Il certificato attuale vale ancora ${String(left)} giorni: si rinnova sotto i ${String(RENEW_AFTER_DAYS)}. Un rinnovo crea una radice nuova da reinstallare sul telefono; per farlo lo stesso: pnpm remote:cert --force`;
}

export type CertCheck = { ok: true; daysLeft: number } | { ok: false; problem: string };

/**
 * The leaf and the root as the core and the doctor want them: the leaf names
 * `host` in its SAN, is not a CA, is signed by the root, is valid now and
 * matches `key` when given. Problems in Italian, without the contents.
 */
export function checkCertificate(pems: { cert: string; root: string; key?: string }, host: string, now: Date): CertCheck {
  let leaf: X509Certificate;
  let root: X509Certificate;
  try {
    leaf = new X509Certificate(pems.cert);
    root = new X509Certificate(pems.root);
  } catch {
    return { ok: false, problem: 'il certificato o la radice non si leggono' };
  }
  // `subject: 'never'`: the name counts only in the SAN, as the browsers want.
  if (leaf.checkHost(host, { subject: 'never', wildcards: false }) !== host) return { ok: false, problem: `il certificato non è per ${host}` };
  if (leaf.ca) return { ok: false, problem: 'il certificato è una radice, non quello del Mac' };
  if (!root.ca || !leaf.checkIssued(root) || !leaf.verify(root.publicKey)) return { ok: false, problem: 'il certificato non è firmato dalla radice di data/remote' };
  if (new Date(leaf.validFrom).getTime() > now.getTime()) return { ok: false, problem: 'il certificato non vale ancora (orologio del Mac?)' };
  const daysLeft = daysUntil(new Date(leaf.validTo), now);
  if (daysLeft < 0 || new Date(leaf.validTo).getTime() <= now.getTime()) return { ok: false, problem: 'il certificato è scaduto' };
  if (pems.key !== undefined) {
    try {
      if (!leaf.checkPrivateKey(createPrivateKey(pems.key))) return { ok: false, problem: 'la chiave non è quella del certificato' };
    } catch {
      return { ok: false, problem: 'la chiave del certificato non si legge' };
    }
  }
  return { ok: true, daysLeft };
}

export type RemoteTls = { ok: true; cert: string; key: string; daysLeft: number } | { ok: false; problem: string };

/** The certificate and key of data/remote for the remote port, checked; without them, why (Italian). */
export function loadRemoteTls(paths: RemotePaths, host: string, now: Date): RemoteTls {
  let cert: string;
  let key: string;
  let root: string;
  try {
    cert = readFileSync(paths.cert, 'utf8');
    key = readFileSync(paths.key, 'utf8');
    root = readFileSync(paths.root, 'utf8');
  } catch {
    return { ok: false, problem: 'manca il certificato in data/remote: lancia pnpm remote:cert' };
  }
  const check = checkCertificate({ cert, root, key }, host, now);
  return check.ok ? { ok: true, cert, key, daysLeft: check.daysLeft } : { ok: false, problem: `${check.problem}: lancia pnpm remote:cert` };
}

const SYSTEM_OPENSSL = '/usr/bin/openssl';

/** The openssl of the system: the LibreSSL of macOS first, else the one in PATH. */
export function findOpenssl(exists: (path: string) => boolean = existsSync): string {
  return exists(SYSTEM_OPENSSL) ? SYSTEM_OPENSSL : 'openssl';
}

/**
 * Runs the plan of `certPlan` in `paths.tmp` (0700) and moves the leaf, its
 * key (0600) and the public root into `paths.dir` (0700). The root's private
 * key and every temporary file are erased, after an error too. openssl runs
 * with a minimal environment: no OPENSSL_CONF or other variable of the user.
 */
export function generateCertificate(options: { openssl: string; paths: RemotePaths; host: string; now: Date; path?: string }): void {
  const { paths } = options;
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  rmSync(paths.tmp, { recursive: true, force: true });
  mkdirSync(paths.tmp, { mode: 0o700 });
  try {
    const plan = certPlan(options.host, paths.tmp, options.now);
    for (const file of plan.files) writeFileSync(join(paths.tmp, file.name), file.text, { mode: 0o600 });
    const env = { PATH: options.path ?? process.env.PATH ?? '' };
    for (const step of plan.steps) {
      execFileSync(options.openssl, step.args, { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 });
    }
    chmodSync(plan.out.key, 0o600);
    // The root's key goes before anything is moved: it never reaches data/remote.
    rmSync(plan.out.rootKey, { force: true });
    chmodSync(plan.out.cert, 0o644);
    chmodSync(plan.out.root, 0o644);
    renameSync(plan.out.key, paths.key);
    renameSync(plan.out.cert, paths.cert);
    renameSync(plan.out.root, paths.root);
  } finally {
    rmSync(paths.tmp, { recursive: true, force: true });
  }
}
