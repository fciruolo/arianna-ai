import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  AGENCY_CARD_MARK,
  AgentCardError,
  checkUserCeiling,
  checkUserPermissions,
  loadUserAgents,
  parseUserPermissions,
  userCard,
  userCardOrigin,
  userPresets,
  type AgentCard,
  type UserCardOrigin,
  type UserPermissions,
} from '@arianna/agents';

const base = mkdtempSync(join(tmpdir(), 'arianna-user-agents-'));
after(() => {
  rmSync(base, { recursive: true, force: true });
});

const answer: UserPermissions = { executor: 'local', tools: [], autonomy: 'A0', maxSteps: 10, maxMinutes: 10 };
const code: UserPermissions = { executor: 'claude', tools: ['repo.read', 'repo.write', 'repo.test'], autonomy: 'A1', maxSteps: 50, maxMinutes: 45 };
const input = { name: 'traduttore', description: 'Translates the release notes', prompt: 'You translate text into Italian.', permissions: answer };

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'prova',
    description: 'x',
    maxLabel: 'L1',
    executors: ['local'],
    tools: [],
    trifecta: { private_data: false, untrusted_content: true, external_comms: false },
    autonomy: 'A1',
    difficulty: 'normal',
    limits: { maxSteps: 1, maxMinutes: 1, maxCost: 0 },
    approvals: [],
    prompt: 'prova.md',
    ...over,
  };
}

describe('checkUserCeiling', () => {
  it('accepts a card at L1 and A1', () => {
    assert.doesNotThrow(() => {
      checkUserCeiling(card());
    });
  });
  it('refuses L2, autonomy above A1, approvals and delegation', () => {
    assert.throws(() => {
      checkUserCeiling(card({ maxLabel: 'L2', trifecta: { private_data: true, untrusted_content: false, external_comms: false } }));
    }, /above L1/);
    assert.throws(() => {
      checkUserCeiling(card({ autonomy: 'A2', autonomyDecision: 'D-040' }));
    }, /above A1/);
    assert.throws(() => {
      checkUserCeiling(card({ approvals: ['send_external'] }));
    }, /approvals/);
    assert.throws(() => {
      checkUserCeiling(card({ tools: ['task.delegate'] }));
    }, /task\.delegate/);
    assert.throws(() => {
      checkUserCeiling(card({ tools: ['channel.send'] }));
    }, /channel\.send/);
    assert.throws(() => {
      checkUserCeiling(card({ autonomyDecision: 'D-040' }));
    }, /autonomy_decision/);
  });
  it('accepts A0 and L0', () => {
    assert.doesNotThrow(() => {
      checkUserCeiling(card({ autonomy: 'A0', maxLabel: 'L0' }));
    });
  });
});

