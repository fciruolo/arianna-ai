// Contract of the local model adapter, against the fake OpenAI-compatible
// server: output format, errors, timeout, cancellation, fallback.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createLocalModel, LocalModelError, type LocalEndpoint, type LocalModel } from '@arianna/executors';

import { startFakeServer, type FakeServer } from './fixtures/fake-server.ts';

const USER = (content: string) => [{ role: 'user' as const, content }];

/** A loopback port with nothing listening. */
async function closedPort(): Promise<number> {
  const server = await startFakeServer();
  await server.close();
  return server.port;
}

function endpoint(id: string, url: string, models: Record<string, string> = { 'local-large': `${id}-large` }): LocalEndpoint {
  return { id, url, models };
}

async function rejectsWith(promise: Promise<unknown>, kind: string, check?: (error: LocalModelError) => void): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof LocalModelError, String(error));
    assert.equal(error.kind, kind);
    check?.(error);
    return true;
  });
}

describe('local model contract', () => {
  let server: FakeServer;
  let model: LocalModel;

  before(async () => {
    server = await startFakeServer();
    model = createLocalModel({ endpoints: [endpoint('fake', server.url)] });
  });
  after(() => server.close());

  it('sends the messages as given and maps the alias to the model name', async () => {
    const messages = [
      { role: 'system' as const, content: 'You are Arianna.' },
      { role: 'user' as const, content: 'say hello' },
    ];
    const result = await model.chat({ model: 'local-large', messages, maxTokens: 16, temperature: 0 });
    assert.equal(result.text, 'hello');
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.usage, { promptTokens: 7, completionTokens: 1 });
    assert.equal(result.endpoint, 'fake');
    assert.equal(result.model, 'fake-large');
    assert.ok(result.durationMs >= 0);
    assert.equal(result.value, undefined);
    assert.deepEqual(server.requests.at(-1), {
      model: 'fake-large',
      messages,
      stream: false,
      max_tokens: 16,
      temperature: 0,
    });
  });

  it('asks for constrained decoding and parses the JSON', async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const result = await model.chat({ model: 'local-large', messages: USER('check'), schema: { name: 'check', schema } });
    assert.deepEqual(result.value, { ok: true });
    assert.deepEqual((server.requests.at(-1) as { response_format: unknown }).response_format, {
      type: 'json_schema',
      json_schema: { name: 'check', schema, strict: true },
    });
  });

  it('rejects content that is not JSON when a schema was asked', async () => {
    await rejectsWith(
      model.chat({ model: 'local-large', messages: USER('!notjson'), schema: { name: 'x', schema: {} } }),
      'bad-response',
    );
  });

  it('accepts non-JSON content when no schema was asked', async () => {
    assert.equal((await model.chat({ model: 'local-large', messages: USER('!notjson') })).text, 'not json');
  });

  it('reports a body that is not JSON or not a completion as bad-response', async () => {
    await rejectsWith(model.chat({ model: 'local-large', messages: USER('!garbage') }), 'bad-response');
    await rejectsWith(model.chat({ model: 'local-large', messages: USER('!empty') }), 'bad-response');
  });

  it('reports HTTP errors with the status and without the body', async () => {
    await rejectsWith(model.chat({ model: 'local-large', messages: USER('!status:400') }), 'http', (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /echo/);
    });
  });

  it('times out', async () => {
    await rejectsWith(model.chat({ model: 'local-large', messages: USER('!slow:2000'), timeoutMs: 100 }), 'timeout');
  });

  it('stops when the caller cancels', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    await rejectsWith(
      model.chat({ model: 'local-large', messages: USER('!slow:2000'), signal: controller.signal }),
      'cancelled',
    );
  });

  it('reports an endpoint with nothing listening as unavailable', async () => {
    const down = createLocalModel({ endpoints: [endpoint('down', `http://127.0.0.1:${String(await closedPort())}/v1`)] });
    await rejectsWith(down.chat({ model: 'local-large', messages: USER('hi') }), 'unavailable');
  });

  it('refuses an alias that no endpoint serves', async () => {
    await rejectsWith(model.chat({ model: 'local-small', messages: USER('hi') }), 'no-endpoint');
  });

  it('does not follow redirects, and does not try another endpoint after one', async () => {
    const elsewhere = await startFakeServer();
    try {
      await rejectsWith(
        model.chat({ model: 'local-large', messages: USER(`!redirect:${elsewhere.url}/chat/completions`) }),
        'http',
        (error) => {
          assert.equal(error.status, 302);
          assert.equal(error.retryable, false);
        },
      );
      assert.equal(elsewhere.requests.length, 0);
    } finally {
      await elsewhere.close();
    }
  });
});

