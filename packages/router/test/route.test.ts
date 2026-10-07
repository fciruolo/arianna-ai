import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createContext, recordRead, type Context, type Label } from '@arianna/policy';

import {
  createRouterConfig,
  needsBudgetApproval,
  route,
  usesOf,
  type Budget,
  type Candidate,
  type RouteDecision,
  type RouterAgent,
  type Step,
} from '../src/index.ts';

const ALL: Candidate[] = [
  { executor: 'local', model: 'local-small', locality: 'local' },
  { executor: 'local', model: 'local-large', locality: 'local' },
  { executor: 'claude', model: 'sonnet', locality: 'cloud' },
  { executor: 'claude', model: 'opus', locality: 'cloud' },
  { executor: 'claude', model: 'fable', locality: 'cloud' },
  { executor: 'codex', model: 'luna', locality: 'cloud' },
  { executor: 'codex', model: 'sol', locality: 'cloud' },
  { executor: 'codex', model: 'astra', locality: 'cloud' },
];
const CONFIG = createRouterConfig(ALL);
const FREE: Budget = { blocked: [] };

const CODER: RouterAgent = {
  name: 'coder',
  executors: ['claude', 'codex', 'local'],
  maxLabel: 'L2',
  cloudMaxLabel: 'L1',
  difficulty: 'normal',
};
const ARIANNA: RouterAgent = { name: 'arianna', executors: ['local'], maxLabel: 'L2', difficulty: 'normal' };

function ctx(effective: Label, clearance: Label = 'L2'): Context {
  return createContext(clearance, effective);
}

function coding(extra: Partial<Step> = {}): Step {
  return { kind: 'coding', agent: CODER, ...extra };
}

function pick(decision: RouteDecision): string {
  return decision.decision === 'route' ? `${decision.executor}/${decision.model}` : `wait:${decision.next}`;
}

