// «Server dei modelli (oMLX)» (D-265): the texts of the card and the dot on «Impostazioni».
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installedText, OMLX_NOTICE, prereleaseText, releaseLink, scheduleText, statusText, updateHint, type OmlxRelease, type OmlxReleaseView } from '../src/lib/omlx-release.ts';

const release = (version: string, prerelease = false): OmlxRelease => ({ tag: `v${version}`, name: version, publishedAt: '2026-10-20T10:00:00Z', url: `https://github.com/jundot/omlx/releases/tag/v${version}`, notes: '', version, prerelease });

function view(change: Partial<OmlxReleaseView> = {}): OmlxReleaseView {
  return {
    version: 1,
    installed: { version: '0.7.1', endpoint: 'omlx', readAt: '2026-10-21T08:00:00Z', error: null },
    checkedAt: '2026-10-21T08:00:00Z',
    message: null,
    failed: false,
    latest: release('0.7.1'),
    prerelease: null,
    news: null,
    checking: false,
    update: false,
    nextCheckAt: '2026-10-22T08:00:00Z',
    ...change,
  };
}

describe('the card of oMLX', () => {
  it('a dot only for a newer stable release', () => {
    assert.equal(updateHint(view({ update: true, latest: release('0.7.2') })), 'oMLX 0.7.2 disponibile');
    assert.equal(updateHint(view()), null);
    assert.equal(updateHint(view({ update: false, prerelease: release('0.7.2rc1', true) })), null);
    assert.equal(updateHint(null), null);
    assert.equal(updateHint(undefined), null);
  });

  it('says whether oMLX is up to date, newer, or unknown', () => {
    assert.deepEqual(statusText(view()), { text: 'oMLX è aggiornato.', tone: 'ok' });
    assert.equal(statusText(view({ update: true, latest: release('0.7.2') })).tone, 'accent');
    assert.match(statusText(view({ latest: null, checkedAt: null })).text, /non ancora controllata/);
    assert.match(statusText(view({ installed: { version: null, endpoint: 'omlx', readAt: 'x', error: 'e' } })).text, /non si legge/);
  });

  it('the version installed: read, not yet, not readable', () => {
    assert.equal(installedText(view()), '0.7.1');
    assert.equal(installedText(view({ installed: { version: null, endpoint: null, readAt: null, error: null } })), 'non ancora letta');
    assert.equal(installedText(view({ installed: { version: null, endpoint: null, readAt: 'x', error: 'e' } })), 'non leggibile');
  });

  it('a pre-release is information, never an update', () => {
    assert.match(prereleaseText(view({ prerelease: release('0.7.2rc1', true) })) ?? '', /non conta come aggiornamento/);
    assert.equal(prereleaseText(view()), null);
  });

  it('the schedule and the link', () => {
    assert.match(scheduleText(view(), (iso) => iso ?? '?'), /prossimo controllo automatico dal 2026-10-22/);
    assert.equal(scheduleText(view({ checking: true }), String), 'Controllo in corso…');
    assert.match(scheduleText(view({ checkedAt: null }), String), /Mai controllato/);
    assert.equal(releaseLink(view()), 'https://github.com/jundot/omlx/releases/tag/v0.7.1');
    assert.equal(releaseLink(view({ latest: null })), 'https://github.com/jundot/omlx/releases');
  });

  it('the fixed notice names the reading of the code and the DMG', () => {
    assert.match(OMLX_NOTICE, /D-221 e D-263/);
    assert.match(OMLX_NOTICE, /DMG a core fermo/);
  });
});
