import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTeardown } from './support/teardown.ts';

test('closeAll closes everything kept, the last kept first', async () => {
  const teardown = createTeardown();
  const closed: string[] = [];
  for (const name of ['database', 'server', 'channel']) {
    assert.equal(
      await teardown.keep(name, (kept) => {
        closed.push(kept);
      }),
      name,
    );
  }
  await teardown.closeAll();
  assert.deepEqual(closed, ['channel', 'server', 'database']);
  // A second call closes nothing again.
  await teardown.closeAll();
  assert.equal(closed.length, 3);
});

test('a close that fails or hangs does not stop the others, and the failures are thrown at the end', async () => {
  const teardown = createTeardown(50);
  const closed: string[] = [];
  await teardown.keep('database', () => {
    closed.push('database');
  });
  await teardown.keep('server', () => Promise.reject(new Error('server refused to close')));
  await teardown.keep('channel', () => new Promise<void>(() => undefined));
  const thrown = await teardown.closeAll().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(thrown instanceof AggregateError);
  assert.deepEqual(
    thrown.errors.map((error: unknown) => (error instanceof Error ? error.message : '')),
    ['a close took more than 50 ms', 'server refused to close'],
  );
  assert.deepEqual(closed, ['database']);
});

test('a single failure is thrown as it is', async () => {
  const teardown = createTeardown();
  await teardown.keep('server', () => Promise.reject(new Error('only one')));
  await assert.rejects(teardown.closeAll(), /^Error: only one$/);
});

test('what is kept after the teardown (a setup that outlived its hook) is closed at once, and the setup fails', async () => {
  const teardown = createTeardown();
  await teardown.closeAll();
  const closed: string[] = [];
  await assert.rejects(
    teardown.keep('late database', (kept) => {
      closed.push(kept);
    }),
    /the setup finished after the teardown/,
  );
  assert.deepEqual(closed, ['late database']);
  // Even when closing it fails, the setup gets the same error.
  await assert.rejects(
    teardown.keep('late server', () => Promise.reject(new Error('refused'))),
    /the setup finished after the teardown/,
  );
});
