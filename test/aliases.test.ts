import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLE_ALIASES } from '@arianna/config';
import { MODEL_ALIASES } from '@arianna/router';

// @arianna/config does not depend on the router: this keeps the two in step.
test('every role alias of the configuration is a model alias of the router', () => {
  for (const alias of Object.values(ROLE_ALIASES)) {
    assert.ok((MODEL_ALIASES as readonly string[]).includes(alias), alias);
  }
});
