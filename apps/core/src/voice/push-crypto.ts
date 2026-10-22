import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The content of a Web Push, encrypted for one browser (RFC 8291 with the
 * `aes128gcm` coding of RFC 8188), with node:crypto only. Only the browser
 * that subscribed can read it: the push service carries bytes it cannot open.
 * One record: the payloads are a few dozen bytes.
 */

/** RFC 8188 record size; the payload must fit in one record. */
const RECORD_SIZE = 4096;
/** Tag of AES-GCM and the delimiter byte of the last record. */
const OVERHEAD = 16 + 1;

export interface EncryptOptions {
  /** For the test vectors of RFC 8291 only: a fixed sender key and salt. */
  senderPrivateKey?: Buffer;
  salt?: Buffer;
}

/**
 * `p256dh` and `auth` are the keys of the subscription (base64url); the
 * result is the request body, sent with `content-encoding: aes128gcm`.
 */
export function encryptPush(plaintext: Buffer, p256dh: string, auth: string, options: EncryptOptions = {}): Buffer {
  const receiverPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4) throw new RangeError('p256dh: not an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new RangeError('auth: 16 bytes expected');
  if (plaintext.length + OVERHEAD > RECORD_SIZE) throw new RangeError('push payload too large for one record');

  const sender = createECDH('prime256v1');
  if (options.senderPrivateKey === undefined) sender.generateKeys();
  else sender.setPrivateKey(options.senderPrivateKey);
  const senderPublic = sender.getPublicKey();
  const salt = options.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new RangeError('salt: 16 bytes expected');

  // RFC 8291 §3.4: the input keying material from the ECDH secret and the auth secret.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sender.computeSecret(receiverPublic), authSecret, keyInfo, 32));
  // RFC 8188 §2.2-2.3: content key and nonce; with one record the sequence number is 0.
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // 0x02 closes the last (only) record, without padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body]);
}
