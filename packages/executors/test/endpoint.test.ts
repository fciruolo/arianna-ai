import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseConfig } from '@arianna/config';
import { localEndpoint, localEndpointUrl, LocalEndpointError } from '@arianna/executors';

describe('localEndpointUrl', () => {
  it('accepts loopback addresses and drops the trailing slash', () => {
    assert.equal(localEndpointUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1');
    assert.equal(localEndpointUrl('https://[::1]:8443/v1'), 'https://[::1]:8443/v1');
  });

  it('rejects anything that is not this machine', () => {
    for (const url of [
      'http://192.168.1.10:8000/v1',
      'http://10.0.0.2/v1',
      'http://api.openai.com/v1',
      'http://127.0.0.1.nip.io/v1',
      'http://localhost.example.com/v1',
      'http://0.0.0.0:8000/v1',
      // A name, not an address: /etc/hosts could point it elsewhere.
      'http://localhost:1234/v1',
    ]) {
      assert.throws(() => localEndpointUrl(url), LocalEndpointError, url);
    }
  });

  it('rejects other protocols, credentials, query and fragment', () => {
    for (const url of [
      'file:///tmp/socket',
      'ftp://127.0.0.1/v1',
      'http://user:pass@127.0.0.1:8000/v1',
      'http://127.0.0.1:8000/v1?key=x',
      'http://127.0.0.1:8000/v1#x',
      'not a url',
    ]) {
      assert.throws(() => localEndpointUrl(url), LocalEndpointError, url);
    }
  });
});

describe('localEndpoint', () => {
  it('returns a frozen, normalized copy', () => {
    const models = { 'local-large': 'qwen' };
    const endpoint = localEndpoint({ id: 'omlx', url: 'http://127.0.0.1:8000/v1/', models });
    assert.equal(endpoint.url, 'http://127.0.0.1:8000/v1');
    assert.ok(Object.isFrozen(endpoint) && Object.isFrozen(endpoint.models));
    models['local-large'] = 'changed';
    assert.equal(endpoint.models['local-large'], 'qwen');
  });

  it('rejects an invalid id', () => {
    assert.throws(() => localEndpoint({ id: 'Bad Id', url: 'http://127.0.0.1:8000/v1', models: {} }), LocalEndpointError);
  });
});

describe('the configuration and the adapter agree on what is local', () => {
  const config = (url: string) => `
[paths]
data = "data"
[database]
host = "127.0.0.1"
port = 54329
name = "arianna"
user = "arianna"
[[local.endpoints]]
id = "x"
url = ${JSON.stringify(url)}
models = { "local-large" = "m" }
`;
  const accepts = (check: () => unknown): boolean => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  };

  for (const url of [
    'http://127.0.0.1:8000/v1',
    'https://[::1]:8443/v1',
    'http://localhost:8000/v1',
    'http://192.168.1.10:8000/v1',
    'http://0.0.0.0:8000/v1',
    'ftp://127.0.0.1/v1',
    'http://u:p@127.0.0.1:8000/v1',
    'http://127.0.0.1:8000/v1?x=1',
  ]) {
    it(url, () => {
      assert.equal(accepts(() => parseConfig(config(url), resolve('home'))), accepts(() => localEndpointUrl(url)));
    });
  }
});
