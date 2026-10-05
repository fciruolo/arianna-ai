import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';

import {
  CATALOG_FILE,
  CONFIG_FILE,
  DEFAULT_SETTINGS,
  EMPTY_CATALOG,
  loadConfig,
  parseConfig,
  parsePersonas,
  readSettings,
  renderSettings,
  resolveHome,
  watchConfig,
  type ConfigChange,
  type Settings,
} from '../src/index.ts';

const HOME = resolve('some-home');
const VALID = renderSettings(DEFAULT_SETTINGS);
const personasOf = (section: string) => parseConfig(`${VALID}\n${section}\n`, HOME).personas;

test('[personas] (D-107): absent, every agent has the defaults', () => {
  assert.deepEqual(parseConfig(VALID, HOME).personas, {});
  assert.deepEqual(parsePersonas(undefined), {});
});

test('[personas.<agent>] is read with the checks of @arianna/agents', () => {
  assert.deepEqual(
    personasOf(
      '[personas.arianna]\ntone = "caloroso"\ntraits = "Precisa e calma."\n\n[personas.coder]\ntone = "asciutto"\naddress = "lei"\ndisplay_name = "Dario"\nspecialization = "Sviluppatore senior."',
    ),
    {
      arianna: { tone: 'caloroso', address: 'tu', traits: 'Precisa e calma.' },
      coder: { tone: 'asciutto', address: 'lei', displayName: 'Dario', specialization: 'Sviluppatore senior.' },
    },
  );
});

test('[personas]: Arianna keeps her name, the other agents can be renamed', () => {
  assert.throws(() => personasOf('[personas.arianna]\ndisplay_name = "Ari"'), { name: 'ConfigError', message: /personas\.arianna\.display_name/ });
  assert.equal(personasOf('[personas.coder]\ndisplay_name = "Ari"').coder?.displayName, 'Ari');
});

test('[personas] refuses what the persona refuses, and bad agent ids, naming the field but not the text', () => {
  const secret = 'testo-privato-da-non-ripetere';
  const bad = [
    '[personas.arianna]\ntone = "sarcastico"',
    '[personas.arianna]\naddress = "voi"',
    '[personas.arianna]\nlabel = "L1"',
    '[personas.arianna]\ntools = ["channel.send"]',
    `[personas.arianna]\ntraits = "${secret}${'a'.repeat(500)}"`,
    `[personas.arianna]\nspecialization = "${secret}${'a'.repeat(500)}"`,
    `[personas.arianna]\ntraits = "${secret}\\u0007"`,
    '[personas.arianna]\ndisplay_name = ""',
    '[personas.arianna]\ndisplay_name = "Un nome davvero troppo lungo"',
    '[personas.Arianna]\ntone = "serio"',
    '[personas]\narianna = "serio"',
    'personas = 1',
  ];
  for (const section of bad) {
    assert.throws(() => personasOf(section), (error: Error) => error.name === 'ConfigError' && !error.message.includes(secret), section);
  }
});

test('[personas] refuses __proto__ as an agent id or as a key', () => {
  for (const section of ['[personas.__proto__]\ntone = "serio"', '[personas.arianna]\n__proto__ = "x"', '[personas."__proto__"]\ntone = "serio"']) {
    assert.throws(() => personasOf(section), { name: 'ConfigError' }, section);
  }
});

test('the settings write [personas] and read back the same, text with quotes and line breaks included', () => {
  const personas = {
    arianna: { tone: 'scherzoso' as const, address: 'lei' as const, traits: 'Dice "ciao"\ne ride. à \\ ok' },
    coder: { tone: 'serio' as const, address: 'tu' as const, displayName: "D'Ari", specialization: 'Senior "TS"\n\\ test' },
  };
  const settings: Settings = { ...DEFAULT_SETTINGS, personas };
  const text = renderSettings(settings);
  assert.match(text, /^\[personas\.arianna\]$/m);
  assert.deepEqual(parseConfig(text, HOME).personas, personas);
  assert.deepEqual(readSettings(text, HOME, EMPTY_CATALOG).personas, personas);
  assert.equal(renderSettings(readSettings(text, HOME, EMPTY_CATALOG)), text);
  // Without personas the key stays absent and the file shows the commented example.
  assert.equal(readSettings(VALID, HOME, EMPTY_CATALOG).personas, undefined);
  assert.match(VALID, /^# \[personas\.coder\]$/m);
});

const WATCH_HOME = join(resolveHome({}), 'data', 'test-tmp', `personas-${randomUUID()}`);
after(() => {
  rmSync(WATCH_HOME, { recursive: true, force: true });
});

function next(events: (ConfigChange | Error)[]): Promise<ConfigChange | Error> {
  return new Promise((resolveEvent, reject) => {
    const started = Date.now();
    const poll = (): void => {
      const event = events.shift();
      if (event !== undefined) resolveEvent(event);
      else if (Date.now() - started > 5000) reject(new Error('no reload within 5 s'));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

test('personas apply without a restart; an invalid file drops their text and keeps tone and address', async () => {
  mkdirSync(join(WATCH_HOME, 'config'), { recursive: true });
  writeFileSync(join(WATCH_HOME, CATALOG_FILE), 'version: 1\nmodels: []\n');
  const write = (text: string): void => {
    const temporary = join(WATCH_HOME, 'config', '.arianna.toml.test');
    writeFileSync(temporary, text);
    renameSync(temporary, join(WATCH_HOME, CONFIG_FILE));
  };
  write(VALID);
  const events: (ConfigChange | Error)[] = [];
  const env = { ARIANNA_HOME: WATCH_HOME };
  const watcher = watchConfig({
    initial: loadConfig(env),
    intervalMs: 20,
    onChange: (change) => events.push(change),
    onError: (error) => events.push(error instanceof Error ? error : new Error(String(error))),
  });
  const declared = { coder: { tone: 'serio' as const, address: 'lei' as const, displayName: 'Dario', traits: 'Calma.', specialization: 'Senior.' } };
  try {
    // Past the watcher's first look (twice the interval): a write before it would race with it.
    await new Promise((done) => setTimeout(done, 120));
    write(renderSettings({ ...DEFAULT_SETTINGS, personas: declared }));
    assert.deepEqual(await next(events), { applied: ['personas'], restart: [] });
    assert.deepEqual(watcher.current().personas, declared);

    write('[paths]\ndata = "/elsewhere"\n');
    assert.deepEqual(await next(events), { applied: ['personas'], restart: [] });
    assert.ok((await next(events)) instanceof Error);
    assert.deepEqual(watcher.current().personas, { coder: { tone: 'serio', address: 'lei' } });

    write(renderSettings({ ...DEFAULT_SETTINGS, personas: declared }));
    assert.deepEqual(await next(events), { applied: ['personas'], restart: [] });
    assert.deepEqual(watcher.current().personas, declared);
  } finally {
    watcher.close();
  }
});
