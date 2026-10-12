// The Studio (I-19, D-184): the isolated srcdoc, the Studio's script, the
// messages from the frame, the variants, the message of revision, the styles
// of the direct edit and the deck. Every name and text here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';

import { ApiError } from '../src/lib/api.ts';
import {
  buildSrcdoc,
  excerptMatches,
  excerptOf,
  highlightMessage,
  isStudioSelector,
  looksMessage,
  modeMessage,
  nthSelector,
  parseFrameMessage,
  pickedExcerpt,
  STUDIO_CSP,
  STUDIO_SOURCE,
  studioScript,
} from '../src/lib/studio-frame.ts';
import {
  commentProblem,
  cutText,
  deckFromParts,
  editProblems,
  exportName,
  fontName,
  groupMockups,
  hexColor,
  isMockupPath,
  isStudioPath,
  nextVariantName,
  pickMockup,
  pointsFrom,
  respace,
  reviewMessage,
  slideText,
  studioErrorText,
  studioFromSearch,
  studioPathFor,
  validStyle,
  variantLabel,
  type Mockup,
  type StudioComment,
} from '../src/lib/studio.ts';

function mockup(name: string, group: string, variant: number | null, modified = '2026-10-12T10:00:00.000Z'): Mockup {
  return { path: `mockups/${name}`, name, group, variant, bytes: 100, modified, sha256: 'a'.repeat(64) };
}

test('the address of the Studio carries project and file', () => {
  assert.equal(isStudioPath('/studio'), true);
  assert.equal(isStudioPath('/studio/'), true);
  assert.equal(isStudioPath('/studio/x'), false);
  assert.equal(studioPathFor(), '/studio');
  const path = studioPathFor({ project: 'Sito Rossi', file: 'mockups/landing-2.html' });
  assert.equal(path, '/studio?progetto=Sito+Rossi&file=mockups%2Flanding-2.html');
  assert.deepEqual(studioFromSearch(path.slice('/studio'.length)), { project: 'Sito Rossi', file: 'mockups/landing-2.html' });
  assert.deepEqual(studioFromSearch('?progetto=&file=%20'), {});
});

