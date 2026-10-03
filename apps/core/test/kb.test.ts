import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseLabelRules, resolveHome } from '@arianna/config';
import { createContext } from '@arianna/policy';

import { checkPagePath, createKb, KbError, parsePage } from '../src/orchestrator/kb.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', randomUUID());
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RULES = parseLabelRules(`
[[folder]]
path = "kb/public"
label = "L0"

[[folder]]
path = "kb/work"
label = "L1"

[[folder]]
path = "kb/private"
label = "L2"
`);

const work = createContext('L1', 'L1');
const personal = createContext('L2', 'L2');

/** A home with a small fake knowledge base. */
function home(): string {
  const dir = join(scratch, randomUUID());
  const page = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  page('kb/public/torta.md', '---\ntitle: Torta di mele\n---\n\nForno a 180 gradi, mele renette.');
  page('kb/work/clienti/rossi.md', '---\ntitle: Rossi Srl\n---\n\nIl contratto di assistenza scade il 31 marzo.');
  page('kb/work/segreto.md', '---\ntitle: Nota riservata\nlabel: L2\n---\n\nIl contratto con la banca è riservato.');
  page('kb/private/affitto.md', '---\ntitle: Affitto\n---\n\nLa càparra è di tre mensilità; contratto di quattro anni.');
  return dir;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof KbError) return error.code;
    throw error;
  }
  return 'ok';
}

describe('kb paths', () => {
  it('accepts plain page paths under kb/', () => {
    assert.equal(checkPagePath(' kb/casa/caldaia.md '), 'kb/casa/caldaia.md');
    assert.equal(checkPagePath('kb/clienti/rossi-srl.md'), 'kb/clienti/rossi-srl.md');
  });

  it('refuses paths outside kb/, hidden or dotted segments and other files', () => {
    for (const path of ['data/kb/x.md', 'kb/x.txt', 'kb/../data/x.md', 'kb/.git/x.md', 'kb//x.md', '/kb/x.md', 'kb/a/...md', 'kb']) {
      assert.equal(code(() => checkPagePath(path)), 'invalid-path', path);
    }
  });

  it('reads the header and the body', () => {
    assert.deepEqual(parsePage('---\ntitle: T\nlabel: L1\nother: x\n---\n\nBody'), { header: { labels: ['L1'], title: 'T' }, body: 'Body' });
    assert.deepEqual(parsePage('No header'), { header: { labels: [] }, body: 'No header' });
  });
});

describe('kb read', () => {
  const kb = createKb({ home: home(), rules: RULES });

  it('reads pages within the clearance, with their label', () => {
    const page = kb.read('kb/work/clienti/rossi.md', work);
    assert.equal(page.label, 'L1');
    assert.equal(page.title, 'Rossi Srl');
    assert.match(page.body, /31 marzo/);
    assert.equal(kb.read('kb/private/affitto.md', personal).label, 'L2');
  });

  it('refuses a page above the clearance, also when its header raises it', () => {
    assert.equal(code(() => kb.read('kb/private/affitto.md', work)), 'above-clearance');
    assert.equal(code(() => kb.read('kb/work/segreto.md', work)), 'above-clearance');
  });

  it('says not found for a missing page', () => {
    assert.equal(code(() => kb.read('kb/work/nessuna.md', work)), 'not-found');
  });

  it('does not follow symbolic links', () => {
    const dir = home();
    writeFileSync(join(dir, 'outside.md'), 'outside');
    symlinkSync(join(dir, 'outside.md'), join(dir, 'kb', 'public', 'link.md'));
    symlinkSync(join(dir, 'kb', 'private'), join(dir, 'kb', 'public', 'linked'));
    const linked = createKb({ home: dir, rules: RULES });
    assert.equal(code(() => linked.read('kb/public/link.md', work)), 'not-found');
    assert.equal(code(() => linked.read('kb/public/linked/affitto.md', work)), 'not-found');
  });
});

describe('kb search', () => {
  const kb = createKb({ home: home(), rules: RULES });

  it('finds pages by words, ignoring case and accents', () => {
    const [hit] = kb.search('CAPARRA affitto', personal).hits;
    assert.ok(hit !== undefined);
    assert.deepEqual([hit.path, hit.label], ['kb/private/affitto.md', 'L2']);
    assert.match(hit.snippet, /càparra/);
  });

  it('leaves out pages above the clearance and says so, whatever they contain', () => {
    const found = kb.search('contratto', work);
    assert.deepEqual(found.hits.map((hit) => hit.path), ['kb/work/clienti/rossi.md']);
    assert.equal(found.skippedAbove, true);
    const none = kb.search('caparra', work);
    assert.deepEqual(none, { hits: [], skippedAbove: true });
  });

  it('searches every page in a private conversation', () => {
    const found = kb.search('contratto', personal);
    assert.deepEqual(found.hits.map((hit) => hit.path).sort(), ['kb/private/affitto.md', 'kb/work/clienti/rossi.md', 'kb/work/segreto.md']);
    assert.equal(found.skippedAbove, false);
  });

  it('respects the limit and ignores short words', () => {
    assert.equal(kb.search('contratto', personal, 1).hits.length, 1);
    assert.deepEqual(kb.search('di il', personal).hits, []);
  });
});

