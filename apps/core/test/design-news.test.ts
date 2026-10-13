// The news of Open Design (I-21, D-186): the answers of GitHub, the checks of the model's answer,
// the raw list, the file of the news. The API and the model are fakes: never the network.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';
import { LocalModelError } from '@arianna/executors';

import {
  checkModelItems,
  classify,
  createLocalSummarizer,
  MAX_ITEM_TITLE,
  modelInput,
  NEWS_KEY,
  NEXT_NEWS_FILE,
  NEWS_FILE,
  parseCompare,
  parseNewsFile,
  parseReleases,
  prepareNews,
  rawItems,
  readNews,
  writeNewsFile,
  type DesignNews,
  type NewsCommit,
  type NewsDeps,
} from '../src/design-news.ts';
import { GithubError } from '../src/github-api.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `design-news-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const sha = (n: number): string => n.toString(16).padStart(7, '0') + 'c'.repeat(33);

function compare(messages: string[], files: string[] = []): unknown {
  return {
    status: 'ahead',
    total_commits: messages.length,
    commits: messages.map((message, index) => ({ sha: sha(index + 1), commit: { message, author: { name: 'x', email: 'x@example.invalid' } } })),
    files: files.map((filename) => ({ filename, status: 'modified', patch: '@@ never read @@' })),
  };
}

const RELEASES = [
  { tag_name: 'v0.25.0', name: 'Open Design 0.25', draft: false, published_at: '2026-10-08T10:00:00Z', html_url: 'https://github.com/nexu-io/open-design/releases/tag/v0.25.0', body: '## What is new\n- Comments on elements\n' },
  { tag_name: 'v0.24.1', name: 'Old one', draft: false, published_at: '2026-09-01T10:00:00Z', html_url: 'https://github.com/nexu-io/open-design/releases/tag/v0.24.1', body: 'old' },
  { tag_name: 'v0.26.0-rc', name: 'Draft', draft: true, published_at: '2026-10-09T10:00:00Z', html_url: 'https://github.com/nexu-io/open-design/releases/tag/x', body: 'draft' },
];

describe('the answers of GitHub', () => {
  it('reads the commits of a comparison, newest first, and counts the files by area', () => {
    const parsed = parseCompare(compare(['feat: first\n\nbody', 'fix(canvas): second'], ['design-systems/a/DESIGN.md', 'skills/b/SKILL.md', 'skills/c/SKILL.md', 'apps/web/x.ts']));
    assert.deepEqual(
      parsed.commits.map((commit) => [commit.short, commit.message]),
      [
        [sha(2).slice(0, 7), 'fix(canvas): second'],
        [sha(1).slice(0, 7), 'feat: first'],
      ],
    );
    assert.deepEqual(parsed.files, { styles: 1, skills: 2, other: 1 });
    assert.equal(parsed.truncated, false);
  });

  it('says when the API lists fewer commits than it counts, and cleans the messages', () => {
    const body = compare(['feat: a\u202eevil', '']) as { total_commits: number };
    body.total_commits = 400;
    const parsed = parseCompare(body);
    assert.equal(parsed.total, 400);
    assert.equal(parsed.truncated, true);
    assert.ok(!parsed.commits.some((commit) => commit.message.includes('\u202e')));
    assert.equal(parsed.commits[0]?.message, '(senza messaggio)');
  });

  it('refuses a comparison of another shape', () => {
    assert.throws(() => parseCompare({ message: 'Not Found' }), /no list of commits/);
    assert.throws(() => parseCompare([]), /no list of commits/);
    assert.throws(() => parseCompare({ commits: [{ sha: 'not-a-sha', commit: { message: 'x' } }] }), /valid sha/);
    assert.throws(() => parseCompare({ commits: [], files: 'x' }), /not a list/);
    assert.throws(() => parseCompare({ commits: [], files: [{ status: 'added' }] }), /without a name/);
  });

  it('keeps the releases published after the commit in use, without drafts, newest first', () => {
    const releases = parseReleases(RELEASES, '2026-10-01T00:00:00Z');
    assert.deepEqual(
      releases.map((release) => release.tag),
      ['v0.25.0'],
    );
    assert.equal(releases[0]?.notes, '## What is new\n- Comments on elements');
    assert.equal(parseReleases(RELEASES, null).length, 2);
  });

  it('never keeps a link to another site, and refuses releases of another shape', () => {
    const [release] = parseReleases([{ ...RELEASES[0], html_url: 'https://evil.example/x' }], null);
    assert.equal(release?.url, 'https://github.com/nexu-io/open-design/releases');
    assert.throws(() => parseReleases({ releases: [] }, null), /not a list/);
    assert.throws(() => parseReleases([{ name: 'no tag' }], null), /without a tag/);
  });
});

