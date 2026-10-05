import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LocalEndpointConfig } from '@arianna/config';

import * as library from '../src/library.ts';
import { trialEndpoints } from '../src/trial.ts';

test('the trial endpoints map local-large, and only it, to the candidate', () => {
  const endpoints: LocalEndpointConfig[] = [
    { id: 'omlx', url: 'http://127.0.0.1:8000/v1', command: ['omlx', 'serve'], models: { 'local-large': 'current-27b', 'local-small': 'small', 'local-voice': 'voice' } },
    { id: 'voice-only', url: 'http://127.0.0.1:8001/v1', models: { 'local-voice': 'voice' } },
  ];
  assert.deepEqual(trialEndpoints(endpoints, 'fake-model-4bit'), [{ id: 'omlx', url: 'http://127.0.0.1:8000/v1', models: { 'local-large': 'fake-model-4bit' } }]);
  // No endpoint serves the orchestrator yet: all of them, with the candidate.
  const none: LocalEndpointConfig[] = [{ id: 'omlx', url: 'http://127.0.0.1:8000/v1', models: { 'local-small': 'small' } }];
  assert.deepEqual(trialEndpoints(none, 'fake-model-4bit'), [{ id: 'omlx', url: 'http://127.0.0.1:8000/v1', models: { 'local-large': 'fake-model-4bit' } }]);
  assert.deepEqual(trialEndpoints([], 'fake-model-4bit'), []);
});

test('the library entry has what the core needs, without the live groups', () => {
  assert.deepEqual(Object.keys(library).sort(), ['TRIAL_ALIAS', 'caseErrorCode', 'casesFingerprint', 'createOrchestratorGroup', 'loadCases', 'runGroup', 'trialEndpoints']);
});