test('the srcdoc puts the policy right after the doctype, before any element', () => {
  const source = '<!DOCTYPE html>\n<html><head><script>alert(1)</script><title>Prova</title></head><body><p>Ciao</p></body></html>';
  const doc = buildSrcdoc(source, 'plain');
  assert.ok(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"'));
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<html>'));
  assert.ok(doc.endsWith('<body><p>Ciao</p></body></html>'));
  assert.equal(doc.includes('data-arianna-studio'), false);
});

test('without a doctype the policy is the very first thing; leading comments stay before it', () => {
  assert.ok(buildSrcdoc('<p>Senza doctype</p>', 'plain').startsWith('<meta http-equiv="Content-Security-Policy"'));
  const commented = buildSrcdoc('<!-- nota --><!doctype html><p>x</p>', 'plain');
  assert.ok(commented.startsWith('<!-- nota --><!doctype html><meta'));
});

test('the policy forbids the network and allows only inline, data: and blob:', () => {
  assert.match(STUDIO_CSP, /default-src 'none'/);
  assert.match(STUDIO_CSP, /connect-src 'none'/);
  assert.match(STUDIO_CSP, /form-action 'none'/);
  assert.match(STUDIO_CSP, /base-uri 'none'/);
  assert.doesNotMatch(STUDIO_CSP, /https?:|\*|'self'/);
  assert.doesNotMatch(STUDIO_CSP, /"/);
});

test('the studio mode adds the marked script, the print mode only the print', () => {
  const studio = buildSrcdoc('<!doctype html><body></body>', 'studio');
  assert.match(studio, /<script data-arianna-studio>/);
  assert.ok(studio.indexOf('data-arianna-studio') < studio.indexOf('<body>'));
  const print = buildSrcdoc('<!doctype html><body></body>', 'print');
  assert.match(print, /window\.print\(\)/);
  assert.doesNotMatch(print, /postMessage/);
});

test('the Studio script is valid JavaScript on its own and never closes its element early', () => {
  const script = studioScript();
  assert.doesNotThrow(() => new Script(script));
  assert.doesNotMatch(script, /<\/script/i);
  assert.match(script, /arianna-studio/);
  assert.match(script, /nth-of-type/);
});

test('selectors carry :nth-of-type at every step from body', () => {
  assert.equal(nthSelector([]), 'body');
  assert.equal(
    nthSelector([
      { tag: 'main', index: 1 },
      { tag: 'section', index: 3 },
      { tag: 'h2', index: 1 },
    ]),
    'body > main:nth-of-type(1) > section:nth-of-type(3) > h2:nth-of-type(1)',
  );
  assert.equal(isStudioSelector('body > div:nth-of-type(2)'), true);
  assert.equal(isStudioSelector('body > div'), false);
  assert.equal(isStudioSelector('body > div:nth-of-type(0)'), false);
  assert.equal(isStudioSelector('body > img[src=x]'), false);
  assert.equal(isStudioSelector('html'), false);
});

test('the excerpt is one line of at most 120 characters', () => {
  assert.equal(excerptOf('  Ciao\n\n  mondo  ', 120), 'Ciao mondo');
  const long = excerptOf('parola '.repeat(40), 120);
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith('…'));
});

const pick = {
  source: STUDIO_SOURCE,
  type: 'pick',
  selector: 'body > main:nth-of-type(1) > h1:nth-of-type(1)',
  rect: { x: 10, y: 20, width: 300, height: 40 },
  tag: 'h1',
  excerpt: 'Benvenuti da Pasticceria Aurora',
};

test('a pick message of the right shape is accepted', () => {
  assert.deepEqual(parseFrameMessage(pick), {
    type: 'pick',
    selector: pick.selector,
    rect: pick.rect,
    tag: 'h1',
    excerpt: 'Benvenuti da Pasticceria Aurora',
  });
  assert.deepEqual(parseFrameMessage({ source: STUDIO_SOURCE, type: 'ready' }), { type: 'ready' });
});

test('messages of another shape are refused', () => {
  assert.equal(parseFrameMessage(null), undefined);
  assert.equal(parseFrameMessage('pick'), undefined);
  assert.equal(parseFrameMessage({ ...pick, source: 'other' }), undefined);
  assert.equal(parseFrameMessage({ ...pick, type: 'navigate' }), undefined);
  assert.equal(parseFrameMessage({ ...pick, extra: 1 }), undefined);
  assert.equal(parseFrameMessage({ ...pick, excerpt: 'x'.repeat(121) }), undefined);
  assert.equal(parseFrameMessage({ ...pick, selector: 'body > h1' }), undefined);
  assert.equal(parseFrameMessage({ ...pick, tag: 'h2' }), undefined);
  assert.equal(parseFrameMessage({ ...pick, rect: { x: 1, y: 2, width: -3, height: 4 } }), undefined);
  assert.equal(parseFrameMessage({ ...pick, rect: { x: Number.NaN, y: 2, width: 3, height: 4 } }), undefined);
  assert.equal(parseFrameMessage({ ...pick, rect: { x: 1, y: 2, width: 3, height: 4, z: 5 } }), undefined);
  assert.equal(parseFrameMessage({ source: STUDIO_SOURCE, type: 'ready', more: true }), undefined);
});

const look = { width: 960, background: '#f4f1ea', color: '#222222', accent: '#8a3b12', titleFont: 'Georgia, serif', bodyFont: 'system-ui, sans-serif', titlePx: 40, bodyPx: 16 };

test('a looks message of the right shape is accepted', () => {
  assert.deepEqual(looksMessage(), { source: STUDIO_SOURCE, type: 'looks' });
  assert.deepEqual(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: [look, { ...look, accent: null, titleFont: null, titlePx: null }] }), {
    type: 'looks',
    slides: [look, { ...look, accent: null, titleFont: null, titlePx: null }],
  });
  assert.equal(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: [{ ...look, width: 2560, background: null }] })?.type, 'looks');
  assert.deepEqual(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: [] }), { type: 'looks', slides: [] });
});

