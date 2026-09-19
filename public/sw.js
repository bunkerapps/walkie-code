// Service worker de walkie-code: solo existe para los avisos push con el teléfono bloqueado.
// No cachea nada: la app necesita la Mac del otro lado para servir de algo.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// iOS exige mostrar una notificación por cada push: si se saltea, Safari termina
// revocando la suscripción. Por eso se muestra siempre, aunque el mensaje venga raro.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { body: event.data?.text() || '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'CLAUDE', {
      body: data.body || 'Hay novedades de Claude.',
      tag: data.tag || 'walkie-code',
      // Con el mismo tag reemplaza al aviso anterior del canal, pero igual vuelve a sonar.
      renotify: true,
      icon: 'icon-180.png',
      badge: 'icon-180.png',
      data: { url: data.url || './' },
    }),
  );
});

// Al tocar el aviso se trae al frente la app si ya estaba abierta; si no, se abre.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (open) return open.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