// D-119, tappa T3b: one rule per test, each with its positive and negative cases.
describe('checkUserPermissions', () => {
  const ok = (over: Partial<AgentCard>, origin: UserCardOrigin = 'page'): void => {
    assert.doesNotThrow(() => checkUserPermissions(card(over), origin));
  };
  const no = (over: Partial<AgentCard>, pattern: RegExp, origin: UserCardOrigin = 'page'): void => {
    assert.throws(() => checkUserPermissions(card(over), origin), pattern);
  };

  it('returns the permissions of a card within the list', () => {
    const permissions = checkUserPermissions(card({ executors: ['claude'], tools: ['repo.read'], autonomy: 'A0', limits: { maxSteps: 5, maxMinutes: 6, maxCost: 0 } }), 'page');
    assert.deepEqual(permissions, { executor: 'claude', tools: ['repo.read'], autonomy: 'A0', maxSteps: 5, maxMinutes: 6 });
  });
  it('keeps the ceiling', () => {
    ok({ maxLabel: 'L1', autonomy: 'A1' });
    no({ maxLabel: 'L2', trifecta: { private_data: true, untrusted_content: true, external_comms: false } }, /above L1/);
  });
  it('one executor, local or Claude', () => {
    ok({ executors: ['local'] });
    ok({ executors: ['claude'] });
    no({ executors: ['local', 'claude'] }, /executors must be one of local, claude/);
    no({ executors: ['codex'] }, /executors must be one of/);
    no({ executors: [] }, /executors must be one of/);
    // The template `code` of tappa T2 had three executors: such a card is no longer within the list.
    no({ executors: ['local', 'claude', 'codex'], tools: ['repo.read'] }, /executors/);
  });
  it('tools of the list for the executor', () => {
    ok({ executors: ['claude'], tools: ['repo.read', 'repo.write', 'repo.test'] });
    no({ executors: ['local'], tools: ['repo.read'] }, /local agent only answers/);
    no({ executors: ['claude'], tools: ['kb.search'] }, /kb\.search not allowed/);
    no({ executors: ['claude'], tools: ['user.ask'] }, /user\.ask not allowed/);
  });
  it('no acting tool with A0', () => {
    ok({ executors: ['claude'], tools: ['repo.read'], autonomy: 'A0' });
    no({ executors: ['claude'], tools: ['repo.read', 'repo.write'], autonomy: 'A0' }, /repo\.write act/);
    no({ executors: ['claude'], tools: ['repo.test'], autonomy: 'A0' }, /repo\.test act/);
  });
  it('the computed trifecta', () => {
    ok({ trifecta: { private_data: false, untrusted_content: true, external_comms: false } });
    no({ trifecta: { private_data: false, untrusted_content: false, external_comms: false } }, /trifecta/);
    no({ trifecta: { private_data: false, untrusted_content: true, external_comms: true } }, /trifecta/);
  });
  it('no cloud_max_label', () => {
    ok({ executors: ['claude'] });
    no({ executors: ['claude'], cloudMaxLabel: 'L0' }, /cloud_max_label/);
  });
  it('labels of a page card: L0 or L1, prompt L1', () => {
    ok({ maxLabel: 'L1', promptLabel: 'L1' });
    // A card of tappa T2 kept the template's L0, without prompt_label.
    ok({ maxLabel: 'L0' });
    no({ promptLabel: 'L0' }, /prompt of a user's card is L1/);
  });
  it('labels of an agency card: L0, prompt L0', () => {
    ok({ maxLabel: 'L0', promptLabel: 'L0' }, 'agency');
    no({ maxLabel: 'L1', promptLabel: 'L0' }, /stays at L0/, 'agency');
    no({ maxLabel: 'L0' }, /prompt_label L0/, 'agency');
  });
  it('difficulty normal and cost 0', () => {
    ok({ difficulty: 'normal', limits: { maxSteps: 1, maxMinutes: 1, maxCost: 0 } });
    no({ difficulty: 'hard' }, /difficulty/);
    no({ limits: { maxSteps: 1, maxMinutes: 1, maxCost: 1 } }, /max_cost/);
  });
  it('limits under the ceiling', () => {
    ok({ limits: { maxSteps: 50, maxMinutes: 45, maxCost: 0 } });
    no({ limits: { maxSteps: 51, maxMinutes: 45, maxCost: 0 } }, /max_steps 51/);
    no({ limits: { maxSteps: 50, maxMinutes: 46, maxCost: 0 } }, /max_minutes 46/);
  });
});

describe('parseUserPermissions', () => {
  it('accepts a choice and keeps the tools in the order of the list', () => {
    assert.deepEqual(parseUserPermissions({ ...code, tools: ['repo.test', 'repo.read'] }), { ...code, tools: ['repo.read', 'repo.test'] });
    assert.deepEqual(parseUserPermissions(answer), answer);
  });
  it('refuses a shape that is not exactly the five fields', () => {
    assert.throws(() => parseUserPermissions(null), /expected an object/);
    assert.throws(() => parseUserPermissions([]), /expected an object/);
    assert.throws(() => parseUserPermissions({ ...answer, maxLabel: 'L2' }), /unknown field\(s\) maxLabel/);
    assert.throws(() => parseUserPermissions({ ...answer, tools: 'repo.read' }), /tools must be a list/);
  });
  it('refuses executors, autonomy and tools outside the list', () => {
    assert.throws(() => parseUserPermissions({ ...answer, executor: 'codex' }), /executor must be one of local, claude/);
    assert.throws(() => parseUserPermissions({ ...answer, autonomy: 'A2' }), /autonomy must be A0 or A1/);
    assert.throws(() => parseUserPermissions({ ...answer, tools: ['shell'] }), /not in the registry/);
    assert.throws(() => parseUserPermissions({ ...code, tools: ['repo.read', 'repo.read'] }), /listed twice/);
    assert.throws(() => parseUserPermissions({ ...code, tools: ['channel.send'] }), /channel\.send not allowed/);
    assert.throws(() => parseUserPermissions({ ...answer, tools: ['repo.read'] }), /local agent only answers/);
    assert.throws(() => parseUserPermissions({ ...code, autonomy: 'A0' }), /act: not allowed with A0/);
  });
  it('refuses limits that are not whole numbers from 1 to the ceiling', () => {
    assert.throws(() => parseUserPermissions({ ...answer, maxSteps: 0 }), /maxSteps must be a whole number from 1 to 50/);
    assert.throws(() => parseUserPermissions({ ...answer, maxSteps: 51 }), /maxSteps/);
    assert.throws(() => parseUserPermissions({ ...answer, maxMinutes: 1.5 }), /maxMinutes/);
    assert.throws(() => parseUserPermissions({ ...answer, maxMinutes: 46 }), /maxMinutes must be a whole number from 1 to 45/);
    assert.throws(() => parseUserPermissions({ ...answer, maxMinutes: '10' }), /maxMinutes/);
  });
});

describe('userPresets and userCardOrigin', () => {
  it('tells an agency card by any line of its provenance, also after a BOM or without the first line', () => {
    assert.equal(userCardOrigin(`${AGENCY_CARD_MARK}: proposed.\nname: x\n`), 'agency');
    assert.equal(userCardOrigin(`\uFEFF${AGENCY_CARD_MARK}: proposed.\nname: x\n`), 'agency');
    assert.equal(userCardOrigin('# Source: https://github.com/msitarzewski/agency-agents, commit abc\nname: x\n'), 'agency');
    assert.equal(userCardOrigin('# Created from the Agents page (D-119).\nname: x\n'), 'page');
    // Below the comments, the text is the card's, not its provenance.
    assert.equal(userCardOrigin('name: x\ndescription: pnpm agency:import\n'), 'page');
  });
  it('offers the templates that fit the list: code and answer, not web', () => {
    assert.deepEqual(userPresets(), [
      { id: 'code', permissions: code },
      { id: 'answer', permissions: answer },
    ]);
  });
});

describe('userCard', () => {
  it('writes the chosen permissions with the computed labels and trifecta', () => {
    const files = userCard({ ...input, permissions: code });
    const dir = mkdtempSync(join(base, 'code-'));
    writeFileSync(join(dir, 'traduttore.yaml'), files.yaml);
    writeFileSync(join(dir, 'traduttore.md'), files.md);
    const loaded = loadUserAgents(dir, new Set()).agents.get('traduttore');
    assert.ok(loaded !== undefined);
    const parsed = loaded.card;
    assert.equal(parsed.maxLabel, 'L1');
    assert.equal(parsed.promptLabel, 'L1');
    assert.deepEqual(parsed.executors, ['claude']);
    assert.deepEqual(parsed.tools, ['repo.read', 'repo.write', 'repo.test']);
    assert.deepEqual(parsed.trifecta, { private_data: false, untrusted_content: true, external_comms: false });
    assert.equal(parsed.autonomy, 'A1');
    assert.deepEqual(parsed.limits, { maxSteps: 50, maxMinutes: 45, maxCost: 0 });
    assert.equal(loaded.origin, 'user');
    assert.equal(files.md, 'You translate text into Italian.\n');
    assert.equal(userCardOrigin(files.yaml), 'page');
  });
  it('keeps an agency card at L0 with its provenance, and refuses one without it', () => {
    const header = `${AGENCY_CARD_MARK}: not active until the user approves it.\n# Source: somewhere`;
    const files = userCard(input, { origin: 'agency', header: `${header}\nname: x\n` });
    assert.ok(files.yaml.startsWith(header));
    assert.equal(userCardOrigin(files.yaml), 'agency');
    assert.match(files.yaml, /max_label: L0/);
    assert.match(files.yaml, /prompt_label: L0/);
    assert.throws(() => userCard(input, { origin: 'agency', header: '# Written by hand\n' }), /keeps its provenance/);
  });
  it('refuses a bad name, bad permissions, an empty prompt and a multi-line description', () => {
    assert.throws(() => userCard({ ...input, name: 'Coder' }), AgentCardError);
    assert.throws(() => userCard({ ...input, name: 'a/b' }), AgentCardError);
    assert.throws(() => userCard({ ...input, permissions: undefined }), /permissions: expected an object/);
    assert.throws(() => userCard({ ...input, permissions: { ...answer, executor: 'codex' } }), /executor/);
    assert.throws(() => userCard({ ...input, prompt: '   ' }), /prompt is empty/);
    assert.throws(() => userCard({ ...input, description: 'a\nb' }), /one line/);
    assert.throws(() => userCard({ ...input, prompt: 'x'.repeat(4001) }), /longer/);
  });
});

describe('loadUserAgents', () => {
  it('loads good cards and refuses the others one by one', () => {
    const dir = join(base, 'attivi');
    mkdirSync(dir);
    const good = userCard(input);
    writeFileSync(join(dir, 'traduttore.yaml'), good.yaml);
    writeFileSync(join(dir, 'traduttore.md'), good.md);
    // Edited by hand above the ceiling.
    const raised = userCard({ ...input, name: 'alzato' })
      .yaml.replace('max_label: L1', 'max_label: L2')
      .replace('private_data: false', 'private_data: true')
      .replace('untrusted_content: true', 'untrusted_content: false');
    writeFileSync(join(dir, 'alzato.yaml'), raised);
    writeFileSync(join(dir, 'alzato.md'), 'x');
    // The name of an official agent.
    writeFileSync(join(dir, 'coder.yaml'), userCard({ ...input, name: 'coder' }).yaml);
    writeFileSync(join(dir, 'coder.md'), 'x');
    // Half moved: the prompt is missing.
    writeFileSync(join(dir, 'mezzo.yaml'), userCard({ ...input, name: 'mezzo' }).yaml);
    writeFileSync(join(dir, 'note.txt'), 'ignored');
    // Edited by hand beyond the list: a tool the local model does not run.
    writeFileSync(join(dir, 'oltre.yaml'), userCard({ ...input, name: 'oltre' }).yaml.replace('tools: []', 'tools:\n  - kb.search'));
    writeFileSync(join(dir, 'oltre.md'), 'x');
    // An agency card raised to L1 by hand: its first line says where it comes from.
    const agency = userCard({ ...input, name: 'terzi' }, { origin: 'agency', header: `${AGENCY_CARD_MARK}: proposed.` });
    writeFileSync(join(dir, 'terzi.yaml'), agency.yaml.replace('max_label: L0', 'max_label: L1'));
    writeFileSync(join(dir, 'terzi.md'), 'x');

    const { agents, refused } = loadUserAgents(dir, new Set(['coder', 'arianna']));
    assert.deepEqual([...agents.keys()], ['traduttore']);
    assert.deepEqual(
      refused.map(({ name }) => name),
      ['alzato', 'coder', 'mezzo', 'oltre', 'terzi'],
    );
    assert.match(refused[0]?.reason ?? '', /above L1/);
    assert.match(refused[3]?.reason ?? '', /kb\.search not allowed/);
    assert.match(refused[4]?.reason ?? '', /stays at L0/);
  });
  it('a missing folder is no agents', () => {
    assert.deepEqual(loadUserAgents(join(base, 'nessuna'), new Set()), { agents: new Map(), refused: [] });
  });
});
