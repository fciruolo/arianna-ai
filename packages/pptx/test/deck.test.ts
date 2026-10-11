import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DeckError, parseDeck } from '../src/index.ts';

const ok = { title: 'Deck', slides: [{ title: 'One' }] };

function rejects(raw: unknown, message: RegExp): void {
  assert.throws(() => parseDeck(raw), (error: unknown) => error instanceof DeckError && message.test(error.message));
}

function slide(fields: Record<string, unknown>): unknown {
  return { title: 'Deck', slides: [fields] };
}

test('a full deck is accepted and colours are lowercased', () => {
  const deck = parseDeck({
    title: 'Deck',
    slides: [
      {
        title: 'T',
        subtitle: 'S',
        paragraphs: ['p1', 'line\nbreak\twith tab'],
        bullets: ['b1'],
        notes: 'n',
        background: '#AABBCC',
        color: '#000000',
        accent: '#ffFFff',
      },
      {},
    ],
  });
  assert.deepEqual(deck, {
    title: 'Deck',
    slides: [
      {
        title: 'T',
        subtitle: 'S',
        paragraphs: ['p1', 'line\nbreak\twith tab'],
        bullets: ['b1'],
        notes: 'n',
        background: '#aabbcc',
        color: '#000000',
        accent: '#ffffff',
      },
      {},
    ],
  });
});

test('the deck must be an object with known keys', () => {
  rejects(null, /deck: expected an object/);
  rejects([], /deck: expected an object/);
  rejects('deck', /deck: expected an object/);
  rejects({ ...ok, extra: 1 }, /deck: unknown key "extra"/);
  rejects(slide({ title: 'x', image: 'a.png' }), /slides\[0\]: unknown key "image"/);
  rejects({ title: 'Deck', slides: [null] }, /slides\[0\]: expected an object/);
});

test('deck title: 1-200 characters, not blank', () => {
  assert.equal(parseDeck({ ...ok, title: 'x'.repeat(200) }).title.length, 200);
  // Characters, not UTF-16 units.
  assert.equal(parseDeck({ ...ok, title: '\u{1F600}'.repeat(200) }).title.length, 400);
  rejects({ ...ok, title: 'x'.repeat(201) }, /deck\.title: longer than 200/);
  rejects({ ...ok, title: '' }, /deck\.title: must not be empty/);
  rejects({ ...ok, title: '   ' }, /deck\.title: must not be empty/);
  rejects({ slides: ok.slides }, /deck\.title: expected a string/);
  rejects({ ...ok, title: 3 }, /deck\.title: expected a string/);
});

test('slides: 1-200', () => {
  assert.equal(parseDeck({ title: 'D', slides: Array.from({ length: 200 }, () => ({})) }).slides.length, 200);
  rejects({ title: 'D', slides: Array.from({ length: 201 }, () => ({})) }, /more than 200 slides/);
  rejects({ title: 'D', slides: [] }, /at least one slide/);
  rejects({ title: 'D' }, /deck\.slides: expected an array/);
  rejects({ title: 'D', slides: {} }, /deck\.slides: expected an array/);
});

test('title and subtitle: at most 300 characters', () => {
  for (const key of ['title', 'subtitle']) {
    assert.equal(parseDeck(slide({ [key]: 'x'.repeat(300) })).slides[0]?.[key as 'title'], 'x'.repeat(300));
    assert.equal(parseDeck(slide({ [key]: '' })).slides[0]?.[key as 'title'], '');
    rejects(slide({ [key]: 'x'.repeat(301) }), new RegExp(`\\.${key}: longer than 300`));
    rejects(slide({ [key]: 1 }), new RegExp(`\\.${key}: expected a string`));
  }
});

test('paragraphs: at most 30, each at most 2000 characters', () => {
  assert.equal(parseDeck(slide({ paragraphs: Array.from({ length: 30 }, () => 'x'.repeat(2000)) })).slides[0]?.paragraphs?.length, 30);
  rejects(slide({ paragraphs: Array.from({ length: 31 }, () => 'p') }), /paragraphs: more than 30 items/);
  rejects(slide({ paragraphs: ['x'.repeat(2001)] }), /paragraphs\[0\]: longer than 2000/);
  rejects(slide({ paragraphs: 'p' }), /paragraphs: expected an array/);
  rejects(slide({ paragraphs: ['ok', 2] }), /paragraphs\[1\]: expected a string/);
});

test('bullets: at most 30, each at most 500 characters', () => {
  assert.equal(parseDeck(slide({ bullets: Array.from({ length: 30 }, () => 'x'.repeat(500)) })).slides[0]?.bullets?.length, 30);
  rejects(slide({ bullets: Array.from({ length: 31 }, () => 'b') }), /bullets: more than 30 items/);
  rejects(slide({ bullets: ['x'.repeat(501)] }), /bullets\[0\]: longer than 500/);
  rejects(slide({ bullets: [null] }), /bullets\[0\]: expected a string/);
});

test('notes: at most 5000 characters', () => {
  assert.equal(parseDeck(slide({ notes: 'x'.repeat(5000) })).slides[0]?.notes?.length, 5000);
  rejects(slide({ notes: 'x'.repeat(5001) }), /notes: longer than 5000/);
  rejects(slide({ notes: ['n'] }), /notes: expected a string/);
});

test('colours: #rrggbb only', () => {
  for (const key of ['background', 'color', 'accent']) {
    assert.equal(parseDeck(slide({ [key]: '#0a0B0c' })).slides[0]?.[key as 'color'], '#0a0b0c');
    for (const bad of ['#fff', '0a0b0c', '#0a0b0g', '#0a0b0c0d', 'red', ' #0a0b0c', 12]) {
      rejects(slide({ [key]: bad }), new RegExp(`\\.${key}: expected #rrggbb`));
    }
  }
});

test('control characters are refused, except newline and tab', () => {
  assert.equal(parseDeck(slide({ notes: 'a\nb\tc' })).slides[0]?.notes, 'a\nb\tc');
  for (const bad of ['\u0000', '\u0007', '\r', '\u000B', '\u001F', '\u007F', '\u0085', '\uD800', 'a\uDC00b']) {
    rejects(slide({ title: `x${bad}y` }), /control characters/);
    rejects(slide({ bullets: [`x${bad}`] }), /bullets\[0\]: control characters/);
  }
  rejects({ title: 'D\u0000', slides: [{}] }, /deck\.title: control characters/);
  // XML 1.0 noncharacters.
  rejects(slide({ notes: String.fromCharCode(0xfffe) }), /control characters/);
  rejects(slide({ notes: String.fromCharCode(0xffff) }), /control characters/);
  // Paired surrogates are fine.
  assert.equal(parseDeck(slide({ title: '\u{1F600}' })).slides[0]?.title, '\u{1F600}');
});
