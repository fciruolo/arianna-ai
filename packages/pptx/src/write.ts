// The Office Open XML parts of a deck (ECMA-376, PresentationML): one master,
// one layout, one theme, a slide per Slide and, when any slide has notes, a
// notes master and the notes slides. Shapes carry their own geometry, so the
// layout only gives the title placeholder.
import { stripForbidden, type Deck, type Slide } from './deck.ts';
import { zip, type ZipEntry } from './zip.ts';

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT_PML = 'application/vnd.openxmlformats-officedocument.presentationml';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NAMESPACES = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

// 16:9 slides and portrait notes pages, in EMU.
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const NOTES_W = 6858000;
const NOTES_H = 9144000;
const MARGIN_X = 609600;
const CONTENT_W = SLIDE_W - 2 * MARGIN_X;

const TITLE_SIZE = 4000;
const SUBTITLE_SIZE = 2400;
const BODY_SIZE = 2000;
const NOTES_SIZE = 1200;
const LANG = 'it-IT';

const COLOR = /^#[0-9a-fA-F]{6}$/;
// The fixed date of docProps/core.xml: the output depends on the deck only.
const FIXED_DATE = '2026-01-01T00:00:00Z';

/** Escapes text for XML content and attribute values. */
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function hex(color: string | undefined): string | undefined {
  return color !== undefined && COLOR.test(color) ? color.slice(1).toUpperCase() : undefined;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function xfrm(box: Box): string {
  return `<a:xfrm><a:off x="${String(box.x)}" y="${String(box.y)}"/><a:ext cx="${String(box.w)}" cy="${String(box.h)}"/></a:xfrm>`;
}

const GROUP_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** How a run looks: size in hundredths of a point, colour, font family. */
interface Look {
  size: number;
  color: string | undefined;
  font?: string | undefined;
}

function runProps(look: Look, bold = false): string {
  const fill = look.color === undefined ? '' : `<a:solidFill><a:srgbClr val="${look.color}"/></a:solidFill>`;
  const font = look.font === undefined ? '' : `<a:latin typeface="${escapeXml(look.font)}"/><a:cs typeface="${escapeXml(look.font)}"/>`;
  return `<a:rPr lang="${LANG}" sz="${String(look.size)}"${bold ? ' b="1"' : ''} dirty="0">${fill}${font}</a:rPr>`;
}

function endProps(size: number): string {
  return `<a:endParaRPr lang="${LANG}" sz="${String(size)}" dirty="0"/>`;
}

/** One paragraph; empty text gives an empty paragraph. */
function paragraph(text: string, look: Look, pPr: string, bold = false): string {
  const run = text === '' ? '' : `<a:r>${runProps(look, bold)}<a:t>${escapeXml(text)}</a:t></a:r>`;
  return `<a:p>${pPr}${run}${endProps(look.size)}</a:p>`;
}

const NO_BULLET = '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>';
const BULLET = '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>';
const BULLET_CONTINUED = '<a:pPr marL="342900" indent="0"><a:buNone/></a:pPr>';

/** Each `\n` starts a new paragraph. */
function lines(text: string): string[] {
  return stripForbidden(text).split('\n');
}

function plainParagraphs(text: string, look: Look, bold = false): string {
  return lines(text)
    .map((line) => paragraph(line, look, NO_BULLET, bold))
    .join('');
}

function bulletParagraphs(text: string, look: Look): string {
  return lines(text)
    .map((line, i) => paragraph(line, look, i === 0 ? BULLET : BULLET_CONTINUED))
    .join('');
}

function textShape(id: number, name: string, box: Box, body: string, anchor: 't' | 'b', placeholder?: string): string {
  const nv =
    placeholder === undefined
      ? `<p:nvSpPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
      : `<p:nvSpPr><p:cNvPr id="${String(id)}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>`;
  return (
    `<p:sp>${nv}<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`
  );
}

function slideXml(slide: Slide): string {
  const text = hex(slide.color);
  const accent = hex(slide.accent) ?? text;
  const background = hex(slide.background);
  // Points from the screen; the subtitle keeps its proportion to the body.
  const titleLook: Look = { size: slide.titleSize === undefined ? TITLE_SIZE : slide.titleSize * 100, color: accent, font: slide.titleFont };
  const bodyLook: Look = { size: slide.bodySize === undefined ? BODY_SIZE : slide.bodySize * 100, color: text, font: slide.bodyFont };
  const subtitleLook: Look = { ...bodyLook, size: Math.round((bodyLook.size * SUBTITLE_SIZE) / BODY_SIZE) };
  const shapes: string[] = [];
  let id = 2;
  let y = 457200;
  if (slide.title !== undefined && slide.title !== '') {
    const box = { x: MARGIN_X, y, w: CONTENT_W, h: 1143000 };
    shapes.push(textShape(id++, 'Title', box, plainParagraphs(slide.title, titleLook, true), 'b', '<p:ph type="title"/>'));
  }
  y += 1143000 + 76200;
  if (slide.subtitle !== undefined && slide.subtitle !== '') {
    const box = { x: MARGIN_X, y, w: CONTENT_W, h: 685800 };
    shapes.push(textShape(id++, 'Subtitle', box, plainParagraphs(slide.subtitle, subtitleLook), 't'));
    y += 685800 + 76200;
  }
  const body = [
    ...(slide.paragraphs ?? []).map((p) => plainParagraphs(p, bodyLook)),
    ...(slide.bullets ?? []).map((b) => bulletParagraphs(b, bodyLook)),
  ];
  if (body.length > 0) {
    const box = { x: MARGIN_X, y, w: CONTENT_W, h: SLIDE_H - 457200 - y };
    shapes.push(textShape(id, 'Body', box, body.join(''), 't'));
  }
  const bg =
    background === undefined
      ? ''
      : `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
  return (
    `${XML_DECL}<p:sld ${NAMESPACES}><p:cSld>${bg}<p:spTree>${GROUP_HEADER}${shapes.join('')}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

function notesSlideXml(notes: string): string {
  return (
    `${XML_DECL}<p:notes ${NAMESPACES}><p:cSld><p:spTree>${GROUP_HEADER}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${plainParagraphs(notes, { size: NOTES_SIZE, color: undefined })}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

const MASTER_BG = '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>';

function level(size: number, bullet: boolean): string {
  const bu = bullet ? '<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' : '<a:buNone/>';
  const margin = bullet ? ' marL="342900" indent="-342900"' : '';
  return `<a:lvl1pPr${margin}>${bu}<a:defRPr sz="${String(size)}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>`;
}

const TITLE_BOX = { x: MARGIN_X, y: 457200, w: CONTENT_W, h: 1143000 };

function titlePlaceholder(): string {
  return (
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${xfrm(TITLE_BOX)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    '<p:txBody><a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:endParaRPr lang="it-IT"/></a:p></p:txBody></p:sp>'
  );
}

function slideMasterXml(): string {
  return (
    `${XML_DECL}<p:sldMaster ${NAMESPACES}><p:cSld>${MASTER_BG}<p:spTree>${GROUP_HEADER}${titlePlaceholder()}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP}/>` +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    `<p:txStyles><p:titleStyle>${level(TITLE_SIZE, false)}</p:titleStyle><p:bodyStyle>${level(BODY_SIZE, true)}</p:bodyStyle><p:otherStyle>${level(1800, false)}</p:otherStyle></p:txStyles>` +
    '</p:sldMaster>'
  );
}

function slideLayoutXml(): string {
  return (
    `${XML_DECL}<p:sldLayout ${NAMESPACES} type="titleOnly" preserve="1"><p:cSld name="Title Only"><p:spTree>${GROUP_HEADER}${titlePlaceholder()}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function notesMasterXml(): string {
  return (
    `${XML_DECL}<p:notesMaster ${NAMESPACES}><p:cSld>${MASTER_BG}<p:spTree>${GROUP_HEADER}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${xfrm({ x: 381000, y: 685800, w: 6096000, h: 3429000 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${xfrm({ x: 685800, y: 4400550, w: 5486400, h: 3600450 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="it-IT"/></a:p></p:txBody></p:sp>' +
    `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/>` +
    `<p:notesStyle>${level(NOTES_SIZE, false)}</p:notesStyle></p:notesMaster>`
  );
}

function themeXml(name: string): string {
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const font = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>';
  const accents = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']
    .map((c, i) => `<a:accent${String(i + 1)}><a:srgbClr val="${c}"/></a:accent${String(i + 1)}>`)
    .join('');
  return (
    `${XML_DECL}<a:theme xmlns:a="${NS_A}" name="${name}"><a:themeElements>` +
    `<a:clrScheme name="${name}"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>${accents}` +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>' +
    `<a:fontScheme name="${name}"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="${name}"><a:fillStyleLst>${solid.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${`<a:ln w="9525">${solid}</a:ln>`.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${solid.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>` +
    '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}

interface Relationship {
  type: string;
  target: string;
}

function relsXml(rels: Relationship[]): string {
  const items = rels.map((rel, i) => `<Relationship Id="rId${String(i + 1)}" Type="${rel.type}" Target="${rel.target}"/>`).join('');
  return `${XML_DECL}<Relationships xmlns="${NS_PKG_RELS}">${items}</Relationships>`;
}

function rel(name: string, target: string): Relationship {
  return { type: `${REL}/${name}`, target };
}

/** The bytes of a .pptx file for a checked deck. */
export function writePptx(deck: Deck): Buffer {
  const slides = deck.slides;
  const notes = slides.map((s) => (s.notes !== undefined && s.notes !== '' ? s.notes : undefined));
  const withNotes = notes.some((n) => n !== undefined);
  const title = stripForbidden(deck.title);

  const parts: { name: string; type: string | undefined; xml: string }[] = [];
  const add = (name: string, type: string | undefined, xml: string): void => {
    parts.push({ name, type, xml });
  };

  // Presentation-level relationships: the master first, then the slides.
  const presRels: Relationship[] = [rel('slideMaster', 'slideMasters/slideMaster1.xml')];
  if (withNotes) presRels.push(rel('notesMaster', 'notesMasters/notesMaster1.xml'));
  const firstSlideRel = presRels.length + 1;
  slides.forEach((_, i) => presRels.push(rel('slide', `slides/slide${String(i + 1)}.xml`)));
  presRels.push(
    rel('presProps', 'presProps.xml'),
    rel('viewProps', 'viewProps.xml'),
    rel('theme', 'theme/theme1.xml'),
    rel('tableStyles', 'tableStyles.xml'),
  );

  const slideIds = slides.map((_, i) => `<p:sldId id="${String(256 + i)}" r:id="rId${String(firstSlideRel + i)}"/>`).join('');
  const presentation =
    `${XML_DECL}<p:presentation ${NAMESPACES} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    (withNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' : '') +
    `<p:sldIdLst>${slideIds}</p:sldIdLst>` +
    `<p:sldSz cx="${String(SLIDE_W)}" cy="${String(SLIDE_H)}"/><p:notesSz cx="${String(NOTES_W)}" cy="${String(NOTES_H)}"/>` +
    `<p:defaultTextStyle>${level(1800, false)}</p:defaultTextStyle></p:presentation>`;

  add('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml', coreXml(title));
  add('docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml', appXml(slides.length, notes.filter((n) => n !== undefined).length));
  add('_rels/.rels', undefined, relsXml([
    rel('officeDocument', 'ppt/presentation.xml'),
    { type: `${NS_PKG_RELS}/metadata/core-properties`, target: 'docProps/core.xml' },
    rel('extended-properties', 'docProps/app.xml'),
  ]));
  add('ppt/presentation.xml', `${CT_PML}.presentation.main+xml`, presentation);
  add('ppt/_rels/presentation.xml.rels', undefined, relsXml(presRels));
  add('ppt/presProps.xml', `${CT_PML}.presProps+xml`, `${XML_DECL}<p:presentationPr ${NAMESPACES}/>`);
  add('ppt/viewProps.xml', `${CT_PML}.viewProps+xml`, `${XML_DECL}<p:viewPr ${NAMESPACES}/>`);
  add('ppt/tableStyles.xml', `${CT_PML}.tableStyles+xml`, `${XML_DECL}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  add('ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml', themeXml('Arianna'));
  add('ppt/slideMasters/slideMaster1.xml', `${CT_PML}.slideMaster+xml`, slideMasterXml());
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', undefined, relsXml([
    rel('slideLayout', '../slideLayouts/slideLayout1.xml'),
    rel('theme', '../theme/theme1.xml'),
  ]));
  add('ppt/slideLayouts/slideLayout1.xml', `${CT_PML}.slideLayout+xml`, slideLayoutXml());
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', undefined, relsXml([rel('slideMaster', '../slideMasters/slideMaster1.xml')]));
  if (withNotes) {
    add('ppt/theme/theme2.xml', 'application/vnd.openxmlformats-officedocument.theme+xml', themeXml('Arianna Notes'));
    add('ppt/notesMasters/notesMaster1.xml', `${CT_PML}.notesMaster+xml`, notesMasterXml());
    add('ppt/notesMasters/_rels/notesMaster1.xml.rels', undefined, relsXml([rel('theme', '../theme/theme2.xml')]));
  }
  slides.forEach((slide, i) => {
    const n = i + 1;
    const note = notes[i];
    const slideRels = [rel('slideLayout', '../slideLayouts/slideLayout1.xml')];
    if (note !== undefined) slideRels.push(rel('notesSlide', `../notesSlides/notesSlide${String(n)}.xml`));
    add(`ppt/slides/slide${String(n)}.xml`, `${CT_PML}.slide+xml`, slideXml(slide));
    add(`ppt/slides/_rels/slide${String(n)}.xml.rels`, undefined, relsXml(slideRels));
    if (note !== undefined) {
      add(`ppt/notesSlides/notesSlide${String(n)}.xml`, `${CT_PML}.notesSlide+xml`, notesSlideXml(note));
      add(`ppt/notesSlides/_rels/notesSlide${String(n)}.xml.rels`, undefined, relsXml([
        rel('notesMaster', '../notesMasters/notesMaster1.xml'),
        rel('slide', `../slides/slide${String(n)}.xml`),
      ]));
    }
  });

  const overrides = parts
    .filter((part) => part.type !== undefined)
    .map((part) => `<Override PartName="/${part.name}" ContentType="${part.type ?? ''}"/>`)
    .join('');
  const contentTypes =
    `${XML_DECL}<Types xmlns="${NS_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${overrides}</Types>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    ...parts.map((part) => ({ name: part.name, data: Buffer.from(part.xml, 'utf8') })),
  ];
  return zip(entries);
}

function coreXml(title: string): string {
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title><dc:creator>Arianna</dc:creator><cp:lastModifiedBy>Arianna</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:modified></cp:coreProperties>`
  );
}

function appXml(slides: number, notes: number): string {
  return (
    `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>Arianna</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>${String(slides)}</Slides><Notes>${String(notes)}</Notes>` +
    '<HiddenSlides>0</HiddenSlides><AppVersion>16.0000</AppVersion></Properties>'
  );
}
