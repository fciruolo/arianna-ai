// «Seguiti» (D-272): the cards of the grid and the search in the news, all on the page.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NewsItem, NewsPair } from '../src/lib/design-news.ts';
import { followedCards, highlight, noResultText, searchFollowed, snippet } from '../src/lib/followed-page.ts';
import type { FollowedAccount, FollowedProject, ProjectNews } from '../src/lib/followed-projects.ts';
import type { OmlxReleaseView } from '../src/lib/omlx-release.ts';

const item = (key: string, title: string, summary = '', messages: string[] = []): NewsItem => ({
  key,
  title,
  summary,
  group: 'feat',
  commits: messages.map((message, index) => ({ sha: String(index).repeat(40).slice(0, 40), short: String(index).repeat(7), message })),
  answer: null,
});

const news = (items: NewsItem[], notes = ''): ProjectNews => ({
  version: 1,
  repository: 'different-ai/openwork',
  from: 'v1',
  to: 'v2',
  fetchedAt: '2026-10-21T08:00:00Z',
  state: 'ready',
  message: null,
  source: 'raw',
  model: null,
  items,
  releases: [{ tag: 'v2', name: 'OpenWork v2', publishedAt: null, url: 'https://github.com/different-ai/openwork/releases/tag/v2', notes }],
  commits: items.length,
  truncated: false,
});

const project = (id: string, extra: Partial<FollowedProject> = {}): FollowedProject => ({ id, page: `https://github.com/${id}`, addedAt: '', catalog: false, checking: false, seen: 'v2', checkedAt: '2026-10-21T08:00:00Z', message: null, news: null, ...extra });

const ACCOUNT: FollowedAccount = {
  id: 'copilotkit',
  page: 'https://github.com/copilotkit',
  addedAt: '',
  checking: false,
  checkedAt: '2026-10-21T09:00:00Z',
  message: null,
  firstCount: 44,
  freshAt: '2026-10-21T09:00:00Z',
  fresh: [{ id: 'copilotkit/new-agent', name: 'new-agent', page: 'https://github.com/copilotkit/new-agent', description: 'Agenti con memoria condivisa', createdAt: '2026-10-20T10:00:00Z', license: 'MIT', followed: false }],
};

const OMLX = { installed: { version: '0.7.1', endpoint: null, readAt: null, error: null }, checkedAt: null, latest: { version: '0.7.2', url: 'https://github.com/jundot/omlx/releases/tag/v0.7.2' }, update: true, news: null } as unknown as OmlxReleaseView;

const sources = () => ({
  projects: [
    project('nexu-io/open-design', { catalog: true }),
    project('different-ai/openwork', { description: 'Agenti sul desktop', news: news([item('a', 'Note vocali', 'Si parla alla chat', ['feat: voice notes']), item('b', 'Ferma la risposta'), item('c', 'Cronologia'), item('d', 'Tema scuro')], 'Fixes the Voice recorder') }),
    project('other/quiet'),
  ],
  accounts: [ACCOUNT],
  omlx: OMLX,
  openDesign: { pending: null, adopted: { ...news([item('od', 'Stili nuovi per le slide')]), files: { styles: 1, skills: 0, other: 0 } }, preparing: false } as NewsPair,
});

describe('the cards of «Seguiti»', () => {
  it('one per project (not the catalog one), account, oMLX and Open Design, with the first three news', () => {
    const cards = followedCards(sources());
    assert.deepEqual(
      cards.map((card) => [card.key, card.count]),
      [
        ['project:different-ai/openwork', 4],
        ['project:other/quiet', 0],
        ['account:copilotkit', 1],
        ['omlx', 0],
        ['open-design', 1],
      ],
    );
    assert.deepEqual(cards[0]?.top, ['Note vocali', 'Ferma la risposta', 'Cronologia']);
    assert.equal(cards[0].description, 'Agenti sul desktop');
    assert.equal(cards[1]?.description, '');
    assert.match(cards[2]?.description ?? '', /44 repository al primo controllo/);
    assert.equal(cards[3]?.release, '0.7.2');
    assert.equal(cards[3].tag, 'Aggiornamento');
    assert.equal(cards[4]?.release, 'OpenWork v2');
  });

  it('without oMLX or Open Design from the core, no card for them', () => {
    assert.deepEqual(
      followedCards({ ...sources(), omlx: null, openDesign: null }).map((card) => card.kind),
      ['project', 'project', 'account'],
    );
  });
});

describe('the search of «Seguiti»', () => {
  it('finds news, commits, release notes and new repositories, and keeps only the cards with a hit', () => {
    const cards = followedCards(sources());
    const voice = searchFollowed(cards, 'VOICE');
    assert.deepEqual(
      voice.cards.map((card) => card.key),
      ['project:different-ai/openwork'],
    );
    assert.deepEqual(
      voice.results.map((result) => [result.source, result.kind, result.text, result.context]),
      [
        ['different-ai/openwork', 'release', 'OpenWork v2', 'Fixes the Voice recorder'],
        ['different-ai/openwork', 'news', 'Note vocali', 'Si parla alla chat feat: voice notes'],
      ],
    );
    const memory = searchFollowed(cards, 'memoria');
    assert.deepEqual(
      memory.results.map((result) => [result.cardKey, result.kind, result.text]),
      [['account:copilotkit', 'repo', 'copilotkit/new-agent']],
    );
    // A card found by its own name or description, with no row.
    assert.deepEqual(
      searchFollowed(cards, 'quiet').cards.map((card) => card.key),
      ['project:other/quiet'],
    );
    assert.deepEqual(searchFollowed(cards, 'quiet').results, []);
  });

  it('an empty query keeps every card; no hit gives no card and no row', () => {
    const cards = followedCards(sources());
    assert.equal(searchFollowed(cards, '   ').cards.length, cards.length);
    assert.deepEqual(searchFollowed(cards, '   ').results, []);
    assert.deepEqual(searchFollowed(cards, 'zzz'), { cards: [], results: [] });
    assert.equal(noResultText(' zzz '), 'Nessuna novità con «zzz».');
  });

  it('marks every hit ignoring case, and cuts a long text around the first one', () => {
    assert.deepEqual(highlight('Voice and voice', 'voice'), [
      { text: 'Voice', hit: true },
      { text: ' and ', hit: false },
      { text: 'voice', hit: true },
    ]);
    assert.deepEqual(highlight('Note vocali', ''), [{ text: 'Note vocali', hit: false }]);
    assert.deepEqual(highlight('Note', 'xyz'), [{ text: 'Note', hit: false }]);
    const long = `${'a '.repeat(100)}trovato${' b'.repeat(100)}`;
    const cut = snippet(long, 'trovato', 10);
    assert.match(cut, /^…a a a a a trovato b b b b b…$/);
    assert.equal(snippet('niente', 'x'), '');
  });
});
