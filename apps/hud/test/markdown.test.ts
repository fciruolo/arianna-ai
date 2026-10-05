import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inlineText, parseInline, parseMarkdown, safeHref, type Block, type Inline } from '../src/lib/markdown.ts';

const text = (value: string): Inline => ({ kind: 'text', text: value });
const paragraph = (...inlines: Inline[]): Block => ({ kind: 'paragraph', inlines });

test('bold, italic, strikethrough and inline code', () => {
  assert.deepEqual(parseInline('**Passo 2:** avvia'), [{ kind: 'strong', children: [text('Passo 2:')] }, text(' avvia')]);
  assert.deepEqual(parseInline('un *poco* e __molto__'), [
    text('un '),
    { kind: 'em', children: [text('poco')] },
    text(' e '),
    { kind: 'strong', children: [text('molto')] },
  ]);
  assert.deepEqual(parseInline('~~no~~'), [{ kind: 'strike', children: [text('no')] }]);
  assert.deepEqual(parseInline('usa `omlx serve`'), [text('usa '), { kind: 'code', text: 'omlx serve' }]);
  assert.deepEqual(parseInline('``a ` b``'), [{ kind: 'code', text: 'a ` b' }]);
  assert.deepEqual(parseInline('***tutto***'), [{ kind: 'strong', children: [{ kind: 'em', children: [text('tutto')] }] }]);
  assert.deepEqual(parseInline('*a **b** c*'), [{ kind: 'em', children: [text('a '), { kind: 'strong', children: [text('b')] }, text(' c')] }]);
});

test('what is not emphasis stays text', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [text('2 * 3 * 4')]);
  assert.deepEqual(parseInline('local_model_error'), [text('local_model_error')]);
  assert.deepEqual(parseInline('**non chiuso'), [text('**non chiuso')]);
  assert.deepEqual(parseInline('\\*letterale\\*'), [text('*letterale*')]);
  assert.deepEqual(parseInline('`**dentro il codice**`'), [{ kind: 'code', text: '**dentro il codice**' }]);
  assert.deepEqual(parseInline('` aperto'), [text('` aperto')]);
});

test('a newline inside a paragraph is a line break', () => {
  assert.deepEqual(parseInline('uno\ndue'), [text('uno'), { kind: 'break' }, text('due')]);
});

test('raw HTML is text, never markup', () => {
  assert.deepEqual(parseMarkdown('<script>alert(1)</script> <b>x</b>'), [paragraph(text('<script>alert(1)</script> <b>x</b>'))]);
});

