// A character drawn by a model (D-123): the answer checked field by field, the
// sheet composed always the same, the fixed prompt pinned, the agent's texts
// labelled, the gateway in front of Claude, the model from [sprites].
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { CATALOG_FILE, CONFIG_FILE, DATA_DIR, DEFAULT_SETTINGS, loadCatalog, parseConfig, renderSettings, resolveHome, settingsFingerprint } from '@arianna/config';
import { createContext, gatewayCheck, secretMatcher } from '@arianna/policy';

import { cleanSheet } from '../src/characters.ts';
import { decodePng } from '../src/png.ts';
import { createSettingsPage } from '../src/settings-page.ts';
import { spriteUnavailable, parseSpriteRequest, SpriteError } from '../src/sprites/generate.ts';
import { EXAMPLES, SPRITE_PROMPT, spriteBrief } from '../src/sprites/prompt.ts';
import { checkSprite, moveEyes, readSpriteReply, SPRITE_SCHEMA, SpriteSpecError, spriteSheet, type SpriteSpec } from '../src/sprites/spec.ts';

const EXAMPLE_TEXT = JSON.stringify(EXAMPLES[0]?.spec);
const example = (): SpriteSpec => JSON.parse(EXAMPLE_TEXT) as SpriteSpec;
const refused = (value: unknown, pattern: RegExp): void => {
  assert.throws(() => checkSprite(value), (error: unknown) => error instanceof SpriteSpecError && pattern.test(error.message));
};
const subject = { name: 'grafico', description: 'Disegna grafici dai dati di lavoro.', prompt: 'Ricevi una tabella e proponi un grafico.', hint: '' };
const FAKE_IBAN = 'IT60X0542811101000000123456';

describe('the answer of the model', () => {
  it('the example of the prompt is a valid drawing', () => {
    const spec = checkSprite(example());
    assert.equal(spec.head.front.length, 10);
    assert.equal(spec.body.side.length, 9);
    assert.equal(spec.legs.stride.length, 6);
    assert.ok(spec.palette.E !== undefined);
  });

  it('refuses a row of the wrong width and a piece with the wrong number of rows', () => {
    const short = example();
    short.head.front[2] = (short.head.front[2] ?? '').slice(1);
    refused(short, /head\.front\[2\]: 16 characters/);
    const long = example();
    long.legs.side[0] = `${long.legs.side[0] ?? ''}.`;
    refused(long, /legs\.side\[0\]: 16 characters/);
    const rows = example();
    rows.body.back.push('................');
    refused(rows, /body\.back: 9 rows/);
    const fewer = example();
    fewer.head.side.pop();
    refused(fewer, /head\.side: 10 rows/);
  });

  it('refuses letters outside the palette and palettes that break the rules', () => {
    const letter = example();
    letter.body.front[3] = 'Z'.repeat(16);
    refused(letter, /body\.front\[3\]: a letter that is not in the palette/);
    const digit = example();
    digit.body.front[3] = '1'.repeat(16);
    refused(digit, /not in the palette/);
    refused({ ...example(), palette: { ...example().palette, ab: '#000000' } }, /one ASCII letter/);
    refused({ ...example(), palette: { ...example().palette, '7': '#000000' } }, /one ASCII letter/);
    refused({ ...example(), palette: { ...example().palette, z: '#abc' } }, /palette\.z: a colour/);
    refused({ ...example(), palette: { ...example().palette, z: 'red' } }, /palette\.z: a colour/);
    const noEyes = example().palette;
    delete noEyes.e;
    refused({ ...example(), palette: noEyes }, /"e" \(eyes\) is required/);
    const noOutline = example().palette;
    delete noOutline.o;
    refused({ ...example(), palette: noOutline }, /"o" \(outline\) is required/);
    const many = Object.fromEntries('abcdefghijklmnopq'.split('').map((key) => [key, '#101010']));
    refused({ ...example(), palette: { ...many, o: '#000000', E: '#000000', s: '#ffffff' } }, /4-16 colours/);
  });

  it('refuses fields outside the schema, at every level', () => {
    refused({ ...example(), name: 'x' }, /answer: 1 field\(s\) not in the schema/);
    refused({ ...example(), head: { ...example().head, top: [] } }, /head: 1 field/);
    refused({ ...example(), legs: { ...example().legs, back: example().legs.front } }, /legs: 1 field/);
    const missing: Partial<SpriteSpec> = example();
    delete missing.body;
    refused(missing, /answer: missing body/);
    refused([], /not a JSON object/);
  });

  it('wants the eyes in front and on the side, never from behind, and no empty piece', () => {
    const back = example();
    back.head.back[5] = '..ohheeeeeeeeho..'.slice(0, 16);
    refused(back, /head\.back: no eyes/);
    const blind = example();
    blind.head.front = blind.head.front.map((line) => line.replaceAll('e', 's'));
    refused(blind, /the eyes \("e"\) are required/);
    const empty = example();
    empty.legs.front = Array.from({ length: 6 }, () => '.'.repeat(16));
    refused(empty, /legs\.front: at least 8 drawn pixels/);
  });

  it('reads the text: JSON alone or in one code fence; anything else is refused', () => {
    assert.ok(readSpriteReply(EXAMPLE_TEXT));
    assert.ok(readSpriteReply(`\`\`\`json\n${EXAMPLE_TEXT}\n\`\`\``));
    assert.ok(readSpriteReply(example()), 'a value parsed by constrained decoding');
    assert.throws(() => readSpriteReply('Here is your character!'), /not JSON/);
    assert.throws(() => readSpriteReply(`Sure: ${EXAMPLE_TEXT}`), /not JSON/);
    assert.throws(() => readSpriteReply(`${EXAMPLE_TEXT} `.repeat(20)), /over 16 KiB|not JSON/);
    assert.throws(() => readSpriteReply('x'.repeat(17 * 1024)), /over 16 KiB/);
  });

  it('the schema of the local model asks for the same fields and sizes', () => {
    const properties = SPRITE_SCHEMA.properties as Record<string, { required?: string[]; properties?: Record<string, { minItems: number }> }>;
    assert.deepEqual(SPRITE_SCHEMA.required, ['palette', 'head', 'body', 'legs']);
    assert.equal(SPRITE_SCHEMA.additionalProperties, false);
    assert.deepEqual(properties.palette?.required, ['o', 'e', 'E', 's']);
    assert.equal(properties.head?.properties?.front?.minItems, 10);
    assert.equal(properties.legs?.properties?.stride?.minItems, 6);
  });
});

