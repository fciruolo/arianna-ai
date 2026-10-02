import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkWorkspace, createLabelRules, isAllowlisted, type WorkspaceEntry } from '../src/index.ts';

const RULES = createLabelRules({
  folders: [
    { path: 'repos/site', label: 'L1' },
    { path: 'repos/site/private', label: 'L2' },
    { path: 'repos/site/public', label: 'L0' },
  ],
  sources: [],
});
const ALLOWLIST = ['repos/site'];

const file = (path: string): WorkspaceEntry => ({ path, kind: 'file' });
const check = (entries: WorkspaceEntry[], repo = 'repos/site', allowlist = ALLOWLIST) =>
  checkWorkspace({ repo, allowlist, entries, rules: RULES });
const kinds = (entries: WorkspaceEntry[]) => {
  const decision = check(entries);
  return decision.decision === 'allow' ? [] : decision.findings.map((finding) => `${finding.kind}:${finding.path}`);
};

describe('allowlist', () => {
  it('an allowlisted repository with L0/L1 files is allowed', () => {
    const decision = check([file('src/index.ts'), file('public/readme.md'), { path: 'src', kind: 'directory' }]);
    assert.equal(decision.decision, 'allow');
  });

  it('a repository outside the allowlist is blocked before looking at files', () => {
    const decision = check([file('a.ts')], 'repos/other');
    assert.deepEqual(decision, { decision: 'block', rule: 'not-allowlisted', reason: 'the repository is not in cloud.allowlist', findings: [] });
  });

  it('matches whole normalized paths, not prefixes', () => {
    assert.equal(isAllowlisted('repos/site', ['repos/site/']), true);
    assert.equal(isAllowlisted('repos/site/sub', ['repos/site']), false);
    assert.equal(isAllowlisted('repos/sit', ['repos/site']), false);
    assert.equal(isAllowlisted('repos/../repos/site', ['repos/site']), false);
    assert.equal(isAllowlisted('/abs/repos/site', ['/abs/repos/site']), false);
  });

  it('an allowlisted repository without a label rule is L2 and blocked, even when empty', () => {
    const decision = checkWorkspace({ repo: 'repos/new', allowlist: ['repos/new'], entries: [], rules: RULES });
    assert.deepEqual(decision.decision === 'block' && decision.findings, [{ kind: 'label', path: '.', label: 'L2' }]);
  });
});

describe('pre-flight scan', () => {
  it('files above L1 are blocked by the folder rules of the repository', () => {
    assert.deepEqual(kinds([file('private/contract.md'), file('src/a.ts')]), ['label:private/contract.md']);
  });

  it('secret files are blocked whatever their label', () => {
    const secrets = ['.env', 'config/.env.local', 'prod.env', '.ENV', 'certs/server.pem', 'keys/id_ed25519', 'x.key', 'vault/a.age', '.git-credentials'];
    assert.deepEqual(kinds(secrets.map(file)), secrets.map((path) => `secret-file:${path}`));
  });

  it('look-alike names are not secrets', () => {
    assert.deepEqual(kinds(['environment.ts', 'id_ed25519.pub', 'keyboard.ts', 'docs/pem-format.md', 'envelope.ts'].map(file)), []);
  });

  it('secret directories are blocked, ordinary ones are not', () => {
    assert.deepEqual(kinds([{ path: 'home/.ssh', kind: 'directory' }, { path: 'src', kind: 'directory' }]), ['secret-file:home/.ssh']);
  });

  it('a file below a secret-named folder is a secret too', () => {
    assert.deepEqual(kinds([file('config/.env/production.json'), file('deploy/.env.d/db'), file('ops/.kube/config')]), [
      'secret-file:config/.env/production.json',
      'secret-file:deploy/.env.d/db',
      'secret-file:ops/.kube/config',
    ]);
    assert.deepEqual(kinds([file('config/environments/production.json')]), []);
  });

  it('other common credential files are secrets', () => {
    const secrets = ['.envrc', '.npmrc', '.pgpass', 'gcp/credentials.json', 'infra/prod.tfvars', 'terraform.tfstate', 'keys/AuthKey.p8', 'ssh/id_rsa_work'];
    assert.deepEqual(kinds(secrets.map(file)), secrets.map((path) => `secret-file:${path}`));
    assert.deepEqual(kinds(['ssh/id_rsa_work.pub', 'infra/main.tf', 'src/npm.ts'].map(file)), []);
  });

  it('entries from JSON with a missing link target or a non-string path are blocked', () => {
    assert.deepEqual(kinds([{ path: 'l', kind: 'symlink' }]), ['symlink-outside:l']);
    assert.deepEqual(kinds([{ path: 42 as unknown as string, kind: 'file' }]), ['invalid-path:42']);
  });

  it('a link that leaves the worktree is blocked; one inside is checked by its target', () => {
    assert.deepEqual(kinds([{ path: 'out', kind: 'symlink', target: null }]), ['symlink-outside:out']);
    assert.deepEqual(kinds([{ path: 'ok', kind: 'symlink', target: 'src/a.ts' }]), []);
    assert.deepEqual(kinds([{ path: 'doc', kind: 'symlink', target: 'private/c.md' }]), ['label:doc']);
    assert.deepEqual(kinds([{ path: 'cfg', kind: 'symlink', target: 'conf/.env' }]), ['secret-file:cfg']);
  });

  it('special files and malformed paths are blocked', () => {
    assert.deepEqual(kinds([{ path: 'pipe', kind: 'other' }]), ['special-file:pipe']);
    assert.deepEqual(kinds([file('../escape'), file('/abs'), file('a//b'), file('a\\b')]), [
      'invalid-path:../escape',
      'invalid-path:/abs',
      'invalid-path:a//b',
      'invalid-path:a\\b',
    ]);
  });

  it('the reason counts findings and never contains file content', () => {
    const decision = check([file('.env'), file('private/x.md')]);
    assert.equal(decision.reason, '2 finding(s): secret-file, label');
  });
});
