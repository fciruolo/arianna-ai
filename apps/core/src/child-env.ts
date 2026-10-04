/**
 * The environment of a process the core starts (apps/voice, oMLX), built from
 * nothing: only the variables named in `inherited`, never the database
 * password or the age key of sops, and a proxy that goes nowhere, because
 * these processes receive L2 in clear and need no network beyond loopback.
 */

/** Port 9 (discard) on loopback: nothing listens, every proxied request fails at once. */
export const DEAD_PROXY = 'http://127.0.0.1:9';

export function cleanChildEnv(from: NodeJS.ProcessEnv, inherited: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of inherited) {
    const value = from[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  return {
    ...env,
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
  };
}
