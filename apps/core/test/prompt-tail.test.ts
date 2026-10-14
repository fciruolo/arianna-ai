// The tail of an agent's prompt (D-107, tappa A3): the persona as a labeled
// piece, within the clearance of the step. Invented texts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PERSONA_BLOCK, personaBlock, personaParts, type AgentCard, type Persona } from '@arianna/agents';
import { secretMatcher } from '@arianna/policy';

import { cloudCeiling } from '../src/orchestrator/delegate.ts';
import { minLabel, personaPart, promptTail, tailParts, withoutPersonal } from '../src/prompt-tail.ts';

const PLAYFUL: Persona = { tone: 'scherzoso', address: 'lei', displayName: 'Ari', traits: 'Ama le metafore di cucina.', specialization: 'Segretaria di casa.' };

test('personaPart: the whole block, L1 by declaration, in a step that admits L1 (work, cloud, private)', () => {
  for (const clearance of ['L1', 'L2'] as const) {
    const part = personaPart({ coder: PLAYFUL }, 'coder', clearance);
    assert.deepEqual(part, { text: personaBlock(personaParts(PLAYFUL, clearance)), label: 'L1', source: 'persona:coder' });
    assert.match(part.text, /<persona>Ama le metafore di cucina\.<\/persona>/);
    assert.match(part.text, /Call yourself "Ari"/);
  }
});

test('personaPart: an L0 step never reads the user’s text, only the fixed sentences (L0)', () => {
  const part = personaPart({ web: PLAYFUL }, 'web', 'L0');
  assert.ok(part !== undefined);
  assert.equal(part.label, 'L0');
  assert.match(part.text, /Tone: playful/);
  assert.doesNotMatch(part.text, /metafore|Ari"|Segretaria|<persona>|<specialization>/);
  // Without a tone or address of its own, nothing at all.
  assert.equal(personaPart({ web: { tone: 'equilibrato', address: 'tu', traits: 'Testo.' } }, 'web', 'L0'), undefined);
});

test('personaPart: none for an agent without a persona, with the defaults, or for a name of the prototype', () => {
  assert.equal(personaPart({}, 'arianna', 'L2'), undefined);
  assert.equal(personaPart({ arianna: { tone: 'equilibrato', address: 'tu' } }, 'arianna', 'L2'), undefined);
  assert.equal(personaPart({ coder: PLAYFUL }, 'arianna', 'L2'), undefined, 'only the agent’s own');
  assert.equal(personaPart({}, 'constructor', 'L2'), undefined);
  assert.equal(personaPart({}, '__proto__', 'L2'), undefined);
});

test('tailParts: the persona today, in order; promptTail joins what the gateway let out', () => {
  assert.deepEqual(tailParts({ personas: {} }, 'arianna', 'L2'), []);
  const parts = tailParts({ personas: { arianna: PLAYFUL } }, 'arianna', 'L2');
  assert.deepEqual(parts.map((part) => [part.label, part.source]), [['L1', 'persona:arianna']]);
  assert.equal(promptTail([]), '');
  assert.equal(promptTail(['A', '', 'B']), 'A\n\nB');
});

test('minLabel and cloudCeiling: the lower label; in the cloud never above L1', () => {
  assert.equal(minLabel('L1', 'L2'), 'L1');
  assert.equal(minLabel('L2', 'L0'), 'L0');
  const card = (maxLabel: AgentCard['maxLabel'], cloudMaxLabel?: AgentCard['maxLabel']) => ({ maxLabel, ...(cloudMaxLabel === undefined ? {} : { cloudMaxLabel }) }) as AgentCard;
  assert.equal(cloudCeiling(card('L2', 'L1')), 'L1');
  assert.equal(cloudCeiling(card('L2')), 'L1');
  assert.equal(cloudCeiling(card('L1', 'L0')), 'L0');
  assert.equal(cloudCeiling(card('L0')), 'L0');
  // An L0 cloud ceiling keeps the user's text out of the brief.
  assert.equal(personaPart({ coder: PLAYFUL }, 'coder', minLabel('L1', cloudCeiling(card('L1', 'L0'))))?.label, 'L0');
});

test('the longest persona stays within the cap of the block: about 400 tokens re-read at each step', () => {
  const longest: Persona = {
    tone: 'scherzoso',
    address: 'lei',
    displayName: 'A'.repeat(24),
    traits: 'è'.repeat(500),
    specialization: 'ò'.repeat(500),
  };
  const text = personaPart({ coder: longest }, 'coder', 'L2')?.text ?? '';
  const length = Array.from(text).length;
  assert.ok(length <= MAX_PERSONA_BLOCK, String(length));
  // 3.5 characters per token (the estimate of the Personality page, D-107f): at most about 400 tokens.
  assert.ok(Math.ceil(length / 3.5) <= 400, String(length));
});

test('personaPart: a free text with personal data, written by hand in arianna.toml, is dropped; tone and address stay', () => {
  const iban: Persona = { ...PLAYFUL, traits: 'Ricorda l\'IBAN IT60X0542811101000000123456.' };
  const part = personaPart({ coder: iban }, 'coder', 'L1');
  assert.ok(part !== undefined);
  assert.doesNotMatch(part.text, /IT60X|<persona>/);
  assert.match(part.text, /Tone: playful/);
  assert.match(part.text, /Segretaria di casa/);
  // Only the clean texts stay; nothing clean left gives L0.
  const bare = withoutPersonal({ tone: 'scherzoso', address: 'lei', label: 'L1', traits: 'Il mio codice fiscale è RSSMRA80A01H501U' });
  assert.deepEqual(bare, { tone: 'scherzoso', address: 'lei', label: 'L0' });
  // A clean text is kept as it is.
  assert.deepEqual(withoutPersonal(personaParts(PLAYFUL, 'L1')), personaParts(PLAYFUL, 'L1'));
});

test('withoutPersonal: a value split over lines or tabs, which the block would join again, is dropped too', () => {
  const split = withoutPersonal({ tone: 'serio', address: 'tu', label: 'L1', traits: 'Conto IT60 X054\n2811 1010 0000 0123 456', specialization: 'Carta 4111 1111\t1111 1111' });
  assert.deepEqual(split, { tone: 'serio', address: 'tu', label: 'L0' });
});

test('withoutPersonal: a text holding a value of the vault is dropped, one without it stays', () => {
  const vault = secretMatcher([{ ref: 'vault://persona-test', value: 'zq-finto-segreto-8842' }]);
  const parts = withoutPersonal({ tone: 'serio', address: 'tu', label: 'L1', traits: 'La parola è zq-finto-segreto-8842.', specialization: 'Contabile di casa.' }, vault);
  assert.deepEqual(parts, { tone: 'serio', address: 'tu', label: 'L1', specialization: 'Contabile di casa.' });
});