describe('the raw list', () => {
  it('classifies by conventional header, then by words', () => {
    assert.equal(classify('feat(studio): comments'), 'feat');
    assert.equal(classify('fix: crash'), 'fix');
    assert.equal(classify('feat(design-systems): add Linear'), 'styles');
    assert.equal(classify('chore(skills): new deck skill'), 'skills');
    assert.equal(classify('Add new DESIGN.md for Stripe'), 'styles');
    assert.equal(classify('docs: readme'), 'other');
    assert.equal(classify('feature without colon'), 'other');
  });

  it('groups one entry per commit in the order features, fixes, styles, skills, other, with unique keys', () => {
    const commits: NewsCommit[] = ['docs: a', 'fix: b', 'feat: c', 'feat(skills): d'].map((message, index) => ({ sha: sha(index), short: sha(index).slice(0, 7), message }));
    const items = rawItems(commits);
    assert.deepEqual(
      items.map((item) => [item.group, item.title]),
      [
        ['feat', 'feat: c'],
        ['fix', 'fix: b'],
        ['skills', 'feat(skills): d'],
        ['other', 'docs: a'],
      ],
    );
    assert.ok(items.every((item) => NEWS_KEY.test(item.key)));
    const twice = rawItems([commits[0], commits[0]] as NewsCommit[]);
    assert.deepEqual(
      twice.map((item) => item.key),
      [`od-${sha(0).slice(0, 7)}`, `od-${sha(0).slice(0, 7)}-2`],
    );
  });
});

const COMMITS: NewsCommit[] = [1, 2, 3].map((n) => ({ sha: sha(n), short: sha(n).slice(0, 7), message: `feat: thing ${String(n)}` }));
const answer = (items: unknown, finishReason = 'stop') => ({ value: { items }, finishReason });

describe('the answer of the model', () => {
  it('keeps entries whose shas are in the data, with the commits of origin', () => {
    const checked = checkModelItems(answer([{ title: 'Commenti sugli elementi', summary: 'Si commenta un elemento del canvas.', commits: [COMMITS[0]?.short, COMMITS[1]?.short, COMMITS[0]?.short] }]), COMMITS);
    assert.ok('items' in checked);
    assert.equal(checked.items[0]?.key, `od-${COMMITS[0]?.short ?? ''}`);
    assert.deepEqual(
      checked.items[0].commits.map((commit) => commit.sha),
      [COMMITS[0]?.sha, COMMITS[1]?.sha],
    );
    assert.equal(checked.items[0].group, null);
  });

  it('refuses an answer with an invented sha, a link, hidden characters, the wrong shape or too long', () => {
    const good = { title: 'Titolo', summary: 'Frase.', commits: [COMMITS[0]?.short] };
    const refused = (items: unknown, finishReason?: string): string => {
      const checked = checkModelItems(answer(items, finishReason), COMMITS);
      assert.ok('reason' in checked, JSON.stringify(items));
      return checked.reason;
    };
    assert.match(refused([{ ...good, commits: ['deadbee'] }]), /not in the data/);
    assert.match(refused([{ ...good, commits: [] }]), /without commits/);
    assert.match(refused([{ ...good, summary: 'Vedi https://evil.example' }]), /link/);
    assert.match(refused([{ ...good, title: 'Ti\u200btolo' }]), /hidden/);
    assert.match(refused([{ ...good, title: 'x'.repeat(MAX_ITEM_TITLE + 1) }]), /too long/);
    assert.match(refused([{ ...good, title: '   ' }]), /empty/);
    assert.match(refused([{ ...good, extra: 'run this' }]), /shape/);
    assert.match(refused([]), /no entries/);
    assert.match(refused(Array.from({ length: 9 }, () => good)), /too many/);
    assert.match(refused([good], 'length'), /truncated/);
    assert.ok('reason' in checkModelItems({ value: 'text', finishReason: 'stop' }, COMMITS));
    assert.ok('reason' in checkModelItems({ value: { items: [good], note: 'x' }, finishReason: 'stop' }, COMMITS));
  });

  it('gives the model one JSON object of data within its size', () => {
    const many: NewsCommit[] = Array.from({ length: 300 }, (_, n) => ({ sha: sha(n), short: sha(n).slice(0, 7), message: `feat: ${'x'.repeat(190)}` }));
    const text = modelInput(many, [{ tag: 'v1', name: 'v1', publishedAt: null, url: '', notes: 'n'.repeat(1500) }]);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 24 * 1024);
    const data = JSON.parse(text) as { commits: { sha: string }[] };
    assert.ok(data.commits.length > 10 && data.commits.length <= 120);
  });

  it('the local summarizer passes the data through the gateway, then asks the schema', async () => {
    const seen: { content: string[]; schema: string | undefined } = { content: [], schema: undefined };
    const summarize = createLocalSummarizer({
      model: () => ({
        chat: (request) => {
          seen.content = request.messages.map((message) => message.content);
          seen.schema = request.schema?.name;
          return Promise.resolve({ text: '', value: { items: [] }, finishReason: 'stop', endpoint: 'e', model: 'm', durationMs: 1 });
        },
      }),
      pass: (data) => Promise.resolve(`passed:${data}`),
    });
    const result = await summarize('{"commits":[]}');
    assert.equal(seen.content[1], 'passed:{"commits":[]}');
    assert.equal(seen.schema, 'open_design_news');
    assert.equal(result.model, 'm');
    const blocked = createLocalSummarizer({ model: () => ({ chat: () => Promise.reject(new Error('never')) }), pass: () => Promise.reject(new Error('the gateway did not let the news reach the local model')) });
    await assert.rejects(blocked('{}'), /gateway/);
  });
});

