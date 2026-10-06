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
export const NOTICE_BODY: Readonly<Record<NoticeKind, string>> = {
  reply: 'Clicca per aprire la conversazione.',
  approval: 'Clicca per vedere cosa approvare.',
  failure: 'Clicca per vedere cosa è successo.',
};
/** The logo of Arianna, in place of the browser's own icon (public/notification-icon.png). */
export const NOTICE_ICON = '/notification-icon.png';

/** A notice shown inside the chat (I-1): the conversation title is read from this page's own list. */
export interface Toast {
  id: number;
  kind: NoticeKind;
  conversationId: string | null;
  title: string | null;
}

/** At most this many toasts at once: the oldest goes first. */
export const MAX_TOASTS = 3;

/** The stack with `toast` on top: one of the same kind and conversation is replaced, never doubled. */
export function pushToast(list: readonly Toast[], toast: Toast): Toast[] {
  return [...list.filter((item) => !(item.kind === toast.kind && item.conversationId === toast.conversationId)), toast].slice(-MAX_TOASTS);
}

/** The small line above the title of a toast. */
export const TOAST_KICKER: Readonly<Record<NoticeKind, string>> = {
  reply: 'Risposta',
  approval: 'Approvazione',
  failure: 'Lavoro fallito',
};

export interface NoticeView {
  /** document.visibilityState === 'hidden'. */
  hidden: boolean;
  /** The conversation open in this page, or null. */
  openConversation: string | null;
  /** Notification.permission, or 'unsupported'. */
  permission: NotificationPermission | 'unsupported';
}

/**
 * Where a notice shows: in the page (the toast of the chat) when the user is
 * looking at the chat but at another conversation; as a notification of the
 * system when the page is hidden or out of focus; nowhere when it is the
 * conversation being read. A trial (the buttons of Impostazioni → Notifiche)
 * shows both, to see them side by side. With the helper of the Mac connected
 * (D-128) the page never shows one of the system: the helper does.
 */
export function noticeWhere(conversationId: string | null, view: NoticeView, trial = false, helper = false): { toast: boolean; system: boolean } {
  if (trial) return { toast: true, system: view.permission === 'granted' && !helper };
  // With the helper of the Mac connected the notification of the system is its own, in the name of Arianna (D-128).
  if (view.hidden) return { toast: false, system: view.permission === 'granted' && !helper };
  return { toast: conversationId === null || conversationId !== view.openConversation, system: false };
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
  const options = { body: NOTICE_BODY[kind], icon: NOTICE_ICON, tag: noticeTag(kind, conversationId), data: { url: noticeUrl(conversationId) } };
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
