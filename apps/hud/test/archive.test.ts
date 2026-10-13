// "Da archiviare" (D-195): what the page sends when the user approves a
// proposal as it is or corrected, and the texts it shows.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { approveItemOf, archiveErrorText, editOf, folderText, isCorrected, movedText, titleProblem, type ArchiveItem } from '../src/lib/archive.ts';

const ITEM: ArchiveItem = {
  name: '2026-10-13-080000-ombrellone.md',
  path: 'kb/inbox/2026-10-13-080000-ombrellone.md',
  noteTitle: 'Ombrellone',
  label: 'L2',
  capturedAt: '2026-10-13T08:00:00+02:00',
  version: 'a'.repeat(64),
  state: 'proposed',
  folder: 'kb/private/casa',
  title: 'Ombrellone per il balcone',
  links: [{ path: 'kb/private/casa/balcone.md', title: 'Balcone finto' }],
  reason: 'Un acquisto per la casa.',
  at: '2026-10-13T08:02:00+02:00',
};

describe('approveItemOf', () => {
  it('sends only name and version for a proposal approved as it is', () => {
    assert.deepEqual(approveItemOf(ITEM, editOf(ITEM)), { name: ITEM.name, version: ITEM.version });
    assert.equal(isCorrected(ITEM, editOf(ITEM)), false);
  });

  it('sends the fields the user changed', () => {
    const edit = { folder: 'kb/public/ricette', title: '  Ombrellone  ', links: [] };
    assert.deepEqual(approveItemOf(ITEM, edit), { name: ITEM.name, version: ITEM.version, folder: 'kb/public/ricette', title: 'Ombrellone', links: [] });
    assert.equal(isCorrected(ITEM, edit), true);
  });
});

describe('texts', () => {
  it('shows folders without kb/', () => {
    assert.equal(folderText('kb/private/casa'), 'private/casa');
  });

  it('checks the title', () => {
    assert.equal(titleProblem('Ombrellone'), undefined);
    assert.notEqual(titleProblem('   '), undefined);
    assert.notEqual(titleProblem('x'.repeat(81)), undefined);
  });

  it('says where a thought went and how many notes were relinked', () => {
    assert.equal(movedText({ name: ITEM.name, ok: true, path: `kb/private/casa/${ITEM.name}`, relinked: 0 }), 'Spostato in private/casa.');
    assert.equal(movedText({ name: ITEM.name, ok: true, path: `kb/private/casa/${ITEM.name}`, relinked: 2 }), 'Spostato in private/casa. Collegamenti aggiornati in 2 note.');
  });

  it('turns every refusal of the core into Italian, an unknown one too', () => {
    for (const code of ['changed', 'expired', 'no-proposal', 'folder', 'exists', 'label', 'invalid', 'not-found', 'unavailable']) assert.doesNotMatch(archiveErrorText(code), /^[a-z-]+$/);
    assert.equal(archiveErrorText('altro'), 'Non sono riuscita a spostarlo.');
  });
});
