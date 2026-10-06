import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOUD_MODELS, ConfigError, loadCloudCatalog, parseCloudCatalog, resolveHome } from '../src/index.ts';

const VALID = `
version: 1
sources:
  - id: fake-page
    url: https://example.org/models
    read: "2026-10-01"
models:
  - alias: opus
    provider: Fake Provider
    family: Claude Opus
    executor: claude
    names:
      - name: claude-opus-9-9
        context_tokens: 1000000
        max_output_tokens: 128000
        description: A fake one
        source: fake-page
    strengths:
      - text: Fake strength
        source: fake-page
    api_price: { input: 4, output: 20.5, source: fake-page }
    quota_ratio: { relative_to: sonnet, times: 2, source: fake-page }
    terms: https://example.org/terms
    notes: Only fake
  - alias: codex
    provider: Fake Other
    family: Fake Codex
    executor: codex
`;

test('a valid cloud catalog is parsed', () => {
  const catalog = parseCloudCatalog(VALID);
  assert.deepEqual(catalog.sources, [{ id: 'fake-page', url: 'https://example.org/models', read: '2026-10-01' }]);
  assert.deepEqual(catalog.models[0], {
    alias: 'opus',
    provider: 'Fake Provider',
    family: 'Claude Opus',
    executor: 'claude',
    names: [{ name: 'claude-opus-9-9', source: 'fake-page', contextTokens: 1000000, maxOutputTokens: 128000, description: 'A fake one' }],
    strengths: [{ text: 'Fake strength', source: 'fake-page' }],
    apiPrice: { input: 4, output: 20.5, source: 'fake-page' },
    quotaRatio: { relativeTo: 'sonnet', times: 2, source: 'fake-page' },
    terms: 'https://example.org/terms',
    notes: 'Only fake',
  });
  // Every fact but the alias, the provider, the family and the executor may be left out.
  assert.deepEqual(catalog.models[1], { alias: 'codex', provider: 'Fake Other', family: 'Fake Codex', executor: 'codex', names: [], strengths: [] });
});

test('the committed cloud catalog loads, one entry per alias, every fact with its source', () => {
  const catalog = loadCloudCatalog(resolveHome({}));
  assert.deepEqual(catalog.models.map(({ alias }) => alias).sort(), [...CLOUD_MODELS].sort());
  assert.deepEqual(
    catalog.models.filter(({ executor }) => executor === 'claude').flatMap(({ names }) => names.map(({ name }) => name)).sort(),
    ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  );
  // Nothing measured is written as a fact: the share of the quota is not on any page read.
  assert.equal(catalog.models.some((entry) => entry.quotaRatio !== undefined), false);
});

test('a fact must name a listed source, and every source must be used', () => {
  assert.throws(() => parseCloudCatalog(VALID.replace('source: fake-page\n    strengths', 'source: other\n    strengths')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('    api_price: { input: 4, output: 20.5, source: fake-page }\n', '    api_price: { input: 4, output: 20.5 }\n')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('sources:\n', 'sources:\n  - id: unused\n    url: https://example.org/x\n    read: "2026-10-01"\n')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('sources:\n', 'sources:\n  - id: fake-page\n    url: https://example.org/x\n    read: "2026-10-01"\n')), ConfigError);
});

test('sources are https pages with the day they were read', () => {
  assert.throws(() => parseCloudCatalog(VALID.replace('https://example.org/models', 'http://example.org/models')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('"2026-10-01"', '"2026-13-01"')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('"2026-10-01"', '"yesterday"')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('id: fake-page\n', 'id: Fake Page\n')), ConfigError);
});

test('aliases are those of the router, once each, on their own executor', () => {
  assert.throws(() => parseCloudCatalog(VALID.replace('alias: codex', 'alias: gpt')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('alias: codex', 'alias: opus')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('executor: codex', 'executor: claude')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('executor: claude', 'executor: codex')), ConfigError);
});

test('names follow the rule of [cloud.models]: valid for --model and of the family of the alias', () => {
  assert.throws(() => parseCloudCatalog(VALID.replace('claude-opus-9-9', 'claude-sonnet-9-9')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('claude-opus-9-9', '--opus')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('context_tokens: 1000000', 'context_tokens: 0')), ConfigError);
  const twice = VALID.replace(
    '        source: fake-page\n    strengths',
    '        source: fake-page\n      - name: claude-opus-9-9\n        source: fake-page\n    strengths',
  );
  assert.throws(() => parseCloudCatalog(twice), ConfigError);
});

test('strengths, prices, ratios and unknown keys are checked', () => {
  assert.throws(() => parseCloudCatalog(VALID.replace('text: Fake strength', 'text: ""')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('input: 4,', 'input: -4,')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('input: 4,', 'input: "4",')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('relative_to: sonnet', 'relative_to: opus')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('times: 2', 'times: 0')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('terms: https://example.org/terms', 'terms: example.org/terms')), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('notes: Only fake', 'notes: Only fake\n    price: 3')), ConfigError);
  assert.throws(() => parseCloudCatalog(`${VALID}extra: true\n`), ConfigError);
  assert.throws(() => parseCloudCatalog(VALID.replace('version: 1', 'version: 2')), ConfigError);
  assert.throws(() => parseCloudCatalog('version: 1\nmodels: []\n'), ConfigError);
  assert.deepEqual(parseCloudCatalog('version: 1\nsources: []\nmodels: []\n').models, []);
});