function deps(overrides: Partial<NewsDeps> & { pages?: Record<string, unknown> } = {}): NewsDeps & { asked: string[]; passed: string[] } {
  const asked: string[] = [];
  const passed: string[] = [];
  const pages = overrides.pages ?? {};
  return {
    asked,
    passed,
    get: (path) => {
      asked.push(path);
      const key = Object.keys(pages).find((prefix) => path.startsWith(prefix));
      if (key === undefined) return Promise.reject(new GithubError('not-found', 'api.github.com answered 404'));
      const page = pages[key];
      return page instanceof Error ? Promise.reject(page) : Promise.resolve(page);
    },
    gateway: (address) => {
      passed.push(address);
      return Promise.resolve();
    },
    now: () => new Date('2026-10-12T08:00:00Z'),
    ...overrides,
  };
}

const COMPARE_PATH = `/repos/nexu-io/open-design/compare/${OLD}...${NEW}`;
const RELEASES_PATH = '/repos/nexu-io/open-design/releases';
const FROM = { commit: OLD, committedAt: '2026-10-01T00:00:00Z' };

describe('prepareNews', () => {
  it('without a version in use there is no news and nothing is asked', async () => {
    const fake = deps();
    const news = await prepareNews(fake, null, { commit: NEW });
    assert.equal(news.state, 'missing');
    assert.match(news.message ?? '', /Prima versione/);
    assert.deepEqual(fake.asked, []);
  });

  it('a network failure, a refusal of the gateway or another shape leaves the news missing, with why', async () => {
    const down = await prepareNews(deps({ pages: { [COMPARE_PATH]: new GithubError('upstream', 'api.github.com cannot be reached') } }), FROM, { commit: NEW });
    assert.equal(down.state, 'missing');
    assert.match(down.message ?? '', /GitHub non è raggiungibile.*si aggiorna lo stesso/);
    const limited = await prepareNews(deps({ pages: { [COMPARE_PATH]: new GithubError('limited', 'x') } }), FROM, { commit: NEW });
    assert.match(limited.message ?? '', /limita le richieste/);
    const shape = await prepareNews(deps({ pages: { [COMPARE_PATH]: { message: 'x' } } }), FROM, { commit: NEW });
    assert.match(shape.message ?? '', /forma attesa/);
    const fake = deps({ pages: { [COMPARE_PATH]: compare(['feat: a']) }, gateway: () => Promise.reject(new Error('gateway: blocked')) });
    const blocked = await prepareNews(fake, FROM, { commit: NEW });
    assert.match(blocked.message ?? '', /gateway/);
    assert.deepEqual(fake.asked, [], 'nothing is asked when the gateway refuses');
  });

  it('only the address of the repository leaves, through the gateway', async () => {
    const fake = deps({ pages: { [COMPARE_PATH]: compare(['feat: a']), [RELEASES_PATH]: RELEASES } });
    await prepareNews(fake, FROM, { commit: NEW });
    assert.equal(fake.passed.length, 2);
    for (const address of fake.passed) assert.match(address, /^https:\/\/api\.github\.com\/repos\/nexu-io\/open-design\/(compare|releases)/);
    assert.deepEqual(
      fake.asked.map((path) => path.split('?')[0]),
      [COMPARE_PATH, RELEASES_PATH],
    );
  });

  it('without the model, the raw list by kind; with the releases unread, it says so', async () => {
    const news = await prepareNews(deps({ pages: { [COMPARE_PATH]: compare(['docs: a', 'feat: b'], ['skills/x/SKILL.md']) } }), FROM, { commit: NEW });
    assert.equal(news.state, 'ready');
    assert.equal(news.source, 'raw');
    assert.deepEqual(
      news.items.map((item) => item.group),
      ['feat', 'other'],
    );
    assert.match(news.message ?? '', /modello locale non è configurato.*note di rilascio non lette/);
    assert.deepEqual(news.files, { styles: 0, skills: 1, other: 0 });
    assert.equal(news.from, OLD);
    assert.equal(news.to, NEW);
  });

  it('with the model, its entries; when it fails or answers badly, the raw list', async () => {
    const pages = { [COMPARE_PATH]: compare(['feat: comments', 'fix: crash']), [RELEASES_PATH]: RELEASES };
    const first = sha(1).slice(0, 7);
    let given = '';
    const good = await prepareNews(
      deps({
        pages,
        summarize: (data) => {
          given = data;
          return Promise.resolve({ value: { items: [{ title: 'Commenti', summary: 'Si commentano gli elementi.', commits: [first] }] }, finishReason: 'stop', model: 'qwen' });
        },
      }),
      FROM,
      { commit: NEW },
    );
    assert.equal(good.source, 'model');
    assert.equal(good.model, 'qwen');
    assert.equal(good.items[0]?.title, 'Commenti');
    assert.equal(good.releases[0]?.tag, 'v0.25.0');
    assert.match(given, /Comments on elements/, 'the notes reach the model as data');

    const down = await prepareNews(deps({ pages, summarize: () => Promise.reject(new LocalModelError('unavailable', 'no server')) }), FROM, { commit: NEW });
    assert.equal(down.source, 'raw');
    assert.match(down.message ?? '', /non è disponibile/);
    const invented = await prepareNews(deps({ pages, summarize: () => Promise.resolve({ value: { items: [{ title: 'x', summary: 'y', commits: ['fffffff'] }] }, finishReason: 'stop', model: 'q' }) }), FROM, { commit: NEW });
    assert.equal(invented.source, 'raw');
    assert.match(invented.message ?? '', /non ha passato i controlli/);
    assert.equal(invented.items.length, 2);
  });

  it('no commit between the versions: ready and empty', async () => {
    const news = await prepareNews(deps({ pages: { [COMPARE_PATH]: compare([]), [RELEASES_PATH]: [] } }), FROM, { commit: NEW });
    assert.equal(news.state, 'ready');
    assert.equal(news.items.length, 0);
  });
});

