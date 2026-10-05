// "Novità": the parser of CHANGELOG.md, the reading of the file and the route.
// Every text here is invented.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveHome } from '@arianna/config';

import { CHANGELOG_FILE, compareVersions, loadChangelog, parseChangelog } from '../src/changelog.ts';
import type { Sql } from '../src/db/client.ts';
import type { LiveFeed } from '../src/live.ts';
import { startApiServer } from '../src/server/http.ts';

const scratch = join(resolveHome({}), 'data', 'test-tmp', `changelog-${randomUUID()}`);
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FULL = `# Registro delle versioni

Un registro finto, per le prove.

Un secondo paragrafo con - un trattino e ### non un titolo.

## [Non rilasciato]

### Aggiunto
- Una pagina che mostra le **novità**

## [0.2.0] - 2026-11-02

### Aggiunto
- Il comando \`pnpm prova\`
- Una voce lunga che continua
  sulla riga seguente
  e su un'altra ancora
### Cambiato
### Corretto
- Un errore corretto
### Sicurezza
- Un controllo in più
### Rimosso
- Una cosa vecchia
### Deprecato
- Una sezione con un titolo fuori dalla lista

## [0.10.0] - 2026-10-20

### Corretto
- Versione con due cifre

## [0.1.0] - 2026-10-05

Un riassunto della versione,
su due righe.

Un secondo paragrafo con \`codice\`.

### Aggiunto
- La prima versione
`;

function makeHome(text?: string): string {
  const home = join(scratch, randomUUID());
  mkdirSync(home, { recursive: true });
  if (text !== undefined) writeFileSync(join(home, CHANGELOG_FILE), text);
  return home;
}

describe('parseChangelog', () => {
  it('reads the versions, the sections and the items of a full register', () => {
    const log = parseChangelog(FULL);
    assert.equal(log.skipped, 0);
    assert.equal(log.current, '0.10.0');
    assert.deepEqual(
      log.versions.map((entry) => [entry.version, entry.date, entry.unreleased]),
      [
        [null, null, true],
        ['0.2.0', '2026-11-02', false],
        ['0.10.0', '2026-10-20', false],
        ['0.1.0', '2026-10-05', false],
      ],
    );
    const second = log.versions[1];
    assert.ok(second !== undefined);
    // Empty sections are left out; other titles are kept as written.
    assert.deepEqual(
      second.sections.map((section) => section.title),
      ['Aggiunto', 'Corretto', 'Sicurezza', 'Rimosso', 'Deprecato'],
    );
    assert.deepEqual(second.sections[0]?.items, ['Il comando `pnpm prova`', "Una voce lunga che continua sulla riga seguente e su un'altra ancora"]);
    assert.deepEqual(log.versions[0]?.sections, [{ title: 'Aggiunto', items: ['Una pagina che mostra le **novità**'] }]);
    // Free text before the first section is the summary of the version.
    assert.equal(log.versions[3]?.summary, 'Un riassunto della versione, su due righe.\n\nUn secondo paragrafo con `codice`.');
    assert.equal(second.summary, null);
  });

  it('has no current version with only the unreleased section', () => {
    const log = parseChangelog('# R\n\n## [Non rilasciato]\n\n### Aggiunto\n- Qualcosa\n');
    assert.equal(log.current, null);
    assert.equal(log.versions.length, 1);
    assert.equal(log.versions[0]?.unreleased, true);
  });

  it('skips and counts malformed lines, never throws', () => {
    const text = [
      '# Registro',
      '',
      '## [0.1.0] - 2026-10-05',
      '- voce fuori da una sezione',
      '### Aggiunto',
      '- buona',
      'testo libero dentro una sezione',
      '-',
      '## [versione strana] - 2026-10-05',
      '### Aggiunto',
      '- persa con il suo titolo',
      '## [0.1.1] - 2026-02-30',
      '## [0.1.0] - 2026-10-06',
      '## [1.0] - 2026-10-05',
      '## [0.0.9] - 2026-10-01',
      '### Corretto',
      '```',
      '## [9.9.9] - 2026-10-05',
      '- dentro un blocco di codice',
      '```',
      '- dopo il blocco',
      '   ',
      '  continuazione dopo una riga vuota',
    ].join('\n');
    const log = parseChangelog(text);
    assert.deepEqual(
      log.versions.map((entry) => entry.version),
      ['0.1.0', '0.0.9'],
    );
    assert.deepEqual(log.versions[0]?.sections, [{ title: 'Aggiunto', items: ['buona'] }]);
    assert.deepEqual(log.versions[1]?.sections, [{ title: 'Corretto', items: ['dopo il blocco'] }]);
    assert.equal(log.current, '0.1.0');
    // Out of a section, free text in a section, empty item, bad heading + its 2 lines, bad date, duplicate, short version, continuation after a blank.
    assert.equal(log.skipped, 10);
    assert.deepEqual(parseChangelog(''), { current: null, versions: [], skipped: 0 });
  });

  it('compares versions by number, not by text', () => {
    assert.ok(compareVersions('0.10.0', '0.2.0') > 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.equal(compareVersions('0.1.1', '0.1.1'), 0);
  });
});

describe('loadChangelog', () => {
  it('reads CHANGELOG.md from the home', () => {
    assert.equal(loadChangelog(makeHome(FULL)).current, '0.10.0');
  });

  it('is empty when the file is missing', () => {
    assert.deepEqual(loadChangelog(makeHome()), { current: null, versions: [], skipped: 0 });
  });

  it('refuses a symbolic link', () => {
    const target = makeHome(FULL);
    const home = makeHome();
    symlinkSync(join(target, CHANGELOG_FILE), join(home, CHANGELOG_FILE));
    assert.deepEqual(loadChangelog(home).versions, []);
  });

  it('refuses a folder in place of the file', () => {
    const home = makeHome();
    mkdirSync(join(home, CHANGELOG_FILE));
    assert.deepEqual(loadChangelog(home).versions, []);
  });

  it('refuses a file larger than 2 MB', () => {
    const home = makeHome(`${FULL}\n${'x'.repeat(2 * 1024 * 1024)}\n`);
    assert.deepEqual(loadChangelog(home), { current: null, versions: [], skipped: 0 });
  });
});

function get(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

describe('route', () => {
  it('serves the register, and answers 404 without the option', async (t) => {
    const server = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0, changelog: { home: makeHome(FULL) } });
    const bare = await startApiServer({ sql: undefined as unknown as Sql, live: undefined as unknown as LiveFeed, host: '127.0.0.1', port: 0 });
    t.after(async () => {
      await server.close();
      await bare.close();
    });
    const reply = await get(server.port, '/api/changelog');
    assert.equal(reply.status, 200);
    const changelog = reply.body.changelog as { current: string; versions: unknown[]; skipped: number };
    assert.equal(changelog.current, '0.10.0');
    assert.equal(changelog.versions.length, 4);
    assert.equal(changelog.skipped, 0);
    assert.equal((await get(bare.port, '/api/changelog')).status, 404);
  });
});
