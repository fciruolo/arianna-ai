// "Novità di Open Design" in "Sviluppo di Arianna" (I-21, D-186): groups, states, sources.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupNews, markRedo, redoStatus, shownNews, sourceText, type DesignNews, type NewsItem } from '../src/lib/design-news.ts';

const commit = { sha: 'e'.repeat(40), short: 'eeeeeee', message: 'feat: comments' };
const item = (key: string, group: NewsItem['group']): NewsItem => ({ key, title: key, summary: '', group, commits: [commit], answer: null });

function news(overrides: Partial<DesignNews> = {}): DesignNews {
  return {
    version: 1,
    repository: 'nexu-io/open-design',
    from: 'a'.repeat(40),
    to: 'b'.repeat(40),
    fetchedAt: '2026-10-12T08:00:00Z',
    state: 'ready',
    message: null,
    source: 'raw',
    model: null,
    items: [item('od-1111111', 'feat'), item('od-2222222', 'feat'), item('od-3333333', 'fix')],
    releases: [],
    commits: 3,
    truncated: false,
    files: { styles: 1, skills: 0, other: 2 },
    ...overrides,
  };
}

describe('news of Open Design', () => {
  it('groups the raw list by kind and the entries of the model in one group', () => {
    assert.deepEqual(
      groupNews(news().items).map((group) => [group.title, group.items.length]),
      [
        ['Funzioni', 2],
        ['Correzioni', 1],
      ],
    );
    assert.deepEqual(
      groupNews([item('od-1111111', null), item('od-2222222', null)]).map((group) => group.title),
      [null],
    );
  });

  it('says where the entries come from', () => {
    assert.equal(sourceText(news()), 'Elenco dei commit per tipo · 3 commit, 3 file cambiati · aaaaaaa → bbbbbbb');
    assert.match(sourceText(news({ source: 'model' })), /^Raggruppate dal modello locale/);
    assert.equal(sourceText(news({ source: null, from: null })), '? → bbbbbbb');
  });

  it('marks an entry sent, and says its state; an entry not sent has none', () => {
    const pair = { pending: news(), adopted: null, preparing: false };
    assert.equal(redoStatus(pair.pending.items[0] as NewsItem), null);
    const marked = markRedo(pair, 'od-2222222', '2026-10-12 10:00');
    assert.match(redoStatus(marked.pending?.items[1] as NewsItem) ?? '', /^Scelta il 2026-10-12 10:00/);
    assert.equal(marked.pending?.items[0]?.answer, null);
    assert.match(redoStatus({ ...item('od-1', null), answer: { state: 'done', at: 'x' } }) ?? '', /^Già scelta/);
  });

  it('shows the version waiting first, then the one in use', () => {
    assert.deepEqual(shownNews(null), []);
    assert.deepEqual(
      shownNews({ pending: news(), adopted: news({ to: 'c'.repeat(40) }), preparing: false }).map((block) => block.label),
      ['Versione scaricata, in attesa', 'Versione in uso'],
    );
  });
});
