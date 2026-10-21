/**
 * The seccomp profile of the agent's browser (D-264): the official default
 * profile of Docker (moby), unchanged, plus three rules that let the sandbox
 * of Chromium start without CAP_SYS_ADMIN. With the default profile alone
 * Chromium stops with "No usable sandbox!", and running it with --no-sandbox
 * would leave only the container between a hostile page and the VM.
 *
 * The sandbox of Chromium needs, as an unprivileged user:
 * - clone() and unshare() with new user, PID and network namespaces: the
 *   renderers live in namespaces of their own;
 * - chroot(): inside its user namespace a renderer moves its root to an
 *   empty folder (/proc/self/fdinfo), so it sees no file at all.
 * Moby allows these only with CAP_SYS_ADMIN (or CAP_SYS_CHROOT), which the
 * container drops. The rules below allow clone and unshare only when no
 * other namespace is asked for: mount, UTS, IPC and cgroup namespaces stay
 * refused (checked by hand on 2026-10-21: `unshare -U -m` gets EPERM).
 * chroot is allowed by the filter, but the kernel still wants CAP_SYS_CHROOT,
 * which exists only inside a new user namespace.
 *
 * apps/core/browser/seccomp.json is written by
 * `node scripts/browser.ts seccomp <moby default.json>` and checked by a test:
 * without the three rules it is byte for byte the file of MOBY_SECCOMP.
 */

export const MOBY_SECCOMP = {
  url: 'https://raw.githubusercontent.com/moby/profiles/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json',
  commit: '6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef',
  sha256: '6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6',
} as const;

// Namespace flags of clone(2) and unshare(2), from linux/sched.h.
export const CLONE_NEWNS = 0x0002_0000;
export const CLONE_NEWCGROUP = 0x0200_0000;
export const CLONE_NEWUTS = 0x0400_0000;
export const CLONE_NEWIPC = 0x0800_0000;
export const CLONE_NEWUSER = 0x1000_0000;
export const CLONE_NEWPID = 0x2000_0000;
export const CLONE_NEWNET = 0x4000_0000;

/**
 * The namespace flags that stay refused: a call passes the rule only when
 * (flags & mask) == 0, so user, PID and network namespaces are the only new
 * ones allowed.
 */
export const REFUSED_NAMESPACES = CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC;

const MARK = 'Arianna D-264';

export type SeccompRule = {
  names: string[];
  action: string;
  args?: { index: number; value: number; op: string }[];
  comment?: string;
  includes?: Record<string, unknown>;
  excludes?: Record<string, unknown>;
  errnoRet?: number;
};

export type SeccompProfile = {
  defaultAction: string;
  syscalls: SeccompRule[];
  [key: string]: unknown;
};

export const BROWSER_RULES: readonly SeccompRule[] = [
  {
    names: ['clone'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: REFUSED_NAMESPACES, op: 'SCMP_CMP_MASKED_EQ' }],
    comment: `${MARK}: sandbox of Chromium, only user, PID and network namespaces`,
    excludes: { arches: ['s390', 's390x'] },
  },
  {
    names: ['unshare'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: REFUSED_NAMESPACES, op: 'SCMP_CMP_MASKED_EQ' }],
    comment: `${MARK}: sandbox of Chromium, only user, PID and network namespaces`,
  },
  {
    names: ['chroot'],
    action: 'SCMP_ACT_ALLOW',
    comment: `${MARK}: sandbox of Chromium, chroot inside its own user namespace`,
  },
];

export function isBrowserRule(rule: SeccompRule): boolean {
  return typeof rule.comment === 'string' && rule.comment.startsWith(MARK);
}

/** Moby's profile with the three rules at the end, in the same layout (tabs, no final newline). */
export function browserSeccomp(mobyText: string): string {
  const profile = JSON.parse(mobyText) as SeccompProfile;
  if (profile.syscalls.some(isBrowserRule)) throw new Error('the profile already has the rules of D-264');
  profile.syscalls.push(...BROWSER_RULES.map((rule) => structuredClone(rule)));
  return JSON.stringify(profile, null, '\t');
}

/** The profile without the three rules, laid out as moby lays it out. */
export function withoutBrowserRules(profileText: string): string {
  const profile = JSON.parse(profileText) as SeccompProfile;
  profile.syscalls = profile.syscalls.filter((rule) => !isBrowserRule(rule));
  return JSON.stringify(profile, null, '\t');
}
