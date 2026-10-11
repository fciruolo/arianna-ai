// The Studio (I-19, D-184): the isolated srcdoc, the Studio's script, the
// messages from the frame, the variants, the message of revision, the styles
// of the direct edit and the deck. Every name and text here is invented.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';

import { ApiError } from '../src/lib/api.ts';
import {
  buildSrcdoc,
  excerptOf,
  highlightMessage,
  isStudioSelector,
  modeMessage,
  nthSelector,
  parseFrameMessage,
  STUDIO_CSP,
  STUDIO_SOURCE,
  studioScript,
} from '../src/lib/studio-frame.ts';
import {
  commentProblem,
  deckFromParts,
  editProblems,
  exportName,
  groupMockups,
  hexColor,
  isMockupPath,
  isStudioPath,
  nextVariantName,
  pickMockup,
  reviewMessage,
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
  assert.equal(first.notes, 'Note  del relatore');
  assert.equal(first.background, '#ffffff');
  assert.equal(first.color, '#123456');
  assert.equal('accent' in first, false);
  assert.equal(second.title?.length, 300);
  assert.equal('paragraphs' in second, false);
  assert.equal(hexColor('#abc'), '#aabbcc');
  assert.equal(hexColor('blue'), undefined);
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
