// Pre-flight check of the worktree a cloud executor will see
// (docs/PRIVACY-POLICY-SPEC.md, "Confinamento", points 1 and 3). Pure: the
// executors package walks the disk and passes what it found.
import { posix } from 'node:path';

import { isAtMost, type Label } from './labels.ts';
import { labelForPath, type LabelRules } from './rules.ts';

export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface WorkspaceEntry {
  /** Relative to the worktree root, with `/` separators. */
  path: string;
  kind: WorkspaceEntryKind;
  /**
   * Symbolic links only: the resolved target relative to the worktree root, or
   * null when it leaves the worktree or cannot be resolved.
   */
  target?: string | null;
}

export interface WorkspaceCheck {
  /** The repository the worktree is checked out from, relative to ARIANNA_HOME. */
  repo: string;
  /** `cloud.allowlist` of arianna.toml. */
  allowlist: readonly string[];
  entries: readonly WorkspaceEntry[];
  rules: LabelRules;
}

export type WorkspaceFindingKind = 'secret-file' | 'label' | 'symlink-outside' | 'special-file' | 'invalid-path';

export interface WorkspaceFinding {
  kind: WorkspaceFindingKind;
  /** Path inside the worktree; never file content. */
  path: string;
  label?: Label;
}

export type WorkspaceDecision =
  | { decision: 'allow'; rule: 'workspace'; reason: string }
  | { decision: 'block'; rule: 'not-allowlisted' | 'workspace-scan'; reason: string; findings: WorkspaceFinding[] };

/** Highest label a file may have to be seen by a cloud executor. */
const CLOUD_CEILING: Label = 'L1';

const SECRET_NAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.pypirc',
  '.htpasswd',
  '.dockercfg',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'terraform.tfstate',
]);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p8', '.p12', '.pfx', '.age', '.jks', '.keystore', '.kdbx', '.gpg', '.tfvars', '.tfstate'];
const SECRET_DIRECTORIES = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker']);
const PRIVATE_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

/**
 * One segment of a path, file or folder alike (`config/.env/production.json`
 * is as secret as `.env`). Lowercased, so `.ENV` on a case-insensitive disk is
 * caught too. Public SSH keys (`.pub`) are not secrets.
 */
function isSecretSegment(segment: string): boolean {
  const lower = segment.normalize('NFC').toLowerCase();
  return (
    SECRET_NAMES.has(lower) ||
    SECRET_DIRECTORIES.has(lower) ||
    lower.startsWith('.env.') ||
    lower.endsWith('.env') ||
    SECRET_EXTENSIONS.some((extension) => lower.endsWith(extension)) ||
    (PRIVATE_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix)) && !lower.endsWith('.pub'))
  );
}

function isSecretPath(path: string): boolean {
  return path.split('/').some(isSecretSegment);
}

/** A relative path without `.`, `..` or empty segments; anything else is not trusted. */
function cleanRelative(path: unknown): string | undefined {
  if (typeof path !== 'string' || path === '' || posix.isAbsolute(path) || path.includes('\\') || path.includes('\0')) return undefined;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? path : undefined;
}

/** True when `repo` is exactly an entry of the allowlist (same normalized path). */
export function isAllowlisted(repo: string, allowlist: readonly string[]): boolean {
  const normalized = cleanRelative(repo.normalize('NFC').replace(/\/+$/, ''));
  if (normalized === undefined) return false;
  return allowlist.some((entry) => cleanRelative(entry.normalize('NFC').replace(/\/+$/, '')) === normalized);
}

/**
 * The problems of each entry: a secret file, a file `labelOf` puts above L1,
 * a link that leaves the folder, a special file, a path that is not clean.
 */
function scanEntries(entries: readonly WorkspaceEntry[], labelOf: (path: string) => Label): WorkspaceFinding[] {
  const findings: WorkspaceFinding[] = [];
  for (const entry of entries) {
    // Entries also come from JSON, where `path` may not be a string at all.
    const raw: unknown = entry.path;
    const path = cleanRelative(raw);
    if (path === undefined) {
      findings.push({ kind: 'invalid-path', path: typeof raw === 'string' ? raw : JSON.stringify(raw) });
      continue;
    }
    if (entry.kind === 'other') {
      findings.push({ kind: 'special-file', path });
      continue;
    }
    if (isSecretPath(path)) findings.push({ kind: 'secret-file', path });
    if (entry.kind === 'symlink') {
      const target = entry.target === null || entry.target === undefined ? undefined : cleanRelative(entry.target);
      if (target === undefined) {
        findings.push({ kind: 'symlink-outside', path });
        continue;
      }
      if (isSecretPath(target) && !isSecretPath(path)) findings.push({ kind: 'secret-file', path });
      const targetLabel = labelOf(target);
      if (!isAtMost(targetLabel, CLOUD_CEILING)) findings.push({ kind: 'label', path, label: targetLabel });
    }
    const label = labelOf(path);
    if (!isAtMost(label, CLOUD_CEILING)) findings.push({ kind: 'label', path, label });
  }
  return findings;
}

function decide(entries: number, findings: WorkspaceFinding[]): WorkspaceDecision {
  if (findings.length === 0) {
    return { decision: 'allow', rule: 'workspace', reason: `${String(entries)} entries, none above ${CLOUD_CEILING}, no secrets` };
  }
  const kinds = [...new Set(findings.map((finding) => finding.kind))].join(', ');
  return { decision: 'block', rule: 'workspace-scan', reason: `${String(findings.length)} finding(s): ${kinds}`, findings };
}

/**
 * Decides whether a cloud executor may be launched on this worktree. Blocked
 * when the repository is not in the allowlist, or when any entry is a secret
 * file, a file the label rules put above L1 (the path counts as inside the
 * repository, not inside `data/worktrees`), a link that leaves the worktree, or
 * a special file. Each entry is checked; every problem is reported.
 */
export function checkWorkspace(input: WorkspaceCheck): WorkspaceDecision {
  if (!isAllowlisted(input.repo, input.allowlist)) {
    return { decision: 'block', rule: 'not-allowlisted', reason: 'the repository is not in cloud.allowlist', findings: [] };
  }
  const repo = input.repo.normalize('NFC').replace(/\/+$/, '');
  const labelOf = (path: string): Label => labelForPath(input.rules, `${repo}/${path}`);
  // The repository itself needs a rule at most L1, also when it is empty:
  // allowlisting it does not label it.
  const repoLabel = labelForPath(input.rules, repo);
  const findings: WorkspaceFinding[] = isAtMost(repoLabel, CLOUD_CEILING) ? [] : [{ kind: 'label', path: '.', label: repoLabel }];
  findings.push(...scanEntries(input.entries, labelOf));
  return decide(input.entries.length, findings);
}

export interface ProjectCheck {
  /** The label the user gave the project in its `[[project]]` section (D-058). */
  label: Label;
  entries: readonly WorkspaceEntry[];
}

/**
 * Decides whether a cloud executor may be launched in a project folder the
 * user approved (D-058). Every file has the project's label, which must be at
 * most L1 (the configuration refuses more; checked again here); the scan is
 * the one of `checkWorkspace`: secrets, links leaving the folder and special
 * files block.
 */
export function checkProject(input: ProjectCheck): WorkspaceDecision {
  const findings: WorkspaceFinding[] = isAtMost(input.label, CLOUD_CEILING) ? [] : [{ kind: 'label', path: '.', label: input.label }];
  findings.push(...scanEntries(input.entries, () => input.label));
  return decide(input.entries.length, findings);
}
