import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AGENTS_DIR, AgentCardError, labelCeiling, loadAgent, loadAgents } from '@arianna/agents';
import { resolveHome } from '@arianna/config';

const HOME = resolveHome({});
const COMMITTED = join(HOME, AGENTS_DIR);
const scratch = join(HOME, 'data', 'test-tmp', randomUUID());

/**
 * The names of the cards of agents/ that git tracks. An agent promoted from
 * the Agents page (D-119) and not committed sits next to them on this
 * machine only: these tests are about the repository's cards.
 */
function trackedCards(home: string): Set<string> {
  const listed = execFileSync('git', ['-C', home, 'ls-files', '--', `${AGENTS_DIR}/*.yaml`], { encoding: 'utf8' });
  return new Set(listed.split('\n').flatMap((line) => /\/([a-z][a-z0-9-]*)\.yaml$/.exec(line)?.[1] ?? []));
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A copy of the committed cards to break. */
function copy(): string {
  const dir = join(scratch, randomUUID());
  mkdirSync(dir, { recursive: true });
  cpSync(COMMITTED, dir, { recursive: true });
  return dir;
}

describe('committed agent cards', () => {
  it('load: Arianna local only, Coder L1 in the cloud and L2 locally', () => {
    const agents = loadAgents(COMMITTED);
    // Agents promoted from the Agents page (D-119) may sit next to them.
    assert.ok(agents.has('arianna') && agents.has('coder'));

    const arianna = agents.get('arianna');
    assert.ok(arianna !== undefined);
    assert.deepEqual(arianna.card.executors, ['local']);
    assert.equal(arianna.card.trifecta.external_comms, false);
    assert.match(arianna.prompt, /Arianna/);

    const coder = agents.get('coder');
    assert.ok(coder !== undefined);
    assert.equal(labelCeiling(coder.card, 'claude'), 'L1');
    assert.equal(labelCeiling(coder.card, 'codex'), 'L1');
    assert.equal(labelCeiling(coder.card, 'local'), 'L2');
  });

  it('start at autonomy A1', () => {
    const tracked = trackedCards(HOME);
    for (const { card } of loadAgents(COMMITTED).values()) if (tracked.has(card.name)) assert.equal(card.autonomy, 'A1', card.name);
  });
});

describe('loadAgent', () => {
  it('rejects an invalid card, and the whole folder with it', () => {
    const dir = copy();
    writeFileSync(join(dir, 'coder.yaml'), 'name: coder\nmax_label: L3\n');
    assert.throws(() => loadAgent(dir, 'coder'), AgentCardError);
    assert.throws(() => loadAgents(dir), AgentCardError);
  });

  it('rejects malformed YAML', () => {
    const dir = copy();
    writeFileSync(join(dir, 'coder.yaml'), 'name: [coder\n');
    assert.throws(() => loadAgent(dir, 'coder'), AgentCardError);
  });

  it('rejects a missing or empty prompt', () => {
    const missing = copy();
    rmSync(join(missing, 'coder.md'));
    assert.throws(() => loadAgent(missing, 'coder'), /prompt coder.md not found/);

    const empty = copy();
    writeFileSync(join(empty, 'coder.md'), '  \n');
    assert.throws(() => loadAgent(empty, 'coder'), /empty/);
  });

  it('rejects a name that could leave the folder', () => {
    assert.throws(() => loadAgent(COMMITTED, '../coder'), /invalid agent name/);
  });
});

describe('YAML tricks', () => {
  /** The committed coder card with `change` applied to its text. */
  function coderWith(change: (text: string) => string): string {
    const dir = copy();
    const file = join(dir, 'coder.yaml');
    writeFileSync(file, change(readFileSync(file, 'utf8')));
    return dir;
  }

  it('rejects __proto__ at the top and inside the trifecta', () => {
    assert.throws(() => loadAgent(coderWith((t) => `${t}__proto__: { cloud_max_label: L2 }\n`), 'coder'), /unknown key/);
    assert.throws(
      () => loadAgent(coderWith((t) => t.replace('trifecta:\n', 'trifecta:\n  __proto__: { external_comms: false }\n')), 'coder'),
      /unknown key/,
    );
  });

  it('rejects merge keys and anchors kept in a side key', () => {
    const merged = coderWith((t) =>
      t.replace(/trifecta:\n(?: {2}.*\n)+/, 'base: &t { private_data: true, untrusted_content: true, external_comms: false }\ntrifecta:\n  <<: *t\n'),
    );
    assert.throws(() => loadAgent(merged, 'coder'), AgentCardError);
  });

  it('rejects duplicate keys', () => {
    assert.throws(() => loadAgent(coderWith((t) => `${t}max_label: L0\n`), 'coder'), AgentCardError);
  });

  it('does not read yes and no as booleans', () => {
    assert.throws(() => loadAgent(coderWith((t) => t.replace('external_comms: false', 'external_comms: no')), 'coder'), /external_comms/);
  });
});

describe('agents folder', () => {
  it('rejects a misnamed card instead of skipping it', () => {
    const dir = copy();
    writeFileSync(join(dir, 'reviewer.yml'), 'name: reviewer\n');
    assert.throws(() => loadAgents(dir), /unexpected file\(s\) reviewer.yml/);
  });

  it('rejects a prompt without a card', () => {
    const dir = copy();
    writeFileSync(join(dir, 'ghost.md'), 'Hello\n');
    assert.throws(() => loadAgents(dir), /without a card ghost.md/);
  });

  it('rejects symbolic links, for cards and prompts', () => {
    const card = copy();
    rmSync(join(card, 'coder.yaml'));
    symlinkSync(join(COMMITTED, 'coder.yaml'), join(card, 'coder.yaml'));
    assert.throws(() => loadAgent(card, 'coder'), /not a regular file/);

    const prompt = copy();
    rmSync(join(prompt, 'coder.md'));
    symlinkSync(join(COMMITTED, 'coder.md'), join(prompt, 'coder.md'));
    assert.throws(() => loadAgent(prompt, 'coder'), /not a regular file/);
  });
});
