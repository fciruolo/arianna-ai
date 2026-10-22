/**
 * The remote port (D-292): the second listener of the core, which
 * `tailscale serve` publishes on the tailnet as https://<name>. A request is
 * remote because it arrived on this port, never because of a header.
 *
 * Stage A: the port serves the files of the web chat and the state of the
 * pairing; every other route of the API and every WebSocket are refused with
 * `device-not-paired`. Stage B adds the session of a paired device in
 * `remoteAccess`, the only place that lets a remote request reach the API.
 */
import type { IncomingMessage } from 'node:http';

/** The address of the remote port: always this one, whatever the configuration says. */
export const REMOTE_LISTEN_HOST = '127.0.0.1';

/** The route that tells the page on the phone whether this device is paired. */
export const REMOTE_STATUS_PATH = '/api/remote/status';

export const DEVICE_NOT_PAIRED = 'device-not-paired';

export type RemoteAccess =
  /** `GET /api/remote/status`: answered by the remote door itself. */
  | { kind: 'status'; body: { paired: boolean } }
  /** The request goes on to the API routes (stage B: a valid session). */
  | { kind: 'allowed' }
  | { kind: 'refused'; status: 401; body: { error: string; code: typeof DEVICE_NOT_PAIRED } };

const REFUSED: RemoteAccess = { kind: 'refused', status: 401, body: { error: 'device not paired', code: DEVICE_NOT_PAIRED } };

/**
 * Whether a request of the remote port, past the checks of Host and Origin,
 * may reach the API or the live feed (`upgrade`). Files of the web chat do not
 * come here: they hold nothing private.
 */
export function remoteAccess(request: Pick<IncomingMessage, 'method' | 'headers'>, pathname: string, upgrade = false): RemoteAccess {
  if (!upgrade && pathname === REMOTE_STATUS_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
    return { kind: 'status', body: { paired: false } };
  }
  // Stage B: a session cookie of a paired device, checked against the database, returns `allowed`.
  return REFUSED;
}
