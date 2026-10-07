// Which local model may open a trial chat (D-142).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import type { CatalogEntry, ModelCatalog } from '@arianna/config';

import { trialRefusal } from '../src/orchestrator/trial-chat.ts';

const DIR = '/srv/models';

function entry(id: string, roles: CatalogEntry['roles']): CatalogEntry {
  return {
    id,
    family: 'qwen3',
    runtime: 'mlx',
    ramMinGib: 1,
    roles,
    status: 'experimental',
    files: [{ path: 'model.safetensors', url: `https://huggingface.co/x/${id}/resolve/${'a'.repeat(40)}/model.safetensors`, sha256: 'b'.repeat(64), sizeBytes: 100 }],
  };
}

const catalog: ModelCatalog = {
  version: 1,
  models: [entry('chat-model', ['orchestrator']), entry('fresh-model', []), entry('whisper', ['stt']), entry('voice-model', ['voice', 'tts'])],
};
const present = (path: string) => (path.endsWith('model.safetensors') ? 100 : undefined);

test('a chat model with its files on the disk opens a trial chat', () => {
  assert.equal(trialRefusal(catalog, 'chat-model', DIR, present), undefined);
  // Just added from Hugging Face: no role yet, still a model to talk with.
  assert.equal(trialRefusal(catalog, 'fresh-model', DIR, present), undefined);
  // A role that writes text among others.
  assert.equal(trialRefusal(catalog, 'voice-model', DIR, present), undefined);
});

test('a model outside the catalog, without text, or without its files opens none', () => {
  assert.match(trialRefusal(catalog, 'unknown', DIR, present) ?? '', /not in the catalog/);
  assert.match(trialRefusal(catalog, 'whisper', DIR, present) ?? '', /does not write text/);
  assert.match(trialRefusal(catalog, 'chat-model', DIR, () => undefined) ?? '', /not on the disk/);
  // A file of another size is not the model of the catalog.
  assert.match(trialRefusal(catalog, 'chat-model', DIR, () => 99) ?? '', /not on the disk/);
  // The file is looked for in the model's own folder.
  const seen: string[] = [];
  trialRefusal(catalog, 'chat-model', DIR, (path) => {
    seen.push(path);
    return 100;
  });
  assert.deepEqual(seen, [join(DIR, 'chat-model', 'model.safetensors')]);
});