describe('privacy filter', () => {
  it('L1 coding goes to the cloud', () => {
    const decision = route(coding(), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'claude/sonnet');
    assert.equal(decision.decision === 'route' && decision.locality, 'cloud');
  });

  it('L2 coding stays on the large local model at every difficulty', () => {
    for (const difficulty of ['trivial', 'normal', 'hard', 'critical'] as const) {
      const decision = route(coding({ agent: { ...CODER, difficulty } }), ctx('L2'), FREE, CONFIG);
      assert.equal(pick(decision), 'local/local-large', difficulty);
    }
  });

  it('a contaminated run stays local even with an L1 clearance history', () => {
    const contaminated = recordRead(createContext('L2'), 'L2').context;
    assert.equal(pick(route(coding(), contaminated, FREE, CONFIG)), 'local/local-large');
  });

  it('a context not issued by the policy is read as L2', () => {
    const forged = { clearance: 'L1', effective: 'L0' } as Context;
    const decision = route(coding(), forged, FREE, CONFIG);
    assert.equal(pick(decision), 'local/local-large');
    assert.equal(decision.label, 'L2');
    assert.match(decision.reason, /not issued by the policy/);
  });

  it('the agent cloud ceiling applies: L1 work with cloud_max_label L0 stays local', () => {
    const decision = route(coding({ agent: { ...CODER, cloudMaxLabel: 'L0' } }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'local/local-large');
    assert.ok(decision.candidates.some((c) => c.model === 'sonnet' && c.outcome === 'privacy'));
    assert.match(decision.reason, /cloud excluded: privacy/);
  });

  it('a local executor declared cloud gets no L2', () => {
    const config = createRouterConfig([{ executor: 'local', model: 'local-large', locality: 'cloud' }]);
    const decision = route(coding(), ctx('L2'), FREE, config);
    assert.equal(pick(decision), 'wait:wait-user');
    assert.deepEqual(decision.candidates, [{ executor: 'local', model: 'local-large', outcome: 'privacy' }]);
  });

  it('a label above the agent clearance waits for the user', () => {
    const agent: RouterAgent = { ...CODER, maxLabel: 'L1' };
    assert.equal(pick(route(coding({ agent }), ctx('L2'), FREE, CONFIG)), 'wait:wait-user');
    assert.equal(pick(route(coding({ agent }), ctx('L1'), FREE, CONFIG)), 'claude/sonnet');
  });

  it('cloud candidates excluded by privacy are logged as such', () => {
    const decision = route(coding(), ctx('L2'), FREE, CONFIG);
    assert.equal(pick(decision), 'local/local-large');
    // Luna is on no ladder (D-141): it is not for the step, whatever the label.
    assert.ok(decision.candidates.every((c) => c.executor === 'local' || c.outcome === (c.model === 'luna' ? 'not-for-step' : 'privacy')));
    // Extraction never uses the cloud ladder: cloud candidates are simply not for the step.
    const extract = route({ kind: 'extract', agent: CODER }, ctx('L1'), FREE, CONFIG);
    assert.ok(extract.candidates.every((c) => c.executor === 'local' || c.outcome === 'not-for-step'));
  });
});

describe('configuration and labels', () => {
  it('a configuration not made by createRouterConfig is validated: claude declared local is refused', () => {
    const forged = { candidates: [{ executor: 'claude' as const, model: 'sonnet' as const, locality: 'local' as const }] };
    assert.throws(() => route(coding(), ctx('L2'), FREE, forged), /always runs in the cloud/);
  });

  it('a validated literal configuration still routes', () => {
    const literal = { candidates: [{ executor: 'claude' as const, model: 'sonnet' as const, locality: 'cloud' as const }] };
    assert.equal(pick(route(coding(), ctx('L1'), FREE, literal)), 'claude/sonnet');
  });

  it('a forged L3 context is read as L2: it stays local and never reaches the cloud', () => {
    // The policy cannot issue an L3 context, so a forged one is the only way in.
    const agent: RouterAgent = { ...CODER, maxLabel: 'L3' };
    const decision = route(coding({ agent }), { clearance: 'L3', effective: 'L3' }, FREE, CONFIG);
    assert.equal(pick(decision), 'local/local-large');
    assert.equal(decision.label, 'L2');
  });
});

describe('mapping', () => {
  it('extraction, classification and summaries go to the small local model at any label', () => {
    for (const kind of ['extract', 'classify', 'summarize'] as const) {
      assert.equal(pick(route({ kind, agent: ARIANNA }, ctx('L0'), FREE, CONFIG)), 'local/local-small', kind);
      assert.equal(pick(route({ kind, agent: ARIANNA }, ctx('L2'), FREE, CONFIG)), 'local/local-small', kind);
    }
  });

  it('planning and judgement go to the large local model', () => {
    assert.equal(pick(route({ kind: 'plan', agent: ARIANNA }, ctx('L2'), FREE, CONFIG)), 'local/local-large');
    assert.equal(pick(route({ kind: 'judge', agent: ARIANNA }, ctx('L0'), FREE, CONFIG)), 'local/local-large');
  });

  it('hard coding goes to Opus, critical to Fable behind a budget approval', () => {
    assert.equal(pick(route(coding({ agent: { ...CODER, difficulty: 'hard' } }), ctx('L1'), FREE, CONFIG)), 'claude/opus');
    const critical = route(coding({ agent: { ...CODER, difficulty: 'critical' } }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(critical), 'claude/fable');
    assert.equal(critical.decision === 'route' && critical.approval, 'budget');
  });

  it('an approved budget lets Fable start without a new approval', () => {
    const decision = route(coding({ agent: { ...CODER, difficulty: 'critical' }, budgetApproved: true }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'claude/fable');
    assert.equal(decision.decision === 'route' && 'approval' in decision, false);
  });

  it('reviews go to Codex for a second opinion, Sonnet when Codex is missing', () => {
    assert.equal(pick(route({ kind: 'review', agent: CODER }, ctx('L1'), FREE, CONFIG)), 'codex/sol');
    // A hard review: Astra, next to Opus (D-141).
    assert.equal(pick(route({ kind: 'review', agent: { ...CODER, difficulty: 'hard' } }, ctx('L1'), FREE, CONFIG)), 'codex/astra');
    const noCodex = createRouterConfig(ALL.filter((c) => c.executor !== 'codex'));
    assert.equal(pick(route({ kind: 'review', agent: CODER }, ctx('L1'), FREE, noCodex)), 'claude/sonnet');
  });

  it('an agent without cloud executors codes locally', () => {
    const agent: RouterAgent = { ...CODER, executors: ['local'] };
    delete agent.cloudMaxLabel;
    assert.equal(pick(route(coding({ agent }), ctx('L0'), FREE, CONFIG)), 'local/local-large');
  });

  it('an agent without the first tier executor starts at its own lowest tier', () => {
    const agent: RouterAgent = { name: 'codex-only', executors: ['codex'], maxLabel: 'L1', difficulty: 'normal' };
    assert.equal(pick(route(coding({ agent }), ctx('L1'), FREE, CONFIG)), 'codex/sol');
  });

  it('Claude and Codex share each tier, Claude first for coding (D-141)', () => {
    assert.equal(pick(route(coding(), ctx('L1'), FREE, CONFIG)), 'claude/sonnet');
    assert.equal(pick(route(coding({ agent: { ...CODER, difficulty: 'hard' } }), ctx('L1'), FREE, CONFIG)), 'claude/opus');
    // Luna is never chosen by the router, only by the user.
    for (const kind of ['coding', 'review'] as const) {
      for (const difficulty of ['trivial', 'normal', 'hard', 'critical'] as const) {
        assert.notEqual(pick(route({ kind, agent: { ...CODER, difficulty }, budgetApproved: true }, ctx('L1'), FREE, CONFIG)), 'codex/luna', `${kind} ${difficulty}`);
      }
    }
    assert.equal(pick(route(coding({ preferredModel: 'luna' }), ctx('L1'), FREE, CONFIG)), 'codex/luna', 'chosen by the user');
  });

  it('Luna chosen by the user still obeys privacy, the agent and the budget (D-141)', () => {
    assert.equal(pick(route(coding({ preferredModel: 'luna' }), ctx('L2'), FREE, CONFIG)), 'local/local-large', 'never L2 to the cloud');
    const claudeOnly: RouterAgent = { ...CODER, executors: ['claude', 'local'] };
    assert.equal(pick(route(coding({ agent: claudeOnly, preferredModel: 'luna' }), ctx('L1'), FREE, CONFIG)), 'claude/sonnet', 'not on the card');
    const lunaOut: Budget = { blocked: [{ executor: 'codex', model: 'luna', cause: 'quota', until: '2026-10-03T08:00:00Z' }] };
    assert.equal(pick(route(coding({ preferredModel: 'luna' }), ctx('L1'), lunaOut, CONFIG)), 'claude/sonnet', 'out of quota: the ladder');
    // After a failed attempt the step escalates: Luna sits below every tier (D-141).
    const failed = route(coding({ preferredModel: 'luna', attempts: [{ executor: 'claude', model: 'sonnet', outcome: 'tests-failed' }] }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(failed), 'claude/opus');
    assert.match(failed.reason, /preferred luna excluded: escalation/);
    const lunaFailed = route(coding({ preferredModel: 'luna', attempts: [{ executor: 'codex', model: 'luna', outcome: 'tests-failed' }] }), ctx('L1'), FREE, CONFIG);
    assert.notEqual(pick(lunaFailed), 'codex/luna', 'never Luna again after Luna failed');
    assert.match(route(coding({ preferredModel: 'luna' }), ctx('L1'), lunaOut, CONFIG).reason, /preferred luna excluded: quota/, 'the note names the real cause');
    // Not a cloud step: Luna is not for it, chosen or not.
    assert.equal(pick(route({ kind: 'extract', agent: CODER, preferredModel: 'luna' }, ctx('L1'), FREE, CONFIG)), 'local/local-small');
  });

  it('a model that is not installed steps down, not up', () => {
    const noOpus = createRouterConfig(ALL.filter((c) => c.model !== 'opus' && c.model !== 'astra'));
    const decision = route(coding({ agent: { ...CODER, difficulty: 'hard' } }), ctx('L1'), FREE, noOpus);
    assert.equal(pick(decision), 'claude/sonnet');
    assert.match(decision.reason, /unavailable/);
  });

  it('an agent without the local executor cannot extract', () => {
    const agent: RouterAgent = { name: 'cloud-only', executors: ['claude'], maxLabel: 'L1', difficulty: 'normal' };
    const decision = route({ kind: 'extract', agent }, ctx('L0'), FREE, CONFIG);
    assert.equal(pick(decision), 'wait:wait-user');
    assert.ok(decision.candidates.some((c) => c.model === 'local-small' && c.outcome === 'agent'));
  });

  it('the reason names rules, never the text of the step', () => {
    const decision = route(coding({ text: 'migrazione del conto IT60X0542811101000000123456' }), ctx('L1'), FREE, CONFIG);
    assert.match(decision.reason, /hard-keyword/);
    assert.doesNotMatch(decision.reason, /IT60|conto/);
  });

  it('rejects unknown step kinds and attempt outcomes', () => {
    assert.throws(() => route({ kind: 'chat' as 'coding', agent: CODER }, ctx('L0'), FREE, CONFIG), /step kind/);
    const attempts = [{ executor: 'claude' as const, model: 'sonnet' as const, outcome: 'meh' as 'stuck' }];
    assert.throws(() => route(coding({ attempts }), ctx('L0'), FREE, CONFIG), /attempt outcome/);
  });
});

describe('escalation', () => {
  const failed = (model: 'sonnet' | 'opus' | 'fable') => ({ executor: 'claude' as const, model, outcome: 'tests-failed' as const });

  it('Sonnet → Opus → Fable', () => {
    const first = route(coding({ attempts: [failed('sonnet')] }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(first), 'claude/opus');
    assert.equal(first.escalatedFrom, 'claude/sonnet');
    const second = route(coding({ attempts: [failed('sonnet'), failed('opus')] }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(second), 'claude/fable');
    assert.equal(second.decision === 'route' && second.approval, 'budget');
  });

  it('a failure after a step down goes to the next tier, not two tiers up', () => {
    const hard = { ...CODER, difficulty: 'hard' as const };
    const decision = route(coding({ agent: hard, attempts: [failed('sonnet')] }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'claude/opus');
    assert.equal(decision.difficulty, 'critical');
  });

  it('after Fable fails there is nothing stronger: the user decides', () => {
    const decision = route(coding({ attempts: [failed('sonnet'), failed('opus'), failed('fable')] }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'wait:wait-user');
  });

  it('a failure never escalates L2 work to the cloud', () => {
    const attempts = [{ executor: 'local' as const, model: 'local-large' as const, outcome: 'tests-failed' as const }];
    const decision = route(coding({ attempts }), ctx('L2'), FREE, CONFIG);
    assert.equal(pick(decision), 'wait:wait-user');
    assert.ok(decision.candidates.every((c) => c.outcome !== 'chosen'));
  });

  it('small local → large local', () => {
    const attempts = [{ executor: 'local' as const, model: 'local-small' as const, outcome: 'stuck' as const }];
    assert.equal(pick(route({ kind: 'summarize', agent: ARIANNA, attempts }, ctx('L2'), FREE, CONFIG)), 'local/local-large');
  });

  it('a failed model is not chosen again when the stronger one is out of budget', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', model: 'opus', cause: 'cap' }, { executor: 'codex', cause: 'cap' }] };
    const decision = route(coding({ attempts: [failed('sonnet')] }), ctx('L1'), budget, CONFIG);
    assert.equal(pick(decision), 'wait:wait-user');
    assert.ok(decision.candidates.some((c) => c.model === 'sonnet' && c.outcome === 'escalation'));
  });
});

describe('budget filter', () => {
  it('a quota error on Claude moves normal coding to Sol, on the same tier (D-141)', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', cause: 'quota', until: '2026-10-03T08:00:00Z' }] };
    const decision = route(coding(), ctx('L1'), budget, CONFIG);
    assert.equal(pick(decision), 'codex/sol');
    assert.ok(decision.candidates.some((c) => c.model === 'sonnet' && c.outcome === 'quota'));
  });

  it('a quota error on both makes normal coding wait until the first reset', () => {
    const budget: Budget = {
      blocked: [
        { executor: 'claude', cause: 'quota', until: '2026-10-03T08:00:00Z' },
        { executor: 'codex', cause: 'quota', until: '2026-10-04T08:00:00Z' },
      ],
    };
    const decision = route(coding(), ctx('L1'), budget, CONFIG);
    assert.equal(pick(decision), 'wait:retry-later');
    assert.equal(decision.decision === 'wait' && decision.retryAt, '2026-10-03T08:00:00.000Z');
    assert.ok(decision.candidates.some((c) => c.model === 'sonnet' && c.outcome === 'quota'));
  });

  it('the earliest reset wins', () => {
    const budget: Budget = {
      blocked: [
        { executor: 'claude', cause: 'quota', until: '2026-10-04T08:00:00Z' },
        { executor: 'codex', cause: 'quota', until: '2026-10-03T09:00:00Z' },
      ],
    };
    const decision = route(coding({ agent: { ...CODER, difficulty: 'hard' } }), ctx('L1'), budget, CONFIG);
    assert.equal(decision.decision === 'wait' && decision.retryAt, '2026-10-03T09:00:00.000Z');
  });

  it('hard coding falls to Astra when Claude is out of quota', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', cause: 'quota', until: '2026-10-03T08:00:00Z' }] };
    assert.equal(pick(route(coding({ agent: { ...CODER, difficulty: 'hard' } }), ctx('L1'), budget, CONFIG)), 'codex/astra');
  });

  it('an exhausted model steps down, never up', () => {
    const opusOut: Budget = { blocked: [{ executor: 'claude', model: 'opus', cause: 'cap' }, { executor: 'codex', cause: 'cap' }] };
    const decision = route(coding({ agent: { ...CODER, difficulty: 'hard' } }), ctx('L1'), opusOut, CONFIG);
    assert.equal(pick(decision), 'claude/sonnet');
    assert.match(decision.reason, /unavailable/);
    const sonnetOut: Budget = { blocked: [{ executor: 'claude', model: 'sonnet', cause: 'cap' }, { executor: 'codex', model: 'sol', cause: 'cap' }] };
    assert.equal(pick(route(coding(), ctx('L1'), sonnetOut, CONFIG)), 'wait:wait-user');
  });

  it('an exhausted Fable falls back to Opus without a budget approval', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', model: 'fable', cause: 'cap' }] };
    const decision = route(coding({ agent: { ...CODER, difficulty: 'critical' } }), ctx('L1'), budget, CONFIG);
    assert.equal(pick(decision), 'claude/opus');
    assert.equal(decision.decision === 'route' && 'approval' in decision, false);
  });

  it('the budget never moves cloud work to the local model', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', cause: 'cap' }, { executor: 'codex', cause: 'cap' }] };
    assert.equal(pick(route(coding(), ctx('L1'), budget, CONFIG)), 'wait:wait-user');
  });

  it('a block on another model leaves the chosen one alone', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', model: 'opus', cause: 'cap' }] };
    assert.equal(pick(route(coding(), ctx('L1'), budget, CONFIG)), 'claude/sonnet');
  });

  it('rejects malformed budgets', () => {
    const bad = (blocked: unknown) => () => route(coding(), ctx('L1'), { blocked } as Budget, CONFIG);
    assert.throws(bad([{ executor: 'claude', cause: 'oops' }]), /budget cause/);
    assert.throws(bad([{ executor: 'claude', cause: 'cap', until: 'soon' }]), /ISO 8601/);
    assert.throws(bad([{ executor: 'claude', cause: 'cap', until: 'Sat Oct 03 2026' }]), /ISO 8601/);
    assert.throws(bad([{ executor: 'claude', cause: 'cap', until: '2026-10-03T08:00:00' }]), /ISO 8601/);
    assert.throws(bad([{ executor: 'Claude', cause: 'quota' }]), /unknown executor/);
    assert.throws(bad([{ executor: 'claude', model: 'sol', cause: 'quota' }]), /another executor/);
    assert.throws(bad([null]), /must be an object/);
    assert.throws(bad('none'), /must be a list/);
  });

  it('rejects attempts with unknown executors or models', () => {
    const attempts = [{ executor: 'claude', model: 'Sonnet <script>', outcome: 'stuck' }] as unknown as Step['attempts'];
    assert.throws(() => route(coding({ ...(attempts === undefined ? {} : { attempts }) }), ctx('L1'), FREE, CONFIG), /unknown executor or model/);
  });

  it('a reset with an offset is normalized to UTC', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', cause: 'quota', until: '2026-10-03T10:00:00+02:00' }, { executor: 'codex', cause: 'quota', until: '2026-10-04T10:00:00+02:00' }] };
    const decision = route(coding(), ctx('L1'), budget, CONFIG);
    assert.equal(decision.decision === 'wait' && decision.retryAt, '2026-10-03T08:00:00.000Z');
  });

  it('a candidate is back only when every block on it lifts', () => {
    const budget: Budget = {
      blocked: [
        { executor: 'claude', cause: 'cap' },
        { executor: 'claude', model: 'sonnet', cause: 'quota', until: '2026-10-03T08:00:00Z' },
        { executor: 'codex', cause: 'cap' },
      ],
    };
    assert.equal(pick(route(coding(), ctx('L1'), budget, CONFIG)), 'wait:wait-user');
    const both: Budget = {
      blocked: [
        { executor: 'claude', cause: 'quota', until: '2026-10-05T08:00:00Z' },
        { executor: 'claude', model: 'sonnet', cause: 'cap', until: '2026-10-03T08:00:00Z' },
        { executor: 'codex', cause: 'quota', until: '2026-10-06T08:00:00Z' },
      ],
    };
    const decision = route(coding(), ctx('L1'), both, CONFIG);
    assert.equal(decision.decision === 'wait' && decision.retryAt, '2026-10-05T08:00:00.000Z');
  });
});

describe('decision log', () => {
  it('lists every configured candidate exactly once, with one chosen', () => {
    const decision = route(coding(), ctx('L1'), FREE, CONFIG);
    assert.deepEqual(
      decision.candidates.map((c) => `${c.executor}/${c.model}:${c.outcome}`),
      [
        'local/local-small:not-for-step',
        'local/local-large:not-for-step',
        'claude/sonnet:chosen',
        'claude/opus:not-chosen',
        'claude/fable:not-chosen',
        'codex/luna:not-for-step',
        'codex/sol:not-chosen',
        'codex/astra:not-chosen',
      ],
    );
  });
});

describe('preferred model (task 1.10)', () => {
  it('the user\'s choice wins over the ladder, upwards too', () => {
    const decision = route(coding({ preferredModel: 'opus' }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'claude/opus');
    assert.match(decision.reason, /chosen by the user/);
    assert.deepEqual(
      decision.candidates.filter((c) => c.outcome === 'chosen').map((c) => c.model),
      ['opus'],
    );
  });

  it('fable chosen by the user still needs the budget approval', () => {
    const decision = route(coding({ preferredModel: 'fable' }), ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'claude/fable');
    assert.equal(decision.decision === 'route' && decision.approval, 'budget');
    const approved = route(coding({ preferredModel: 'fable', budgetApproved: true }), ctx('L1'), FREE, CONFIG);
    assert.equal(approved.decision === 'route' && approved.approval, undefined);
  });

  it('privacy still excludes a preferred cloud model', () => {
    const decision = route(coding({ preferredModel: 'opus' }), ctx('L2'), FREE, CONFIG);
    assert.equal(pick(decision), 'local/local-large');
    assert.match(decision.reason, /preferred opus excluded: privacy/);
  });

  it('a preferred model out of quota or below a failed attempt is not taken', () => {
    const budget: Budget = { blocked: [{ executor: 'claude', model: 'opus', cause: 'quota' }] };
    assert.equal(pick(route(coding({ preferredModel: 'opus' }), ctx('L1'), budget, CONFIG)), 'claude/sonnet');
    const escalated = coding({ preferredModel: 'sonnet', attempts: [{ executor: 'claude', model: 'sonnet', outcome: 'tests-failed' }] });
    const decision = route(escalated, ctx('L1'), FREE, CONFIG);
    assert.equal(pick(decision), 'claude/opus');
    assert.match(decision.reason, /preferred sonnet excluded: escalation/);
  });

  it('a preferred model that is not installed or not for the step is ignored', () => {
    const noOpus = createRouterConfig(ALL.filter((c) => c.model !== 'opus'));
    const decision = route(coding({ preferredModel: 'opus' }), ctx('L1'), FREE, noOpus);
    assert.equal(pick(decision), 'claude/sonnet');
    assert.match(decision.reason, /preferred opus not installed/);
    assert.equal(pick(route({ kind: 'plan', agent: ARIANNA, preferredModel: 'sonnet' }, ctx('L1'), FREE, CONFIG)), 'local/local-large');
  });

  it('an unknown preferred model is rejected', () => {
    assert.throws(() => route(coding({ preferredModel: 'gpt' as 'opus' }), ctx('L1'), FREE, CONFIG), /unknown preferred model/);
  });
});

describe('typical use of a model (I-3)', () => {
  const short = (model: string): string[] =>
    usesOf(model).map((use) => `${use.kind}:${String(use.tier)}/${String(use.tiers)}${use.fallback === true ? ' fallback' : ''}`);

  it('reads the cloud ladders: Sonnet or Sol first, Opus or Astra next, Fable last; Luna on none (D-141)', () => {
    assert.deepEqual(short('sonnet'), ['coding:0/3', 'review:0/3']);
    assert.deepEqual(short('opus'), ['coding:1/3', 'review:1/3']);
    assert.deepEqual(short('sol'), ['coding:0/3', 'review:0/3']);
    assert.deepEqual(short('astra'), ['coding:1/3', 'review:1/3']);
    assert.deepEqual(short('luna'), []);
    assert.deepEqual(short('fable'), ['coding:2/3', 'review:2/3']);
  });

  it('reads the local ladders, with the large model as the fallback of coding and review', () => {
    assert.deepEqual(short('local-small'), ['extract:0/2', 'classify:0/2', 'summarize:0/2']);
    assert.deepEqual(short('local-large'), ['extract:1/2', 'classify:1/2', 'summarize:1/2', 'plan:0/1', 'judge:0/1', 'coding:0/1 fallback', 'review:0/1 fallback']);
  });

  it('an alias outside the ladders takes no step', () => {
    assert.deepEqual(usesOf('local-voice'), []);
    assert.deepEqual(usesOf('gpt'), []);
    assert.deepEqual(usesOf(''), []);
  });

  it('agrees with route: the first tier is what a normal step gets', () => {
    const chosen = route(coding(), ctx('L1'), FREE, CONFIG);
    assert.ok(chosen.decision === 'route');
    assert.equal(usesOf(chosen.model).find((use) => use.kind === 'coding')?.tier, 0);
    const local = route(coding(), ctx('L2'), FREE, CONFIG);
    assert.ok(local.decision === 'route');
    assert.equal(usesOf(local.model).find((use) => use.kind === 'coding')?.fallback, true);
    const plan = route({ kind: 'plan', agent: ARIANNA }, ctx('L2'), FREE, CONFIG);
    assert.ok(plan.decision === 'route');
    assert.equal(usesOf(plan.model).find((use) => use.kind === 'plan')?.tier, 0);
  });

  it('only Fable needs a budget approval, as route asks', () => {
    assert.equal(needsBudgetApproval('fable'), true);
    for (const model of ['sonnet', 'opus', 'codex', 'local-large', 'local-small', 'gpt']) assert.equal(needsBudgetApproval(model), false, model);
    const fable = route(coding({ preferredModel: 'fable' }), ctx('L1'), FREE, CONFIG);
    assert.equal(fable.decision === 'route' && fable.approval, 'budget');
  });
});