test('looks of another shape are refused', () => {
  const bad = (slide: Record<string, unknown>): void => {
    assert.equal(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: [look, slide] }), undefined);
  };
  bad({ ...look, background: 'red' });
  bad({ ...look, color: '#FFF' });
  bad({ ...look, width: 0 });
  bad({ ...look, width: null });
  bad({ ...look, width: 20_001 });
  bad({ ...look, titlePx: -1 });
  bad({ ...look, bodyPx: Number.POSITIVE_INFINITY });
  bad({ ...look, bodyFont: 'x'.repeat(301) });
  bad({ ...look, extra: 1 });
  bad(Object.fromEntries(Object.entries(look).filter(([key]) => key !== 'accent')));
  assert.equal(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: Array.from({ length: 201 }, () => look) }), undefined);
  assert.equal(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: look }), undefined);
  assert.equal(parseFrameMessage({ source: STUDIO_SOURCE, type: 'looks', slides: [], more: 1 }), undefined);
});

test('the font of a computed font-family for PowerPoint', () => {
  assert.equal(fontName('"Playfair Display", Georgia, serif'), 'Playfair Display');
  assert.equal(fontName("'Gill Sans', sans-serif"), 'Gill Sans');
  assert.equal(fontName('serif'), 'Times New Roman');
  assert.equal(fontName('ui-monospace, monospace'), 'Courier New');
  assert.equal(fontName('system-ui, sans-serif'), undefined);
  assert.equal(fontName('-apple-system, BlinkMacSystemFont, Helvetica'), undefined);
  assert.equal(fontName('"Font<x>", serif'), undefined);
  assert.equal(fontName(''), undefined);
  assert.equal(fontName(null), undefined);
});

test('sizes on screen become points of a 960-point slide', () => {
  assert.equal(pointsFrom(40, 960), 40);
  assert.equal(pointsFrom(40, 1920), 20);
  assert.equal(pointsFrom(16, 390), 39);
  assert.equal(pointsFrom(2, 960), 8);
  assert.equal(pointsFrom(400, 960), 120);
  assert.equal(pointsFrom(null, 960), undefined);
  assert.equal(pointsFrom(16, 0), undefined);
});

test('an edit of the text pieces counts toward the limits', () => {
  assert.deepEqual(editProblems({ selector: 'body', segments: ['Un solo interlocutore.', ' che lavora per te.'], styles: {} }), []);
  assert.deepEqual(editProblems({ selector: 'body', segments: ['x'.repeat(3000), 'y'.repeat(2001)], styles: {} }), ['Testo']);
  assert.deepEqual(editProblems({ selector: 'body', segments: Array.from({ length: 21 }, () => 'z'), styles: {} }), ['Testo']);
});

test('a text piece keeps the blanks around it', () => {
  assert.equal(respace('Un solo interlocutore. ', 'Uno unico.'), 'Uno unico. ');
  assert.equal(respace('\n  che lavora per te.\n', '  per te  '), '\n  per te\n');
  assert.equal(respace(' x ', ''), '  ');
  assert.equal(respace('x', 'riga uno\nriga due'), 'riga uno\nriga due');
});

test('the deck carries fonts and sizes', () => {
  const slide = deckFromParts('T', [{ title: 'Titolo', paragraphs: ['Testo'], bullets: [], titleFont: 'Georgia, serif', bodyFont: 'system-ui', titleSize: 40, bodySize: 16 }])?.slides.at(0);
  assert.deepEqual(slide, { title: 'Titolo', paragraphs: ['Testo'], titleFont: 'Georgia', titleSize: 40, bodySize: 16 });
  const clamped = deckFromParts('T', [{ paragraphs: [], bullets: [], titleSize: 300.4, bodySize: 3.2 }])?.slides.at(0);
  assert.deepEqual(clamped, { titleSize: 120, bodySize: 8 });
});

test('control characters of an excerpt become spaces', () => {
  const message = parseFrameMessage({ ...pick, excerpt: 'a\u0007b' });
  assert.equal(message?.type === 'pick' ? message.excerpt : undefined, 'a b');
});

test('the page sends modes and highlights of fixed shape; a foreign selector becomes none', () => {
  assert.deepEqual(modeMessage(true), { source: STUDIO_SOURCE, type: 'mode', comment: true });
  assert.equal(highlightMessage('body > p:nth-of-type(1)').selector, 'body > p:nth-of-type(1)');
  assert.equal(highlightMessage('*').selector, null);
});