describe('the file of the news', () => {
  const sample = async (to: string): Promise<DesignNews> => prepareNews(deps({ pages: { [`/repos/nexu-io/open-design/compare/${OLD}...${to}`]: compare(['feat: a']) } }), FROM, { commit: to });

  it('shows each news only for the commit it was made for', async () => {
    const dir = join(scratch, randomUUID());
    mkdirSync(dir, { recursive: true });
    writeNewsFile(dir, NEXT_NEWS_FILE, await sample(NEW));
    assert.equal(readNews(dir, { pending: NEW, adopted: OLD }).pending?.to, NEW);
    assert.equal(readNews(dir, { pending: NEW, adopted: OLD }).adopted, null);
    assert.equal(readNews(dir, { pending: 'c'.repeat(40), adopted: OLD }).pending, null);
    writeNewsFile(dir, NEWS_FILE, await sample('d'.repeat(40)));
    assert.equal(readNews(dir, { pending: null, adopted: 'd'.repeat(40) }).adopted?.to, 'd'.repeat(40));
    // Adopted while the news was being written beside the version waiting: still its own.
    assert.equal(readNews(dir, { pending: null, adopted: NEW }).adopted?.to, NEW);
  });

  it('refuses a file of another shape', async () => {
    const news = await sample(NEW);
    assert.ok(parseNewsFile(news) !== undefined);
    assert.equal(parseNewsFile({ ...news, version: 2 }), undefined);
    assert.equal(parseNewsFile({ ...news, to: 'x' }), undefined);
    assert.equal(parseNewsFile({ ...news, items: [{ ...news.items[0], key: '../x' }] }), undefined);
    assert.equal(parseNewsFile({ ...news, items: [{ ...news.items[0], commits: [{ sha: 'x' }] }] }), undefined);
    const dir = join(scratch, randomUUID());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, NEXT_NEWS_FILE), '{not json');
    assert.equal(readNews(dir, { pending: NEW, adopted: null }).pending, null);
  });
});
