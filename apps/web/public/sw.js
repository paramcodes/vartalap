/**
 * Service Worker for Web Push (ADR 0011).
 *
 * Uses `registration.showNotification()` because `new Notification()` throws on mobile browsers.
 * Payload carries `{ conversationId, messageId, senderName, title, body }` where body is always "New message".
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const payload = event.data.json();
    const title = payload.senderName || payload.title || 'vartalap';
    const options = {
      body: payload.body || 'New message',
      data: {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
      },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch {
    // Malformed push payload dropped safely
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId;
  const targetUrl = conversationId ? `/c/${conversationId}` : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    }),
  );
});
