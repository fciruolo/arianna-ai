// The follow-up of the Studio (I-20, D-185): permanent deletion and the register of the variants.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { resolveHome, type Project } from '@arianna/config';

import type { NewEvent } from '../src/events.ts';
import { deleteMockup, listMockups, recordVariantDesign, REGISTER_NAME, StudioError } from '../src/studio.ts';

const HOME = join(resolveHome({}), 'data', 'test-tmp', `studio-register-${randomUUID()}`);
after(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function project(name: string): Project {
  const absolute = join(HOME, 'repos', name);
  mkdirSync(join(absolute, 'mockups'), { recursive: true });
  return { name, path: `repos/${name}`, absolute, label: 'L1' };
}

function deps(projects: Project[]): { projects: () => Project[]; record: (event: NewEvent) => Promise<void>; events: NewEvent[] } {
  const events: NewEvent[] = [];
  return {
    projects: () => projects,
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    events,
  };
}

test('a permanent deletion removes the file for good, with the sha256 checked; the default still moves it', async () => {
  const sito = project('perm');
  const studio = deps([sito]);
  writeFileSync(join(sito.absolute, 'mockups', 'home-1.html'), '<h1>Uno</h1>');
  writeFileSync(join(sito.absolute, 'mockups', 'home-2.html'), '<h1>Due</h1>');
  await assert.rejects(deleteMockup(studio, 'perm', { path: 'mockups/home-1.html', base: sha('other'), permanent: true }), (error: unknown) => error instanceof StudioError && error.code === 'changed');
  assert.ok(existsSync(join(sito.absolute, 'mockups', 'home-1.html')));
  await assert.rejects(deleteMockup(studio, 'perm', { path: 'mockups/home-1.html', base: sha('<h1>Uno</h1>'), permanent: 'yes' }), (error: unknown) => error instanceof StudioError && error.code === 'invalid');
  assert.deepEqual(await deleteMockup(studio, 'perm', { path: 'mockups/home-1.html', base: sha('<h1>Uno</h1>'), permanent: true }), { path: 'mockups/home-1.html', retired: null });
  assert.equal(existsSync(join(sito.absolute, 'mockups', 'home-1.html')), false);
  assert.equal(existsSync(join(sito.absolute, 'mockups', 'eliminati', 'home-1.html')), false);
  assert.deepEqual(studio.events.at(-1)?.payload, { project: 'perm', path: 'mockups/home-1.html', retired: null, permanent: true, sha256: sha('<h1>Uno</h1>') });
  const moved = await deleteMockup(studio, 'perm', { path: 'mockups/home-2.html', base: sha('<h1>Due</h1>'), permanent: false });
  assert.equal(moved.retired, 'mockups/eliminati/home-2.html');
});

test('the register notes the style of the mockups a run wrote, and the list shows it', async () => {
  const sito = project('reg');
  const folder = join(sito.absolute, 'mockups');
  const since = new Date(Date.now() - 60_000);
  writeFileSync(join(folder, 'landing-1.html'), '<h1>1</h1>');
  writeFileSync(join(folder, 'landing-2.html'), '<h1>2</h1>');
  writeFileSync(join(sito.absolute, 'index.html'), '<h1>root</h1>');
  // Changed before the run: left alone.
  writeFileSync(join(folder, 'old.html'), '<h1>old</h1>');
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(folder, 'old.html'), past, past);
  const written = await recordVariantDesign(sito.absolute, ['mockups/landing-2.html', 'mockups/old.html', 'index.html', 'mockups/missing.html'], { style: 'apple', skills: ['web-design'] }, since);
  assert.deepEqual(written, ['mockups/landing-2.html']);
  const register = JSON.parse(readFileSync(join(folder, REGISTER_NAME), 'utf8')) as { variants: Record<string, unknown> };
  assert.deepEqual(Object.keys(register.variants), ['landing-2.html']);
  const listed = await listMockups(deps([sito]), 'reg');
  assert.deepEqual(listed.files.find((file) => file.name === 'landing-2.html')?.design?.style, 'apple');
  assert.deepEqual(listed.files.find((file) => file.name === 'landing-2.html')?.design?.skills, ['web-design']);
  assert.equal(listed.files.find((file) => file.name === 'landing-1.html')?.design, undefined);
  // A later run without style: known as none, the earlier entry stays.
  writeFileSync(join(folder, 'landing-3.html'), '<h1>3</h1>');
  await recordVariantDesign(sito.absolute, ['mockups/landing-3.html'], { style: null, skills: [] }, since);
  const again = await listMockups(deps([sito]), 'reg');
  assert.equal(again.files.find((file) => file.name === 'landing-3.html')?.design?.style, null);
  assert.equal(again.files.find((file) => file.name === 'landing-2.html')?.design?.style, 'apple');
  // The register is not a mockup.
  assert.equal(again.files.some((file) => file.name === REGISTER_NAME), false);
});

test('a register edited by hand: bad entries are not shown; a link is never written through', async () => {
  const sito = project('hand');
  const folder = join(sito.absolute, 'mockups');
  writeFileSync(join(folder, 'a.html'), '<h1>a</h1>');
  writeFileSync(join(folder, 'b.html'), '<h1>b</h1>');
  writeFileSync(
    join(folder, REGISTER_NAME),
    JSON.stringify({ variants: { 'a.html': { style: '<script>', skills: [], at: '2026-10-12T10:00:00Z' }, 'b.html': { style: 'ok-style', skills: ['x'], at: '2026-10-12T10:00:00Z' } } }),
  );
  const listed = await listMockups(deps([sito]), 'hand');
  assert.equal(listed.files.find((file) => file.name === 'a.html')?.design, undefined);
  assert.equal(listed.files.find((file) => file.name === 'b.html')?.design?.style, 'ok-style');

  const linked = project('linked');
  const outside = join(HOME, 'outside.json');
  writeFileSync(outside, '{"variants":{}}');
  symlinkSync(outside, join(linked.absolute, 'mockups', REGISTER_NAME));
  writeFileSync(join(linked.absolute, 'mockups', 'c.html'), '<h1>c</h1>');
  assert.deepEqual(await recordVariantDesign(linked.absolute, ['mockups/c.html'], { style: 'apple', skills: [] }, new Date(Date.now() - 60_000)), []);
  assert.equal(readFileSync(outside, 'utf8'), '{"variants":{}}');
  // A broken register is left as it is.
  writeFileSync(join(folder, REGISTER_NAME), '{ not json');
  assert.deepEqual(await recordVariantDesign(sito.absolute, ['mockups/a.html'], { style: 'apple', skills: [] }, new Date(Date.now() - 60_000)), []);
  assert.equal(readFileSync(join(folder, REGISTER_NAME), 'utf8'), '{ not json');
});
