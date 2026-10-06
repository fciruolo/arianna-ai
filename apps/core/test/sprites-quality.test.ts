// What looks wrong in a valid drawing (D-132): the hand-drawn characters pass,
// each rule refuses a drawing that breaks it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXAMPLES } from '../src/sprites/prompt.ts';
import { frameOf, spritePreview, spriteProblems, type SpriteProblem } from '../src/sprites/quality.ts';
import { checkSprite, type SpriteSpec } from '../src/sprites/spec.ts';

const coder = (): SpriteSpec => {
  const example = EXAMPLES[1];
  if (example === undefined) throw new Error('the Coder is the second example');
  return structuredClone(example.spec);
};
const rules = (spec: SpriteSpec): SpriteProblem['rule'][] => spriteProblems(checkSprite(spec)).map((problem) => problem.rule);
const set = (rows: string[], y: number, x: number, letter: string): void => {
  const line = rows[y] ?? '';
  rows[y] = line.slice(0, x) + letter + line.slice(x + 1);
};

describe('the quality of a drawing', () => {
  it('the three hand-drawn examples have nothing to fix', () => {
    assert.equal(EXAMPLES.length, 3);
    for (const { about, spec } of EXAMPLES) assert.deepEqual(spriteProblems(spec), [], about);
  });

  it('symmetry: a front view with a side missing is refused', () => {
    const spec = coder();
    spec.body.front = spec.body.front.map((line) => `${line.slice(0, 12)}....`);
    assert.ok(rules(spec).includes('symmetry'));
  });

  it('symmetry: colours different on the two sides are refused, one accessory is not', () => {
    const one = coder();
    set(one.body.front, 3, 10, 'c');
    assert.ok(!rules(one).includes('symmetry'));
    const many = coder();
    many.body.front = many.body.front.map((line, y) => (y >= 2 && y <= 5 ? `${line.slice(0, 4)}kkkk${line.slice(8)}` : line));
    assert.ok(rules(many).includes('symmetry'));
  });

  it('outline: a figure without its outline is refused', () => {
    const spec = coder();
    spec.body.front = spec.body.front.map((line) => line.replaceAll('o', 'b'));
    assert.ok(rules(spec).includes('outline'));
  });

  it('eyes: two eyes on the same row, apart, with face around; one in the side view, on the right', () => {
    const touching = coder();
    touching.head.front = touching.head.front.map((line) => line.replace('vevvev', 'veevvv'));
    assert.match(spriteProblems(checkSprite(touching)).map((problem) => problem.text).join(), /too close/);
    const three = coder();
    set(three.head.front, 6, 7, 'e');
    assert.match(spriteProblems(checkSprite(three)).map((problem) => problem.text).join(), /3 eye pixels/);
    const edge = coder();
    // An eye next to the outline cannot look sideways.
    edge.head.front = edge.head.front.map((line) => line.replace('ogvevvevgo', 'oevvvvvveo'));
    assert.match(spriteProblems(checkSprite(edge)).map((problem) => problem.text).join(), /cannot move/);
    const left = coder();
    left.head.side = left.head.side.map((line) => line.replace('ogggggvveo', 'oegggggvvo'));
    assert.match(spriteProblems(checkSprite(left)).map((problem) => problem.text).join(), /left half/);
    const pale = coder();
    pale.palette.e = pale.palette.v ?? '#000000';
    assert.match(spriteProblems(checkSprite(pale)).map((problem) => problem.text).join(), /too close to the face/);
  });

  it('colours: a light outline and a single colour are refused', () => {
    const light = coder();
    light.palette.o = '#c0c0c0';
    assert.ok(rules(light).includes('colours'));
    const flat = coder();
    const only = (rows: string[]): string[] => rows.map((line) => line.replace(/[^.oeEs]/g, 'g'));
    for (const group of [flat.head, flat.body, flat.legs] as Record<string, string[]>[]) {
      for (const view of Object.keys(group)) group[view] = only(group[view] ?? []);
    }
    assert.ok(rules(flat).includes('colours'));
  });

  it('centre and pieces: a figure moved to the side, or a head floating over the body, is refused', () => {
    const moved = coder();
    for (const group of [moved.head, moved.body, moved.legs] as Record<string, string[]>[]) {
      for (const view of Object.keys(group)) group[view] = (group[view] ?? []).map((line) => `..${line.slice(0, 14)}`);
    }
    assert.ok(rules(moved).includes('centre'));
    const floating = coder();
    floating.body.front = ['.'.repeat(16), ...floating.body.front.slice(1)];
    assert.ok(rules(floating).includes('pieces'));
  });

  it('proportions: an empty top row of the head or bottom row of the legs, or a small head, is refused', () => {
    const texts = (spec: SpriteSpec): string => spriteProblems(checkSprite(spec)).map((problem) => problem.text).join();
    const legs = coder();
    legs.legs.stride = [...legs.legs.stride.slice(0, 5), '.'.repeat(16)];
    assert.match(texts(legs), /legs\.stride is empty/);
    const top = coder();
    top.head.back = ['.'.repeat(16), ...top.head.back.slice(1)];
    assert.match(texts(top), /first row of head\.back is empty/);
    const small = coder();
    small.head.front = small.head.front.map((line) => `.....${line.slice(5, 11)}.....`);
    assert.match(texts(small), /pixels wide/);
  });

  it('eyes on different rows, and a side eye that cannot look down, are refused', () => {
    const texts = (spec: SpriteSpec): string => spriteProblems(checkSprite(spec)).map((problem) => problem.text).join();
    const rows = coder();
    rows.head.front = rows.head.front.map((line, y) => (y === 5 ? line.replace('vevvev', 'vevvvv') : y === 6 ? line.replace('vvvvvv', 'vvvvev') : line));
    assert.match(texts(rows), /not on the same row/);
    const side = coder();
    side.head.side = side.head.side.map((line, y) => (y === 6 ? line.replace('ogggggvvvo', 'oooooooooo') : line));
    assert.match(texts(side), /cannot move one pixel down/);
  });

  it('pieces: legs apart from the body are refused', () => {
    const spec = coder();
    spec.legs.front = ['.'.repeat(16), ...spec.legs.front.slice(1)];
    assert.ok(rules(spec).includes('pieces'));
  });

  it('the preview shows the three views on rows 7-31', () => {
    const spec = coder();
    const preview = spritePreview(spec).split('\n');
    assert.equal(preview.length, 1 + 25);
    assert.equal(preview[1], `  7  ${frameOf(spec, 'front')[7] ?? ''}  ${frameOf(spec, 'side')[7] ?? ''}  ${frameOf(spec, 'back')[7] ?? ''}`);
  });
});