describe('the sheet', () => {
  it('is the same PNG for the same answer, 112×128, and the upload of D-118 accepts it', () => {
    const first = spriteSheet(checkSprite(example()));
    const second = spriteSheet(readSpriteReply(EXAMPLE_TEXT));
    assert.ok(first.png.equals(second.png));
    assert.equal(first.rows, 4);
    const image = decodePng(first.png, 128);
    assert.deepEqual([image.width, image.height], [112, 128]);
    assert.equal(cleanSheet(first.png).rows, 4);
  });

  it('closes the eyes in the pause and moves them when working', () => {
    const image = decodePng(spriteSheet(checkSprite(example())).png, 128);
    const pixel = (x: number, y: number): string => {
      const at = (y * image.width + x) * 4;
      return [...image.rgba.subarray(at, at + 3)].map((value) => value.toString(16).padStart(2, '0')).join('');
    };
    const eye = example().palette.e?.slice(1).toLowerCase() ?? '';
    const closed = example().palette.E?.slice(1).toLowerCase() ?? '';
    // Row 13 of the frame (head row 6) holds Arianna's eyes at columns 5 and 10.
    assert.equal(pixel(5, 13), eye, 'idle: open');
    assert.equal(pixel(6 * 16 + 5, 3 * 32 + 13), closed, 'fourth row, blink: closed');
    assert.equal(pixel(3 * 16 + 5, 14), eye, 'typing: one pixel lower');
  });

  it('never moves the eyes onto the outline', () => {
    const rows = ['oooo', 'oseo', 'oooo'].map((line) => line.padEnd(16, '.'));
    assert.deepEqual(moveEyes(rows, 1, 0), rows);
    assert.deepEqual(moveEyes(['.ses'.padEnd(16, '.'), '.sss'.padEnd(16, '.')], 1, 0), ['.sss'.padEnd(16, '.'), '.ses'.padEnd(16, '.')]);
  });
});

