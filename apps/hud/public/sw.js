// Service worker of the web chat (D-066): only the notification of a call.
// The push carries no content: the text is always the same, written here.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Arianna ti chiama', {
      body: 'Apri la chat per rispondere.',
      tag: 'arianna-call',
      renotify: true,
      requireInteraction: true,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((open) => {
      const page = open.find((client) => new URL(client.url).origin === self.location.origin);
      return page !== undefined ? page.focus() : clients.openWindow('/');
    }),
  );
});
