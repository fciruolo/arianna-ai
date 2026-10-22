// The DeviceStore of D-292 in memory, with the rules of migration 0089 that
// the service relies on (revocation, the counter moving forward only, the
// 12 hours and the 30 minutes): the tests of the service run without
// PostgreSQL. test-db/remote-devices.test.ts runs the same flow on the real one.
import type { DeviceStore, NewSession, RemoteEvent, StoredDeviceCredential } from '../../src/remote/devices.ts';

interface Device {
  id: string;
  name: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}
interface Session extends NewSession {
  id: string;
  deviceId: string;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface MemoryDevices extends DeviceStore {
  devices: Device[];
  credentialRows: (StoredDeviceCredential & { revokedAt: Date | null })[];
  sessions: Session[];
  events: RemoteEvent[];
}

export function memoryDeviceStore(): MemoryDevices {
  const devices: Device[] = [];
  const credentialRows: MemoryDevices['credentialRows'] = [];
  const sessions: Session[] = [];
  const events: RemoteEvent[] = [];
  const live = (deviceId: string): boolean => devices.some((device) => device.id === deviceId && device.revokedAt === null);
  const addSession = (deviceId: string, session: NewSession): void => {
    if (!live(deviceId)) throw new Error('remote_device_live: the device is unlinked');
    if (session.expiresAt.getTime() > session.createdAt.getTime() + 12 * 3_600_000) throw new Error('remote_sessions: 12 hours at most');
    sessions.push({ ...session, id: String(sessions.length + 1), deviceId, lastSeenAt: session.createdAt, revokedAt: null });
  };
  const alive = (session: Session, now: Date, idleMs: number): boolean =>
    session.revokedAt === null && live(session.deviceId) && session.expiresAt > now && session.lastSeenAt.getTime() > now.getTime() - idleMs;
  return {
    devices,
    credentialRows,
    sessions,
    events,
    pair(device, credential, session) {
      devices.push({ ...device, createdAt: session.createdAt, lastSeenAt: session.createdAt, revokedAt: null });
      credentialRows.push({ deviceId: device.id, credentialId: credential.credentialId, publicKey: credential.publicKey, algorithm: credential.algorithm, signCount: credential.signCount, revokedAt: null });
      addSession(device.id, session);
      return Promise.resolve();
    },
    credential(credentialId) {
      const row = credentialRows.find((item) => item.credentialId.equals(credentialId) && item.revokedAt === null && live(item.deviceId));
      if (row === undefined) return Promise.resolve(undefined);
      return Promise.resolve({ deviceId: row.deviceId, credentialId: row.credentialId, publicKey: row.publicKey, algorithm: row.algorithm, signCount: row.signCount });
    },
    credentials(deviceId) {
      return Promise.resolve(credentialRows.filter((row) => row.deviceId === deviceId && row.revokedAt === null && live(deviceId)).map((row) => row.credentialId));
    },
    useCredential(credentialId, from, to) {
      const row = credentialRows.find((item) => item.credentialId.equals(credentialId) && item.revokedAt === null && live(item.deviceId));
      if (row?.signCount !== from) return Promise.resolve(false);
      if (to < from) throw new Error('remote_credentials_guard: the counter never goes back');
      row.signCount = to;
      return Promise.resolve(true);
    },
    createSession(deviceId, session) {
      addSession(deviceId, session);
      return Promise.resolve();
    },
    session(tokenHash, now, idleMs) {
      const found = sessions.find((session) => session.tokenHash.equals(tokenHash) && alive(session, now, idleMs));
      return Promise.resolve(found === undefined ? undefined : { id: found.id, deviceId: found.deviceId, lastSeenAt: found.lastSeenAt });
    },
    touchSession(id, deviceId, at) {
      const session = sessions.find((item) => item.id === id);
      if (session !== undefined && session.revokedAt === null) session.lastSeenAt = at;
      const device = devices.find((item) => item.id === deviceId);
      if (device !== undefined) device.lastSeenAt = at;
      return Promise.resolve();
    },
    sessionAlive(id, now, idleMs) {
      const session = sessions.find((item) => item.id === id);
      return Promise.resolve(session !== undefined && alive(session, now, idleMs));
    },
    endSession(tokenHash, at) {
      for (const session of sessions) if (session.tokenHash.equals(tokenHash) && session.revokedAt === null) session.revokedAt = at;
      return Promise.resolve();
    },
    list() {
      return Promise.resolve(
        devices.filter((device) => device.revokedAt === null).map((device) => ({ id: device.id, name: device.name, createdAt: device.createdAt.toISOString(), lastSeenAt: device.lastSeenAt?.toISOString() ?? null })),
      );
    },
    unlink(deviceId, at) {
      const device = devices.find((item) => item.id === deviceId && item.revokedAt === null);
      if (device === undefined) return Promise.resolve(false);
      device.revokedAt = at;
      for (const session of sessions) if (session.deviceId === deviceId && session.revokedAt === null) session.revokedAt = at;
      for (const row of credentialRows) if (row.deviceId === deviceId && row.revokedAt === null) row.revokedAt = at;
      return Promise.resolve(true);
    },
    event(event) {
      events.push(structuredClone(event));
      return Promise.resolve();
    },
  };
}
