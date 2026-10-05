import { loadPushKey, subscribePush } from './api.ts';

/**
 * Web Push for the calls of Arianna (D-066): the browser asks its push
 * service (Apple, Google, Mozilla) for an address and gives it to the core.
 * The notification carries no content; the service worker (public/sw.js)
 * asks the core what it was about (a call, a reply, an approval, a failed
 * task, I-1) and writes a fixed sentence.
 */
export type PushState = 'off' | 'unsupported' | 'denied' | 'available' | 'on';

/** The VAPID public key (base64url) as the bytes PushManager wants. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function pushState(): Promise<{ state: PushState; key: string | null }> {
  const key = await loadPushKey().catch(() => null);
  if (key === null) return { state: 'off', key };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { state: 'unsupported', key };
  if (Notification.permission === 'denied') return { state: 'denied', key };
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  return { state: subscription === null || subscription === undefined ? 'available' : 'on', key };
}

export async function enablePush(key: string): Promise<PushState> {
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await subscribePush(subscription.toJSON());
  return 'on';
}
