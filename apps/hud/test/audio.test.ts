import assert from 'node:assert/strict';
import { test } from 'node:test';

import { concat, downsample, peak, toBase64, toPcm16 } from '../src/lib/audio.ts';
import { blocker, missingBytes, rolesSnippet, secondsText, sizeText } from '../src/lib/voice-trial.ts';
import { isVoiceTrialPath, conversationFromPath, VOICE_TRIAL_PATH } from '../src/lib/route.ts';

test('downsample: 48 kHz to 16 kHz averages each group of three; same rate copies; upsampling is refused', () => {
  const input = Float32Array.from([0, 0.3, 0.6, 1, 1, 1, -1, 0, 1]);
  assert.deepEqual([...downsample(input, 48_000)].map((value) => Math.round(value * 100) / 100), [0.3, 1, 0]);
  assert.equal(downsample(new Float32Array(44_100), 44_100).length, 16_000);
  assert.deepEqual([...downsample(input, 16_000)], [...input]);
  assert.throws(() => downsample(input, 8_000), RangeError);
  assert.throws(() => downsample(input, 0), RangeError);
});

test('toPcm16: little-endian 16-bit, clipped at the extremes', () => {
  const bytes = toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  const view = new DataView(bytes.buffer);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((index) => view.getInt16(index * 2, true)), [0, 32767, -32768, 32767, -32768, 16384]);
});

test('concat, peak and base64 of a long recording', () => {
  assert.deepEqual([...concat([Float32Array.from([1, 2]), Float32Array.from([3])])], [1, 2, 3]);
  assert.equal(peak(Float32Array.from([0.1, -0.7, 0.3])), Math.fround(0.7));
  const long = new Uint8Array(30 * 16_000 * 2).map((_, index) => index % 251);
  assert.equal(toBase64(long), Buffer.from(long).toString('base64'));
});

test('voice trial texts: what blocks the page, sizes, seconds and the lines for [roles]', () => {
  assert.equal(blocker('up'), undefined);
  assert.match(blocker('off')?.title ?? '', /spente/);
  assert.ok(blocker('not-installed')?.steps.some((step) => step.includes('brew install uv')));
  assert.match(blocker('starting')?.title ?? '', /avviando/);
  assert.equal(sizeText(2_508_288_736 + 1_000_000), '2,5 GB');
  assert.equal(sizeText(330_000_000), '330 MB');
  assert.equal(secondsText(1.25), '1,3 s');
  assert.equal(rolesSnippet('a', undefined), '[roles]\nstt = "a"');
  assert.equal(rolesSnippet('a', 'b'), '[roles]\nstt = "a"\ntts = "b"');
  const model = { id: 'x', family: 'kokoro', kind: 'tts' as const, assigned: false, voices: [] };
  assert.equal(missingBytes([{ ...model, present: false, sizeBytes: 5 }, { ...model, present: true, sizeBytes: 7 }]), 5);
});

test('the voice trial has its own address, which opens no conversation', () => {
  assert.ok(isVoiceTrialPath(VOICE_TRIAL_PATH));
  assert.ok(isVoiceTrialPath(`${VOICE_TRIAL_PATH}/`));
  for (const path of ['/', '/voce', '/voce/provino/x', '/c/voce']) assert.ok(!isVoiceTrialPath(path), path);
  assert.equal(conversationFromPath(VOICE_TRIAL_PATH), undefined);
});
