// The master password of P5 (D-187): only its scrypt hash is kept.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hashMasterPassword, isMasterPasswordHash, verifyMasterPassword } from '@arianna/vault';

describe('master password', () => {
  it('checks the right password and refuses a wrong one', async () => {
    const hash = await hashMasterPassword('cavallo-batteria-graffetta');
    assert.match(hash, /^scrypt\$15\$8\$1\$/);
    assert.equal(hash.includes('cavallo'), false);
    assert.equal(isMasterPasswordHash(hash), true);
    assert.equal(await verifyMasterPassword(hash, 'cavallo-batteria-graffetta'), true);
    assert.equal(await verifyMasterPassword(`${hash}\n`, 'cavallo-batteria-graffetta'), true);
    assert.equal(await verifyMasterPassword(hash, 'cavallo-batteria-graffettA'), false);
    assert.equal(await verifyMasterPassword(hash, ''), false);
  });

  it('gives two hashes of the same password with different salts', async () => {
    const [one, two] = await Promise.all([hashMasterPassword('stessa-password-1'), hashMasterPassword('stessa-password-1')]);
    assert.notEqual(one, two);
  });

  it('refuses a short password when the hash is made', async () => {
    await assert.rejects(hashMasterPassword('corta'), RangeError);
  });

  it('throws on a value that is not one of its hashes, and on a cost too high', async () => {
    await assert.rejects(verifyMasterPassword('la-password-in-chiaro', 'la-password-in-chiaro'), RangeError);
    const hash = await hashMasterPassword('cavallo-batteria-graffetta');
    const costly = hash.replace(/^scrypt\$15\$/, 'scrypt$18$');
    assert.equal(isMasterPasswordHash(costly), false);
    await assert.rejects(verifyMasterPassword(costly, 'cavallo-batteria-graffetta'), RangeError);
  });
});
