import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  actionButtons,
  actionErrorText,
  blockedReasons,
  canConfirm,
  confirmationOf,
  emptyTrashConfirmation,
  outcomeText,
  progressOf,
  runningAction,
  trashText,
  type ModelAction,
} from '../src/lib/model-actions.ts';
import type { LocalModelView } from '../src/lib/models-page.ts';

const local = (id: string, overrides: Partial<LocalModelView> = {}): LocalModelView => ({
  locality: 'local',
  id,
  family: 'fake',
  runtime: 'mlx',
  ramMinGib: 18,
  status: 'experimental',
  sizeBytes: 16_000_000_000,
  provider: null,
  contextTokens: null,
  strengths: [],
  license: null,
  notes: null,
  source: null,
  suitedRoles: ['orchestrator'],
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

const action = (overrides: Partial<ModelAction> = {}): ModelAction => ({
  modelId: 'fake-a',
  kind: 'download',
  status: 'running',
  bytesDone: 4_000_000_000,
  bytesTotal: 16_000_000_000,
  startedAt: '2026-10-07T21:00:00.000Z',
  finishedAt: null,
  error: null,
  bad: [],
  ...overrides,
});

const MISSING = { present: false, state: 'missing' as const, hasFiles: false, missingBytes: 16_000_000_000 };
const kinds = (view: LocalModelView, running?: ModelAction) => actionButtons(view, running).map((button) => button.kind);

describe('actionButtons', () => {
  it('a missing model can only be downloaded; one on the disk verified and removed', () => {
    assert.deepEqual(kinds(local('fake-a', MISSING)), ['download']);
    assert.equal(actionButtons(local('fake-a', MISSING))[0]?.text, 'Scarica');
    assert.deepEqual(kinds(local('fake-a')), ['verify', 'remove']);
  });

  it('a partial download is resumed and can be removed; wrong files after a verification are downloaded again', () => {
    const partial = local('fake-a', { present: false, state: 'missing', missingBytes: 6_000_000_000 });
    assert.deepEqual(kinds(partial), ['download', 'remove']);
    assert.equal(actionButtons(partial)[0]?.text, 'Riprendi lo scaricamento');
    const wrong = local('fake-a', { action: action({ kind: 'verify', status: 'done', bad: ['model.bin'] }) });
    assert.equal(actionButtons(wrong)[0]?.text, 'Riscarica i file sbagliati');
    // A verification that found nothing wrong offers no download.
    assert.deepEqual(kinds(local('fake-a', { action: action({ kind: 'verify', status: 'done' }) })), ['verify', 'remove']);
  });

  it('a model with a role or in memory cannot be removed, and says why', () => {
    const assigned = actionButtons(local('fake-a', { roles: ['orchestrator'] })).find((button) => button.kind === 'remove');
    assert.match(assigned?.blocked ?? '', /ruolo Orchestratore/);
    const loaded = local('fake-a', { state: 'loaded', loaded: [{ endpoint: 'omlx', gib: 18, busy: false }] });
    assert.deepEqual(kinds(loaded), ['verify', 'unload', 'remove']);
    assert.match(actionButtons(loaded).find((button) => button.kind === 'remove')?.blocked ?? '', /scaricalo dalla memoria/);
    assert.equal(actionButtons(loaded).find((button) => button.kind === 'unload')?.blocked, undefined);
    const busy = local('fake-a', { state: 'loaded', loaded: [{ endpoint: 'omlx', gib: 18, busy: true }] });
    assert.match(actionButtons(busy).find((button) => button.kind === 'unload')?.blocked ?? '', /sta usando/);
  });

  it('while an action runs the model offers only to stop it, and the others wait', () => {
    const running = action();
    assert.deepEqual(actionButtons(local('fake-a', { ...MISSING, action: running })), [{ kind: 'cancel', text: 'Ferma lo scaricamento' }]);
    const other = actionButtons(local('fake-b', MISSING), running);
    assert.match(other[0]?.blocked ?? '', /sto scaricando fake-a/);
    assert.equal(actionButtons(local('fake-b'), running).find((button) => button.kind === 'remove')?.blocked, undefined);
    assert.deepEqual(blockedReasons(actionButtons(local('fake-b'), running)), ['Aspetta la fine: sto scaricando fake-a.']);
  });

  it('runningAction finds the one running among the models', () => {
    assert.equal(runningAction([local('fake-a'), local('fake-b', { action: action({ modelId: 'fake-b' }) })])?.modelId, 'fake-b');
    assert.equal(runningAction([local('fake-a', { action: action({ status: 'done' }) })]), undefined);
  });
});

describe('confirmations', () => {
  it('a download says how much, where, and that only catalog files are fetched', () => {
    const shown = confirmationOf('download', local('fake-a', { ...MISSING, missingBytes: 6_000_000_000, hasFiles: true }));
    assert.equal(shown.title, 'Scaricare fake-a?');
    assert.match(shown.lines[0] ?? '', /^Scarica 6 GB \(di 16 GB: il resto è già sul disco\) in data\/models\/fake-a/);
    assert.ok(shown.lines.some((line) => /sha256/.test(line)));
    assert.equal(shown.typed, undefined);
    assert.equal(canConfirm(shown, ''), true);
  });

  it('a removal names the bin, the size, and wants the id typed', () => {
    const shown = confirmationOf('remove', local('fake-a'));
    assert.equal(shown.danger, true);
    assert.equal(shown.typed, 'fake-a');
    assert.match(shown.lines[0] ?? '', /Sposta 16 GB da data\/models\/fake-a al cestino data\/models\/eliminati/);
    assert.equal(canConfirm(shown, 'fake'), false);
    assert.equal(canConfirm(shown, 'FAKE-A'), false);
    assert.equal(canConfirm(shown, ' fake-a '), true);
  });

  it('verify, unload and stop say what happens', () => {
    assert.match(confirmationOf('verify', local('fake-a')).lines[0] ?? '', /Rilegge 16 GB/);
    const unload = confirmationOf('unload', local('fake-a', { roles: ['orchestrator'], loaded: [{ endpoint: 'omlx', gib: 18, busy: false }] }));
    assert.match(unload.lines[0] ?? '', /\(omlx\).*circa 18 GiB/);
    assert.match(unload.lines[1] ?? '', /ricarica/);
    assert.match(confirmationOf('cancel', local('fake-a', { action: action() })).lines[0] ?? '', /resta sul disco/);
  });

  it('emptying the bin counts folders and bytes and says it cannot be undone', () => {
    const shown = emptyTrashConfirmation({ folder: 'data/models/eliminati', entries: [{ name: 'a', sizeBytes: 1e9 }, { name: 'b', sizeBytes: 2e9 }], sizeBytes: 3e9 });
    assert.match(shown.lines[0] ?? '', /2 cartelle in data\/models\/eliminati: 3 GB/);
    assert.match(shown.lines[1] ?? '', /Non si può annullare/);
    assert.equal(shown.danger, true);
  });
});

describe('progress and outcomes', () => {
  it('progress in bytes and percent', () => {
    assert.deepEqual(progressOf(action()), { ratio: 0.25, text: 'Scarico: 4 GB di 16 GB · 25%' });
    assert.equal(progressOf(action({ bytesTotal: 0, bytesDone: 0 })).ratio, 0);
  });

  it('outcomes in Italian, none while running', () => {
    assert.equal(outcomeText(action()), undefined);
    assert.equal(outcomeText(null), undefined);
    assert.equal(outcomeText(action({ status: 'done' }))?.tone, 'ok');
    assert.match(outcomeText(action({ status: 'failed', error: 'network' }))?.text ?? '', /si riprende da lì/);
    assert.match(outcomeText(action({ status: 'failed', error: 'TypeError' }))?.text ?? '', /errore del nucleo/);
    assert.match(outcomeText(action({ kind: 'verify', status: 'done', bad: ['a.bin', 'b.bin'] }))?.text ?? '', /2 file non corrispondono .*a\.bin, b\.bin/);
    assert.equal(outcomeText(action({ kind: 'verify', status: 'done' }))?.tone, 'ok');
  });

  it('the bin in one line', () => {
    assert.equal(trashText({ folder: 'data/models/eliminati', entries: [], sizeBytes: 0 }), 'Il cestino è vuoto.');
    assert.equal(trashText({ folder: 'data/models/eliminati', entries: [{ name: 'a', sizeBytes: 5e8 }], sizeBytes: 5e8 }), '1 cartella, 500 MB');
  });
});

describe('actionErrorText', () => {
  it('translates the refusals of the core, roles included', () => {
    assert.equal(actionErrorText(new ApiError(409, 'the model has the role orchestrator, extractor: give the role to another model first')), 'Il modello ha il ruolo Orchestratore, Estrattore: prima assegna il ruolo a un altro modello e salva.');
    assert.equal(actionErrorText(new ApiError(409, 'a download of fake-b is running: wait for it or stop it')), 'Aspetta la fine: sto scaricando fake-b.');
    assert.match(actionErrorText(new ApiError(409, 'not enough free space: 123 bytes to download')), /spazio libero/);
    assert.match(actionErrorText(new ApiError(409, 'a trial of the model is queued or running: cancel it first')), /prova/);
  });

  it('anything else as the other errors of the chat', () => {
    assert.equal(actionErrorText(new TypeError('fetch failed')), 'Il nucleo non risponde: controlla che sia avviato.');
    assert.equal(actionErrorText(new ApiError(400, 'something new')), 'Richiesta non valida.');
  });
});
