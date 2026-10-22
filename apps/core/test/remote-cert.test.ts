import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { remotePaths, resolveHome } from '@arianna/config';

import { addMonths, certPlan, checkCertificate, findOpenssl, generateCertificate, loadRemoteTls, renewRefusal, validityDays } from '../src/remote-cert.ts';

// D-292, tls = "own". Made-up name; files only in data/test-tmp.
const HOST = 'mac-prova.tail0000.ts.net';
const root = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function opensslWorks(binary: string): boolean {
  try {
    execFileSync(binary, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('validity: the root 27 months, the leaf 800 days and never past the root', () => {
  const now = new Date('2026-10-22T10:00:00Z');
  assert.equal(addMonths(now, 27).toISOString(), '2029-01-22T10:00:00.000Z');
  const days = validityDays(now);
  assert.equal(days.root, 823);
  assert.equal(days.leaf, 800);
});

test('the plan: a root that signs only for the name, the leaf with SAN and serverAuth, every file in the temporary folder', () => {
  const tmp = join('data', 'remote', 'tmp');
  const plan = certPlan(HOST, tmp, new Date('2026-10-22T10:00:00Z'), () => 'ab');
  const rootConf = plan.files.find((file) => file.name === 'root.cnf')?.text ?? '';
  const leafConf = plan.files.find((file) => file.name === 'leaf.cnf')?.text ?? '';
  assert.match(rootConf, /^basicConstraints = critical,CA:TRUE,pathlen:0$/m);
  assert.match(rootConf, /^keyUsage = critical,keyCertSign,cRLSign$/m);
  assert.match(rootConf, new RegExp(`^nameConstraints = critical,permitted;DNS:${HOST.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(leafConf, new RegExp(`^CN = ${HOST.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(leafConf, new RegExp(`^subjectAltName = DNS:${HOST.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(leafConf, /^extendedKeyUsage = serverAuth$/m);
  assert.match(leafConf, /^keyUsage = critical,digitalSignature$/m);
  assert.match(leafConf, /^basicConstraints = CA:FALSE$/m);
  // EC P-256 and SHA-256; the days of validityDays.
  assert.equal(plan.steps.filter((step) => step.args.includes('prime256v1')).length, 2);
  assert.ok(plan.steps.filter((step) => step.args[0] !== 'ecparam').every((step) => step.args.includes('-sha256')));
  assert.deepEqual(plan.steps.map((step) => step.args[step.args.indexOf('-days') + 1]).filter((_, index) => [1, 4].includes(index)), ['823', '800']);
  // Every path is in the temporary folder: the root's key never in data/remote.
  for (const path of Object.values(plan.out)) assert.ok(path.startsWith(tmp), path);
});

test('renewal: refused while the leaf is valid for more than 60 days, unless --force', () => {
  assert.equal(renewRefusal({ ok: false, problem: 'manca' }, false), undefined);
  assert.equal(renewRefusal({ ok: true, cert: 'c', key: 'k', daysLeft: 61 }, false)?.includes('--force'), true);
  assert.equal(renewRefusal({ ok: true, cert: 'c', key: 'k', daysLeft: 60 }, false), undefined);
  assert.equal(renewRefusal({ ok: true, cert: 'c', key: 'k', daysLeft: 400 }, true), undefined);
});

test('checkCertificate refuses what is not a certificate', () => {
  assert.deepEqual(checkCertificate({ cert: 'x', root: 'y' }, HOST, new Date()), { ok: false, problem: 'il certificato o la radice non si leggono' });
  assert.equal(loadRemoteTls(remotePaths(join(root, 'none')), HOST, new Date()).ok, false);
});

const openssl = findOpenssl();
test(`with ${openssl}: the certificate is made, checked by node:crypto, and the root's key is gone`, { skip: !opensslWorks(openssl) }, () => {
  const data = join(root, 'data');
  const paths = remotePaths(data);
  const now = new Date();
  generateCertificate({ openssl, paths, host: HOST, now });

  assert.equal(existsSync(paths.tmp), false, 'temporary files erased');
  assert.equal(existsSync(join(paths.dir, 'root.key')), false);
  assert.equal(statSync(paths.dir).mode & 0o777, 0o700);
  assert.equal(statSync(paths.key).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(paths.root, 'utf8'), /PRIVATE KEY/);

  const leaf = new X509Certificate(readFileSync(paths.cert));
  const rootCert = new X509Certificate(readFileSync(paths.root));
  assert.equal(leaf.subjectAltName, `DNS:${HOST}`);
  assert.equal(leaf.ca, false);
  assert.equal(rootCert.ca, true);
  assert.ok(leaf.verify(rootCert.publicKey));
  assert.equal(rootCert.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  const text = (file: string) => execFileSync(openssl, ['x509', '-noout', '-text', '-in', file], { encoding: 'utf8' });
  const rootText = text(paths.root);
  assert.match(rootText, /Name Constraints: critical\s+Permitted:\s+DNS:mac-prova\.tail0000\.ts\.net/);
  assert.match(rootText, /Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(rootText, /Key Usage: critical\s+Certificate Sign, CRL Sign/);
  const leafText = text(paths.cert);
  assert.match(leafText, /Extended Key Usage:\s+TLS Web Server Authentication/);
  assert.match(leafText, /Key Usage: critical\s+Digital Signature/);
  assert.match(leafText, /Subject: CN ?= ?mac-prova\.tail0000\.ts\.net/);
  assert.match(leafText, /ecdsa-with-SHA256/);
  const days = (date: string) => Math.round((new Date(date).getTime() - now.getTime()) / 86_400_000);
  assert.ok(Math.abs(days(leaf.validTo) - 800) <= 1, leaf.validTo);
  assert.ok(new Date(leaf.validTo).getTime() <= new Date(rootCert.validTo).getTime());

  const loaded = loadRemoteTls(paths, HOST, now);
  assert.equal(loaded.ok, true);
  assert.equal(checkCertificate({ cert: leaf.toString(), root: rootCert.toString() }, 'altro.tail0000.ts.net', now).ok, false);
  // Expired at the end of the leaf.
  assert.deepEqual(checkCertificate({ cert: leaf.toString(), root: rootCert.toString() }, HOST, new Date(new Date(leaf.validTo).getTime() + 1000)), { ok: false, problem: 'il certificato è scaduto' });
  // A fresh certificate is not renewed without --force.
  assert.match(renewRefusal(loadRemoteTls(paths, HOST, now), false) ?? '', /--force/);
  assert.equal(renewRefusal(loadRemoteTls(paths, HOST, now), true), undefined);
  assert.equal(renewRefusal(loadRemoteTls(paths, HOST, new Date(new Date(leaf.validTo).getTime() - 30 * 86_400_000)), false), undefined);
  // Another name in arianna.toml, or the key gone: replaced without --force, never a dead end.
  assert.equal(renewRefusal(loadRemoteTls(paths, 'altro.tail0000.ts.net', now), false), undefined);
  assert.equal(renewRefusal(loadRemoteTls({ ...paths, key: join(root, 'no-key') }, HOST, now), false), undefined);

  // The key: a regular file of mode 0600 or narrower, never through a symbolic link; the same line as a missing certificate.
  chmodSync(paths.key, 0o640);
  const open = loadRemoteTls(paths, HOST, now);
  assert.equal(open.ok, false);
  assert.match(open.problem, /server\.key è leggibile da altri.*: lancia pnpm remote:cert$/);
  chmodSync(paths.key, 0o400);
  assert.equal(loadRemoteTls(paths, HOST, now).ok, true);
  chmodSync(paths.key, 0o600);
  const linked = { ...paths, key: join(root, 'linked.key') };
  symlinkSync(paths.key, linked.key);
  const viaLink = loadRemoteTls(linked, HOST, now);
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.problem, /collegamento simbolico.*: lancia pnpm remote:cert$/);
  const folder = { ...paths, key: join(root, 'folder.key') };
  mkdirSync(folder.key, { mode: 0o700 });
  const notFile = loadRemoteTls(folder, HOST, now);
  assert.match(notFile.ok ? '' : notFile.problem, /non è un file normale/);

  // A second root does not sign for the first: the leaf is refused against it.
  const other = remotePaths(join(root, 'other'));
  generateCertificate({ openssl, paths: other, host: HOST, now });
  assert.equal(checkCertificate({ cert: leaf.toString(), root: readFileSync(other.root, 'utf8') }, HOST, now).ok, false);
  // The key of another certificate does not match.
  assert.deepEqual(checkCertificate({ cert: leaf.toString(), root: rootCert.toString(), key: readFileSync(other.key, 'utf8') }, HOST, now), { ok: false, problem: 'la chiave non è quella del certificato' });
});

test('a failing openssl leaves no temporary file and nothing in data/remote', () => {
  const paths = remotePaths(join(root, 'failing'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  const fake = join(root, 'bin', 'openssl');
  writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  assert.throws(() => {
    generateCertificate({ openssl: fake, paths, host: HOST, now: new Date() });
  });
  assert.equal(existsSync(paths.tmp), false);
  assert.equal(existsSync(paths.cert), false);
  assert.equal(existsSync(paths.key), false);
});