describe('the brief', () => {
  it('the fixed prompt is the same bytes every time, pinned: a change is a choice', () => {
    assert.equal(createHash('sha256').update(SPRITE_PROMPT).digest('hex'), '5719d2be6deda290367bc7bda5972f74fda7c0ba1fa7d5704eeeebf5b6a62afb');
    const one = spriteBrief(subject)[0];
    const two = spriteBrief({ ...subject, name: 'altro', hint: 'cappello rosso' }, { tone: 'scherzoso', specialization: 'grafici' })[0];
    assert.deepEqual(one, { text: SPRITE_PROMPT, label: 'L0', source: 'prompt:sprite' });
    assert.deepEqual(two, one);
    assert.doesNotMatch(SPRITE_PROMPT, /grafico|cappello/);
  });

  it('one fragment per field, L1 with its source; persona and hint only when they say something', () => {
    assert.deepEqual(spriteBrief(subject).slice(1), [
      { text: 'Agent name: grafico', label: 'L1', source: 'agent:grafico:name' },
      { text: 'Description: Disegna grafici dai dati di lavoro.', label: 'L1', source: 'agent:grafico:description' },
      { text: 'Agent prompt:\nRicevi una tabella e proponi un grafico.', label: 'L1', source: 'agent:grafico:prompt' },
    ]);
    const full = spriteBrief({ ...subject, hint: 'felpa gialla' }, { tone: 'scherzoso', specialization: 'Grafici per riunioni.' }).slice(4);
    assert.deepEqual(full, [
      { text: 'Tone: scherzoso', label: 'L1', source: 'persona:grafico:tone' },
      { text: 'Specialization: Grafici per riunioni.', label: 'L1', source: 'persona:grafico:specialization' },
      { text: 'User hint: felpa gialla', label: 'L1', source: 'user:sprite-hint' },
    ]);
    assert.equal(spriteBrief({ ...subject, prompt: ' ' }, { tone: 'equilibrato' }).length, 3, 'the default tone adds nothing');
  });

  it('the gateway lets a clean brief go to Claude, and blocks personal data or a vault value in the hint', () => {
    const payload = (hint: string) => spriteBrief({ ...subject, hint }).map((fragment) => ({ value: fragment.text, label: fragment.label, source: fragment.source }));
    const claude = { kind: 'executor', id: 'claude', locality: 'cloud' } as const;
    const local = { kind: 'executor', id: 'local', locality: 'local' } as const;
    const none = secretMatcher([]);
    const clean = gatewayCheck(payload('felpa gialla'), createContext('L1', 'L1'), claude, none);
    assert.equal(clean.decision, 'allow');
    assert.equal(clean.label, 'L1');
    const iban = gatewayCheck(payload(`colori come ${FAKE_IBAN}`), createContext('L1', 'L1'), claude, none);
    assert.equal(iban.decision, 'block');
    const vault = secretMatcher([{ ref: 'vault://test/sprite', value: 'segreto-sprite-98765' }]);
    assert.equal(gatewayCheck(payload('segreto-sprite-98765'), createContext('L1', 'L1'), claude, vault).decision, 'block');
    assert.equal(gatewayCheck(payload('segreto-sprite-98765'), createContext('L2', 'L1'), local, vault).decision, 'block', 'a vault value is blocked towards the local model too');
  });

  it('the request takes four fields, checked like the texts of the user agents', () => {
    const code = (body: Record<string, unknown>): string | undefined => {
      try {
        parseSpriteRequest(body);
        return undefined;
      } catch (error) {
        return error instanceof SpriteError ? `${error.code}: ${error.message}` : 'other';
      }
    };
    assert.equal(code({ name: 'grafico', description: 'Grafici.' }), undefined);
    assert.match(code({ name: 'grafico', description: 'Grafici.', model: 'opus' }) ?? '', /^invalid: unknown field/);
    assert.match(code({ name: '', description: 'Grafici.' }) ?? '', /^invalid: name: required/);
    assert.match(code({ name: 'grafico', description: 'Grafici.', hint: `paga su ${FAKE_IBAN}` }) ?? '', /^invalid: hint looks like personal data or a secret \(iban\)/);
    assert.match(code({ name: 'grafico', description: 'Grafici.', hint: 'x'.repeat(301) }) ?? '', /hint: at most 300/);
    assert.match(code({ name: 'gra\nfico', description: 'Grafici.' }) ?? '', /name: one line/);
  });
});

