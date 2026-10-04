/**
 * Audio of the voice trial page (D-066), pure so that it is tested without a
 * browser: the microphone gives floats at the device rate (44.1 or 48 kHz),
 * the speech-to-text models want 16 kHz 16-bit mono.
 */
export const STT_RATE = 16_000;
/** apps/voice refuses recordings outside this range. */
export const MIN_SECONDS = 0.3;
export const MAX_SECONDS = 30;

/** Averages the input over each output sample: a box filter is enough for speech at 16 kHz. */
export function downsample(input: Float32Array, fromRate: number, toRate: number = STT_RATE): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('rates must be positive');
  if (fromRate === toRate) return input.slice();
  if (fromRate < toRate) throw new RangeError('only downsampling');
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let at = start; at < end; at += 1) sum += input[at] ?? 0;
    output[index] = end > start ? sum / (end - start) : 0;
  }
  return output;
}

/** Floats in [-1, 1] to 16-bit little-endian bytes, clipped. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, Math.round(clipped < 0 ? clipped * 32768 : clipped * 32767), true);
  });
  return bytes;
}

/** Joins the chunks the recorder posts. */
export function concat(chunks: readonly Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** Standard base64, in slices so that a long recording does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/** The loudest sample: the page warns when the microphone heard almost nothing. */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (const sample of samples) max = Math.max(max, Math.abs(sample));
  return max;
}
