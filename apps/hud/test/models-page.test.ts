import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cardSources,
  chosenKey,
  cloudNotice,
  contextText,
  countText,
  EMPTY_FILTER,
  filterModels,
  memorySummary,
  modelEntries,
  overviewErrorText,
  priceText,
  privacyText,
  providerName,
  providersOf,
  shownName,
  sizeText,
  toggleRole,
  unsavedKeys,
  usageLines,
  useText,
  type CloudModelView,
  type LocalModelView,
  type ModelEntry,
  type ModelFilter,
  type ModelsOverview,
} from '../src/lib/models-page.ts';
import type { CloudModelsForm } from '../src/lib/settings.ts';

const local = (id: string, overrides: Partial<LocalModelView> = {}): LocalModelView => ({
  locality: 'local',
  id,
  family: 'qwen3.8',
  runtime: 'mlx',
  ramMinGib: 18,
  status: 'experimental',
  sizeBytes: 16_100_000_000,
  provider: 'Qwen (Alibaba); conversione MLX di mlx-community',
  contextTokens: null,
  strengths: [],
  license: null,
  notes: null,
  source: null,
  suitedRoles: ['orchestrator'],
  origin: 'catalog',
  roles: [],
  aliases: [],
  agents: [],
  uses: [],
  present: true,
  state: 'on-disk',
  hasFiles: true,
  missingBytes: 0,
  action: null,
  loaded: [],
  lastEval: null,
  ...overrides,
});

const cloud = (alias: CloudModelView['alias'], overrides: Partial<CloudModelView> = {}): CloudModelView => ({
  locality: 'cloud',
  alias,
  executor: ['luna', 'sol', 'astra'].includes(alias) ? 'codex' : 'claude',
  card: null,
  enabled: true,
  name: null,
  executorEnabled: true,
  adapter: true,
  state: 'on',
  budgetApproval: false,
  agents: [],
  uses: [],
  ...overrides,
});

const overview: ModelsOverview = {
  local: [
    local('qwen3.8-27b-4bit', {
      roles: ['orchestrator'],
      aliases: ['local-large'],
      agents: ['arianna'],
      state: 'loaded',
      uses: [
        { kind: 'plan', tier: 0, tiers: 1 },
        { kind: 'coding', tier: 0, tiers: 1, fallback: true },
      ],
    }),
    local('kokoro-82m-bf16-mlx', { family: 'kokoro', provider: 'hexgrad; conversione MLX di mlx-community', suitedRoles: ['tts'], present: false, state: 'missing' }),
  ],
  cloud: [
    cloud('sonnet', {
      agents: ['coder'],
      uses: [
        { kind: 'coding', tier: 0, tiers: 3 },
        { kind: 'review', tier: 0, tiers: 3 },
      ],
      card: {
        alias: 'sonnet',
        provider: 'Anthropic',
        family: 'Claude Sonnet',
        executor: 'claude',
        names: [{ name: 'claude-sonnet-5-5', source: 'anthropic-models', contextTokens: 1_000_000, maxOutputTokens: 128_000 }],
        strengths: [{ text: 'Veloce', source: 'anthropic-models' }],
        apiPrice: { input: 2, output: 10, source: 'anthropic-models' },
      },
    }),
    cloud('opus', { state: 'off', enabled: false, uses: [{ kind: 'coding', tier: 1, tiers: 3 }] }),
    cloud('sol', { state: 'not-connected', adapter: false }),
  ],
  sources: [{ id: 'anthropic-models', url: 'https://example.org/models', read: '2026-10-07' }],
  memory: { memoryGib: 64, budgets: [{ endpoint: 'omlx', gib: 24 }], estimatedGib: 21, swap: null },
  trash: null,
  errors: { catalog: null, cloudCatalog: null, evals: null },
};

