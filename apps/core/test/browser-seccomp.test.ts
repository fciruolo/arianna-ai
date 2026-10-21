import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveHome } from '@arianna/config';

import { browserSeccompPath } from '../src/browser/image.ts';
import {
  BROWSER_RULES,
  browserSeccomp,
  CLONE_NEWCGROUP,
  CLONE_NEWIPC,
  CLONE_NEWNET,
  CLONE_NEWNS,
  CLONE_NEWPID,
  CLONE_NEWUSER,
  CLONE_NEWUTS,
  isBrowserRule,
  MOBY_SECCOMP,
  withoutBrowserRules,
  type SeccompProfile,
} from '../src/browser/seccomp.ts';

const text = readFileSync(browserSeccompPath(resolveHome()), 'utf8');
const profile = JSON.parse(text) as SeccompProfile;

/**
 * Whether a call passes the filter for a container with no capabilities on
 * arm64: an ALLOW rule for the name, not tied to a capability, whose
 * conditions all hold. Enough for the rules of clone, unshare and chroot.
 */
function allowed(name: string, arg0 = 0): boolean {
  return profile.syscalls.some((rule) => {
    if (!rule.names.includes(name) || rule.action !== 'SCMP_ACT_ALLOW') return false;
    if (rule.includes !== undefined && 'caps' in rule.includes) return false;
    return (rule.args ?? []).every((arg) => arg.index === 0 && arg.op === 'SCMP_CMP_MASKED_EQ' && (arg0 & arg.value) === 0);
  });
}

test('the browser profile is moby default.json, byte for byte, plus the three rules of D-264', () => {
  const moby = withoutBrowserRules(text);
  assert.equal(createHash('sha256').update(moby).digest('hex'), MOBY_SECCOMP.sha256);
  assert.equal(browserSeccomp(moby), text);
  assert.deepEqual(profile.syscalls.filter(isBrowserRule), BROWSER_RULES);
});

test('the rules are added once: a profile that already has them is refused', () => {
  assert.throws(() => browserSeccomp(text), /already has the rules/);
});

test('the default action stays a refusal', () => {
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
});

test('clone and unshare pass with user, PID and network namespaces, as the Chromium sandbox asks', () => {
  for (const name of ['clone', 'unshare']) {
    assert.ok(allowed(name, CLONE_NEWUSER), name);
    assert.ok(allowed(name, CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET), name);
    assert.ok(allowed(name, 0), name);
  }
});

test('clone and unshare with a mount, UTS, IPC or cgroup namespace stay refused', () => {
  for (const name of ['clone', 'unshare']) {
    for (const flag of [CLONE_NEWNS, CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWCGROUP]) {
      assert.equal(allowed(name, CLONE_NEWUSER | flag), false, `${name} ${flag.toString(16)}`);
    }
  }
});

test('chroot passes the filter; mount, setns and clone3 do not, as in moby', () => {
  assert.ok(allowed('chroot'));
  assert.equal(allowed('mount'), false);
  assert.equal(allowed('setns'), false);
  assert.equal(allowed('pivot_root'), false);
  // clone3 answers ENOSYS without CAP_SYS_ADMIN, so the C library falls back to clone.
  const clone3 = profile.syscalls.find((rule) => rule.names.includes('clone3') && rule.action === 'SCMP_ACT_ERRNO');
  assert.equal(clone3?.errnoRet, 38);
});

test('the profile lives next to the Dockerfile', () => {
  assert.equal(browserSeccompPath('/x'), join('/x', 'apps/core/browser/seccomp.json'));
});
