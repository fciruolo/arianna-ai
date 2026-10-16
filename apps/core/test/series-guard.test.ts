// Every person of the series through the real second scanner (D-214, as the
// tests of D-203): its piece of the prompt must leave towards the cloud.
// Only with Rizzo-PII on disk: `pnpm test:guard` sets ARIANNA_GUARD_MODEL and
// runs this file too; in `pnpm test` it is skipped.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { loadAgents, SERIES_PERSONAS, seriesNamesOfSource, seriesPersonaBlock, seriesSource } from '@arianna/agents';
import { DATA_DIR, guardPaths, resolveHome } from '@arianna/config';
import { piiVerdict } from '@arianna/policy';

import { fragmentNamesOf } from '../src/gateway.ts';
import { createPiiGuard, guardStarter } from '../src/pii-guard.ts';
import { rosterPart, userNamesPart, wornSeriesNames } from '../src/prompt-tail.ts';

const MODEL = process.env.ARIANNA_GUARD_MODEL ?? '';
const available = MODEL !== '' && existsSync(join(MODEL, 'model.safetensors'));
const home = resolveHome();
// The names of the agents are no persons, as main.ts tells the guard.
const guard = available ? createPiiGuard({ start: guardStarter(guardPaths(home, join(home, DATA_DIR)), MODEL), development: false, names: () => [...loadAgents(join(home, 'agents')).keys()], startTimeoutMs: 120_000, requestTimeoutMs: 120_000 }) : undefined;

after(async () => {
  await guard?.stop();
});

test('the piece of every person of the series passes the second scanner, its name being no person there (D-214)', { skip: !available && 'Rizzo-PII is not in data/guard/models' }, async () => {
  assert.ok(guard !== undefined);
  for (const [id, person] of Object.entries(SERIES_PERSONAS)) {
    const text = seriesPersonaBlock(person, { withName: true, withTraits: true });
    const check = await guard.scan([text], [seriesNamesOfSource(seriesSource(id))]);
    assert.deepEqual(piiVerdict(check, [text]), { verdict: 'clean' }, id);
  }
});

test('who is who and an answer that names the agents by their characters pass the real scanner; a real person does not (D-217)', { skip: !available && 'Rizzo-PII is not in data/guard/models' }, async () => {
  assert.ok(guard !== undefined);
  for (const theme of ['corsia', 'ufficio', 'springfield', 'quahog']) {
    const config = { personas: {}, appearance: { theme }, home, paths: { data: join(home, DATA_DIR) }, agentsNow: () => ({ official: [...loadAgents(join(home, 'agents')).keys()], user: [] }) };
    for (const agent of ['arianna', 'coder', 'god', 'designer']) {
      const roster = rosterPart(config, agent);
      assert.ok(roster !== undefined, `${theme} ${agent}`);
      const check = await guard.scan([roster.text], fragmentNamesOf([{ value: roster.text, label: roster.label, source: roster.source }], []));
      assert.deepEqual(piiVerdict(check, [roster.text]), { verdict: 'clean' }, `${theme} ${agent}`);
    }
  }
  const worn = wornSeriesNames({ personas: {}, appearance: { theme: 'corsia' }, home, paths: { data: join(home, DATA_DIR) }, agentsNow: () => ({ official: [...loadAgents(join(home, 'agents')).keys()], user: [] }) });
  const answer = 'Ne ho parlato con Carla e con il Dr. Cox; Elliot rivede il diff e Turk fa i conti.';
  const clean = await guard.scan([answer], fragmentNamesOf([{ value: answer, label: 'L1', source: 'message:1' }], worn));
  assert.deepEqual(piiVerdict(clean, [answer]), { verdict: 'clean' });
  const person = 'Scrivi a Carla Bianchi per il preventivo.';
  const found = await guard.scan([person], fragmentNamesOf([{ value: person, label: 'L1', source: 'message:2' }], worn));
  assert.equal(piiVerdict(found, [person]).verdict, 'found');
  // The people of D-227 worn by the Designer, Finanze and the local model: an answer that names them passes too.
  const office = wornSeriesNames({ personas: {}, appearance: { theme: 'ufficio' }, home, paths: { data: join(home, DATA_DIR) }, agentsNow: () => ({ official: [...loadAgents(join(home, 'agents')).keys()], user: [] }) });
  const springfield = wornSeriesNames({ personas: {}, appearance: { theme: 'springfield' }, home, paths: { data: join(home, DATA_DIR) }, agentsNow: () => ({ official: [...loadAgents(join(home, 'agents')).keys()], user: [] }) });
  const quahog = wornSeriesNames({ personas: {}, appearance: { theme: 'quahog' }, home, paths: { data: join(home, DATA_DIR) }, agentsNow: () => ({ official: [...loadAgents(join(home, 'agents')).keys()], user: [] }) });
  for (const [names, text] of [
    [worn, 'L’Inserviente ha preparato la grafica e il Dr. Kelso ha risposto in locale.'],
    [office, 'Oscar ha controllato i conti, Andy ha fatto la grafica e Kevin ha risposto in locale.'],
    // The people of Springfield (D-237), worn with the theme I Simpson.
    [springfield, 'Homer ha scritto il codice, Lisa ha rivisto il diff, Smithers ha fatto i conti e il signor Burns ha approvato.'],
    // I Griffin (D-238): every agent of the theme named in one answer.
    [quahog, 'Lois ha passato il lavoro a Peter, Stewie ha deciso, Brian ha rivisto il diff, Meg ha fatto i conti, Chris la grafica e Cleveland ha risposto in locale.'],
  ] as const) {
    const check = await guard.scan([text], fragmentNamesOf([{ value: text, label: 'L1', source: 'message:3' }], names));
    assert.deepEqual(piiVerdict(check, [text]), { verdict: 'clean' }, text);
  }
});

test('the piece of the names the user wrote passes the real scanner, the same name in a brief does not (D-217)', { skip: !available && 'Rizzo-PII is not in data/guard/models' }, async () => {
  assert.ok(guard !== undefined);
  const config = {
    personas: { coder: { tone: 'equilibrato' as const, address: 'tu' as const, displayName: 'Bruno' } },
    appearance: { theme: 'corsia' },
    home,
    paths: { data: join(home, DATA_DIR) },
    agentsNow: () => ({ official: [...loadAgents(join(home, 'agents')).keys()], user: [] }),
  };
  const piece = userNamesPart(config, 'god', 'L1');
  assert.ok(piece !== undefined);
  const brief = 'Scrivi a Bruno Ferri per il preventivo.';
  const texts = [piece.text, brief];
  const check = await guard.scan(texts, fragmentNamesOf([{ value: piece.text, label: piece.label, source: piece.source }, { value: brief, label: 'L1', source: 'message:1' }], []));
  const verdict = piiVerdict(check, texts);
  assert.ok(verdict.verdict === 'found');
  assert.deepEqual(verdict.findings.map((finding) => finding.fragment), [1]);
});