describe('the model from the settings', () => {
  const REPO = resolveHome({});
  const root = join(REPO, DATA_DIR, 'test-tmp', randomUUID());
  const home = join(root, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  copyFileSync(join(REPO, CATALOG_FILE), join(home, CATALOG_FILE));
  const read = (text: string) => parseConfig(text, home, loadCatalog(home), root);
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('[sprites] absent is Claude Opus (D-132); sonnet and local are read; anything else is refused', () => {
    const base = renderSettings(DEFAULT_SETTINGS);
    assert.equal(read(base).sprites.model, 'opus');
    assert.equal(read(renderSettings({ ...DEFAULT_SETTINGS, sprites: 'sonnet' })).sprites.model, 'sonnet');
    assert.equal(read(renderSettings({ ...DEFAULT_SETTINGS, sprites: 'local' })).sprites.model, 'local');
    assert.throws(() => read(`${base}\n[sprites]\nmodel = "fable"\n`), /sprites\.model/);
    assert.throws(() => read(`${base}\n[sprites]\nmodel = "opus"\ncolour = "red"\n`), /sprites: unknown key/);
  });

  it('a model that cannot draw says why, and never falls back to another', () => {
    const on = read(renderSettings({ ...DEFAULT_SETTINGS, cloud: { executors: ['claude'] } }));
    assert.equal(spriteUnavailable(on, true), undefined);
    assert.match(spriteUnavailable(on, false) ?? '', /cannot run/);
    assert.match(spriteUnavailable(read(renderSettings(DEFAULT_SETTINGS)), true) ?? '', /not on in \[cloud\] executors/);
    const opusOff = read(renderSettings({ ...DEFAULT_SETTINGS, sprites: 'opus', cloud: { executors: ['claude'], models: { sonnet: { enabled: true }, opus: { enabled: false }, fable: { enabled: true }, codex: { enabled: true } } } }));
    assert.match(spriteUnavailable(opusOff, true) ?? '', /opus is off/);
    const local = read(renderSettings({ ...DEFAULT_SETTINGS, sprites: 'local' }));
    assert.match(spriteUnavailable(local, true) ?? '', /no local server serves local-large/);
    const served = read(renderSettings({ ...DEFAULT_SETTINGS, sprites: 'local', roles: { orchestrator: 'qwen3.8-27b-4bit' }, endpoints: [{ id: 'omlx', url: 'http://127.0.0.1:7001/v1' }] }));
    assert.equal(spriteUnavailable(served, false), undefined);
  });

  it('the settings page shows the model and saves it as an ordinary setting', () => {
    const file = join(home, CONFIG_FILE);
    writeFileSync(file, renderSettings(DEFAULT_SETTINGS));
    const running = read(renderSettings(DEFAULT_SETTINGS));
    const page = createSettingsPage({ home, userHome: root, dataDir: join(home, DATA_DIR), running: () => running, agentModels: () => ({}) });
    const view = page.read();
    assert.equal(view.values?.sprites, 'opus');
    assert.ok(view.ordinary.includes('sprites'));
    const next = page.update({ fingerprint: settingsFingerprint(readFileSync(file, 'utf8')), values: { sprites: 'local' } });
    assert.equal(next.values?.sprites, 'local');
    assert.match(readFileSync(file, 'utf8'), /\[sprites\]\nmodel = "local"/);
    assert.throws(() => page.update({ fingerprint: next.fingerprint, values: { sprites: 'gpt' } }), /sprites: one of sonnet, opus, local/);
  });

  it('[participants] leave_after (I-8, D-130): ten by default, saved as an ordinary setting, 0 to 100', () => {
    const file = join(home, CONFIG_FILE);
    writeFileSync(file, renderSettings(DEFAULT_SETTINGS));
    const running = read(renderSettings(DEFAULT_SETTINGS));
    const page = createSettingsPage({ home, userHome: root, dataDir: join(home, DATA_DIR), running: () => running, agentModels: () => ({}) });
    const view = page.read();
    assert.equal(view.values?.participants, 10);
    assert.ok(view.ordinary.includes('participants'));
    const next = page.update({ fingerprint: settingsFingerprint(readFileSync(file, 'utf8')), values: { participants: 0 } });
    assert.equal(next.values?.participants, 0);
    assert.match(readFileSync(file, 'utf8'), /\[participants\]\nleave_after = 0/);
    assert.equal(read(readFileSync(file, 'utf8')).participants.leaveAfter, 0);
    for (const bad of [-1, 101, 2.5, '10']) {
      assert.throws(() => page.update({ fingerprint: next.fingerprint, values: { participants: bad } }), /participants: a whole number/);
    }
  });
});