test('the mockups paths of a delegation', () => {
  assert.equal(isMockupPath('mockups/landing.html'), true);
  assert.equal(isMockupPath('docs/mockups/studio-2.html'), true);
  assert.equal(isMockupPath('mockups/sub/landing.html'), false);
  assert.equal(isMockupPath('mockups/.nascosto.html'), false);
  assert.equal(isMockupPath('src/mockups/landing.html'), false);
  assert.equal(isMockupPath('mockups/landing.css'), false);
});

test('variants are grouped, without number first, and the next name follows the last', () => {
  const files = [mockup('landing-2.html', 'landing', 2), mockup('about.html', 'about', null), mockup('landing.html', 'landing', null), mockup('landing-3.html', 'landing', 3)];
  const groups = groupMockups(files);
  assert.deepEqual(
    groups.map((group) => [group.group, group.variants.map((file) => file.name)]),
    [
      ['about', ['about.html']],
      ['landing', ['landing.html', 'landing-2.html', 'landing-3.html']],
    ],
  );
  assert.equal(nextVariantName('landing', files), 'landing-4.html');
  assert.equal(nextVariantName('about', files), 'about-2.html');
  assert.equal(variantLabel(mockup('about.html', 'about', null)), 'base');
  assert.equal(variantLabel(mockup('landing-2.html', 'landing', 2)), 'v2');
});

test('the first mockup shown is the one asked for, or the most recent', () => {
  const files = [mockup('a.html', 'a', null, '2026-10-10T10:00:00.000Z'), mockup('b.html', 'b', null, '2026-10-12T10:00:00.000Z')];
  assert.equal(pickMockup(files, 'mockups/a.html')?.name, 'a.html');
  assert.equal(pickMockup(files, 'mockups/zzz.html')?.name, 'b.html');
  assert.equal(pickMockup([], undefined), undefined);
});

test('the comments leave as one message, by file, with selector, excerpt and comment', () => {
  const files = [mockup('landing.html', 'landing', null), mockup('landing-2.html', 'landing', 2)];
  const comments: StudioComment[] = [
    { id: 1, file: 'mockups/landing-2.html', selector: 'body > h1:nth-of-type(1)', tag: 'h1', excerpt: 'Benvenuti', text: 'Titolo più grande' },
    { id: 2, file: 'mockups/landing-2.html', selector: 'body > a:nth-of-type(2)', tag: 'a', excerpt: '', text: 'Bottone\nverde' },
  ];
  const text = reviewMessage(comments, files);
  assert.match(text, /^Revisione dallo Studio/);
  assert.match(text, /File: mockups\/landing-2\.html → scrivi mockups\/landing-3\.html/);
  assert.match(text, /1\. Elemento `body > h1:nth-of-type\(1\)` \(h1, «Benvenuti»\)/);
  assert.match(text, / {3}Commento: Titolo più grande/);
  assert.match(text, /2\. Elemento `body > a:nth-of-type\(2\)` \(a\)\n {3}Commento: Bottone verde/);
  assert.equal(commentProblem('  '), 'Scrivi il commento.');
  assert.equal(commentProblem('ok'), undefined);
  assert.notEqual(commentProblem('x'.repeat(2001)), undefined);
});

test('only plain values of the allowed styles pass', () => {
  assert.equal(validStyle('color', '#1f2933'), true);
  assert.equal(validStyle('color', 'rgb(31 41 51)'), true);
  assert.equal(validStyle('background-color', 'rgba(0, 0, 0, 0.5)'), true);
  assert.equal(validStyle('color', 'teal'), true);
  assert.equal(validStyle('color', 'url(x)'), false);
  assert.equal(validStyle('color', 'red; position: fixed'), false);
  assert.equal(validStyle('color', 'var(--x)'), false);
  assert.equal(validStyle('color', 'inherit'), false);
  assert.equal(validStyle('font-size', '18px'), true);
  assert.equal(validStyle('font-size', '1.25rem'), true);
  assert.equal(validStyle('font-size', 'calc(1px + 2px)'), false);
  assert.equal(validStyle('font-weight', '700'), true);
  assert.equal(validStyle('font-weight', '750'), false);
  assert.equal(validStyle('padding', '8px 16px'), true);
  assert.equal(validStyle('padding', '-4px'), false);
  assert.equal(validStyle('margin', '0 auto'), true);
  assert.equal(validStyle('margin', '-8px 0'), true);
  assert.equal(validStyle('margin', '1px 2px 3px 4px 5px'), false);
  assert.equal(validStyle('text-align', 'center'), true);
  assert.equal(validStyle('text-align', 'middle'), false);
  assert.equal(validStyle('border-radius', '50%'), true);
  assert.equal(validStyle('border-radius', 'round'), false);
  assert.equal(validStyle('padding', ''), true);
  assert.deepEqual(editProblems({ selector: 'body', styles: { color: 'red', padding: 'x' } }), ['Spaziatura interna']);
  assert.deepEqual(editProblems({ selector: 'body', styles: { position: 'fixed' } as never }), ['position']);
});

