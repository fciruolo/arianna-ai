import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AgentCardError, CARD_TEMPLATES, checkUserCeiling, loadUserAgents, matchingTemplate, userCard, userLabelOf, type AgentCard } from '@arianna/agents';

const base = mkdtempSync(join(tmpdir(), 'arianna-user-agents-'));
after(() => {
  rmSync(base, { recursive: true, force: true });
});

const input = { name: 'traduttore', description: 'Translates the release notes', template: 'answer', prompt: 'You translate text into Italian.' };

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

describe('matchingTemplate', () => {
  it('finds the template of a card and none for a card changed beyond it', () => {
    assert.equal(matchingTemplate(card({ maxLabel: 'L0', autonomy: 'A0' }))?.id, 'answer');
    // A user's answering card reads up to L1 (tappa T3); a web card never rises.
    assert.equal(matchingTemplate(card({ maxLabel: 'L1', autonomy: 'A0' }))?.id, 'answer');
    assert.equal(matchingTemplate(card({ maxLabel: 'L2', autonomy: 'A0' })), undefined);
    const label = Object.fromEntries(CARD_TEMPLATES.map((template) => [template.id, userLabelOf(template)]));
    assert.deepEqual(label, { code: 'L1', web: 'L0', answer: 'L1' });
    assert.equal(matchingTemplate(card({ maxLabel: 'L0', autonomy: 'A0', tools: ['kb.search'] })), undefined);
    assert.equal(matchingTemplate(card({ maxLabel: 'L0', autonomy: 'A0', executors: ['local', 'claude'] })), undefined);
    assert.equal(matchingTemplate(card({ maxLabel: 'L0', autonomy: 'A1' })), undefined);
    assert.equal(matchingTemplate(card({ maxLabel: 'L0', autonomy: 'A0', limits: { maxSteps: 11, maxMinutes: 1, maxCost: 0 } })), undefined);
  });
});

describe('userCard', () => {
  it('takes tools, labels and autonomy from the template only', () => {
    const files = userCard({ ...input, template: 'code' });
    const dir = mkdtempSync(join(base, 'code-'));
    writeFileSync(join(dir, 'traduttore.yaml'), files.yaml);
    writeFileSync(join(dir, 'traduttore.md'), files.md);
    const parsed = loadUserAgents(dir, new Set()).agents.get('traduttore')?.card;
    assert.ok(parsed !== undefined);
    assert.equal(parsed.maxLabel, 'L1');
    assert.deepEqual(parsed.tools, ['repo.read', 'repo.write', 'repo.test', 'task.update', 'user.ask']);
    assert.equal(parsed.autonomy, 'A1');
    assert.equal(files.md, 'You translate text into Italian.\n');
  });
  it('refuses a bad name, an unknown template, an empty prompt and a multi-line description', () => {
    assert.throws(() => userCard({ ...input, name: 'Coder' }), AgentCardError);
    assert.throws(() => userCard({ ...input, name: '../x' }), AgentCardError);
    assert.throws(() => userCard({ ...input, template: 'admin' }), /unknown template/);
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
    const raised = userCard({ ...input, name: 'alzato' }).yaml.replace('max_label: L1', 'max_label: L2').replace('private_data: false', 'private_data: true').replace('untrusted_content: true', 'untrusted_content: false');
    writeFileSync(join(dir, 'alzato.yaml'), raised);
    writeFileSync(join(dir, 'alzato.md'), 'x');
    // The name of an official agent.
    writeFileSync(join(dir, 'coder.yaml'), userCard({ ...input, name: 'coder' }).yaml);
    writeFileSync(join(dir, 'coder.md'), 'x');
    // Half moved: the prompt is missing.
    writeFileSync(join(dir, 'mezzo.yaml'), userCard({ ...input, name: 'mezzo' }).yaml);
    writeFileSync(join(dir, 'note.txt'), 'ignored');

    const { agents, refused } = loadUserAgents(dir, new Set(['coder', 'arianna']));
    assert.deepEqual([...agents.keys()], ['traduttore']);
    assert.deepEqual(
      refused.map(({ name }) => name),
      ['alzato', 'coder', 'mezzo'],
    );
    assert.match(refused[0]?.reason ?? '', /above L1/);
  });
  it('a missing folder is no agents', () => {
    assert.deepEqual(loadUserAgents(join(base, 'nessuna'), new Set()), { agents: new Map(), refused: [] });
  });
});
