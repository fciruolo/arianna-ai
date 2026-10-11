import assert from 'node:assert/strict';
import { test } from 'node:test';

import { writePptx, type Deck } from '../src/index.ts';
import { assertWellFormedXml, unzip, type UnzippedEntry } from './support/unzip.ts';

const deck: Deck = {
  title: 'Quarterly review',
  slides: [
    { title: 'Opening', subtitle: 'Fake numbers only', background: '#112233', color: '#eeeeee', accent: '#FFAA00', notes: 'Say hello\nthen smile' },
    { title: 'Details', paragraphs: ['First paragraph', 'Line one\nLine two'], bullets: ['Alpha', 'Beta'] },
    { bullets: ['Only bullets'] },
  ],
};

function text(entries: Map<string, UnzippedEntry>, name: string): string {
  const entry = entries.get(name);
  assert.ok(entry, `missing part ${name}`);
  return entry.data.toString('utf8');
}

function attr(xml: string, element: string, name: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(new RegExp(`<${element}\\b[^>]*\\s${name}="([^"]*)"`, 'g'))) values.push(match[1] ?? '');
  return values;
}

/** Resolves a relationship target against the folder of its source part. */
function resolve(relsName: string, target: string): string {
  const folder = relsName.replace(/_rels\/[^/]*\.rels$/, '');
  const parts = (folder + target).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

test('the package has every part, in a zip that rereads with matching CRCs', () => {
  const entries = unzip(writePptx(deck));
  const names = [...entries.keys()];
  assert.equal(names[0], '[Content_Types].xml', 'content types come first');
  for (const part of [
    '_rels/.rels',
    'docProps/core.xml',
    'docProps/app.xml',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/theme/theme1.xml',
    'ppt/slides/slide1.xml',
    'ppt/slides/slide2.xml',
    'ppt/slides/slide3.xml',
    'ppt/slides/_rels/slide3.xml.rels',
    'ppt/notesMasters/notesMaster1.xml',
    'ppt/notesSlides/notesSlide1.xml',
    'ppt/notesSlides/_rels/notesSlide1.xml.rels',
  ]) {
    assert.ok(entries.has(part), `missing ${part}`);
  }
  // Notes only for the slide that has them.
  assert.equal(entries.has('ppt/notesSlides/notesSlide2.xml'), false);
  for (const entry of entries.values()) {
    assert.equal(entry.method, 8, `${entry.name} is deflated`);
    assertWellFormedXml(entry.data.toString('utf8'), entry.name);
  }
});

test('content types cover every part and nothing else', () => {
  const entries = unzip(writePptx(deck));
  const types = text(entries, '[Content_Types].xml');
  const overrides = attr(types, 'Override', 'PartName').map((p) => p.slice(1));
  for (const name of overrides) assert.ok(entries.has(name), `override for missing part ${name}`);
  assert.equal(new Set(overrides).size, overrides.length, 'no duplicate overrides');
  for (const name of entries.keys()) {
    if (name === '[Content_Types].xml' || name.endsWith('.rels')) continue;
    assert.ok(overrides.includes(name), `no content type for ${name}`);
  }
  assert.match(types, /<Default Extension="rels" ContentType="application\/vnd\.openxmlformats-package\.relationships\+xml"\/>/);
  assert.match(types, /PartName="\/ppt\/slides\/slide2\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.slide\+xml"/);
  assert.match(types, /PartName="\/ppt\/presentation\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation\.main\+xml"/);
});

test('every relationship points to a part of the package and r:ids resolve', () => {
  const entries = unzip(writePptx(deck));
  for (const name of entries.keys()) {
    if (!name.endsWith('.rels')) continue;
    const rels = text(entries, name);
    const ids = attr(rels, 'Relationship', 'Id');
    assert.equal(new Set(ids).size, ids.length, `${name}: duplicate ids`);
    for (const target of attr(rels, 'Relationship', 'Target')) {
      assert.ok(entries.has(resolve(name, target)), `${name} points to missing ${target}`);
    }
    // Each r:id used by the source part exists in its rels.
    const source = name.replace(/_rels\/([^/]*)\.rels$/, '$1');
    if (source === '') continue;
    for (const id of text(entries, source).matchAll(/r:id="([^"]+)"/g)) {
      assert.ok(ids.includes(id[1] ?? ''), `${source} uses unknown ${id[1] ?? ''}`);
    }
  }
  const presentation = text(entries, 'ppt/presentation.xml');
  assert.equal(attr(presentation, 'p:sldId', 'id').join(','), '256,257,258');
  assert.match(presentation, /<p:sldSz cx="12192000" cy="6858000"\/>/);
  assert.match(text(entries, 'docProps/app.xml'), /<Slides>3<\/Slides><Notes>1<\/Notes>/);
});