describe('kb write', () => {
  it('writes under kb/inbox with the label and the source', () => {
    const dir = home();
    const kb = createKb({ home: dir, rules: RULES });
    assert.deepEqual(kb.write('kb/inbox/caldaia.md', 'Revisione entro novembre.', 'L1', 'task:a'), { path: 'kb/inbox/caldaia.md', label: 'L2' });
    const text = readFileSync(join(dir, 'kb', 'inbox', 'caldaia.md'), 'utf8');
    // No folder rule for the inbox: L2 by default-deny, above what it was written from.
    assert.match(text, /^---\nlabel: L2\nsource: task:a\n---\n\nRevisione entro novembre\.\n$/);
  });

  it('refuses to write outside kb/inbox with autonomy A1', () => {
    const dir = home();
    const kb = createKb({ home: dir, rules: RULES });
    assert.equal(code(() => kb.write('kb/work/nuova.md', 'x', 'L1', 'task:a')), 'not-allowed');
    assert.equal(existsSync(join(dir, 'kb', 'work', 'nuova.md')), false);
  });

  it('lets only the task that wrote a page write it again', () => {
    const kb = createKb({ home: home(), rules: RULES });
    kb.write('kb/inbox/nota.md', 'prima', 'L2', 'task:a');
    assert.equal(code(() => kb.write('kb/inbox/nota.md', 'seconda', 'L2', 'task:a')), 'ok');
    assert.equal(code(() => kb.write('kb/inbox/nota.md', 'altra', 'L2', 'task:b')), 'exists');
  });

  it('refuses an inbox that is a link to somewhere else', () => {
    const dir = home();
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'kb', 'inbox'));
    const kb = createKb({ home: dir, rules: RULES });
    assert.equal(code(() => kb.write('kb/inbox/nota.md', 'x', 'L2', 'task:a')), 'invalid-path');
    assert.equal(existsSync(join(dir, 'elsewhere', 'nota.md')), false);
  });
});

describe('kb header labels', () => {
  /** The label of one page in kb/public (L0) with this text. */
  function labelOf(text: string) {
    const dir = home();
    writeFileSync(join(dir, 'kb', 'public', 'p.md'), text);
    return createKb({ home: dir, rules: RULES }).search('pagina', personal).hits[0]?.label;
  }

  it('reads a header with a byte order mark, keys in any case, and keeps the highest of repeated labels', () => {
    assert.equal(labelOf('\uFEFF---\nlabel: L2\n---\n\npagina'), 'L2');
    assert.equal(labelOf('---\nLabel: L1\n---\n\npagina'), 'L1');
    assert.equal(labelOf('---\nlabel: L2\nlabel: L0\n---\n\npagina'), 'L2');
    assert.equal(labelOf('---\ntitle: x\n---\n\npagina'), 'L0');
  });

  it('counts a header that may hide a label as L3, so that no context reads the page', () => {
    assert.equal(labelOf('---\nlabel: l2\n---\n\npagina'), undefined);
    assert.equal(labelOf('---\nlabel L2\n---\n\npagina'), undefined);
    assert.equal(labelOf('---\nlabel: L2\n\npagina senza chiusura'), undefined);
  });
});

describe('kb hardening', () => {
  it('answers the same for a missing and an existing page above the clearance', () => {
    const kb = createKb({ home: home(), rules: RULES });
    assert.equal(code(() => kb.read('kb/private/affitto.md', work)), 'above-clearance');
    assert.equal(code(() => kb.read('kb/private/inesistente.md', work)), 'above-clearance');
  });

  it('does not write through a link to a file in the inbox', () => {
    const dir = home();
    mkdirSync(join(dir, 'kb', 'inbox'));
    writeFileSync(join(dir, 'target.txt'), 'untouched');
    symlinkSync(join(dir, 'target.txt'), join(dir, 'kb', 'inbox', 'nota.md'));
    const kb = createKb({ home: dir, rules: RULES });
    assert.equal(code(() => kb.write('kb/inbox/nota.md', 'x', 'L2', 'task:a')), 'invalid-path');
    assert.equal(readFileSync(join(dir, 'target.txt'), 'utf8'), 'untouched');
  });

  it('creates no folder through a linked inbox', () => {
    const dir = home();
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'kb', 'inbox'));
    const kb = createKb({ home: dir, rules: RULES });
    assert.equal(code(() => kb.write('kb/inbox/sub/nota.md', 'x', 'L2', 'task:a')), 'invalid-path');
    assert.equal(existsSync(join(dir, 'elsewhere', 'sub')), false);
  });
});