test('the deck keeps the limits of the contract', () => {
  assert.equal(deckFromParts('Vuoto', []), undefined);
  const deck = deckFromParts('  Piano  2027 ', [
    { title: ' Apertura ', subtitle: '', paragraphs: ['Uno', '  ', 'Due'], bullets: Array.from({ length: 40 }, (_, at) => `Punto ${String(at)}`), notes: 'Note\u0001 del relatore', background: '#FFF', color: '#123456', accent: 'red' },
    { paragraphs: [], bullets: [], title: 'x'.repeat(400) },
  ]);
  assert.ok(deck !== undefined);
  assert.equal(deck.title, 'Piano 2027');
  const first = deck.slides.at(0);
  const second = deck.slides.at(1);
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.title, 'Apertura');
  assert.equal(first.subtitle, undefined);
  assert.deepEqual(first.paragraphs, ['Uno', 'Due']);
  assert.equal(first.bullets?.length, 30);
  assert.equal(first.notes, 'Note del relatore');
  assert.equal(first.background, '#ffffff');
  assert.equal(first.color, '#123456');
  assert.equal('accent' in first, false);
  assert.equal(second.title?.length, 300);
  assert.equal('paragraphs' in second, false);
  assert.equal(hexColor('#abc'), '#aabbcc');
  assert.equal(hexColor('blue'), undefined);
});

// Every character parseDeck of @arianna/pptx refuses.
// eslint-disable-next-line no-control-regex
const REFUSED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('slide text: line ends as \\n, without what a slide cannot hold', () => {
  assert.equal(slideText('uno\r\ndue\rtre\nquattro\tcinque'), 'uno\ndue\ntre\nquattro\tcinque');
  assert.equal(slideText('a\u0001b\u007fc\u0085d\ufffee\uffff'), 'abcde');
  assert.equal(slideText('x\ud83dy\ude00z'), 'xyz');
  assert.equal(slideText('ok 😀'), 'ok 😀');
  assert.equal(REFUSED.test(slideText('\u0000\u000b\u001f\u0080\u009f\ud800\udfff\ufffe')), false);
});

test('texts are cut by code point, never through a surrogate pair', () => {
  // The emoji is two UTF-16 units across the limit: kept whole or dropped, never halved.
  const text = `${'a'.repeat(8)}😀bcd`;
  const cut = cutText(text, 10, true);
  assert.equal(cut, `${'a'.repeat(8)}😀…`);
  assert.equal(Array.from(cut).length, 10);
  assert.equal(cutText(text, 9, false), `${'a'.repeat(8)}😀`);
  assert.equal(cutText(`${'a'.repeat(9)}😀`, 10, true), `${'a'.repeat(9)}😀`);
  assert.equal(REFUSED.test(cutText(`${'a'.repeat(9)}😀😀`, 10, true)), false);
  const deck = deckFromParts('Titolo', [
    { title: `${'b'.repeat(298)}😀😀😀`, paragraphs: ['riga\r\naltra'], bullets: [], notes: `${'n'.repeat(4999)}😀😀\r\nfine` },
  ]);
  const slide = deck?.slides.at(0);
  assert.ok(slide !== undefined);
  assert.equal(Array.from(slide.title ?? '').length, 300);
  assert.equal(REFUSED.test(slide.title ?? ''), false);
  assert.equal(slide.title?.endsWith('😀…'), true);
  assert.deepEqual(slide.paragraphs, ['riga altra']);
  assert.equal(Array.from(slide.notes ?? '').length, 5000);
  assert.equal(slide.notes?.endsWith('😀'), true);
  assert.deepEqual(deckFromParts('T', [{ paragraphs: [], bullets: [], notes: 'uno\r\ndue\u0002' }])?.slides.at(0)?.notes, 'uno\ndue');
});

