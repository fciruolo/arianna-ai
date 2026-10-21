// "Progetti seguiti" in "Sviluppo di Arianna" (D-202): sources, states of the choice, marks.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NewsItem } from '../src/lib/design-news.ts';
import { choiceStatus, commitUrl, followedKind, followedUrlProblem, markChosen, projectSourceText, repoFacts, type FollowedProject, type ProjectNews } from '../src/lib/followed-projects.ts';

const item = (key: string, answer: NewsItem['answer'] = null): NewsItem => ({ key, title: key, summary: '', group: 'feat', commits: [{ sha: 'e'.repeat(40), short: 'eeeeeee', message: 'feat: x' }], answer });

const news = (items: NewsItem[], overrides: Partial<ProjectNews> = {}): ProjectNews => ({
  version: 1,
  repository: 'different-ai/openwork',
  from: 'v1',
  to: 'v2',
  fetchedAt: '2026-10-14T08:00:00Z',
  state: 'ready',
  message: null,
  source: 'raw',
  model: null,
  items,
  releases: [],
  commits: items.length,
  truncated: false,
  ...overrides,
});

const project = (items: NewsItem[]): FollowedProject => ({ id: 'different-ai/openwork', page: 'https://github.com/different-ai/openwork', addedAt: '', catalog: false, checking: false, seen: 'v2', checkedAt: null, message: null, news: news(items) });

describe('followed projects', () => {
  it('says where the entries come from', () => {
    assert.equal(projectSourceText(news([item('a')])), 'Elenco dei commit per tipo · 1 commit · v1 → v2');
    assert.equal(projectSourceText(news([], { source: 'model', from: null })), 'Raggruppate dal modello locale · 0 commit · v2');
    assert.equal(projectSourceText(news([], { source: null })), 'v1 → v2');
  });

  it('shows the buttons until a choice, then its state', () => {
    assert.equal(choiceStatus(item('a')), null);
    assert.match(choiceStatus(item('a', { state: 'new', at: '2026-10-14 10:00' })) ?? '', /leggerà/);
    assert.match(choiceStatus(item('a', { state: 'done', at: '2026-10-14 10:00' })) ?? '', /già letta/);
  });

  it('marks only the entry chosen, never one chosen before', () => {
    const before = [project([item('gh-a__b-1111111'), item('gh-a__b-2222222', { state: 'done', at: 'prima' })])];
    const after = markChosen(before, 'gh-a__b-1111111', 'ora');
    assert.deepEqual(after[0]?.news?.items.map((entry) => entry.answer?.at ?? null), ['ora', 'prima']);
    assert.deepEqual(markChosen(before, 'gh-a__b-2222222', 'ora')[0]?.news?.items[1]?.answer?.at, 'prima');
    assert.equal(before[0]?.news?.items[0]?.answer, null);
  });

  it('links a commit to the page of its project', () => {
    assert.equal(commitUrl(project([]), 'f'.repeat(40)), `https://github.com/different-ai/openwork/commit/${'f'.repeat(40)}`);
  });

  it('tells an account from a repository, and refuses anything else (D-271)', () => {
    assert.equal(followedKind('https://github.com/CopilotKit'), 'account');
    assert.equal(followedKind(' https://github.com/copilotkit/ '), 'account');
    assert.equal(followedKind('https://github.com/copilotkit/copilotkit'), 'project');
    for (const bad of ['https://gitlab.com/copilotkit', 'https://github.com/a/b/c', 'github.com/copilotkit', 'https://github.com/-x']) {
      assert.equal(followedKind(bad), null, bad);
      assert.match(followedUrlProblem(bad) ?? '', /Solo https/);
    }
    assert.match(followedUrlProblem('  ') ?? '', /Scrivi/);
    assert.equal(followedUrlProblem('https://github.com/copilotkit'), undefined);
  });

  it('says when a new repository was created and its license (D-271)', () => {
    const repo = { id: 'copilotkit/x', name: 'x', page: 'https://github.com/copilotkit/x', description: '', createdAt: '2026-10-20T10:00:00Z', followed: false };
    assert.equal(repoFacts({ ...repo, license: 'MIT' }, () => '20 ott'), 'creato il 20 ott · MIT');
    assert.equal(repoFacts({ ...repo, license: null }, () => '20 ott'), 'creato il 20 ott · licenza non indicata');
  });
});