test('slides carry title, subtitle, paragraphs, bullets and colours', () => {
  const entries = unzip(writePptx(deck));
  const first = text(entries, 'ppt/slides/slide1.xml');
  assert.match(first, /<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"\/><\/a:solidFill>/);
  assert.match(first, /<p:ph type="title"\/>.*<a:srgbClr val="FFAA00"\/><\/a:solidFill><\/a:rPr><a:t>Opening<\/a:t>/);
  assert.match(first, /<a:srgbClr val="EEEEEE"\/><\/a:solidFill><\/a:rPr><a:t>Fake numbers only<\/a:t>/);

  const second = text(entries, 'ppt/slides/slide2.xml');
  assert.equal(second.includes('<p:bg>'), false, 'no background: the master one');
  assert.equal(second.includes('srgbClr'), false, 'no colours: inherited');
  // `\n` makes separate paragraphs; bullets use buChar.
  assert.match(second, /<a:t>Line one<\/a:t><\/a:r><a:endParaRPr[^>]*\/><\/a:p><a:p><a:pPr marL="0" indent="0"><a:buNone\/><\/a:pPr><a:r>.*<a:t>Line two<\/a:t>/);
  assert.equal(second.match(/<a:buChar char="&#8226;"\/>/g)?.length, 2);

  const third = text(entries, 'ppt/slides/slide3.xml');
  assert.equal(third.includes('type="title"'), false, 'no title shape without a title');
  assert.match(third, /<a:buChar char="&#8226;"\/><\/a:pPr><a:r>.*<a:t>Only bullets<\/a:t>/);
});

test('notes are written to the notes slide of their slide', () => {
  const entries = unzip(writePptx(deck));
  const notes = text(entries, 'ppt/notesSlides/notesSlide1.xml');
  assert.match(notes, /<a:t>Say hello<\/a:t>.*<a:t>then smile<\/a:t>/);
  assert.match(text(entries, 'ppt/notesSlides/_rels/notesSlide1.xml.rels'), /Target="\.\.\/slides\/slide1\.xml"/);
  assert.match(text(entries, 'ppt/slides/_rels/slide1.xml.rels'), /Target="\.\.\/notesSlides\/notesSlide1\.xml"/);
  assert.equal(text(entries, 'ppt/slides/_rels/slide2.xml.rels').includes('notesSlide'), false);
});

test('without notes there is no notes master', () => {
  const entries = unzip(writePptx({ title: 'Plain', slides: [{ title: 'One' }, { notes: '' }] }));
  assert.equal([...entries.keys()].some((name) => name.includes('notes')), false);
  assert.equal(entries.has('ppt/theme/theme2.xml'), false);
  assert.equal(text(entries, 'ppt/presentation.xml').includes('notesMasterIdLst'), false);
});

test('text is XML-escaped everywhere', () => {
  const nasty = `<b>&"quoted"'s</b>`;
  const entries = unzip(writePptx({ title: nasty, slides: [{ title: nasty, subtitle: nasty, paragraphs: [nasty], bullets: [nasty], notes: nasty }] }));
  const escaped = '&lt;b&gt;&amp;&quot;quoted&quot;&apos;s&lt;/b&gt;';
  for (const name of ['ppt/slides/slide1.xml', 'ppt/notesSlides/notesSlide1.xml', 'docProps/core.xml']) {
    const xml = text(entries, name);
    assert.ok(xml.includes(escaped), `${name} escapes the text`);
    assert.equal(xml.includes('<b>'), false);
    assertWellFormedXml(xml, name);
  }
  assert.equal(text(entries, 'ppt/slides/slide1.xml').split(escaped).length - 1, 4, 'title, subtitle, paragraph and bullet');
});

test('characters that XML cannot hold are dropped by the writer', () => {
  const entries = unzip(writePptx({ title: 'T\u0000', slides: [{ title: 'a\u0007b\tc' }] }));
  assert.match(text(entries, 'ppt/slides/slide1.xml'), /<a:t>ab\tc<\/a:t>/);
  assert.match(text(entries, 'docProps/core.xml'), /<dc:title>T<\/dc:title>/);
});

test('the output is deterministic, with fixed dates', () => {
  const a = writePptx(deck);
  const b = writePptx(structuredClone(deck));
  assert.ok(a.equals(b));
  for (const entry of unzip(a).values()) {
    assert.equal(entry.dosTime, 0);
    assert.equal(entry.dosDate, 0x21, '1980-01-01');
  }
  assert.equal(a.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
});

test('a 200-slide deck with notes is written', () => {
  const slides = Array.from({ length: 200 }, (_, i) => ({ title: `Slide ${String(i + 1)}`, notes: `n${String(i)}` }));
  const entries = unzip(writePptx({ title: 'Big', slides }));
  assert.ok(entries.has('ppt/slides/slide200.xml'));
  assert.ok(entries.has('ppt/notesSlides/notesSlide200.xml'));
  assert.equal(attr(text(entries, 'ppt/presentation.xml'), 'p:sldId', 'id').at(-1), '455');
});