test('the direct edit checks the excerpt of the element picked', () => {
  assert.equal(pickedExcerpt('  Ciao\n  mondo '), 'Ciao mondo');
  assert.equal(pickedExcerpt('a\u0001b'), 'a b');
  assert.equal(pickedExcerpt('x'.repeat(200)), excerptOf('x'.repeat(200), 120));
  assert.equal(excerptMatches('  Prezzo:\n 10 €', 'Prezzo: 10 €'), true);
  assert.equal(excerptMatches('Prezzo: 12 €', 'Prezzo: 10 €'), false);
  assert.equal(excerptMatches('', ''), true);
  assert.equal(excerptMatches('Titolo', ''), false);
});

test('exported files take the name of the mockup', () => {
  assert.equal(exportName('docs/mockups/landing-2.html', 'pptx'), 'landing-2.pptx');
  assert.equal(exportName('mockups/landing.html', 'html'), 'landing.html');
});

test('errors of the Studio in Italian', () => {
  assert.match(studioErrorText(new ApiError(409, 'changed')), /cambiato/);
  assert.match(studioErrorText(new ApiError(403, 'refused')), /rifiutato/);
  assert.match(studioErrorText(new ApiError(404, 'not-found')), /Non trovato/);
  assert.match(studioErrorText(new TypeError('fetch failed')), /non risponde/);
});

/** The least DOM the Studio's script touches: elements in a tree, listeners, a parent window. */
class FakeElement {
  readonly localName: string;
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  textContent: string;
  constructor(localName: string, text = '') {
    this.localName = localName;
    this.textContent = text;
  }
  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  appendChild(child: FakeElement): FakeElement {
    this.append(child);
    return child;
  }
  get previousElementSibling(): FakeElement | null {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  contains(other: FakeElement): boolean {
    for (let node: FakeElement | null = other; node !== null; node = node.parentElement) if (node === this) return true;
    return false;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 10.4, top: 20.6, width: 300, height: 40 };
  }
}

test('the Studio script sends the selector of the clicked element only in comment mode, on its parent’s word', () => {
  const html = new FakeElement('html');
  const body = new FakeElement('body');
  const title = new FakeElement('h1', '  Pasticceria\n Aurora ');
  const main = new FakeElement('main').append(new FakeElement('p'), new FakeElement('h2'), title);
  html.append(new FakeElement('head'), body.append(new FakeElement('header'), new FakeElement('main'), main));
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const on = (type: string, listener: (event: unknown) => void): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  const sent: unknown[] = [];
  const parent = {
    postMessage: (message: unknown): void => {
      sent.push(message);
    },
  };
  const doc = { body, documentElement: html, readyState: 'complete', createElement: (tag: string) => new FakeElement(tag), addEventListener: on, querySelector: () => null };
  const win = { document: doc, parent, addEventListener: on };
  const fire = (type: string, event: object): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  new Script(studioScript().replace(/\(window\);$/, '(fakeWindow);')).runInNewContext({ fakeWindow: win, Element: FakeElement, Math, String });
  // Objects of the script's own realm: compared by their JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ source: STUDIO_SOURCE, type: 'ready' }]);
  let prevented = false;
  const click = {
    target: title,
    preventDefault: (): void => {
      prevented = true;
    },
    stopPropagation: (): void => undefined,
  };
  fire('click', click);
  assert.equal(sent.length, 1, 'no pick outside comment mode');
  // A message from another window is ignored.
  fire('message', { source: {}, data: modeMessage(true) });
  fire('click', click);
  assert.equal(sent.length, 1);
  fire('message', { source: parent, data: modeMessage(true) });
  fire('click', click);
  assert.equal(prevented, true);
  assert.deepEqual(parseFrameMessage(sent[1]), {
    type: 'pick',
    selector: 'body > main:nth-of-type(2) > h1:nth-of-type(1)',
    rect: { x: 10, y: 21, width: 300, height: 40 },
    tag: 'h1',
    excerpt: 'Pasticceria Aurora',
  });
});
