import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentCardError, labelCeiling, parseAgentCard, TOOLS } from '@arianna/agents';

/** A valid card; each test changes one thing. */
function base(): Record<string, unknown> {
  return {
    name: 'archivista',
    description: 'Classifies and files documents',
    max_label: 'L2',
    executors: ['local'],
    tools: ['kb.read', 'kb.write'],
    trifecta: { private_data: true, untrusted_content: false, external_comms: false },
    autonomy: 'A1',
    difficulty: 'normal',
    limits: { max_steps: 30, max_minutes: 20, max_cost: 0 },
    approvals: ['delete'],
    prompt: 'archivista.md',
  };
}

function card(change: (card: Record<string, unknown>) => void): Record<string, unknown> {
  const value = base();
  change(value);
  return value;
}

function rejects(raw: unknown, pattern: RegExp): void {
  assert.throws(() => parseAgentCard(raw, 'archivista'), (error: unknown) => {
    assert.ok(error instanceof AgentCardError, String(error));
    assert.match(error.message, pattern);
    return true;
  });
}

describe('parseAgentCard', () => {
  it('accepts a valid card', () => {
    assert.deepEqual(parseAgentCard(base(), 'archivista'), {
      name: 'archivista',
      description: 'Classifies and files documents',
      maxLabel: 'L2',
      executors: ['local'],
      tools: ['kb.read', 'kb.write'],
      trifecta: { private_data: true, untrusted_content: false, external_comms: false },
      autonomy: 'A1',
      difficulty: 'normal',
      limits: { maxSteps: 30, maxMinutes: 20, maxCost: 0 },
      approvals: ['delete'],
      prompt: 'archivista.md',
    });
  });

  describe('trifecta', () => {
    it('rejects a card with all three sides', () => {
      rejects(card((c) => (c.trifecta = { private_data: true, untrusted_content: true, external_comms: true })), /lethal trifecta/);
    });

    it('accepts any one side removed', () => {
      for (const removed of ['private_data', 'untrusted_content', 'external_comms']) {
        const trifecta = { private_data: true, untrusted_content: true, external_comms: true, [removed]: false };
        const raw = card((c) => {
          c.trifecta = trifecta;
          if (removed === 'private_data') c.max_label = 'L1';
        });
        assert.equal(parseAgentCard(raw, 'archivista').trifecta[removed as 'private_data'], false);
      }
    });

    it('rejects a missing, non-boolean or unknown side', () => {
      rejects(card((c) => (c.trifecta = { private_data: true, untrusted_content: false })), /external_comms/);
      rejects(card((c) => (c.trifecta = { private_data: true, untrusted_content: 'no', external_comms: false })), /untrusted_content/);
      rejects(card((c) => (c.trifecta = { ...(c.trifecta as object), lethal: false })), /unknown key/);
    });

    it('rejects private data declared removed with an L2 clearance', () => {
      rejects(card((c) => (c.trifecta = { private_data: false, untrusted_content: true, external_comms: false })), /private_data must be true/);
    });

    it('accepts private data removed with an L1 clearance', () => {
      const raw = card((c) => {
        c.max_label = 'L1';
        c.trifecta = { private_data: false, untrusted_content: true, external_comms: true };
        c.tools = ['web.search', 'web.fetch'];
      });
      assert.equal(parseAgentCard(raw, 'archivista').maxLabel, 'L1');
    });

    it('rejects a tool that opens a side declared removed', () => {
      rejects(card((c) => (c.tools = ['kb.read', 'web.search'])), /web.search opens untrusted_content/);
      rejects(
        card((c) => {
          c.tools = ['channel.send'];
          c.approvals = ['send_external'];
          c.trifecta = { private_data: true, untrusted_content: true, external_comms: false };
        }),
        /channel.send opens external_comms/,
      );
    });
  });

  describe('labels and executors', () => {
    it('rejects L3', () => {
      rejects(card((c) => (c.max_label = 'L3')), /L3 does not exist/);
    });

    it('rejects a cloud executor with an L2 clearance and no cloud ceiling', () => {
      rejects(card((c) => (c.executors = ['local', 'claude'])), /needs cloud_max_label/);
    });

    it('accepts a cloud executor with an L2 clearance and cloud_max_label L1, like the Coder', () => {
      const parsed = parseAgentCard(
        card((c) => {
          c.executors = ['claude', 'local'];
          c.cloud_max_label = 'L1';
        }),
        'archivista',
      );
      assert.equal(labelCeiling(parsed, 'claude'), 'L1');
      assert.equal(labelCeiling(parsed, 'local'), 'L2');
      assert.throws(() => labelCeiling(parsed, 'codex'), AgentCardError);
    });

    it('accepts a cloud executor with an L1 clearance without cloud_max_label', () => {
      const parsed = parseAgentCard(card((c) => ((c.max_label = 'L1'), (c.executors = ['codex']))), 'archivista');
      assert.equal(labelCeiling(parsed, 'codex'), 'L1');
    });

    it('rejects a cloud ceiling above L1, above max_label, or without a cloud executor', () => {
      rejects(card((c) => ((c.executors = ['claude']), (c.cloud_max_label = 'L2'))), /at most L1/);
      rejects(card((c) => ((c.max_label = 'L0'), (c.executors = ['claude']), (c.cloud_max_label = 'L1'))), /exceed max_label/);
      rejects(card((c) => (c.cloud_max_label = 'L1')), /without a cloud executor/);
    });

    it('rejects unknown, duplicate or no executors', () => {
      rejects(card((c) => (c.executors = ['gemini'])), /executors/);
      rejects(card((c) => (c.executors = ['local', 'local'])), /twice/);
      rejects(card((c) => (c.executors = [])), /must not be empty/);
    });
  });

  describe('cloud', () => {
    it('never lets a cloud executor see above L1, whatever the declared trifecta', () => {
      for (const executor of ['claude', 'codex'] as const) {
        for (const maxLabel of ['L0', 'L1', 'L2'] as const) {
          for (const cloud of [undefined, 'L0', 'L1', 'L2'] as const) {
            const raw = card((c) => {
              c.executors = ['local', executor];
              c.max_label = maxLabel;
              if (cloud !== undefined) c.cloud_max_label = cloud;
              if (maxLabel !== 'L2') c.trifecta = { private_data: false, untrusted_content: false, external_comms: false };
            });
            let parsed;
            try {
              parsed = parseAgentCard(raw, 'archivista');
            } catch {
              continue;
            }
            assert.ok(['L0', 'L1'].includes(labelCeiling(parsed, executor)), `${maxLabel}/${String(cloud)}`);
          }
        }
      }
    });
  });

  describe('own properties only', () => {
    it('ignores values inherited from a polluted prototype', () => {
      const raw = card((c) => {
        c.executors = ['local', 'claude'];
        delete c.trifecta;
      });
      const proto = { cloud_max_label: 'L1', trifecta: { private_data: true, untrusted_content: false, external_comms: false } };
      // The inherited cloud_max_label is not seen: the card fails on the missing ceiling.
      rejects(Object.assign(Object.create(proto) as object, raw), /needs cloud_max_label/);
      const trifecta = Object.assign(Object.create({ external_comms: false }) as object, { private_data: true, untrusted_content: true });
      rejects(card((c) => (c.trifecta = trifecta)), /external_comms/);
    });
  });

  describe('tools and approvals', () => {
    it('rejects a tool outside the registry', () => {
      rejects(card((c) => (c.tools = ['kb.read', 'shell.exec'])), /not in the registry/);
      rejects(card((c) => (c.tools = ['toString'])), /not in the registry/);
    });

    it('rejects a duplicate tool', () => {
      rejects(card((c) => (c.tools = ['kb.read', 'kb.read'])), /twice/);
    });

    it('requires the approvals the tools need', () => {
      rejects(card((c) => ((c.tools = ['file.delete']), (c.approvals = []))), /needs approval "delete"/);
      assert.deepEqual(parseAgentCard(card((c) => (c.tools = ['file.delete'])), 'archivista').tools, ['file.delete']);
    });

    it('rejects an unknown approval', () => {
      rejects(card((c) => (c.approvals = ['everything'])), /approvals/);
    });

    it('has a registry where every approval a tool needs is a known action', () => {
      for (const [id, spec] of Object.entries(TOOLS)) {
        if ('approval' in spec) assert.ok(['delete', 'send_external', 'payment', 'call'].includes(spec.approval), id);
      }
    });
  });

  describe('autonomy', () => {
    it('accepts A0 and A1 without a decision', () => {
      assert.equal(parseAgentCard(card((c) => (c.autonomy = 'A0')), 'archivista').autonomy, 'A0');
    });

    it('rejects A2 and A3 without the decision that granted them', () => {
      rejects(card((c) => (c.autonomy = 'A2')), /needs autonomy_decision/);
      rejects(card((c) => (c.autonomy = 'A3')), /needs autonomy_decision/);
    });

    it('accepts A2 with a decision id, rejects a malformed one', () => {
      const parsed = parseAgentCard(card((c) => ((c.autonomy = 'A2'), (c.autonomy_decision = 'D-040'))), 'archivista');
      assert.equal(parsed.autonomyDecision, 'D-040');
      rejects(card((c) => ((c.autonomy = 'A2'), (c.autonomy_decision = 'yes'))), /decision id/);
    });
  });

  describe('shape', () => {
    it('rejects unknown keys', () => {
      rejects(card((c) => (c.model = 'opus')), /unknown key/);
      rejects(card((c) => (c.limits = { max_steps: 1, max_minutes: 1, max_cost: 0, max_tokens: 9 })), /unknown key/);
    });

    it('rejects a name that differs from the file', () => {
      rejects(card((c) => (c.name = 'other')), /name must be "archivista"/);
    });

    it('rejects a prompt that is not <name>.md', () => {
      rejects(card((c) => (c.prompt = '../secrets.md')), /prompt must be/);
    });

    it('rejects out-of-range limits', () => {
      rejects(card((c) => (c.limits = { max_steps: 0, max_minutes: 20, max_cost: 0 })), /max_steps/);
      rejects(card((c) => (c.limits = { max_steps: 30, max_minutes: 1.5, max_cost: 0 })), /max_minutes/);
      rejects(card((c) => (c.limits = { max_steps: 30, max_minutes: 20, max_cost: -1 })), /max_cost/);
    });

    it('rejects an unknown difficulty or autonomy, and a card that is not a mapping', () => {
      rejects(card((c) => (c.difficulty = 'easy')), /difficulty/);
      rejects(card((c) => (c.autonomy = 'A4')), /autonomy/);
      rejects(['name'], /mapping/);
      rejects(null, /mapping/);
    });
  });
});
