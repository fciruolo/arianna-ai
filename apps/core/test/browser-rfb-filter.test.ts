// The filter of the stream from the screen in the chat to Xvnc (D-264, passo 4).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRfbFilter, MAX_CUT_TEXT, MAX_ENCODINGS, MAX_FENCE, RFB_VERSION, type FilterStep } from '../src/browser/rfb-filter.ts';

const HANDSHAKE = Buffer.concat([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 1])]);

const setPixelFormat = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.alloc(16, 7)]);
function setEncodings(count: number): Buffer {
  const head = Buffer.from([2, 0, 0, 0]);
  head.writeUInt16BE(count, 2);
  const list = Buffer.alloc(4 * count);
  for (let index = 0; index < count; index += 1) list.writeInt32BE(index - 10, index * 4);
  return Buffer.concat([head, list]);
}
const updateRequest = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const continuous = Buffer.from([150, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
function fence(size: number): Buffer {
  return Buffer.concat([Buffer.from([248, 0, 0, 0, 0x80, 0, 0, 1, size]), Buffer.alloc(size, 9)]);
}
const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const pointerEvent = Buffer.from([5, 1, 0, 10, 0, 20]);
function cutText(size: number, extended = false): Buffer {
  const head = Buffer.from([6, 0, 0, 0, 0, 0, 0, 0]);
  head.writeInt32BE(extended ? -size : size, 4);
  return Buffer.concat([head, Buffer.alloc(size, 0x41)]);
}

/** Everything a filter forwards for these chunks, joined, and how it ended. */
function run(chunks: Buffer[]): { out: Buffer; close: FilterStep['close'] } {
  const filter = createRfbFilter('view');
  const out: Buffer[] = [];
  let close: FilterStep['close'];
  for (const chunk of chunks) {
    const step = filter.push(chunk);
    out.push(...step.forward);
    if (step.close !== undefined) {
      close = step.close;
      break;
    }
  }
  return { out: Buffer.concat(out), close };
}

test('the handshake of RFB 3.8 with security None passes as it is', () => {
  const { out, close } = run([HANDSHAKE]);
  assert.equal(close, undefined);
  assert.deepEqual(out, HANDSHAKE);
  assert.equal(createRfbFilter().mode, 'view');
});

test('a wrong handshake closes: another version, another security type, a bad ClientInit', () => {
  assert.equal(run([Buffer.from('RFB 003.003\n', 'latin1')]).close, 'bad-version');
  assert.equal(run([Buffer.from('GET / HTTP/1.1\r\n', 'latin1')]).close, 'bad-version');
  // A wrong first byte closes before the 12 bytes are in.
  assert.equal(run([Buffer.from('X', 'latin1')]).close, 'bad-version');
  assert.equal(run([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([2])]).close, 'bad-security');
  assert.equal(run([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([16])]).close, 'bad-security');
  assert.equal(run([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 2])]).close, 'bad-init');
  // ClientInit 0 (not shared) is accepted: Xvnc runs with -AlwaysShared.
  assert.equal(run([Buffer.from(RFB_VERSION, 'latin1'), Buffer.from([1, 0])]).close, undefined);
});

test('the types of view pass whole: SetPixelFormat, SetEncodings, FramebufferUpdateRequest, EnableContinuousUpdates, ClientFence', () => {
  for (const message of [setPixelFormat, setEncodings(3), setEncodings(0), updateRequest, continuous, fence(0), fence(MAX_FENCE)]) {
    const { out, close } = run([HANDSHAKE, message]);
    assert.equal(close, undefined, `type ${String(message[0])}`);
    assert.deepEqual(out, Buffer.concat([HANDSHAKE, message]), `type ${String(message[0])}`);
  }
});

test('keys, pointer and clipboard are dropped, and the stream goes on after them', () => {
  for (const dropped of [keyEvent, pointerEvent, cutText(5), cutText(0), cutText(40, true)]) {
    const { out, close } = run([HANDSHAKE, dropped, updateRequest]);
    assert.equal(close, undefined, `type ${String(dropped[0])}`);
    assert.deepEqual(out, Buffer.concat([HANDSHAKE, updateRequest]), `type ${String(dropped[0])}`);
  }
});

test('xvp, SetDesktopSize, QEMU and every unknown type close the connection', () => {
  for (const type of [250, 251, 255, 1, 7, 8, 127, 149, 249, 252]) {
    const { out, close } = run([HANDSHAKE, Buffer.from([type, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
    assert.equal(close, 'refused-type', `type ${String(type)}`);
    assert.deepEqual(out, HANDSHAKE);
  }
  // A forwarded message before the refused one still goes; nothing after it.
  const { out, close } = run([Buffer.concat([HANDSHAKE, updateRequest, Buffer.from([251, 0, 0, 0]), updateRequest])]);
  assert.equal(close, 'refused-type');
  assert.deepEqual(out, Buffer.concat([HANDSHAKE, updateRequest]));
});

test('messages split byte by byte, and glued together, give the same stream', () => {
  const stream = Buffer.concat([HANDSHAKE, setPixelFormat, setEncodings(20), keyEvent, updateRequest, pointerEvent, cutText(300, true), continuous, fence(12), updateRequest]);
  const expected = Buffer.concat([HANDSHAKE, setPixelFormat, setEncodings(20), updateRequest, continuous, fence(12), updateRequest]);
  const whole = run([stream]);
  assert.equal(whole.close, undefined);
  assert.deepEqual(whole.out, expected);
  const bytes = run([...stream].map((byte) => Buffer.from([byte])));
  assert.equal(bytes.close, undefined);
  assert.deepEqual(bytes.out, expected);
  const uneven: Buffer[] = [];
  for (let at = 0, size = 1; at < stream.length; at += size, size = (size % 7) + 3) uneven.push(stream.subarray(at, at + size));
  assert.deepEqual(run(uneven).out, expected);
  // A half message forwards nothing yet.
  const filter = createRfbFilter();
  filter.push(HANDSHAKE);
  assert.deepEqual(filter.push(updateRequest.subarray(0, 9)).forward, []);
  assert.deepEqual(Buffer.concat(filter.push(updateRequest.subarray(9)).forward), updateRequest);
});

test('long messages: SetEncodings, ClientFence and ClientCutText have a cap', () => {
  assert.equal(run([HANDSHAKE, setEncodings(MAX_ENCODINGS)]).close, undefined);
  assert.equal(run([HANDSHAKE, setEncodings(MAX_ENCODINGS + 1)]).close, 'too-long');
  // The header alone is enough to refuse it.
  assert.equal(run([HANDSHAKE, Buffer.from([2, 0, 0xff, 0xff])]).close, 'too-long');
  assert.equal(run([HANDSHAKE, fence(MAX_FENCE + 1)]).close, 'too-long');
  assert.equal(run([HANDSHAKE, cutText(MAX_CUT_TEXT)]).close, undefined);
  assert.equal(run([HANDSHAKE, cutText(MAX_CUT_TEXT + 1).subarray(0, 8)]).close, 'too-long');
  assert.equal(run([HANDSHAKE, cutText(MAX_CUT_TEXT + 1, true).subarray(0, 8)]).close, 'too-long');
  assert.equal(run([HANDSHAKE, Buffer.from([6, 0, 0, 0, 0x80, 0, 0, 0])]).close, 'too-long');
});

test('after a close nothing passes any more', () => {
  const filter = createRfbFilter();
  assert.equal(filter.push(Buffer.from('RFB 003.007\n', 'latin1')).close, 'bad-version');
  assert.deepEqual(filter.push(HANDSHAKE), { forward: [], close: 'bad-version' });
});
