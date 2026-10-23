import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';

/** What the browser does: the receiving side of RFC 8291, one record. */
export function decryptPush(body: Buffer, receiverPrivate: Buffer, receiverPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(receiverPrivate);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', receiver.computeSecret(senderPublic), auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const sealed = body.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  if (padded[padded.length - 1] !== 2) throw new Error('not the last record');
  return padded.subarray(0, padded.length - 1);
}
