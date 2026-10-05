// Service worker of the web chat (D-066, I-1): the notifications of Web Push.
// A push carries no content. The worker asks the core what it was about (a
// call, a reply, an approval, a failed task) over the chat's own connection,
// never through the push service, and writes a fixed sentence: never the text
// or the title of a conversation.
const TEXTS = {
  call: { title: 'Arianna ti chiama', body: 'Apri la chat per rispondere.' },
  reply: { title: 'Arianna ha risposto', body: 'Apri la chat per vedere.' },
  approval: { title: 'Arianna aspetta una tua decisione', body: 'Apri la chat per vedere.' },
  failure: { title: 'Un lavoro è fallito', body: 'Apri la chat per vedere.' },
};
// The core unreachable, or nothing recent: still a notification (browsers require one), without saying what.
const UNKNOWN = { title: 'Arianna', body: 'Apri la chat per vedere le novità.' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function latest() {
  try {
    const response = await fetch('/api/notifications/latest', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    const { notice } = await response.json();
    if (notice === null || typeof notice !== 'object' || !Object.hasOwn(TEXTS, notice.kind)) return null;
    const conversationId = typeof notice.conversationId === 'string' && UUID.test(notice.conversationId) ? notice.conversationId : null;
    return { kind: notice.kind, conversationId };
  } catch {
    return null;
  }
}

async function show() {
  const notice = await latest();
  if (notice === null) return self.registration.showNotification(UNKNOWN.title, { body: UNKNOWN.body, tag: 'arianna', data: { url: '/' } });
  const text = TEXTS[notice.kind];
  const url = notice.conversationId === null ? '/' : `/c/${notice.conversationId}`;
  if (notice.kind === 'call') {
    return self.registration.showNotification(text.title, { body: text.body, tag: 'arianna-call', renotify: true, requireInteraction: true, data: { url: null } });
  }
  // The same tag as a notice shown by an open page: the two replace each other.
  return self.registration.showNotification(text.title, { body: text.body, tag: `arianna-${notice.kind}-${notice.conversationId ?? 'home'}`, data: { url } });
}

self.addEventListener('push', (event) => {
  event.waitUntil(show());
});

// A new worker takes over at once: an older one (D-066) would show every push as a call.
self.addEventListener('install', () => {
  void self.skipWaiting();
});

// Pages opened before the worker was registered follow it too: a click can move them.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  // A call (no url): the page that is open rings already, it is only brought forward.
  const wanted = typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : null;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (open) => {
      const page = open.find((client) => new URL(client.url).origin === self.location.origin);
      if (page === undefined) return clients.openWindow(wanted ?? '/');
      const focused = await page.focus();
      if (wanted === null || new URL(focused.url).pathname === wanted || typeof focused.navigate !== 'function') return focused;
      return focused.navigate(wanted).catch(() => focused);
    }),
  );
});
