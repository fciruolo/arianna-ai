import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';

import { CaseFileError } from '../src/cases.ts';
import { loadMemoryCases, parseQuestions, parseWorld } from '../src/memory/cases.ts';
import { abstains, matchesExpected, NO_JUDGE, normalize } from '../src/memory/check.ts';
import { createFakeMemory } from '../src/memory/fake.ts';
import { runMemoryEval, type MemoryReport } from '../src/memory/run.ts';
import type { MemoryAdapter, MemoryJudge, RecalledMemory } from '../src/memory/types.ts';

const { world, questions } = loadMemoryCases(join(resolveHome({}), 'evals', 'memory'));

const run = (adapter: MemoryAdapter, judge?: MemoryJudge): Promise<MemoryReport> =>
  runMemoryEval(adapter, world, questions, judge === undefined ? {} : { judge });

const failedIds = (report: MemoryReport): string[] => report.privacy.failed.map((item) => item.id);
const failure = (report: MemoryReport, id: string): string | undefined => report.privacy.failed.find((item) => item.id === id)?.code;

const EPISODE = '{"id":"e1","at":"2026-01-10T09:00:00+01:00","label":"L1","conversation":"c1","text":"Testo finto."}';
const QUESTION = '{"id":"q1","asOf":"2026-10-23","clearance":"L1","question":"Domanda?","reference":"Risposta","expect":{"any":["risposta"]},"tags":[]}';

describe('memory case files', () => {
  it('the committed world and questions load', () => {
    assert.equal(world.filter((step) => step.kind === 'episode').length, 15);
    assert.deepEqual(world.filter((step) => step.kind === 'forget').map((step) => step.id), ['f01']);
    assert.equal(questions.length, 21);
    for (const tag of ['privacy', 'temporale', 'astensione', 'incognito', 'l3', 'cancellazione']) {
      assert.ok(questions.some((question) => question.tags.includes(tag)), tag);
    }
  });

  it('every privacy question forbids at least one string, and every forbidden string is in an episode', () => {
    const texts = world.flatMap((step) => (step.kind === 'episode' ? [step.text] : [])).join('\n');
    for (const question of questions.filter((item) => item.tags.includes('privacy'))) {
      assert.ok(question.expect.none !== undefined, question.id);
      for (const word of question.expect.none) assert.ok(normalize(texts).includes(normalize(word)), `${question.id}: ${word}`);
    }
  });

  it('accepts a well-formed line of each file', () => {
    assert.equal(parseWorld(EPISODE).length, 1);
    assert.equal(parseQuestions(QUESTION).length, 1);
  });

  it('rejects malformed episodes and deletions', () => {
    assert.throws(() => parseWorld(EPISODE.replace('"L1"', '"L4"')), CaseFileError);
    assert.throws(() => parseWorld(EPISODE.replace('}', ',"extra":1}')), CaseFileError);
    assert.throws(() => parseWorld(EPISODE.replace('+01:00', '')), CaseFileError);
    assert.throws(() => parseWorld(EPISODE.replace('}', ',"incognito":"yes"}')), CaseFileError);
    assert.throws(() => parseWorld(`${EPISODE}\n${EPISODE}`), CaseFileError, 'duplicate id');
    assert.throws(() => parseWorld(`${EPISODE}\n${EPISODE.replace('"e1"', '"e2"').replace('2026-01-10', '2026-01-09')}`), CaseFileError, 'back in time');
    assert.throws(() => parseWorld(`${EPISODE}\n{"id":"f1","at":"2026-02-01T09:00:00+01:00","forget":"c-other"}`), CaseFileError);
    const forget = '{"id":"f1","at":"2026-02-01T09:00:00+01:00","forget":"c1"}';
    assert.throws(() => parseWorld(`${EPISODE}\n${forget}`), CaseFileError, 'a deleted episode needs a canary');
    assert.equal(parseWorld(`${EPISODE.replace('"text"', '"canaries":["finto"],"text"')}\n${forget}`).length, 2);
  });

  it('a protected episode needs a canary of its own text, found in no open episode', () => {
    const PRIVATE = EPISODE.replace('"L1"', '"L2"').replace('"e1"', '"e2"');
    assert.throws(() => parseWorld(PRIVATE), CaseFileError, 'L2 without canary');
    assert.throws(() => parseWorld(EPISODE.replace('"L1"', '"L3"')), CaseFileError, 'L3 without canary');
    assert.throws(() => parseWorld(EPISODE.replace('}', ',"incognito":true}')), CaseFileError, 'incognito without canary');
    assert.throws(() => parseWorld(PRIVATE.replace('"text"', '"canaries":["assente"],"text"')), CaseFileError, 'not in the text');
    assert.throws(() => parseWorld(`${EPISODE}\n${PRIVATE.replace('"text"', '"canaries":["Testo finto"],"text"')}`), CaseFileError, 'also in an L1 episode');
    const other = PRIVATE.replace('Testo finto.', 'Altro finto.');
    assert.throws(() => parseWorld(`${EPISODE}\n${other.replace('"text"', '"canaries":["finto"],"text"')}`), CaseFileError, '"finto" is in e1 too');
    assert.equal(parseWorld(`${EPISODE}\n${other.replace('"text"', '"canaries":["Altro"],"text"')}`).length, 2);
  });

  it('rejects malformed questions', () => {
    assert.throws(() => parseQuestions(QUESTION.replace('"clearance":"L1"', '"clearance":"L3"')), CaseFileError);
    assert.throws(() => parseQuestions(QUESTION.replace('"clearance":"L1"', '"clearance":"L0"')), CaseFileError, 'no canary guards L1 data from L0');
    assert.throws(() => parseQuestions(QUESTION.replace('2026-10-23', '23/10/2026')), CaseFileError);
    assert.throws(() => parseQuestions(QUESTION.replace('{"any":["risposta"]}', '{"none":["x"]}')), CaseFileError, 'nothing expected');
    assert.throws(() => parseQuestions(QUESTION.replace('{"any":["risposta"]}', '{"any":[]}')), CaseFileError);
    assert.throws(() => parseQuestions(QUESTION.replace('{"any":["risposta"]}', '{"abstain":false}')), CaseFileError);
    assert.throws(() => parseQuestions(QUESTION.replace('{"any":["risposta"]}', '{"some":["x"]}')), CaseFileError);
    assert.throws(() => parseQuestions(`${QUESTION}\n${QUESTION}`), CaseFileError);
  });
});

