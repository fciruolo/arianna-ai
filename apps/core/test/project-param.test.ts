import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectFromParam } from '../src/server/http.ts';

test('a part of a container reaches the routes as the page encodes it', () => {
  assert.equal(projectFromParam(encodeURIComponent('progetto-test:progetto-test-admin')), 'progetto-test:progetto-test-admin');
  assert.equal(projectFromParam('progetto-test:progetto-test-admin'), 'progetto-test:progetto-test-admin');
  assert.equal(projectFromParam('demo'), 'demo');
});

test('anything that is not a project name is refused', () => {
  assert.equal(projectFromParam(undefined), undefined);
  assert.equal(projectFromParam(''), undefined);
  assert.equal(projectFromParam('%E0%A4%A'), undefined);
  assert.equal(projectFromParam(encodeURIComponent('demo/../segreti')), undefined);
  assert.equal(projectFromParam(encodeURIComponent('.nascosto')), undefined);
  assert.equal(projectFromParam(encodeURIComponent('demo progetto')), undefined);
  assert.equal(projectFromParam('a'.repeat(201)), undefined);
});