const entries = modelEntries(overview);
function byKey(key: string): ModelEntry {
  const found = entries.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no entry ${key}`);
  return found;
}
const keys = (filter: Partial<ModelFilter>): string[] => filterModels(entries, { ...EMPTY_FILTER, ...filter }).map((entry) => entry.key);

describe('modelEntries', () => {
  it('lists local models first, then cloud ones, each with a unique key', () => {
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['local:qwen3.8-27b-4bit', 'local:kokoro-82m-bf16-mlx', 'cloud:sonnet', 'cloud:opus', 'cloud:sol'],
    );
    assert.deepEqual(modelEntries(null), []);
  });

  it('names, providers, states and badges', () => {
    const qwen = byKey('local:qwen3.8-27b-4bit');
    assert.equal(qwen.provider, 'Qwen');
    assert.equal(qwen.badge, 'Qw');
    assert.deepEqual(qwen.state, { text: 'in memoria', tone: 'ok' });
    assert.equal(qwen.inUse, true);
    const kokoro = byKey('local:kokoro-82m-bf16-mlx');
    assert.equal(kokoro.state.text, 'da scaricare');
    assert.equal(kokoro.inUse, false);
    const sonnet = byKey('cloud:sonnet');
    assert.equal(sonnet.name, 'Claude Sonnet');
    assert.equal(sonnet.sub, 'Anthropic · cloud · alias sonnet');
    const opus = byKey('cloud:opus');
    assert.equal(opus.state.text, 'spento');
    assert.equal(opus.inUse, false);
    // Codex without a card still has its provider and says why it is out.
    const codex = byKey('cloud:sol');
    assert.equal(codex.provider, 'OpenAI');
    assert.equal(codex.name, 'Codex Sol');
    assert.equal(codex.badge, 'So');
    assert.equal(codex.state.text, 'non collegato');
  });

  it('keeps who makes a local model, without the converter', () => {
    assert.equal(providerName('Qwen (Alibaba); conversione MLX di mlx-community'), 'Qwen');
    assert.equal(providerName('Mistral AI; conversione MLX'), 'Mistral AI');
    assert.equal(providerName(null), 'Sconosciuto');
    assert.equal(providerName(''), 'Sconosciuto');
    assert.deepEqual(providersOf(entries), ['Qwen', 'hexgrad', 'Anthropic', 'OpenAI']);
  });
});

describe('filterModels', () => {
  it('passes everything with the empty filter', () => {
    assert.equal(keys({}).length, entries.length);
  });

  it('filters by where it runs and by provider', () => {
    assert.deepEqual(keys({ where: 'local' }), ['local:qwen3.8-27b-4bit', 'local:kokoro-82m-bf16-mlx']);
    assert.deepEqual(keys({ where: 'cloud', provider: 'Anthropic' }), ['cloud:sonnet', 'cloud:opus']);
    assert.deepEqual(keys({ where: 'local', provider: 'Anthropic' }), []);
  });

  it('filters by role and by kind of step, a fallback included', () => {
    assert.deepEqual(keys({ use: 'role:orchestrator' }), ['local:qwen3.8-27b-4bit']);
    // A role is only of local models; a suited role not given is not enough.
    assert.deepEqual(keys({ use: 'role:tts' }), []);
    assert.deepEqual(keys({ use: 'step:coding' }), ['local:qwen3.8-27b-4bit', 'cloud:sonnet', 'cloud:opus']);
    assert.deepEqual(keys({ use: 'step:review' }), ['cloud:sonnet']);
    assert.deepEqual(keys({ use: 'nonsense' }), []);
  });

  it('keeps only the models in use', () => {
    assert.deepEqual(keys({ inUse: true }), ['local:qwen3.8-27b-4bit', 'cloud:sonnet']);
  });

  it('searches every word, without case, in names, ids and exact names', () => {
    assert.deepEqual(keys({ query: 'OPUS' }), ['cloud:opus']);
    assert.deepEqual(keys({ query: 'claude-sonnet-5-5' }), ['cloud:sonnet']);
    assert.deepEqual(keys({ query: 'local-large' }), ['local:qwen3.8-27b-4bit']);
    assert.deepEqual(keys({ query: '  qwen   mac ' }), ['local:qwen3.8-27b-4bit']);
    assert.deepEqual(keys({ query: 'qwen anthropic' }), []);
    assert.deepEqual(keys({ query: 'codex' }), ['cloud:sol']);
    assert.deepEqual(keys({ query: 'gemini' }), []);
  });

  it('counts in Italian', () => {
    assert.equal(countText(1), '1 modello');
    assert.equal(countText(0), '0 modelli');
    assert.equal(countText(4), '4 modelli');
  });
});

describe('chosenKey', () => {
  it('keeps the chosen model while it is shown, else the first one', () => {
    assert.equal(chosenKey(entries, 'cloud:opus'), 'cloud:opus');
    assert.equal(chosenKey(entries, null), 'local:qwen3.8-27b-4bit');
    const cloudOnly = filterModels(entries, { ...EMPTY_FILTER, where: 'cloud' });
    assert.equal(chosenKey(cloudOnly, 'local:qwen3.8-27b-4bit'), 'cloud:sonnet');
    assert.equal(chosenKey([], 'cloud:opus'), null);
  });
});

describe('usage', () => {
  it('says the tier of each step from the router, never written by hand', () => {
    assert.equal(useText({ kind: 'coding', tier: 1, tiers: 3 }), 'Coding: secondo gradino di 3');
    assert.equal(useText({ kind: 'plan', tier: 0, tiers: 1 }), 'Pianificazione: sempre');
    assert.match(useText({ kind: 'review', tier: 0, tiers: 1, fallback: true }), /^Revisione: solo quando il cloud non è ammesso/);
    assert.equal(useText({ kind: 'extract', tier: 7, tiers: 9 }), 'Estrazione: 8° gradino di 9');
  });

  it('lists roles with aliases, steps and agents', () => {
    const [qwen, kokoro] = overview.local;
    assert.ok(qwen !== undefined && kokoro !== undefined);
    const lines = usageLines(qwen);
    assert.equal(lines[0], 'Ruolo Orchestratore (alias local-large)');
    assert.equal(lines[1], 'Pianificazione: sempre');
    assert.equal(lines.at(-1), 'Agenti che partono con questo modello: Arianna');
    assert.deepEqual(usageLines(kokoro), []);
    assert.deepEqual(usageLines(overview.cloud[0] as CloudModelView).slice(-1), ['Agenti che partono con questo modello: Coder']);
  });
});

describe('numbers', () => {
  it('writes sizes and contexts', () => {
    assert.equal(sizeText(16_100_000_000), '16,1 GB');
    assert.equal(sizeText(820_000_000), '820 MB');
    assert.equal(sizeText(1000), '1 MB');
    assert.equal(contextText(1_000_000), '1M token');
    assert.equal(contextText(200_000), '200k token');
    assert.equal(contextText(512), '512 token');
    assert.equal(contextText(null), 'non indicato');
    assert.equal(contextText(undefined), 'non indicato');
  });

  it('sums the memory on the ceiling of the endpoints, or the Mac without one', () => {
    const summary = memorySummary(overview.memory, overview.local);
    assert.deepEqual(summary, { value: '21 di 24 GiB', ratio: 21 / 24, detail: 'In memoria: qwen3.8-27b-4bit' });
    assert.deepEqual(memorySummary({ memoryGib: 32, budgets: [], estimatedGib: 40, swap: null }, []), {
      value: '40 di 32 GiB',
      ratio: 1,
      detail: 'Nessun modello caricato da Arianna',
    });
    assert.equal(memorySummary(null, overview.local), null);
  });

  it('writes the API price, or nothing without one', () => {
    assert.equal(priceText({ input: 2, output: 10, source: 'x' }), '$2 entrata · $10 uscita, per milione di token');
    assert.equal(priceText({ input: 0.25, output: 1.5, source: 'x' }), '$0,25 entrata · $1,5 uscita, per milione di token');
    assert.equal(priceText(undefined), undefined);
  });
});

describe('cloud card', () => {
  const sonnet = overview.cloud[0] as CloudModelView;

  it('says why a model is out, nothing when it is on', () => {
    assert.equal(cloudNotice(sonnet), undefined);
    assert.match(cloudNotice(cloud('sol', { state: 'not-connected', adapter: false })) ?? '', /adattatore di Codex/);
    assert.match(cloudNotice(cloud('opus', { state: 'not-connected', adapter: false })) ?? '', /adattatore di Claude/);
    assert.match(cloudNotice(cloud('opus', { state: 'executor-off' })) ?? '', /Claude Code è spento in Esecutori cloud/);
    assert.match(cloudNotice(cloud('opus', { state: 'off' })) ?? '', /^Spento/);
  });

  it('describes the exact name chosen, the first of the catalog when none', () => {
    assert.equal(shownName(sonnet.card, '')?.name, 'claude-sonnet-5-5');
    assert.equal(shownName(sonnet.card, ' claude-sonnet-5-5 ')?.contextTokens, 1_000_000);
    // A name the catalog does not know: no facts borrowed from another.
    assert.equal(shownName(sonnet.card, 'sonnet[1m]'), undefined);
    assert.equal(shownName(null, ''), undefined);
  });

  it('names each source once, and only the known ones', () => {
    assert.deepEqual(cardSources(sonnet.card, overview.sources), [{ id: 'anthropic-models', url: 'https://example.org/models', read: '2026-10-07' }]);
    assert.deepEqual(cardSources(sonnet.card, []), []);
    assert.deepEqual(cardSources(null, overview.sources), []);
  });

  it('states the rule of privacy by where it runs', () => {
    assert.match(privacyText(sonnet), /solo dati Pubblici e Interni/);
    assert.match(privacyText(local('x')), /niente esce/);
  });
});

describe('overviewErrorText', () => {
  it('says in Italian why a catalog or the trials cannot be read', () => {
    assert.equal(overviewErrorText('config/models.catalog.yaml is not valid at models[2].files'), 'config/models.catalog.yaml non è valido (in models[2].files): correggilo a mano.');
    assert.equal(overviewErrorText('config/cloud-models.catalog.yaml is not valid'), 'config/cloud-models.catalog.yaml non è valido: correggilo a mano.');
    assert.equal(overviewErrorText('config/cloud-models.catalog.yaml cannot be read'), 'config/cloud-models.catalog.yaml non si legge.');
    assert.equal(overviewErrorText('the trials cannot be read'), 'Le prove non si leggono: il database non risponde.');
  });

  it('leaves an unknown reason as it is', () => {
    assert.equal(overviewErrorText('something else'), 'something else');
    assert.equal(overviewErrorText('/etc/passwd is not valid'), '/etc/passwd is not valid');
  });
});

describe('roles and unsaved edits', () => {
  it('a role taken from its card leaves the one who had it; clicked again it is empty', () => {
    const roles = { orchestrator: 'a', tts: 'k' };
    assert.deepEqual(toggleRole(roles, 'orchestrator', 'b'), { orchestrator: 'b', tts: 'k' });
    assert.deepEqual(toggleRole(roles, 'orchestrator', 'a'), { tts: 'k' });
    assert.deepEqual(toggleRole({}, 'stt', 'p'), { stt: 'p' });
    // The input is not changed.
    assert.deepEqual(roles, { orchestrator: 'a', tts: 'k' });
  });

  const rows = (opus: { enabled: boolean; name: string }): CloudModelsForm => ({
    rows: [
      { alias: 'sonnet', enabled: true, name: '' },
      { alias: 'opus', ...opus },
    ],
  });

  it('marks both models of a role that changed hands, and the cloud rows changed', () => {
    const base = { roles: { orchestrator: 'a' }, cloudModels: rows({ enabled: true, name: '' }) };
    assert.deepEqual(unsavedKeys(base, base), new Set());
    assert.deepEqual(unsavedKeys({ roles: { orchestrator: 'b' }, cloudModels: rows({ enabled: true, name: '' }) }, base), new Set(['local:a', 'local:b']));
    assert.deepEqual(unsavedKeys({ roles: { orchestrator: undefined }, cloudModels: rows({ enabled: true, name: '' }) }, base), new Set(['local:a']));
    assert.deepEqual(unsavedKeys({ roles: { orchestrator: 'a' }, cloudModels: rows({ enabled: false, name: '' }) }, base), new Set(['cloud:opus']));
    // Spaces count, as for the rest of the settings page: the bar and the page agree on what is an edit.
    assert.deepEqual(unsavedKeys({ roles: { orchestrator: 'a' }, cloudModels: rows({ enabled: true, name: '  ' }) }, base), new Set(['cloud:opus']));
    assert.deepEqual(unsavedKeys({ roles: { orchestrator: 'a' }, cloudModels: rows({ enabled: true, name: 'opus[1m]' }) }, base), new Set(['cloud:opus']));
  });
});
