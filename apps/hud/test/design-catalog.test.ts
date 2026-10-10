// "Stili di Open Design" in Impostazioni → Agenti (D-160): button, summary, errors.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { catalogErrorText, changesText, creditText, filterStyles, jobErrorText, shouldPoll, updateBlocked, updateButtonText, type CatalogStatus } from '../src/lib/design-catalog.ts';

const version = { commit: 'a'.repeat(40), committedAt: '2026-10-01T10:00:00Z', fetchedAt: '2026-10-10T08:00:00Z', styles: 152, skills: 163, rejected: 0 };
const none = { added: 0, removed: 0, changed: 0, addedSlugs: [], removedSlugs: [], changedSlugs: [] };

function status(overrides: Partial<CatalogStatus> = {}): CatalogStatus {
  return {
    repository: 'https://github.com/nexu-io/open-design.git',
    page: 'https://github.com/nexu-io/open-design',
    license: { name: 'Apache-2.0', copyright: 'Copyright 2026 Open Design contributors', notice: null },
    adopted: null,
    pending: null,
    job: null,
    ...overrides,
  };
}

const running = { status: 'running' as const, phase: 'download' as const, startedAt: '', finishedAt: null, outcome: null, error: null };

describe('the button', () => {
  it('is "Scarica catalogo" the first time, then "Aggiorna catalogo"', () => {
    assert.equal(updateButtonText(status()), 'Scarica catalogo');
    assert.equal(updateButtonText(null), 'Scarica catalogo');
    assert.equal(updateButtonText(status({ adopted: { ...version, adoptedAt: '' } })), 'Aggiorna catalogo');
    assert.equal(updateButtonText(status({ job: running })), 'Scarico…');
  });

  it('waits while a download runs or a version waits, and polls only while running', () => {
    assert.equal(updateBlocked(status()), undefined);
    assert.match(updateBlocked(status({ job: running })) ?? '', /in corso/);
    assert.match(updateBlocked(status({ pending: { ...version, diff: { styles: none, skills: none } } })) ?? '', /usa o scarta/);
    assert.equal(shouldPoll(status({ job: running })), true);
    assert.equal(shouldPoll(status({ job: { ...running, status: 'done' } })), false);
    assert.equal(shouldPoll(null), false);
  });
});

describe('the summary', () => {
  it('says how many styles and skills are new, changed and gone', () => {
    assert.equal(changesText({ ...none, added: 5, changed: 2, removed: 1 }, 'style'), '5 stili nuovi, 2 cambiati, 1 tolto');
    assert.equal(changesText({ ...none, added: 1 }, 'style'), '1 stile nuovo, 0 cambiati, 0 tolti');
    assert.equal(changesText({ ...none, added: 1, changed: 3 }, 'skill'), '1 skill nuova, 3 cambiate, 0 tolte');
  });

  it('credits the source and its license', () => {
    assert.match(creditText(status()), /nexu-io\/open-design.*Apache-2\.0, Copyright 2026 Open Design contributors/);
  });

  it('finds styles by every word of the query', () => {
    const styles = [
      { slug: 'airbnb', name: 'Airbnb', description: 'Warm coral accent.', category: 'E-Commerce' },
      { slug: 'spacex', name: 'SpaceX', description: 'Stark black and white.' },
    ];
    assert.deepEqual(filterStyles(styles, '').map((item) => item.slug), ['airbnb', 'spacex']);
    assert.deepEqual(filterStyles(styles, 'black WHITE').map((item) => item.slug), ['spacex']);
    assert.deepEqual(filterStyles(styles, 'commerce coral').map((item) => item.slug), ['airbnb']);
    assert.deepEqual(filterStyles(styles, 'coral black'), []);
  });
});

describe('errors', () => {
  it('turns the refusals of the core into Italian', () => {
    assert.match(catalogErrorText(new ApiError(409, 'the version waiting is not the one shown: read the status again')), /ricarica la pagina/);
    assert.match(catalogErrorText(new ApiError(404, 'not found')), /riavvialo/);
    assert.match(catalogErrorText(new ApiError(409, 'Il catalogo è occupato da un altro processo: riprova quando ha finito.')), /occupato da un altro processo/);
    assert.equal(catalogErrorText(new ApiError(409, 'Prima usa o scarta la versione scaricata.')), 'Prima usa o scarta la versione scaricata.');
    assert.match(catalogErrorText(new ApiError(502, 'the swap of the catalog did not complete: EISDIR')), /cambio di versione/);
    assert.match(jobErrorText('the gateway did not let the request out: blocked'), /gateway/);
    assert.match(jobErrorText('the license of the repository is no longer Apache-2.0: nothing adopted'), /licenza/);
    assert.match(jobErrorText('git clone: could not resolve host'), /could not resolve host/);
    assert.match(jobErrorText(null), /non è riuscito/);
  });
});
