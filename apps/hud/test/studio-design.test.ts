// The style and skills of the Studio (I-19, D-184): the choice stored per
// project in this browser, read back defensively, kept only while the
// catalogs hold it, and sent with a message only when something is chosen.
// Every name here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { keepKnown, messageDesign, NO_DESIGN, parseStudioDesign, STUDIO_SKILLS_MAX, studioDesignKey } from '../src/lib/studio.ts';

test('the key of a project in the storage', () => {
  assert.equal(studioDesignKey('demo'), 'arianna.studio.design.demo');
  assert.notEqual(studioDesignKey('demo'), studioDesignKey('demo-2'));
});

test('a stored choice is read back; anything else is no choice', () => {
  assert.deepEqual(parseStudioDesign(JSON.stringify({ style: 'sabbia', skills: ['acme/skills/alpha'] })), { style: 'sabbia', skills: ['acme/skills/alpha'] });
  // Repeated skills once, empty ones dropped, at most ten.
  const many = Array.from({ length: 12 }, (_, index) => `acme/skills/s${String(index)}`);
  assert.deepEqual(parseStudioDesign(JSON.stringify({ style: '', skills: ['acme/skills/alpha', 'acme/skills/alpha', '', 3] })), { style: null, skills: ['acme/skills/alpha'] });
  assert.equal(parseStudioDesign(JSON.stringify({ skills: many })).skills.length, STUDIO_SKILLS_MAX);
  for (const raw of [null, '', 'not json', '"sabbia"', 'null', '[1]', JSON.stringify({ style: 7, skills: 'acme/skills/alpha' })]) {
    assert.deepEqual(parseStudioDesign(raw), NO_DESIGN, String(raw));
  }
});

test('only what the adopted catalogs still hold', () => {
  const design = { style: 'sabbia', skills: ['acme/skills/alpha', 'acme/skills/gone'] };
  assert.deepEqual(keepKnown(design, ['sabbia', 'notte'], ['acme/skills/alpha']), { style: 'sabbia', skills: ['acme/skills/alpha'] });
  assert.deepEqual(keepKnown(design, ['notte'], []), NO_DESIGN);
});

test('the fields of a message: only what is chosen, nothing for no choice', () => {
  assert.equal(messageDesign(NO_DESIGN), undefined);
  assert.deepEqual(messageDesign({ style: 'sabbia', skills: [] }), { style: 'sabbia' });
  assert.deepEqual(messageDesign({ style: null, skills: ['acme/skills/alpha'] }), { skills: ['acme/skills/alpha'] });
  assert.deepEqual(messageDesign({ style: 'notte', skills: ['acme/skills/alpha'] }), { style: 'notte', skills: ['acme/skills/alpha'] });
});
