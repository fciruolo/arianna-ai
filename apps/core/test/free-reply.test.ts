import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REPLY_TEXT_MAX_LENGTH } from '@arianna/agents';
import { LocalModelError, type ChatRequest, type ChatResult, type LocalModel } from '@arianna/executors';

import { CUT_DRAFT_NOTE, freeReplyMessages, MAX_REPLY_CHARS, REPLY_INSTRUCTION, REPLY_MAX_TOKENS, writeFreeReply } from '../src/orchestrator/free-reply.ts';

const STEP = [
  { role: 'system' as const, content: 'You are Arianna.' },
  { role: 'user' as const, content: 'Quanto spendo al mese per la casa?' },
];
const DRAFT = '| Voce | Importo | |---|---| | Affitto | 800 € |';
const TABLE = '| Voce | Importo |\n|---|---|\n| Affitto | 800 € |';

type Answer = Partial<ChatResult> | LocalModelError | ((request: ChatRequest) => Partial<ChatResult>);

function fake(answers: Answer[]): LocalModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat(request) {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) throw new Error('no answer scripted');
      if (next instanceof LocalModelError) return Promise.reject(next);
      const partial = typeof next === 'function' ? next(request) : next;
      const result: ChatResult = {
        text: '',
        finishReason: 'stop',
        endpoint: 'test',
        model: 'test',
        durationMs: 1,
        usage: { promptTokens: 10, completionTokens: 5 },
        ...partial,
      };
      if (request.onText !== undefined && result.text !== '') for (const piece of result.text.match(/[\s\S]{1,4}/g) ?? []) request.onText(piece);
      return Promise.resolve(result);
    },
  };
}

const request = (model: LocalModel, extra: { onText?: (piece: string) => void; signal?: AbortSignal } = {}) =>
  writeFreeReply(model, {
    model: 'local-large',
    messages: STEP,
    draft: DRAFT,
    temperature: 0,
    signal: extra.signal ?? new AbortController().signal,
    ...(extra.onText === undefined ? {} : { onText: extra.onText }),
  });

test('freeReplyMessages (D-251): the step, byte for byte, then the draft as the answer and the instruction', () => {
  const messages = freeReplyMessages(STEP, DRAFT);
  assert.deepEqual(messages.slice(0, STEP.length), STEP);
  assert.deepEqual(messages.at(-2), {
    role: 'assistant',
    content: JSON.stringify({ action: 'reply', text: DRAFT }),
  });
  assert.deepEqual(messages.at(-1), {
    role: 'user',
    content: REPLY_INSTRUCTION,
  });
  assert.match(REPLY_INSTRUCTION, /Markdown table/);
  assert.match(REPLY_INSTRUCTION, /add nothing that is not there/);
});

test('freeReplyMessages (D-251): a draft cut at the limit of the schema asks to leave out its unfinished last item', () => {
  // Seen live: «34. `git pack-` —», the draft cut at 2000 characters and copied as it was.
  const cut = 'x'.repeat(REPLY_TEXT_MAX_LENGTH);
  assert.equal(freeReplyMessages(STEP, cut).at(-1)?.content, `${REPLY_INSTRUCTION}\n${CUT_DRAFT_NOTE}`);
  // Negative: one character shorter is a whole draft, and the instruction stays the same.
  assert.equal(freeReplyMessages(STEP, cut.slice(1)).at(-1)?.content, REPLY_INSTRUCTION);
  assert.match(REPLY_INSTRUCTION, /at most about 12 items/);
});

test('writeFreeReply (D-251): the free text with its line breaks, no schema, thinking off, tokens counted', async () => {
  const model = fake([{ text: `\n${TABLE}\n` }]);
  const pieces: string[] = [];
  const written = await request(model, {
    onText: (piece) => pieces.push(piece),
  });
  assert.deepEqual(written, { text: TABLE, tokensIn: 10, tokensOut: 5 });
  const [sent] = model.requests;
  assert.ok(sent !== undefined);
  assert.equal(sent.schema, undefined);
  assert.equal(sent.thinking, false);
  assert.equal(sent.maxTokens, REPLY_MAX_TOKENS);
  assert.equal(sent.streamUsage, true);
  assert.equal(pieces.join(''), `\n${TABLE}\n`);
});

test('writeFreeReply (D-251): a <think> block is neither shown nor stored', async () => {
  const pieces: string[] = [];
  const written = await request(fake([{ text: '<think>La tabella.</think>\nCiao.' }]), { onText: (piece) => pieces.push(piece) });
  assert.equal(written.text, 'Ciao.');
  assert.doesNotMatch(pieces.join(''), /tabella|think/);
});

test('writeFreeReply (D-251): the draft when the model fails, writes nothing, is cut, too long or JSON again', async () => {
  const cases: [Answer, string][] = [
    [new LocalModelError('unavailable', 'down'), 'failed'],
    [new LocalModelError('timeout', 'slow'), 'failed'],
    [{ text: '  \n ' }, 'empty'],
    [{ text: '<think>Solo pensiero</think>' }, 'empty'],
    [{ text: 'Una tabella a metà |', finishReason: 'length' }, 'truncated'],
    [{ text: 'x'.repeat(MAX_REPLY_CHARS + 1) }, 'too-long'],
    [{ text: '{"action":"reply","text":"Ciao"}' }, 'json'],
  ];
  for (const [answer, reason] of cases) {
    const written = await request(fake([answer]));
    assert.equal(written.text, DRAFT, reason);
    assert.equal(written.draftKept, reason);
  }
  // The tokens of a reply that was written and then not kept still count.
  assert.deepEqual(await request(fake([{ text: '' }])), {
    text: DRAFT,
    draftKept: 'empty',
    tokensIn: 10,
    tokensOut: 5,
  });
});

test('writeFreeReply (D-251): a server that refuses the thinking option is asked once more without it', async () => {
  const model = fake([new LocalModelError('http', 'bad request', { status: 422 }), { text: 'Ciao.' }]);
  assert.equal((await request(model)).text, 'Ciao.');
  assert.deepEqual(
    model.requests.map((sent) => sent.thinking),
    [false, undefined],
  );
});

test('writeFreeReply (D-251): a stopped step throws, as does an error that is not of the local model', async () => {
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(
    request(fake([new LocalModelError('cancelled', 'stopped')]), {
      signal: stop.signal,
    }),
    /stopped/,
  );
  await assert.rejects(
    request(
      fake([
        () => {
          throw new Error('bug');
        },
      ]),
    ),
    /bug/,
  );
});
