// «Server dei modelli (oMLX)» (D-265): versions, the command that says the version, the releases of a
// fake GitHub, the daily schedule, the routes. Never the network, never the real oMLX.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';

import type { Sql } from '../src/db/client.ts';
import { GithubError, type GithubGet } from '../src/github-api.ts';
import type { LiveFeed } from '../src/live.ts';
import {
  checkReleases,
  compareVersions,
  createOmlxReleases,
  createVersionRunner,
  emptyState,
  hasUpdate,
  isDue,
  isStable,
  LAUNCHER_ENDPOINT,
  NO_OMLX_ENDPOINT,
  omlxEndpoint,
  parseReleaseState,
  parseVersion,
  readInstalled,
  readReleases,
  STATE_FILE,
  UNREADABLE_VERSION,
  versionCommand,
  type OmlxEndpoint,
  type Version,
} from '../src/omlx-release.ts';
import { startApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `omlx-release-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const v = (text: string): Version => {
  const parsed = parseVersion(text);
  assert.ok(parsed !== undefined, text);
  return parsed;
};

describe('versions of oMLX', () => {
  it('reads the version from what oMLX prints and from tags', () => {
    assert.equal(v('0.7.1\n').text, '0.7.1');
    assert.equal(v('omlx 0.7.1').text, '0.7.1');
    assert.equal(v('v0.6.3rc2').text, '0.6.3rc2');
    assert.equal(v('omlx, version 0.7.2-rc.1').rank, 'rc');
    assert.equal(v('0.7.2.dev3').rank, 'dev');
    assert.equal(v('0.7.2+local').rank, 'stable');
  });

  it('refuses a text without a version', () => {
    for (const text of ['', 'omlx', 'usage: omlx [-h]', 'version 7', undefined, 42]) assert.equal(parseVersion(text), undefined, String(text));
  });

  it('orders versions: 0.7.1 before 0.7.2, pre-releases before their release, equal ones equal', () => {
    assert.ok(compareVersions(v('0.7.1'), v('0.7.2')) < 0);
    assert.ok(compareVersions(v('0.7.2'), v('0.7.1')) > 0);
    assert.equal(compareVersions(v('0.7.2'), v('v0.7.2')), 0);
    assert.ok(compareVersions(v('0.7.2rc1'), v('0.7.2')) < 0);
    assert.ok(compareVersions(v('0.7.2rc1'), v('0.7.2rc2')) < 0);
    assert.ok(compareVersions(v('0.7.2.dev1'), v('0.7.2a1')) < 0);
    assert.ok(compareVersions(v('0.7.2b1'), v('0.7.2rc1')) < 0);
    assert.ok(compareVersions(v('0.7.10'), v('0.7.9')) > 0);
  });

  it('counts only releases without a pre-release mark as stable', () => {
    assert.equal(isStable(v('0.7.2')), true);
    assert.equal(isStable(v('0.7.2.post1')), true);
    assert.equal(isStable(v('0.7.2rc1')), false);
    assert.equal(isStable(v('0.7.2-hotfix')), false);
  });

  it('an update is a stable release newer than the one installed', () => {
    const release = (version: string) => ({ tag: `v${version}`, name: version, publishedAt: null, url: 'https://github.com/jundot/omlx/releases', notes: '', version, prerelease: false });
    assert.equal(hasUpdate('0.7.1', release('0.7.2')), true);
    assert.equal(hasUpdate('0.7.2', release('0.7.2')), false);
    assert.equal(hasUpdate('0.7.3', release('0.7.2')), false);
    assert.equal(hasUpdate('0.7.1', release('0.7.2rc1')), false);
    assert.equal(hasUpdate('0.7.2rc1', release('0.7.2')), true);
    assert.equal(hasUpdate(null, release('0.7.2')), false);
    assert.equal(hasUpdate('0.7.1', null), false);
  });
});

describe('the command that says the version', () => {
  it('runs only the program of a recognised oMLX endpoint, with --version', () => {
    assert.deepEqual(versionCommand(['omlx', 'serve', '--port', '7001']), ['omlx', '--version']);
    assert.deepEqual(versionCommand(['/Applications/oMLX.app/Contents/MacOS/omlx-cli', 'serve']), ['/Applications/oMLX.app/Contents/MacOS/omlx-cli', '--version']);
    assert.deepEqual(versionCommand(['python3', '-m', 'omlx.cli', 'serve']), ['python3', '-m', 'omlx.cli', '--version']);
  });

  it('never a command that is not oMLX, nor a launcher in front of it', () => {
    for (const command of [
      ['llama-server', '--port', '7001'],
      ['rm', '-rf', 'serve'],
      ['uvx', 'omlx', 'serve'],
      ['sh', '-c', 'omlx serve'],
      ['python3', '-m', 'other', 'serve'],
      ['omlx'],
      ['node', 'omlx', 'serve'],
    ]) {
      assert.equal(versionCommand(command), undefined, command.join(' '));
    }
    assert.equal(versionCommand(undefined), undefined);
  });

  it('picks the first endpoint that starts oMLX', () => {
    const endpoints: OmlxEndpoint[] = [{ id: 'other', command: ['llama-server'] }, { id: 'remote' }, { id: 'omlx', command: ['omlx', 'serve'] }];
    assert.equal(omlxEndpoint(endpoints)?.id, 'omlx');
    assert.equal(omlxEndpoint([{ id: 'other', command: ['llama-server', 'serve'] }]), undefined);
  });

  it('reads the installed version, and runs nothing without an oMLX endpoint', async () => {
    const ran: string[][] = [];
    const run = (argv: readonly string[]) => {
      ran.push([...argv]);
      return Promise.resolve('0.7.1\n');
    };
    assert.deepEqual(await readInstalled({ endpoints: () => [{ id: 'omlx', command: ['omlx', 'serve'] }], run }).then((found) => [found.version, found.endpoint, found.error]), ['0.7.1', 'omlx', null]);
    assert.deepEqual(ran, [['omlx', '--version']]);
    ran.length = 0;
    assert.equal((await readInstalled({ endpoints: () => [{ id: 'x', command: ['llama-server', 'serve'] }], run })).error, NO_OMLX_ENDPOINT);
    assert.equal((await readInstalled({ endpoints: () => [{ id: 'x', command: ['uvx', 'omlx', 'serve'] }], run })).error, LAUNCHER_ENDPOINT);
    assert.deepEqual(ran, []);
  });

  it('says in Italian when the version cannot be read', async () => {
    const endpoints = () => [{ id: 'omlx', command: ['omlx', 'serve'] }];
    assert.equal((await readInstalled({ endpoints, run: () => Promise.resolve('usage: omlx') })).error, UNREADABLE_VERSION);
    const missing = await readInstalled({ endpoints: () => [{ id: 'omlx', command: [join(scratch, 'no-such', 'omlx'), 'serve'] }], run: createVersionRunner({ cwd: resolveHome({}), env: { PATH: '/usr/bin:/bin' } }) });
    assert.equal(missing.version, null);
    assert.match(missing.error ?? '', /non si trova/);
  });

  it('the runner never uses a shell', async () => {
    mkdirSync(scratch, { recursive: true });
    const run = createVersionRunner({ cwd: scratch, env: { PATH: '/usr/bin:/bin' } });
    // With a shell `;` would run a second command; here it is one argument of echo.
    assert.equal((await run(['/bin/echo', '0.7.1;', 'touch', 'x'])).trim(), '0.7.1; touch x');
  });
});

const page = 'https://github.com/jundot/omlx/releases/tag';
function releasesAnswer(...tags: [string, boolean?][]): unknown {
  return tags.map(([tag, prerelease], index) => ({
    tag_name: tag,
    name: `oMLX ${tag}`,
    draft: false,
    prerelease: prerelease === true,
    published_at: `2026-10-${String(20 - index).padStart(2, '0')}T10:00:00Z`,
    html_url: `${page}/${tag}`,
    body: `Notes of ${tag}`,
  }));
}
const sha = (n: number): string => n.toString(16).padStart(7, '0') + 'e'.repeat(33);
const compareAnswer = (messages: string[]): unknown => ({ total_commits: messages.length, commits: messages.map((message, index) => ({ sha: sha(index + 1), commit: { message } })), files: [] });

function fakeGithub(answers: Record<string, unknown>): { get: GithubGet; asked: string[]; gateway: (address: string) => Promise<void> } {
  const asked: string[] = [];
  return {
    asked,
    gateway: (address) => {
      asked.push(address);
      return Promise.resolve();
    },
    get: (path) => {
      const found = Object.entries(answers).find(([prefix]) => path.startsWith(prefix));
      if (found === undefined) return Promise.reject(new GithubError('not-found', 'answered 404'));
      return found[1] instanceof Error ? Promise.reject(found[1]) : Promise.resolve(found[1]);
    },
  };
}

describe('the releases of oMLX', () => {
  it('keeps pre-releases apart from the stable ones, by flag or by tag', () => {
    const found = readReleases(releasesAnswer(['v0.7.3rc1'], ['v0.7.2'], ['v0.7.2-beta', true], ['v0.7.1'], ['nightly']));
    assert.deepEqual(
      found.map((release) => [release.version, release.prerelease]),
      [
        ['0.7.3rc1', true],
        ['0.7.2', false],
        ['0.7.2-beta', true],
        ['0.7.1', false],
      ],
    );
  });

  it('finds the newest stable, the pre-release after it, and the news against the stable before it', async () => {
    const github = fakeGithub({
      '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.3rc1', true], ['v0.7.2'], ['v0.7.2rc1', true], ['v0.7.1']),
      '/repos/jundot/omlx/compare/v0.7.1...v0.7.2': compareAnswer(['feat: faster prefill', 'fix: crash']),
    });
    const state = await checkReleases({ ...github, now: () => new Date('2026-10-21T08:00:00Z') }, { ...emptyState(), installed: { version: '0.7.1', endpoint: 'omlx', readAt: null, error: null } });
    assert.equal(state.message, null);
    assert.equal(state.latest?.version, '0.7.2');
    assert.equal(state.latest.url, `${page}/v0.7.2`);
    assert.equal(state.prerelease?.version, '0.7.3rc1');
    assert.equal(state.news?.from, 'v0.7.1');
    assert.equal(state.news.to, 'v0.7.2');
    assert.equal(state.news.source, 'raw');
    assert.deepEqual(state.news.releases.map((release) => release.tag), ['v0.7.2', 'v0.7.2rc1']);
    assert.equal(hasUpdate(state.installed.version, state.latest), true);
    // Only the name of the repository and two public tags left, through the gateway: nothing about the installation.
    assert.deepEqual(github.asked, ['https://api.github.com/repos/jundot/omlx/releases?per_page=10', 'https://api.github.com/repos/jundot/omlx/compare/v0.7.1...v0.7.2?per_page=250']);
  });

  it('the installed version never leaves, even when it differs from every tag', async () => {
    const github = fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.0']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a']) });
    await checkReleases(github, { ...emptyState(), installed: { version: '0.6.9-secret', endpoint: 'omlx', readAt: null, error: null } });
    assert.ok(github.asked.every((address) => !address.includes('0.6.9')));
  });

  it('groups with the local model, as for a followed project', async () => {
    const github = fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.1']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a', 'feat: b']) });
    const state = await checkReleases({ ...github, summarize: () => Promise.resolve({ value: { items: [{ title: 'Prima parola più rapida', summary: 'Il prefill è più veloce.', commits: [1, 2] }] }, finishReason: 'stop', model: 'm' }) }, emptyState());
    assert.equal(state.news?.source, 'model');
    assert.equal(state.news.items[0]?.title, 'Prima parola più rapida');
  });

  it('reads the news of a release once', async () => {
    const github = fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.1']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a']) });
    const first = await checkReleases(github, emptyState());
    github.asked.length = 0;
    await checkReleases(github, first);
    assert.deepEqual(github.asked, ['https://api.github.com/repos/jundot/omlx/releases?per_page=10']);
  });

  it('a failure keeps what was found and says why in Italian', async () => {
    const before = await checkReleases(fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.1']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a']) }), emptyState());
    const limited = await checkReleases(fakeGithub({ '/repos/jundot/omlx/releases': new GithubError('limited', 'limited') }), before);
    assert.match(limited.message ?? '', /GitHub limita le richieste/);
    assert.equal(limited.latest?.version, '0.7.2');
    const offline = await checkReleases(fakeGithub({ '/repos/jundot/omlx/releases': new GithubError('upstream', 'cannot be reached') }), before);
    assert.match(offline.message ?? '', /GitHub non è raggiungibile/);
    const refused = await checkReleases({ ...fakeGithub({}), gateway: () => Promise.reject(new Error('gateway deny')) }, before);
    assert.match(refused.message ?? '', /gateway/);
  });

  it('only pre-releases: no stable one to offer', async () => {
    const state = await checkReleases(fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.8.0rc1', true]) }), emptyState());
    assert.equal(state.latest, null);
    assert.equal(state.prerelease?.version, '0.8.0rc1');
  });
});

describe('the daily check', () => {
  it('is due only when a day has gone since the last one', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    assert.equal(isDue(null, now), true);
    assert.equal(isDue('2026-10-21T11:00:00Z', now), false);
    assert.equal(isDue('2026-10-20T12:00:01Z', now), false);
    assert.equal(isDue('2026-10-20T12:00:00Z', now), true);
    assert.equal(isDue('2026-10-23T12:00:00Z', now), true, 'a clock that went back');
    assert.equal(isDue('not a date', now), true);
    // After a failed check: again after six hours, not before.
    assert.equal(isDue('2026-10-21T07:00:00Z', now, true), false);
    assert.equal(isDue('2026-10-21T06:00:00Z', now, true), true);
  });

  it('a failed check is marked so, and a good one clears the mark', async () => {
    const failed = await checkReleases(fakeGithub({ '/repos/jundot/omlx/releases': new GithubError('upstream', 'down') }), emptyState());
    assert.equal(failed.failed, true);
    const ok = await checkReleases(fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.1']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a']) }), failed);
    assert.equal(ok.failed, false);
  });

  it('asks GitHub at most once a day, and the time survives a restart', async () => {
    const dir = join(scratch, 'daily');
    let clock = new Date('2026-10-21T08:00:00Z');
    const github = fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.1']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a']) });
    const ran: string[][] = [];
    const deps = {
      dir,
      ...github,
      endpoints: () => [{ id: 'omlx', command: ['omlx', 'serve'] }],
      run: (argv: readonly string[]) => {
        ran.push([...argv]);
        return Promise.resolve('0.7.1');
      },
      now: () => clock,
    };
    const releases = createOmlxReleases(deps);
    const releaseRequests = () => github.asked.filter((address) => address.includes('/releases')).length;
    releases.tick();
    await releases.idle();
    assert.equal(releaseRequests(), 1);
    assert.equal(releases.view().update, true);
    assert.equal(releases.view().installed.version, '0.7.1');
    clock = new Date('2026-10-21T20:00:00Z');
    releases.tick();
    await releases.idle();
    assert.equal(releaseRequests(), 1);
    // A new core reads the time of the last check from data/.
    const restarted = createOmlxReleases(deps);
    restarted.tick();
    await restarted.idle();
    assert.equal(releaseRequests(), 1);
    clock = new Date('2026-10-22T08:00:00Z');
    restarted.tick();
    await restarted.idle();
    assert.equal(releaseRequests(), 2);
    // «Controlla ora» goes anyway, but one at a time.
    restarted.checkNow();
    assert.throws(() => {
      restarted.checkNow();
    }, /already running/);
    await restarted.idle();
    assert.equal(releaseRequests(), 3);
    assert.ok(ran.every((argv) => argv.join(' ') === 'omlx --version'));
  });

  it('a state file that is not ours reads as empty', () => {
    assert.deepEqual(parseReleaseState({ version: 2 }), emptyState());
    assert.deepEqual(parseReleaseState({ ...emptyState(), latest: { tag: '../x', version: '1', name: 'x', url: 'https://evil.example/releases', publishedAt: null, notes: '', prerelease: false } }), emptyState());
    const dir = join(scratch, 'broken');
    mkdirSync(join(dir, 'followed'), { recursive: true });
    writeFileSync(join(dir, 'followed', STATE_FILE), 'not json');
    assert.equal(createOmlxReleases({ dir, ...fakeGithub({}), endpoints: () => [], run: () => Promise.resolve('') }).view().checkedAt, null);
  });
});

describe('the routes', () => {
  it('read the state, check in the background and refuse another body', async () => {
    const dir = join(scratch, 'routes');
    const github = fakeGithub({ '/repos/jundot/omlx/releases': releasesAnswer(['v0.7.2'], ['v0.7.1']), '/repos/jundot/omlx/compare/': compareAnswer(['feat: a']) });
    const omlxReleases = createOmlxReleases({ dir, ...github, endpoints: () => [{ id: 'omlx', command: ['omlx', 'serve'] }], run: () => Promise.resolve('0.7.1') });
    const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, omlxReleases });
    try {
      const base = `http://127.0.0.1:${String(server.port)}`;
      const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await post('/api/models/omlx-release/check', { command: ['rm'] })).status, 400);
      assert.equal((await post('/api/models/omlx-release/check', {})).status, 202);
      await omlxReleases.idle();
      const view = (await (await fetch(`${base}/api/models/omlx-release`)).json()) as { update: boolean; latest: { version: string } };
      assert.equal(view.update, true);
      assert.equal(view.latest.version, '0.7.2');
      const read = (await (await post('/api/models/omlx-release/version', {})).json()) as { installed: { version: string } };
      assert.equal(read.installed.version, '0.7.1');
    } finally {
      await server.close();
    }
  });

  it('answer 404 without the service', async () => {
    const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${String(server.port)}/api/models/omlx-release`)).status, 404);
    } finally {
      await server.close();
    }
  });
});