describe('createLocalModel', () => {
  it('refuses endpoints that are not on this machine', () => {
    assert.throws(() => createLocalModel({ endpoints: [endpoint('lan', 'http://192.168.1.10:8000/v1')] }));
    assert.throws(() => createLocalModel({ endpoints: [endpoint('cloud', 'https://api.openai.com/v1')] }));
  });

  it('refuses duplicate endpoint ids', () => {
    assert.throws(() =>
      createLocalModel({ endpoints: [endpoint('a', 'http://127.0.0.1:1/v1'), endpoint('a', 'http://127.0.0.1:2/v1')] }),
    );
  });
});

describe('fallback', () => {
  let primary: FakeServer;
  let secondary: FakeServer;

  before(async () => {
    primary = await startFakeServer();
    secondary = await startFakeServer();
  });
  after(async () => {
    await primary.close();
    await secondary.close();
  });

  it('uses the first endpoint when it answers', async () => {
    const model = createLocalModel({ endpoints: [endpoint('one', primary.url), endpoint('two', secondary.url)] });
    assert.equal((await model.chat({ model: 'local-large', messages: USER('hi') })).endpoint, 'one');
  });

  it('moves to the next endpoint when the first is down, and reports the failure', async () => {
    const failures: string[] = [];
    const model = createLocalModel({
      endpoints: [endpoint('one', `http://127.0.0.1:${String(await closedPort())}/v1`), endpoint('two', secondary.url)],
      onFailure: (id, error) => failures.push(`${id}:${error.kind}`),
    });
    const result = await model.chat({ model: 'local-large', messages: USER('hi') });
    assert.equal(result.endpoint, 'two');
    assert.equal(result.model, 'two-large');
    assert.deepEqual(failures, ['one:unavailable']);
  });

  it('moves on after a 5xx, not after a 4xx', async () => {
    const model = createLocalModel({ endpoints: [endpoint('one', primary.url), endpoint('two', secondary.url)] });
    // The scripted status is answered by both servers: a 5xx is tried on each, a 4xx stops at the first.
    await rejectsWith(model.chat({ model: 'local-large', messages: USER('!status:503') }), 'http', (error) => {
      assert.deepEqual(
        error.attempts.map((attempt) => attempt.endpoint),
        ['one', 'two'],
      );
    });
    await rejectsWith(model.chat({ model: 'local-large', messages: USER('!status:422') }), 'http', (error) => {
      assert.equal(error.endpoint, 'one');
    });
  });

  it('does not try the next endpoint after a cancellation', async () => {
    const before = secondary.requests.length;
    const model = createLocalModel({ endpoints: [endpoint('one', primary.url), endpoint('two', secondary.url)] });
    await rejectsWith(
      model.chat({ model: 'local-large', messages: USER('!slow:2000'), signal: AbortSignal.timeout(50) }),
      'cancelled',
    );
    assert.equal(secondary.requests.length, before);
  });

  it('tries endpoints reported down last', async () => {
    const model = createLocalModel({
      endpoints: [endpoint('one', primary.url), endpoint('two', secondary.url)],
      isAvailable: (id) => id !== 'one',
    });
    assert.equal((await model.chat({ model: 'local-large', messages: USER('hi') })).endpoint, 'two');
  });

  it('skips endpoints that do not serve the alias', async () => {
    const model = createLocalModel({
      endpoints: [endpoint('one', primary.url, { 'local-large': 'big' }), endpoint('two', secondary.url, { 'local-small': 'small' })],
    });
    const result = await model.chat({ model: 'local-small', messages: USER('hi') });
    assert.equal(result.endpoint, 'two');
    assert.equal(result.model, 'small');
  });
});
