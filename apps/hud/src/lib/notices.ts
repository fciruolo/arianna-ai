import type { NoticeKind } from './protocol.ts';
import { pathFor } from './route.ts';

/**
 * Notifications of the web chat (I-1). The core sends a notice (a kind and a
 * conversation id) to every open page; the page shows a browser notification
 * when it is not in view, or when the notice is about another conversation.
 * The words are fixed here and in public/sw.js: never the text or the title
 * of a conversation, which may be L2.
 */
export const NOTICE_TITLE: Readonly<Record<NoticeKind, string>> = {
  reply: 'Arianna ha risposto',
  approval: 'Arianna aspetta una tua decisione',
  failure: 'Un lavoro è fallito',
};
export const NOTICE_BODY = 'Apri la chat per vedere.';

export interface NoticeView {
  /** document.visibilityState === 'hidden'. */
  hidden: boolean;
  /** The conversation open in this page, or null. */
  openConversation: string | null;
  /** Notification.permission, or 'unsupported'. */
  permission: NotificationPermission | 'unsupported';
}

/** Show a notice in this page? Only with permission, and only if the user is not looking at it already. */
export function shouldShow(conversationId: string | null, view: NoticeView): boolean {
  if (view.permission !== 'granted') return false;
  if (view.hidden) return true;
  return conversationId === null || conversationId !== view.openConversation;
}

/**
 * The same tag the service worker uses: a push and a page notice of the same
 * thing in this browser replace each other instead of showing twice.
 */
export function noticeTag(kind: NoticeKind, conversationId: string | null): string {
  return `arianna-${kind}-${conversationId ?? 'home'}`;
}

export function noticeUrl(conversationId: string | null): string {
  return pathFor(conversationId);
}

export function permissionNow(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Asked only from a click of the user (Impostazioni → Notifiche). */
export async function askPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

/**
 * Shows a notice: through the service worker when there is one (so that a
 * click opens the conversation even from a closed tab, and the tag matches
 * the push), else from the page. `open` follows a click on the page's own.
 */
export async function showNotice(kind: NoticeKind, conversationId: string | null, open: (path: string) => void): Promise<void> {
  const options = { body: NOTICE_BODY, tag: noticeTag(kind, conversationId), data: { url: noticeUrl(conversationId) } };
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : undefined;
  if (registration !== undefined) {
    await registration.showNotification(NOTICE_TITLE[kind], options);
    return;
  }
  const notification = new Notification(NOTICE_TITLE[kind], options);
  notification.onclick = () => {
    window.focus();
    open(noticeUrl(conversationId));
    notification.close();
  };
}
