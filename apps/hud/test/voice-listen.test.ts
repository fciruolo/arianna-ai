// «Ascolta» next to the voice of the calls (D-192): when it can be used and why not.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { LISTEN_PHRASE, listenBlocker, listenErrorText, serviceSettling, type ListenInput } from '../src/lib/voice-listen.ts';

const READY: ListenInput = { service: 'up', callBusy: false, model: { present: true, voices: ['serena', 'vivian'] }, voice: 'serena' };

test('ready: the service is up, no call, the model on disk, a voice of the model', () => {
  assert.equal(listenBlocker(READY), undefined);
  assert.equal(listenBlocker({ ...READY, voice: '  vivian ' }), undefined);
  assert.ok(LISTEN_PHRASE.length > 0 && LISTEN_PHRASE.length <= 400);
});

test('the voice service: unknown, off, not installed, starting, down', () => {
  assert.match(listenBlocker({ ...READY, service: undefined }) ?? '', /Controllo/);
  assert.match(listenBlocker({ ...READY, service: 'off' }) ?? '', /spento.*Chiamate accese/);
  assert.match(listenBlocker({ ...READY, service: 'not-installed' }) ?? '', /ambiente della voce/);
  for (const state of ['idle', 'starting', 'restarting']) assert.match(listenBlocker({ ...READY, service: state }) ?? '', /sta partendo/, state);
  for (const state of ['down', 'failed', 'stopped', 'something-new']) assert.match(listenBlocker({ ...READY, service: state }) ?? '', /non risponde/, state);
});

test('a call on: wait for it to end', () => {
  assert.match(listenBlocker({ ...READY, callBusy: true }) ?? '', /chiamata in corso/);
  // The service comes first: a call cannot be on with the service off.
  assert.match(listenBlocker({ ...READY, callBusy: true, service: 'off' }) ?? '', /spento/);
});

test('model and voice: none chosen, not on disk, empty field, a voice of another model', () => {
  assert.match(listenBlocker({ ...READY, model: undefined }) ?? '', /Modelli/);
  assert.match(listenBlocker({ ...READY, model: { present: false, voices: ['serena'] } }) ?? '', /non è ancora scaricato/);
  assert.match(listenBlocker({ ...READY, voice: '  ' }) ?? '', /Scrivi o scegli/);
  assert.equal(listenBlocker({ ...READY, voice: 'nuova-voce' }), '«nuova-voce» non è fra le voci del modello scelto in Modelli: scegline una dall’elenco del campo, poi ascoltala.');
});

test('the page asks again only while the service may change by itself', () => {
  assert.equal(serviceSettling(undefined), true);
  assert.equal(serviceSettling('starting'), true);
  assert.equal(serviceSettling('up'), false);
  assert.equal(serviceSettling('failed'), false);
});

test('errors in plain words, never the English of the core', () => {
  assert.match(listenErrorText(new ApiError(503, 'voice off: add [voice] to arianna.toml')), /si è spento/);
  assert.match(listenErrorText(new ApiError(400, 'voice: one of the voices of the model')), /non si può provare/);
  assert.match(listenErrorText(new ApiError(502, 'voice: model-error')), /non ha risposto/);
  assert.equal(listenErrorText(new TypeError('Failed to fetch')), 'Arianna non risponde: controlla che sia avviata.');
  for (const cause of [new ApiError(503, 'voice off'), new ApiError(400, 'voice: x'), new ApiError(502, 'voice: y')]) assert.doesNotMatch(listenErrorText(cause), /voice|arianna\.toml/);
});
