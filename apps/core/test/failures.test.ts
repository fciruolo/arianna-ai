import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClaudeError, LocalModelError, WorkspaceError } from '@arianna/executors';

import { cleanFailure, describeFailure } from '../src/failures.ts';
import { KbError } from '../src/orchestrator/kb.ts';
import { failureMessage } from '../src/system-chats.ts';

const FAKE_IBAN = 'IT60X0542811101000000123456';

test('a local model that is down gives its code, endpoint, port and attempts', () => {
  const tried = new LocalModelError('unavailable', 'omlx is not reachable', { endpoint: 'omlx' });
  const error = new LocalModelError('unavailable', 'no local endpoint answered local-large', { attempts: [tried] });
  assert.deepEqual(describeFailure(error, { attempts: 3, endpointPort: (id) => (id === 'omlx' ? 7001 : undefined) }), {
    origin: 'local-model',
    code: 'local-model.unavailable',
    details: { endpoint: 'omlx', endpoints: 1, port: 7001, attempts: 3 },
  });
});

test('an HTTP error of the local server keeps the status; a missing endpoint has no endpoint detail', () => {
  const http = new LocalModelError('http', 'omlx answered 503', { endpoint: 'omlx', status: 503 });
  assert.deepEqual(describeFailure(http).details, { endpoint: 'omlx', status: 503 });
  assert.deepEqual(describeFailure(new LocalModelError('no-endpoint', 'no local endpoint serves x'), { attempts: 1 }), {
    origin: 'local-model',
    code: 'local-model.no-endpoint',
    details: { attempts: 1 },
  });
});

test('claude, tool and database errors map to their origin', () => {
  assert.deepEqual(describeFailure(new ClaudeError('exit', 'claude: run ended', { exitCode: 1, apiStatus: 529 })), {
    origin: 'claude',
    code: 'claude.exit',
    details: { exitCode: 1, apiStatus: 529 },
  });
  assert.equal(describeFailure(new WorkspaceError('x')).code, 'tool.workspace');
  assert.equal(describeFailure(new KbError('not-found', 'page kb/a.md not found')).code, 'tool.kb');
  const database = Object.assign(new Error('relation does not exist'), { name: 'PostgresError', code: '42P01' });
  assert.deepEqual(describeFailure(database, { attempts: 3 }).details, { sqlstate: '42P01', attempts: 3 });
});

test('an unknown error keeps its class and system code, never its message', () => {
  const error = Object.assign(new Error(`prompt said ${FAKE_IBAN}`), { code: 'ECONNRESET' });
  const failure = describeFailure(error, { attempts: 2 });
  assert.deepEqual(failure, { origin: 'engine', code: 'engine.unknown', details: { error: 'Error:ECONNRESET', attempts: 2 } });
  assert.doesNotMatch(JSON.stringify(failure), /IT60/);
});

test('a class name or code that could carry text is dropped', () => {
  const error = Object.assign(new Error('x'), { code: `bad ${FAKE_IBAN} code` });
  assert.deepEqual(describeFailure(error).details, {});
});

test('cleanFailure keeps only the details listed for the code, each checked', () => {
  assert.deepEqual(
    cleanFailure('local-model', 'local-model.http', { endpoint: 'omlx', status: 503, port: 7001, sqlstate: '42P01', note: FAKE_IBAN }),
    { origin: 'local-model', code: 'local-model.http', details: { endpoint: 'omlx', status: 503, port: 7001 } },
  );
  assert.deepEqual(cleanFailure('local-model', 'local-model.http', { endpoint: 'Has Spaces', status: 99, port: 70_000 }).details, {});
  assert.deepEqual(cleanFailure('engine', 'engine.unknown', { attempts: -1 }).details, {});
  assert.deepEqual(cleanFailure('engine', 'engine.unknown', { attempts: 1.5 }).details, {});
});

test('an unknown code, or a code outside its origin, becomes engine.unknown', () => {
  assert.equal(cleanFailure('engine', 'engine.made-up', {}).code, 'engine.unknown');
  assert.equal(cleanFailure('tool', 'local-model.unavailable', {}).code, 'engine.unknown');
  assert.equal(cleanFailure('other', 'other.x', {}).code, 'engine.unknown');
  assert.equal(cleanFailure('claude', 'claude.Not Valid', {}).code, 'engine.unknown');
  assert.equal(cleanFailure('claude', 'claude.quota', {}).code, 'claude.quota');
});

test('the first message of a system chat holds the structured error only', () => {
  const text = failureMessage({ origin: 'local-model', code: 'local-model.unavailable', details: { endpoint: 'omlx', port: 7001, attempts: 3 } });
  assert.match(text, /Codice: local-model\.unavailable/);
  assert.match(text, /endpoint omlx, porta 7001, tentativi 3/);
  assert.match(text, /Allega la domanda/);
  assert.match(failureMessage({ origin: 'engine', code: 'engine.lock-expired', details: {} }), /Dettagli: nessuno/);
});

test('a system code with digits, or a class name with other characters, is dropped: it could be a data token', () => {
  assert.deepEqual(describeFailure(Object.assign(new Error('x'), { code: FAKE_IBAN })).details, {});
  const odd = new Error('x');
  odd.name = 'Error_123';
  assert.deepEqual(describeFailure(odd).details, {});
  assert.deepEqual(describeFailure(Object.assign(new Error('x'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })).details, { error: 'Error:ERR_STREAM_PREMATURE_CLOSE' });
});
