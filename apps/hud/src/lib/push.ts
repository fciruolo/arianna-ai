import { loadPushKey, subscribePush, tellThisMac } from './api.ts';

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
  // A new address of this browser: on the Mac the core is told it is its own (D-128).
  await reportThisMac().catch(() => undefined);
  return 'on';
}

/** This page runs on the Mac of the core: reached through the loopback address. */
export function onThisMac(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

/**
 * On the Mac, the push address of this browser (D-128): while the helper is
 * connected the core leaves it out of the notices, so that the helper's
 * notification is not doubled by Chrome's. Calls still ring here.
 */
export async function reportThisMac(): Promise<void> {
  if (!onThisMac(window.location.hostname) || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription === null || subscription === undefined) return;
  await tellThisMac(subscription.endpoint);
}
