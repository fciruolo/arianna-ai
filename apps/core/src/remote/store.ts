/**
 * The devices of the remote port in PostgreSQL (D-292, stage B; migration
 * 0089): devices, public keys of their passkeys, sha256 of their session
 * cookies. Times come from the service's clock, never from now() of the
 * database, so the rules of 12 hours and 30 minutes are the same everywhere.
 */
import type { Sql } from '../db/client.ts';
import { appendEvent } from '../events.ts';
import type { DeviceStore, StoredDeviceCredential } from './devices.ts';
import type { CoseAlgorithm } from './webauthn.ts';

export function createDeviceStore(sql: Sql): DeviceStore {
  return {
    async pair(device, credential, session) {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO remote_devices (id, name, created_at, last_seen_at) VALUES (${device.id}, ${device.name}, ${session.createdAt}, ${session.createdAt})`;
        await tx`
          INSERT INTO remote_credentials (device_id, credential_id, public_key, algorithm, sign_count, created_at, last_used_at)
          VALUES (${device.id}, ${credential.credentialId}, ${credential.publicKey}, ${credential.algorithm}, ${credential.signCount}, ${session.createdAt}, ${session.createdAt})`;
        await tx`
          INSERT INTO remote_sessions (device_id, token_hash, created_at, last_seen_at, expires_at)
          VALUES (${device.id}, ${session.tokenHash}, ${session.createdAt}, ${session.createdAt}, ${session.expiresAt})`;
      });
    },

    async credential(credentialId) {
      const [row] = await sql<{ deviceId: string; credentialId: Buffer; publicKey: Buffer; algorithm: number; signCount: string }[]>`
        SELECT c.device_id AS "deviceId", c.credential_id AS "credentialId", c.public_key AS "publicKey", c.algorithm, c.sign_count::text AS "signCount"
        FROM remote_credentials c JOIN remote_devices d ON d.id = c.device_id
        WHERE c.credential_id = ${credentialId} AND c.revoked_at IS NULL AND d.revoked_at IS NULL`;
      if (row === undefined) return undefined;
      const stored: StoredDeviceCredential = { ...row, algorithm: row.algorithm as CoseAlgorithm, signCount: Number(row.signCount) };
      return stored;
    },

    async credentials(deviceId) {
      const rows = await sql<{ id: Buffer }[]>`
        SELECT c.credential_id AS id FROM remote_credentials c JOIN remote_devices d ON d.id = c.device_id
        WHERE c.device_id = ${deviceId} AND c.revoked_at IS NULL AND d.revoked_at IS NULL ORDER BY c.id`;
      return rows.map((row) => row.id);
    },

    async useCredential(credentialId, from, to, at) {
      // Compare-and-set on the counter read: two uses of one value cannot both pass.
      const rows = await sql`
        UPDATE remote_credentials SET sign_count = ${to}, last_used_at = ${at}
        WHERE credential_id = ${credentialId} AND sign_count = ${from} AND revoked_at IS NULL
          AND EXISTS (SELECT FROM remote_devices d WHERE d.id = device_id AND d.revoked_at IS NULL)
        RETURNING id`;
      if (rows.length === 0) return false;
      await sql`UPDATE remote_devices SET last_seen_at = ${at} WHERE id = (SELECT device_id FROM remote_credentials WHERE credential_id = ${credentialId})`;
      return true;
    },

    async createSession(deviceId, session) {
      await sql`
        INSERT INTO remote_sessions (device_id, token_hash, created_at, last_seen_at, expires_at)
        VALUES (${deviceId}, ${session.tokenHash}, ${session.createdAt}, ${session.createdAt}, ${session.expiresAt})`;
    },

    async session(tokenHash, now, idleMs) {
      const idleSince = new Date(now.getTime() - idleMs);
      const [row] = await sql<{ id: string; deviceId: string; lastSeenAt: Date }[]>`
        SELECT s.id::text AS id, s.device_id AS "deviceId", s.last_seen_at AS "lastSeenAt"
        FROM remote_sessions s JOIN remote_devices d ON d.id = s.device_id
        WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL AND d.revoked_at IS NULL
          AND s.expires_at > ${now} AND s.last_seen_at > ${idleSince} AND s.created_at <= ${now}`;
      return row;
    },

    async touchSession(id, deviceId, at) {
      await sql`UPDATE remote_sessions SET last_seen_at = ${at} WHERE id = ${id} AND revoked_at IS NULL AND last_seen_at < ${at}`;
      await sql`UPDATE remote_devices SET last_seen_at = ${at} WHERE id = ${deviceId} AND revoked_at IS NULL AND (last_seen_at IS NULL OR last_seen_at < ${at})`;
    },

    async sessionAlive(id, now, idleMs) {
      const idleSince = new Date(now.getTime() - idleMs);
      const rows = await sql`
        SELECT 1 FROM remote_sessions s JOIN remote_devices d ON d.id = s.device_id
        WHERE s.id = ${id} AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND s.expires_at > ${now} AND s.last_seen_at > ${idleSince}`;
      return rows.length > 0;
    },

    async endSession(tokenHash, at) {
      await sql`UPDATE remote_sessions SET revoked_at = ${at} WHERE token_hash = ${tokenHash} AND revoked_at IS NULL`;
    },

    async list() {
      const rows = await sql<{ id: string; name: string; createdAt: Date; lastSeenAt: Date | null }[]>`
        SELECT id, name, created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM remote_devices
        WHERE revoked_at IS NULL ORDER BY created_at, id`;
      return rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt?.toISOString() ?? null }));
    },

    async unlink(deviceId, at) {
      return sql.begin(async (tx) => {
        const rows = await tx`UPDATE remote_devices SET revoked_at = ${at} WHERE id = ${deviceId} AND revoked_at IS NULL RETURNING id`;
        if (rows.length === 0) return false;
        await tx`UPDATE remote_sessions SET revoked_at = ${at} WHERE device_id = ${deviceId} AND revoked_at IS NULL`;
        await tx`UPDATE remote_credentials SET revoked_at = ${at} WHERE device_id = ${deviceId} AND revoked_at IS NULL`;
        // The notices with the chat closed stop at once for this phone.
        await tx`UPDATE push_subscriptions SET removed_at = ${at} WHERE device_id = ${deviceId} AND removed_at IS NULL`;
        return true;
      });
    },

    async event(event) {
      // Metadata only, L0: the id of the device and the outcome.
      await appendEvent(sql, { kind: event.kind, label: 'L0', payload: event.payload });
    },
  };
}