describe('expected words', () => {
  it('compare without case, accents or curly apostrophes', () => {
    assert.equal(matchesExpected('Il GIOVEDI pomeriggio', { all: ['giovedì pomeriggio'] }), true);
    assert.equal(matchesExpected('Prima l’app della palestra', { any: ["prima l'app"] }), true);
    assert.equal(matchesExpected('Il martedì mattina', { all: ['giovedì pomeriggio'] }), false);
  });

  it('need all of all and one of any', () => {
    assert.equal(matchesExpected('Ortofrutta Bellini e Palestra Vento Finto', { all: ['Ortofrutta Bellini', 'Palestra Vento'] }), true);
    assert.equal(matchesExpected('Solo Ortofrutta Bellini', { all: ['Ortofrutta Bellini', 'Palestra Vento'] }), false);
    assert.equal(matchesExpected('6500 euro', { any: ['6.500', '6500'] }), true);
    assert.equal(matchesExpected('4000 euro', { any: ['6.500', '6500'] }), false);
  });

  it('an abstention is recognised', () => {
    assert.equal(abstains('Non lo so.'), true);
    assert.equal(abstains('Qui non posso dirlo.'), true);
    assert.equal(abstains('Il budget è 4.000 euro.'), false);
    assert.equal(abstains('Non sono sicuro, 4.000 euro.'), false, 'non sono is not non so');
    assert.equal(matchesExpected('Il budget è 4.000 euro.', { abstain: true }), false);
  });
});

describe('the memory protocol on the fake adapter', () => {
  it('passes every privacy check and keeps no text in the report', async () => {
    const report = await run(createFakeMemory());
    assert.equal(report.ok, true, JSON.stringify(report.privacy.failed));
    assert.equal(report.privacy.rate, 1);
    // Two excluded episodes, one deletion, the audit, a clearance and a leak check per question.
    assert.equal(report.privacy.total, 2 + 1 + 1 + questions.length * 2);
    assert.deepEqual(report.episodes.filter((item) => item.outcome === 'refused').map((item) => item.id), ['e12', 'e14']);
    assert.equal(report.accuracy.total, questions.length);
    const json = JSON.stringify(report);
    for (const secret of ['7Q3X', 'CA00000ZZ', 'Nebbia', '4417', 'Borgo Finto', 'Paolo Sarti', 'Ortofrutta']) assert.ok(!json.includes(secret), secret);
  });

  it('without a judge an unconfirmed answer stays doubtful; a judge decides it', async () => {
    const plain = await run(createFakeMemory());
    assert.ok(plain.accuracy.doubtful > 0);
    assert.equal(plain.accuracy.wrong, 0);
    const judged = await run(createFakeMemory(), { id: 'always-wrong', judge: () => Promise.resolve('wrong') });
    assert.equal(judged.judge, 'always-wrong');
    assert.equal(judged.accuracy.doubtful, 0);
    assert.equal(judged.accuracy.wrong, plain.accuracy.doubtful);
    assert.equal(judged.questions.find((item) => item.verdict === 'wrong')?.by, 'judge');
    assert.equal(NO_JUDGE.id, 'none');
  });
});

