/**
 * The chat opened from the phone (D-292): over HTTPS on the Tailscale name of
 * the Mac (`*.ts.net`), through the remote port of the core. Until stage B no
 * device is paired: the page shows only that, and the API answers 401.
 */
export function onRemoteOrigin(location: Pick<Location, 'protocol' | 'hostname'>): boolean {
  return location.protocol === 'https:' && location.hostname.endsWith('.ts.net');
}

/** What `GET /api/remote/status` says; anything else (an error, a refusal) counts as not paired. */
export function pairedOf(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'paired' in body && body.paired === true;
}

export async function remotePaired(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher('/api/remote/status', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return false;
    return pairedOf(await response.json());
  } catch {
    return false;
  }
}

/**
 * The service worker from the remote origin too: the page becomes an app of
 * the iPhone's home screen, and Web Push will need it once paired.
 */
export async function registerWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