test('links: http, https and mailto only; images are never loaded', () => {
  assert.deepEqual(parseInline('[docs](https://example.org/a)'), [{ kind: 'link', href: 'https://example.org/a', children: [text('docs')] }]);
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [text('[x](javascript:alert(1))')]);
  assert.deepEqual(parseInline('[x](data:text/html,hi)'), [text('[x](data:text/html,hi)')]);
  assert.deepEqual(parseInline('[x](/relativo)'), [text('[x](/relativo)')]);
  assert.deepEqual(parseInline('![logo](https://example.org/p.png?d=segreto)'), [text('![logo](https://example.org/p.png?d=segreto)')]);
  assert.deepEqual(parseInline('[mail](mailto:a@example.org)'), [{ kind: 'link', href: 'mailto:a@example.org', children: [text('mail')] }]);
  assert.equal(safeHref('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeHref('https://example.org'), 'https://example.org/');
});

test('bare URLs become links without the punctuation after them', () => {
  assert.deepEqual(parseInline('vedi https://example.org/v1/models.'), [
    text('vedi '),
    { kind: 'link', href: 'https://example.org/v1/models', children: [text('https://example.org/v1/models')] },
    text('.'),
  ]);
  assert.deepEqual(parseInline('(https://example.org/a_(b))'), [
    text('('),
    { kind: 'link', href: 'https://example.org/a_(b)', children: [text('https://example.org/a_(b)')] },
    text(')'),
  ]);
  assert.deepEqual(parseInline('xhttps://example.org'), [text('xhttps://example.org')]);
});

test('the reply seen in the system chat: headings in bold, fenced code, paragraphs', () => {
  const blocks = parseMarkdown('**Passo 1: controlla**\n\n```\nlsof -i :7001\n```\n\nSe non stampa nulla, il server non è avviato.');
  assert.deepEqual(blocks, [
    paragraph({ kind: 'strong', children: [text('Passo 1: controlla')] }),
    { kind: 'code', lang: null, text: 'lsof -i :7001' },
    paragraph(text('Se non stampa nulla, il server non è avviato.')),
  ]);
});

test('fenced code keeps its text and language, even unclosed while streaming', () => {
  assert.deepEqual(parseMarkdown('```ts\nconst a = **b**;\n\n<b>\n```'), [{ kind: 'code', lang: 'ts', text: 'const a = **b**;\n\n<b>' }]);
  assert.deepEqual(parseMarkdown('~~~\nx\n'), [{ kind: 'code', lang: null, text: 'x\n' }]);
  assert.deepEqual(parseMarkdown('````\n```\n````'), [{ kind: 'code', lang: null, text: '```' }]);
});

test('headings, rules and quotes', () => {
  assert.deepEqual(parseMarkdown('## Titolo ##\n---\n> citato\n> ancora'), [
    { kind: 'heading', level: 2, inlines: [text('Titolo')] },
    { kind: 'rule' },
    { kind: 'quote', blocks: [paragraph(text('citato'), { kind: 'break' }, text('ancora'))] },
  ]);
  assert.deepEqual(parseMarkdown('#hashtag'), [paragraph(text('#hashtag'))]);
});

test('setext headings: a paragraph underlined with === or ---', () => {
  const heading = (level: number, ...inlines: Inline[]): Block => ({ kind: 'heading', level, inlines });
  assert.deepEqual(parseMarkdown('Titolo\n==='), [heading(1, text('Titolo'))]);
  assert.deepEqual(parseMarkdown('Sotto **titolo**\n---\ntesto'), [
    heading(2, text('Sotto '), { kind: 'strong', children: [text('titolo')] }),
    paragraph(text('testo')),
  ]);
  assert.deepEqual(parseMarkdown('Due\nrighe\n  =  '), [heading(1, text('Due'), { kind: 'break' }, text('righe'))]);
  assert.deepEqual(parseMarkdown('- voce\n  ---'), [{ kind: 'list', ordered: false, start: 1, items: [[heading(2, text('voce'))]] }]);
  assert.deepEqual(parseMarkdown('> citato\n> ==='), [{ kind: 'quote', blocks: [heading(1, text('citato'))] }]);
});

test('--- stays a rule when it does not follow a paragraph; spaced or other marks never underline', () => {
  assert.deepEqual(parseMarkdown('---'), [{ kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('Testo\n\n---'), [paragraph(text('Testo')), { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('# Titolo\n---'), [{ kind: 'heading', level: 1, inlines: [text('Titolo')] }, { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('- voce\n---'), [{ kind: 'list', ordered: false, start: 1, items: [[paragraph(text('voce'))]] }, { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('```\nx\n```\n---'), [{ kind: 'code', lang: null, text: 'x' }, { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('Testo\n- - -'), [paragraph(text('Testo')), { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('Testo\n***'), [paragraph(text('Testo')), { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('Testo\n= ='), [paragraph(text('Testo'), { kind: 'break' }, text('= ='))]);
  assert.deepEqual(parseMarkdown('Testo\n    ==='), [paragraph(text('Testo'), { kind: 'break' }, text('==='))]);
  assert.deepEqual(parseMarkdown('a | b\n--- | ---\n1 | 2')[0]?.kind, 'table');
  assert.deepEqual(parseMarkdown('===\nTesto'), [paragraph(text('==='), { kind: 'break' }, text('Testo'))]);
});

test('lazy quote lines: a line without > continues the paragraph of the quote', () => {
  const quote = (...blocks: Block[]): Block => ({ kind: 'quote', blocks });
  const br: Inline = { kind: 'break' };
  assert.deepEqual(parseMarkdown('> prima\nseconda\nterza'), [quote(paragraph(text('prima'), br, text('seconda'), br, text('terza')))]);
  assert.deepEqual(parseMarkdown('> > dentro\nancora'), [quote(quote(paragraph(text('dentro'), br, text('ancora'))))]);
  assert.deepEqual(parseMarkdown('> - voce\ncontinua'), [
    quote({ kind: 'list', ordered: false, start: 1, items: [[paragraph(text('voce'), br, text('continua'))]] }),
  ]);
  // A lazy underline stays text: it cannot make the quoted paragraph a heading.
  assert.deepEqual(parseMarkdown('> citato\n==='), [quote(paragraph(text('citato'), br, text('===')))]);
});

test('what is not a lazy quote line ends the quote', () => {
  const quote = (...blocks: Block[]): Block => ({ kind: 'quote', blocks });
  assert.deepEqual(parseMarkdown('> citato\n\nfuori'), [quote(paragraph(text('citato'))), paragraph(text('fuori'))]);
  assert.deepEqual(parseMarkdown('> citato\n---'), [quote(paragraph(text('citato'))), { kind: 'rule' }]);
  assert.deepEqual(parseMarkdown('> citato\n- voce'), [
    quote(paragraph(text('citato'))),
    { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('voce'))]] },
  ]);
  assert.deepEqual(parseMarkdown('> citato\n# Titolo'), [quote(paragraph(text('citato'))), { kind: 'heading', level: 1, inlines: [text('Titolo')] }]);
  assert.deepEqual(parseMarkdown('> # Titolo\nfuori'), [quote({ kind: 'heading', level: 1, inlines: [text('Titolo')] }), paragraph(text('fuori'))]);
  assert.deepEqual(parseMarkdown('> ---\nfuori'), [quote({ kind: 'rule' }), paragraph(text('fuori'))]);
  assert.deepEqual(parseMarkdown('> Titolo\n> ===\nfuori'), [quote({ kind: 'heading', level: 1, inlines: [text('Titolo')] }), paragraph(text('fuori'))]);
  assert.deepEqual(parseMarkdown('> ```\n> codice\nfuori'), [quote({ kind: 'code', lang: null, text: 'codice' }), paragraph(text('fuori'))]);
  assert.deepEqual(parseMarkdown('> ```\n> codice\n> ```\nfuori'), [quote({ kind: 'code', lang: null, text: 'codice' }), paragraph(text('fuori'))]);
  assert.deepEqual(parseMarkdown('> \nfuori'), [quote(), paragraph(text('fuori'))]);
});

test('lists: bullets, numbers with their start, nesting, a list right after a paragraph', () => {
  assert.deepEqual(parseMarkdown('Passi:\n1. uno\n2. **due**'), [
    paragraph(text('Passi:')),
    {
      kind: 'list',
      ordered: true,
      start: 1,
      items: [[paragraph(text('uno'))], [paragraph({ kind: 'strong', children: [text('due')] })]],
    },
  ]);
  assert.deepEqual(parseMarkdown('3. tre\n4. quattro'), [
    { kind: 'list', ordered: true, start: 3, items: [[paragraph(text('tre'))], [paragraph(text('quattro'))]] },
  ]);
  assert.deepEqual(parseMarkdown('- a\n  - a1\n  - a2\n- b'), [
    {
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        [paragraph(text('a')), { kind: 'list', ordered: false, start: 1, items: [[paragraph(text('a1'))], [paragraph(text('a2'))]] }],
        [paragraph(text('b'))],
      ],
    },
  ]);
});

test('a list item can hold code and continue after a blank line', () => {
  assert.deepEqual(parseMarkdown('1. avvia:\n\n   ```\n   omlx serve\n   ```\n2. verifica'), [
    {
      kind: 'list',
      ordered: true,
      start: 1,
      items: [[paragraph(text('avvia:')), { kind: 'code', lang: null, text: 'omlx serve' }], [paragraph(text('verifica'))]],
    },
  ]);
});

test('a different marker starts a new list; text after a blank line ends it', () => {
  const blocks = parseMarkdown('- a\n* b\n\nfine');
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['list', 'list', 'paragraph'],
  );
});

test('pipe tables with alignment; rows padded to the header', () => {
  assert.deepEqual(parseMarkdown('| Nome | Porta |\n| :--- | ---: |\n| oMLX | `7001` |\n| core |'), [
    {
      kind: 'table',
      align: ['left', 'right'],
      head: [[text('Nome')], [text('Porta')]],
      rows: [
        [[text('oMLX')], [{ kind: 'code', text: '7001' }]],
        [[text('core')], []],
      ],
    },
  ]);
  // Not a table (the separator has one cell for two in the header): as in GFM, a setext heading.
  assert.deepEqual(parseMarkdown('a | b\n---'), [{ kind: 'heading', level: 2, inlines: [text('a | b')] }]);
  assert.deepEqual(parseMarkdown('a | b\n\n---'), [paragraph(text('a | b')), { kind: 'rule' }]);
});

test('deep nesting is cut to text instead of recursing without end', () => {
  const blocks = parseMarkdown('>'.repeat(50) + ' fondo');
  let depth = 0;
  let current: Block | undefined = blocks[0];
  while (current?.kind === 'quote') {
    depth++;
    current = current.blocks[0];
  }
  assert.ok(depth <= 10);
  assert.equal(current?.kind, 'paragraph');
});

test('crafted or degenerate input does not stall the page', () => {
  // Each input is built for a size n; the parser must grow linearly with it. A wall-clock cap alone
  // fails on a machine busy with the rest of the suite, so the test compares sizes n and 8n
  // measured back to back (best of a few rounds): linear gives a ratio near 8, quadratic near 64.
  // The small size is large enough (16k) that its time is not timer noise, and is never taken
  // below 1 ms.
  const inputs: ((n: number) => string)[] = [
    (n) => '*a '.repeat(n / 3),
    (n) => '['.repeat(n),
    (n) => '`x '.repeat(n / 3),
    (n) => '_'.repeat(n),
    (n) => '## Passi' + ' '.repeat(n) + '.',
    (n) => 'a|b\n|-' + ' '.repeat(n) + 'x',
    (n) => '- a' + '\n'.repeat(n) + '   b',
    (n) => 'https://a' + '.'.repeat(n) + 'a',
    (n) => 'https://a' + ')'.repeat(n),
    (n) => 'https://['.repeat(n / 9),
    (n) => '[a](b'.repeat(n / 5),
    (n) => '[a]('.repeat(n / 4),
    (n) => '[a](<'.repeat(n / 5),
    (n) => '[a](b "'.repeat(n / 7),
    (n) => 'a\n'.repeat(n / 4) + '='.repeat(n / 2),
    (n) => '> a\n' + 'b\n'.repeat(n / 2),
    (n) => '> a\n'.repeat(n / 8) + '===\n'.repeat(n / 8),
    (n) => '> ```\n' + '> x\n'.repeat(n / 4),
  ];
  const small = 16_000;
  const large = 8 * small;
  // CPU time of this process, in ms: other processes of the suite do not count, wall-clock time does.
  const time = (input: string) => {
    const started = process.cpuUsage();
    parseMarkdown(input);
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1000;
  };
  const measure = (a: string, b: string) => {
    let bestSmall = Infinity;
    let bestLarge = Infinity;
    for (let round = 0; round < 5; round++) {
      bestSmall = Math.min(bestSmall, time(a));
      bestLarge = Math.min(bestLarge, time(b));
    }
    return { bestSmall, bestLarge };
  };
  for (const build of inputs) {
    const [a, b] = [build(small), build(large)];
    time(a);
    // A burst of load can still hit every round of one measure: a linear parser passes on a repeat,
    // a quadratic one fails them all.
    let label = '';
    let linear = false;
    for (let attempt = 0; attempt < 3 && !linear; attempt++) {
      const { bestSmall, bestLarge } = measure(a, b);
      label = `${JSON.stringify(b.slice(0, 12))}…: ${bestSmall.toFixed(1)} ms at ${String(small)}, ${bestLarge.toFixed(1)} ms at ${String(large)}`;
      // Linear parsing takes a few hundred ms for the slowest input at the large size; quadratic, far more.
      // Very wide: only a stall fails it, never a loaded machine.
      assert.ok(bestLarge < 10_000, label);
      // Under 5 ms the large size is fast whatever the ratio (timer noise dominates).
      linear = bestLarge < 5 || bestLarge / Math.max(bestSmall, 1) < 25;
    }
    assert.ok(linear, `grows faster than linear: ${label}`);
  }
});

test('headings keep a closing # only when it is part of the text', () => {
  assert.deepEqual(parseMarkdown('# C#'), [{ kind: 'heading', level: 1, inlines: [text('C#')] }]);
  assert.deepEqual(parseMarkdown('### Fine ###   '), [{ kind: 'heading', level: 3, inlines: [text('Fine')] }]);
  assert.deepEqual(parseMarkdown('##'), [{ kind: 'heading', level: 2, inlines: [] }]);
});

test('no link inside a link label', () => {
  assert.deepEqual(parseInline('[https://a.example](https://b.example)'), [
    { kind: 'link', href: 'https://b.example/', children: [text('https://a.example')] },
  ]);
  assert.deepEqual(parseInline('[[a](https://x.example)](https://y.example)'), [
    { kind: 'link', href: 'https://y.example/', children: [text('[a](https://x.example)')] },
  ]);
});

test('safeHref refuses disguised schemes and keeps what URL normalizes', () => {
  for (const href of [' javascript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', '&#106;avascript:alert(1)', 'vbscript:x', '//host/a']) {
    assert.equal(safeHref(href), null, href);
  }
  assert.equal(safeHref('https:evil.example'), 'https://evil.example/');
  assert.deepEqual(parseInline('[a](<https://e.example/x y> "titolo")'), [{ kind: 'link', href: 'https://e.example/x%20y', children: [text('a')] }]);
});

test('inlineText flattens a label', () => {
  assert.equal(inlineText(parseInline('**a** `b` [c](https://example.org)')), 'a b c');
});
