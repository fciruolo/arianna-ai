import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentCardError, labelCeiling, parseAgentCard, promptLabelOf, TOOLS } from '@arianna/agents';

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

    it('im.add (D-167): local only, no approval to list', () => {
      assert.deepEqual(parseAgentCard(card((c) => (c.tools = ['im.add'])), 'archivista').tools, ['im.add']);
      rejects(
        card((c) => {
          c.tools = ['im.add'];
          c.executors = ['local', 'claude'];
          c.cloud_max_label = 'L1';
        }),
        /im\.add reads private data/,
      );
    });

    it('the commitments of the secretary (D-144): only on a card that reads L2 and runs on the local model alone', () => {
      const tools = ['commitment.add', 'commitment.list', 'commitment.done', 'commitment.move', 'commitment.report'];
      assert.deepEqual(parseAgentCard(card((c) => (c.tools = tools)), 'archivista').tools, tools);
      for (const tool of tools) {
        rejects(
          card((c) => {
            c.tools = [tool];
            c.executors = ['local', 'claude'];
            c.cloud_max_label = 'L1';
          }),
          new RegExp(`${tool.replace('.', '\\.')} reads private data`),
        );
        rejects(
          card((c) => {
            c.tools = [tool];
            c.max_label = 'L1';
            c.trifecta = { private_data: false, untrusted_content: false, external_comms: false };
          }),
          /reads private data/,
        );
      }
    });

    it('the finance tools (D-183): local alone at L2, and nothing that hands their data on', () => {
      const tools = ['finance.summary', 'finance.search', 'finance.alerts', 'user.ask'];
      assert.deepEqual(parseAgentCard(card((c) => (c.tools = tools)), 'archivista').tools, tools);
      rejects(
        card((c) => {
          c.tools = ['finance.summary'];
          c.executors = ['local', 'claude'];
          c.cloud_max_label = 'L1';
        }),
        /finance\.summary reads private data/,
      );
      rejects(
        card((c) => {
          c.tools = ['finance.search'];
          c.max_label = 'L1';
          c.trifecta = { private_data: false, untrusted_content: false, external_comms: false };
        }),
        /reads private data/,
      );
      rejects(card((c) => (c.tools = ['finance.alerts', 'task.delegate'])), /may not list task\.delegate/);
      rejects(card((c) => (c.tools = ['finance.summary', 'task.plan'])), /may not list task\.plan/);
      // Only finance.* and user.ask: a tool that opens nothing is refused too.
      rejects(card((c) => (c.tools = ['finance.summary', 'kb.read'])), /may not list kb\.read: only finance\.\* and user\.ask/);
      rejects(card((c) => (c.tools = ['finance.search', 'user.ask', 'kb.write'])), /may not list kb\.write/);
      assert.deepEqual(parseAgentCard(card((c) => (c.tools = ['finance.alerts'])), 'archivista').tools, ['finance.alerts']);
    });

    it('web.fetch (D-262): offered only where private data is closed, so a card reading L2 may list it', () => {
      const raw = card((c) => {
        c.tools = ['kb.read', 'web.fetch'];
        c.trifecta = { private_data: true, untrusted_content: true, external_comms: false };
      });
      assert.deepEqual(parseAgentCard(raw, 'archivista').tools, ['kb.read', 'web.fetch']);
      assert.equal(TOOLS['web.fetch'].withoutPrivateData, true);
      // web.search has no such guarantee: still refused.
      rejects(card((c) => {
        c.tools = ['kb.read', 'web.search'];
        c.trifecta = { private_data: true, untrusted_content: true, external_comms: false };
      }), /web.search opens external_comms/);
      // Only on a card that runs on the local model alone: a cloud executor is not the core's orchestrator.
      rejects(card((c) => {
        c.tools = ['web.fetch'];
        c.max_label = 'L1';
        c.executors = ['local', 'claude'];
        c.trifecta = { private_data: true, untrusted_content: true, external_comms: false };
      }), /web.fetch opens external_comms/);
      rejects(card((c) => {
        c.tools = ['kb.read', 'web.fetch'];
        c.executors = ['local', 'codex'];
        c.cloud_max_label = 'L1';
        c.trifecta = { private_data: true, untrusted_content: true, external_comms: false };
      }), /web.fetch opens external_comms/);
      // With the side declared open, a cloud card may list it as before.
      assert.deepEqual(
        parseAgentCard(card((c) => {
          c.tools = ['web.fetch'];
          c.max_label = 'L1';
          c.executors = ['claude'];
          c.trifecta = { private_data: false, untrusted_content: true, external_comms: true };
        }), 'archivista').tools,
        ['web.fetch'],
      );
      // What it reads stays in the history: untrusted content must be declared.
      rejects(card((c) => (c.tools = ['kb.read', 'web.fetch'])), /web.fetch opens untrusted_content/);
      // Not on a card of the finances.
      rejects(card((c) => {
        c.tools = ['finance.summary', 'web.fetch'];
        c.trifecta = { private_data: true, untrusted_content: true, external_comms: false };
      }), /may not list web\.fetch/);
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

  describe('cloud_tools (D-261)', () => {
    const cloud = (c: Record<string, unknown>): void => {
      c.executors = ['claude', 'local'];
      c.cloud_max_label = 'L1';
    };

    it('accepts kb.search and kb.read on a card with claude, apart from tools', () => {
      const parsed = parseAgentCard(card((c) => ((c.tools = ['repo.read']), cloud(c), (c.cloud_tools = ['kb.search', 'kb.read']))), 'archivista');
      assert.deepEqual(parsed.cloudTools, ['kb.search', 'kb.read']);
      assert.deepEqual(parsed.tools, ['repo.read']);
    });

    it('accepts web.fetch (D-262) in cloud_tools, never web.search', () => {
      assert.deepEqual(parseAgentCard(card((c) => (cloud(c), (c.cloud_tools = ['kb.read', 'web.fetch']))), 'archivista').cloudTools, ['kb.read', 'web.fetch']);
      rejects(card((c) => (cloud(c), (c.cloud_tools = ['web.search']))), /cloud_tools: "web\.search" is not one of kb\.search, kb\.read, web\.fetch/);
      rejects(card((c) => ((c.executors = ['codex', 'local']), (c.cloud_max_label = 'L1'), (c.cloud_tools = ['web.fetch']))), /without the claude executor/);
    });

    it('is absent when the card does not say it', () => {
      assert.equal(parseAgentCard(card(cloud), 'archivista').cloudTools, undefined);
    });

    it('rejects a tool outside CLOUD_TOOLS, one listed twice, or not a list', () => {
      rejects(card((c) => (cloud(c), (c.cloud_tools = ['kb.write']))), /cloud_tools: "kb\.write" is not one of/);
      rejects(card((c) => (cloud(c), (c.cloud_tools = ['repo.read']))), /cloud_tools/);
      rejects(card((c) => (cloud(c), (c.cloud_tools = ['kb.read', 'kb.read']))), /twice/);
      rejects(card((c) => (cloud(c), (c.cloud_tools = 'kb.read'))), /cloud_tools: expected a list/);
    });

    it('rejects cloud_tools without the claude executor', () => {
      rejects(card((c) => (c.cloud_tools = ['kb.read'])), /without the claude executor/);
      rejects(card((c) => ((c.executors = ['codex', 'local']), (c.cloud_max_label = 'L1'), (c.cloud_tools = ['kb.read']))), /without the claude executor/);
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

  // D-119, tappa T3b: the label of the prompt of a promoted user's card.
  describe('prompt_label', () => {
    it('accepts L0 and L1 within max_label', () => {
      assert.equal(parseAgentCard(card((c) => (c.prompt_label = 'L1')), 'archivista').promptLabel, 'L1');
      assert.equal(parseAgentCard(card((c) => (c.prompt_label = 'L0')), 'archivista').promptLabel, 'L0');
      assert.equal(parseAgentCard(base(), 'archivista').promptLabel, undefined);
    });
    it('refuses L2 and above, a label above max_label and an unknown value', () => {
      rejects(card((c) => (c.prompt_label = 'L2')), /prompt_label must be L0 or L1/);
      rejects(
        card((c) => {
          c.max_label = 'L0';
          c.trifecta = { private_data: false, untrusted_content: false, external_comms: false };
          c.tools = [];
          c.approvals = [];
          c.prompt_label = 'L1';
        }),
        /prompt_label L1 is above max_label L0/,
      );
      rejects(card((c) => (c.prompt_label = 'public')), /prompt_label/);
    });
  });

  // D-159: the user chooses where each card of the agent runs.
  describe('executor_choice', () => {
    const cloud = (c: Record<string, unknown>) => {
      c.executors = ['claude', 'codex', 'local'];
      c.cloud_max_label = 'L1';
    };
    it('accepts ask on a card with several executors', () => {
      assert.equal(parseAgentCard(card((c) => {
        cloud(c);
        c.executor_choice = 'ask';
      }), 'archivista').executorChoice, 'ask');
      assert.equal(parseAgentCard(card(cloud), 'archivista').executorChoice, undefined);
    });
    it('refuses another value, and ask with nothing to choose from', () => {
      rejects(card((c) => {
        cloud(c);
        c.executor_choice = 'always';
      }), /executor_choice: expected one of ask/);
      rejects(card((c) => (c.executor_choice = 'ask')), /executor_choice ask needs at least two executors/);
    });
    // D-298: the first executor without asking, the choice only when it cannot take the card.
    it('accepts prefer-first on a card with several executors', () => {
      assert.equal(parseAgentCard(card((c) => {
        cloud(c);
        c.executor_choice = 'prefer-first';
      }), 'archivista').executorChoice, 'prefer-first');
    });
    it('refuses prefer-first with nothing to fall back on', () => {
      rejects(card((c) => (c.executor_choice = 'prefer-first')), /executor_choice prefer-first needs at least two executors/);
    });
  });
});

describe('promptLabelOf', () => {
  const parsed = (label?: string) => parseAgentCard(card((c) => (label === undefined ? undefined : (c.prompt_label = label))), 'archivista');
  it('reads L0 for a card of agents/ without prompt_label, L1 for a user card', () => {
    assert.equal(promptLabelOf({ card: parsed(), prompt: 'x' }), 'L0');
    assert.equal(promptLabelOf({ card: parsed(), prompt: 'x', origin: 'user' }), 'L1');
  });
  it('reads the card when it says the label, also for a user card', () => {
    assert.equal(promptLabelOf({ card: parsed('L1'), prompt: 'x' }), 'L1');
    // A third-party prompt among the user's cards stays L0.
    assert.equal(promptLabelOf({ card: parsed('L0'), prompt: 'x', origin: 'user' }), 'L0');
  });
});
