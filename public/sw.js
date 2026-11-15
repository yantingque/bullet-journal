self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  if (!event.data) return;
  const { id, title, body } = event.data.json();
  const page = id.startsWith('weekly:') ? 'week' : 'today';
  event.waitUntil(self.registration.showNotification(title, { body, tag: id, icon: '/icon-192.png', data: { page } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = event.notification.data?.page === 'week' ? 'week' : 'today';
    const target = new URL('/#' + page, self.location.origin).href;
    if (windows.length) {
      await windows[0].navigate(target);
      return windows[0].focus();
    }
    return self.clients.openWindow(target);
  })());
});
