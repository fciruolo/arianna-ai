import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contrast, createSampleCache, fontsOf, paletteOf, radiusOf, styleSample, titleWeightOf } from '../src/style-sample.ts';

// Invented styles in the two shapes of the catalog of Open Design.
const LONG = `# Design System Inspired by Lumen

> Category: Media
> Calm white space, one blue.

## 2. Color Palette & Roles

### Primary
- **Deep Night** (\`#000000\`): hero canvases.
- **Mist Gray** (\`#f5f5f7\`): feature bands.
- **Night Ink** (\`#1d1d1f\`): primary text.

### Secondary & Accent
- **Action Blue** (\`#0071e3\`): primary action fill.
- **Link Blue** (\`#0066cc\`): inline links.

### Surface & Background
- **Pure White Canvas** (\`#ffffff\`): product backgrounds.

## 3. Typography Rules

### Font Family
- **Display Family:** \`Lumen Display\`, fallbacks \`Helvetica Neue, Arial, sans-serif\`
- **Text Family:** \`Lumen Text\`, fallbacks \`Helvetica Neue, sans-serif\`

### Hierarchy
| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Hero Display | 56px | 600 | 1.07 |
| Body | 17px | 400 | 1.47 |

## 4. Component Stylings
- Primary button: pill, 980px radius, Action Blue fill.
`;

const SHORT = `# Design System Inspired by Ember

## 2. Color

- **Primary:** \`#FF5701\` — Token from style foundations.
- **Surface:** \`#FFFFFF\` — Token from style foundations.
- **Text:** \`#111827\` — Token from style foundations.

## 3. Typography

- **Families:** primary=Playfair Display, display=Playfair Display, mono=JetBrains Mono

## 6. Components

- Cards/sections: 12px radius.
`;

test('the palette: names and colors in order, once per color, from the color section', () => {
  const palette = paletteOf(LONG);
  assert.deepEqual(palette.slice(0, 4), [
    { name: 'Deep Night', hex: '#000000' },
    { name: 'Mist Gray', hex: '#f5f5f7' },
    { name: 'Night Ink', hex: '#1d1d1f' },
    { name: 'Action Blue', hex: '#0071e3' },
  ]);
  assert.deepEqual(paletteOf(SHORT).map((color) => color.hex), ['#ff5701', '#ffffff', '#111827']);
  // A table row keeps its name without the pipes; three hex digits become six.
  assert.deepEqual(paletteOf('## Colors\n| Background | `#abc` |\n'), [{ name: 'Background', hex: '#aabbcc' }]);
  assert.deepEqual(paletteOf('# Nothing\nno colors here\n'), []);
});

test('the roles: band from the first color, page from a background name, legible text, vivid accent', () => {
  const sample = styleSample(LONG);
  assert.equal(sample.hero, '#000000');
  assert.equal(sample.heroText, '#ffffff');
  assert.equal(sample.background, '#ffffff');
  assert.equal(sample.text, '#1d1d1f');
  assert.equal(sample.accent, '#0071e3');
  // "Link Blue" is not a text color: "ink" counts only as a word.
  assert.notEqual(sample.text, '#0066cc');
  const short = styleSample(SHORT);
  assert.equal(short.background, '#ffffff');
  assert.equal(short.text, '#111827');
  assert.equal(short.accent, '#ff5701');
  // The accent melts into the band: the button takes the page's color.
  assert.equal(short.hero, '#ff5701');
  assert.equal(short.heroAction, '#ffffff');
});

test('a text color too light for the page gives way to near black', () => {
  const sample = styleSample('## Color\n- **Canvas** (`#ffffff`)\n- **Text** (`#ffd000`)\n');
  assert.equal(sample.text, '#111111');
  assert.ok(contrast(sample.text, sample.background) >= 4.5);
});

test('a style that says nothing gets the defaults', () => {
  const sample = styleSample('# Empty\n');
  assert.deepEqual(sample.palette, []);
  assert.equal(sample.background, '#ffffff');
  assert.equal(sample.text, '#111111');
  assert.deepEqual(sample.displayFont, ['sans-serif']);
  assert.equal(sample.titleWeight, 700);
  assert.equal(sample.radius, 8);
});

test('the fonts: display and body stacks with a generic family at the end', () => {
  assert.deepEqual(fontsOf(LONG), { displayFont: ['Lumen Display', 'Helvetica Neue', 'Arial', 'sans-serif'], bodyFont: ['Lumen Text', 'Helvetica Neue', 'sans-serif'] });
  assert.deepEqual(fontsOf(SHORT), { displayFont: ['Playfair Display', 'serif'], bodyFont: ['Playfair Display', 'serif'] });
});

test('the fonts: sentences, CSS words and unsafe names are not fonts', () => {
  const text = '## Typography\n- **Three weights**: light, regular, bold\n- **Display:** `uppercase`, `letter-spacing`\n- **Body:** `Good Sans`, `x"; color: red`\n';
  const fonts = fontsOf(text);
  assert.deepEqual(fonts.bodyFont, ['Good Sans', 'sans-serif']);
  assert.deepEqual(fonts.displayFont, ['Good Sans', 'sans-serif']);
  for (const name of [...fonts.bodyFont, ...fonts.displayFont]) assert.match(name, /^[A-Za-z0-9][A-Za-z0-9 .-]*$/);
});

test('the weight of the titles from the first display row of a table', () => {
  assert.equal(titleWeightOf(LONG), 600);
  assert.equal(titleWeightOf('| Hero | 48px | 300-600 | 1.1 |\n'), 300);
  assert.equal(titleWeightOf('| Body | 16px | 400 |\n'), 700);
});

test('the corners: a pill button, a radius in px, the default', () => {
  assert.equal(radiusOf(LONG), 999);
  assert.equal(radiusOf(SHORT), 12);
  assert.equal(radiusOf('- Buttons: 4px radius, cards 16px radius\n'), 4);
  assert.equal(radiusOf('no corners here\n'), 8);
});

test('the samples of the catalog: once per version, a style that cannot be read left out', () => {
  let reads = 0;
  let commit = 'a'.repeat(40);
  const samples = createSampleCache({
    list: () => ({ commit, styles: [{ slug: 'lumen' }, { slug: 'gone' }] }),
    styleText: (slug) => {
      reads += 1;
      if (slug === 'gone') throw new Error('no longer on the disk');
      return { text: LONG };
    },
  });
  const first = samples();
  assert.deepEqual(Object.keys(first.samples), ['lumen']);
  assert.equal(first.samples.lumen?.accent, '#0071e3');
  assert.equal(samples(), first);
  assert.equal(reads, 2);
  commit = 'b'.repeat(40);
  assert.equal(samples().commit, commit);
  assert.equal(reads, 4);
});