describe('a faulty adapter fails the privacy checks', () => {
  it('a private memory returned to a work conversation', async () => {
    const fake = createFakeMemory();
    const report = await run({ ...fake, ask: (query) => fake.ask({ ...query, clearance: 'L2' }) });
    assert.equal(report.ok, false);
    assert.equal(failure(report, 'clearance:q15'), 'above-clearance');
    assert.equal(failure(report, 'leak:q15'), 'in-answer');
    assert.equal(failure(report, 'clearance:q01'), undefined, 'a work memory to a work conversation is fine');
  });

  it('a forbidden string only in the memories handed over', async () => {
    const fake = createFakeMemory();
    const report = await run({
      ...fake,
      ask: async (query) => {
        const reply = await fake.ask({ ...query, clearance: 'L2' });
        return { ...reply, answer: 'Non lo so.' };
      },
    });
    assert.equal(failure(report, 'leak:q16'), 'in-memories');
  });

  it('a forbidden string only in the answer', async () => {
    const fake = createFakeMemory();
    const report = await run({
      ...fake,
      ask: async (query) => {
        const reply = await fake.ask(query);
        return query.question.includes('Come mi chiama') ? { ...reply, answer: `${reply.answer} Zuzù-7Q3X` } : reply;
      },
    });
    assert.deepEqual(failedIds(report), ['leak:q16']);
    assert.equal(failure(report, 'leak:q16'), 'in-answer');
  });

  it('an incognito episode stored', async () => {
    const fake = createFakeMemory();
    const report = await run({ ...fake, ingest: (episode) => fake.ingest({ ...episode, incognito: false }) });
    assert.equal(failure(report, 'exclude:e12'), 'stored');
    assert.equal(failure(report, 'audit'), 'excluded-source');
    assert.equal(failure(report, 'leak:q19'), 'in-answer');
  });

  it('an L3 episode stored with a lower label', async () => {
    const fake = createFakeMemory();
    const report = await run({ ...fake, ingest: (episode) => fake.ingest(episode.label === 'L3' ? { ...episode, label: 'L2' } : episode) });
    assert.equal(failure(report, 'exclude:e14'), 'stored');
    assert.equal(failure(report, 'audit'), 'excluded-source');
    assert.equal(failure(report, 'leak:q20'), 'in-answer');
  });

  it('a deletion that leaves the memories of the conversation', async () => {
    const report = await run({ ...createFakeMemory(), forgetConversation: () => Promise.resolve() });
    assert.equal(failure(report, 'forget:f01'), 'forgotten-source');
    assert.equal(failure(report, 'audit'), 'forgotten-source');
    assert.equal(failure(report, 'leak:q21'), 'in-answer');
  });

  it('a memory consolidated from a work and a private episode labeled as work', async () => {
    const fake = createFakeMemory();
    const merged: RecalledMemory = { text: 'Paolo Sarti e Lucia, fusi.', label: 'L1', sources: ['e05', 'e10'] };
    const report = await run({
      ...fake,
      memories: async () => [...(await fake.memories()), merged],
      ask: async (query) => {
        const reply = await fake.ask(query);
        return query.question.includes('referente di Ortofrutta Bellini?') ? { ...reply, memories: [...reply.memories, merged] } : reply;
      },
    });
    assert.equal(failure(report, 'audit'), 'label-below-sources');
    assert.equal(failure(report, 'clearance:q01'), 'label-below-sources');
  });

  it('the same consolidated memory labeled L2 passes the audit', async () => {
    const fake = createFakeMemory();
    const merged: RecalledMemory = { text: 'Paolo Sarti e Lucia, fusi.', label: 'L2', sources: ['e05', 'e10'] };
    const report = await run({ ...fake, memories: async () => [...(await fake.memories()), merged] });
    assert.equal(report.ok, true);
  });

  it('memories without a label, with L3 or with an unknown source', async () => {
    for (const [memory, code] of [
      [{ text: 'x', sources: ['e01'] }, 'bad-label'],
      [{ text: 'x', label: 'L3', sources: ['e01'] }, 'bad-label'],
      [{ text: 'x', label: 'L1', sources: ['e99'] }, 'unknown-source'],
      [{ text: 'x', label: 'L1', sources: [] }, 'malformed'],
    ] as const) {
      const fake = createFakeMemory();
      const report = await run({ ...fake, memories: async () => [...(await fake.memories()), memory as unknown as RecalledMemory] });
      assert.equal(failure(report, 'audit'), code, JSON.stringify(memory));
    }
  });

  it('a crash on a privacy question fails it; on another question it is only an error', async () => {
    const fake = createFakeMemory();
    const report = await run({
      ...fake,
      ask: (query) => (query.question.includes('film') || query.question.includes('Quanto pago') ? Promise.reject(new Error('down')) : fake.ask(query)),
    });
    assert.deepEqual(failedIds(report), ['clearance:q19']);
    assert.equal(report.accuracy.error, 2);
    assert.equal(report.questions.find((item) => item.id === 'q17')?.errorCode, 'Error');
  });

  it('a private canary in the answer of a work question that forbids nothing', async () => {
    const fake = createFakeMemory();
    const report = await run({
      ...fake,
      ask: async (query) => {
        const reply = await fake.ask(query);
        return query.question === 'Chi è il referente di Ortofrutta Bellini?' ? { ...reply, answer: `${reply.answer} Tua sorella è a Borgo Finto, Zuzù-7Q3X.` } : reply;
      },
    });
    assert.deepEqual(failedIds(report), ['leak:q01']);
    assert.equal(report.questions.find((item) => item.id === 'q01')?.by, 'privacy', 'a leaked answer never goes to the judge');
  });

  it('a memory that launders its label by citing a work source', async () => {
    const fake = createFakeMemory();
    const laundered: RecalledMemory = { text: 'Paolo Sarti; Zuzù-7Q3X.', label: 'L1', sources: ['e05'] };
    const report = await run({ ...fake, memories: async () => [...(await fake.memories()), laundered] });
    assert.equal(failure(report, 'audit'), 'canary-in-memory');
  });

  it('an excluded or deleted episode handed over by ask only', async () => {
    for (const [source, text, code] of [
      ['e12', 'Nebbia', 'excluded-source'],
      ['e15', 'Ceramiche Quarzo-9R2K', 'forgotten-source'],
    ] as const) {
      const fake = createFakeMemory();
      const report = await run({
        ...fake,
        ask: async (query) => {
          const reply = await fake.ask(query);
          return query.clearance === 'L2' ? { ...reply, memories: [...reply.memories, { text, label: 'L2', sources: [source] }] } : reply;
        },
      });
      assert.equal(failure(report, 'clearance:q14'), code, source);
      assert.equal(failure(report, 'audit'), undefined, source);
    }
  });

  it('a malformed answer of ask fails its clearance check', async () => {
    const fake = createFakeMemory();
    for (const bad of [null, { answer: 'Non lo so.' }, { answer: 7, memories: [] }]) {
      const report = await run({ ...fake, ask: (query) => (query.question.includes('film') ? Promise.resolve(bad as never) : fake.ask(query)) });
      assert.equal(failure(report, 'clearance:q19'), 'malformed', JSON.stringify(bad));
    }
  });

  it('a crash while ingesting an excluded episode, or while listing the memories', async () => {
    const fake = createFakeMemory();
    const crashing = await run({ ...fake, ingest: (episode) => (episode.id === 'e14' ? Promise.reject(new Error('down')) : fake.ingest(episode)) });
    assert.equal(failure(crashing, 'exclude:e14'), 'error');
    assert.equal(crashing.episodes.find((item) => item.id === 'e14')?.outcome, 'error');
    const odd = await run({ ...fake, ingest: (episode) => fake.ingest(episode).then((outcome) => (outcome === 'stored' ? ('saved: Borgo Finto' as never) : outcome)) });
    assert.ok(odd.episodes.every((item) => item.outcome === 'refused' || item.outcome === 'error'), 'a strange outcome never enters the report');
    const blind = await run({ ...fake, memories: () => Promise.reject(new Error('down')) });
    assert.equal(failure(blind, 'audit'), 'error');
    assert.equal(failure(blind, 'forget:f01'), 'error');
  });

  it('a judge verdict outside the three is doubtful', async () => {
    const report = await run(createFakeMemory(), { id: 'odd', judge: () => Promise.resolve('Borgo Finto' as never) });
    assert.ok(report.questions.every((item) => ['correct', 'doubtful', 'wrong'].includes(item.verdict)));
    assert.ok(!JSON.stringify(report).includes('Borgo'));
  });

  it('close runs even when the run crashes', async () => {
    let closed = false;
    const fake = createFakeMemory();
    await assert.rejects(run({ ...fake, reset: () => Promise.reject(new Error('down')), close: () => { closed = true; return Promise.resolve(); } }));
    assert.equal(closed, true);
  });

  it('a crash while deleting fails the deletion', async () => {
    const report = await run({ ...createFakeMemory(), forgetConversation: () => Promise.reject(new Error('down')) });
    assert.equal(failure(report, 'forget:f01'), 'error');
  });
});
