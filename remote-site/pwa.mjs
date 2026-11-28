export const manifest = {
  id: '/',
  name: 'Agent Room 원격',
  short_name: 'Agent Room',
  lang: 'ko',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f1117',
  theme_color: '#0f1117',
  icons: [192, 512].map(size => ({
    src: '/icons/' + size + '.png',
    sizes: size + 'x' + size,
    type: 'image/png',
    purpose: 'any maskable'
  }))
};

export const serviceWorker = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.mode !== 'navigate' || url.origin !== self.location.origin || url.pathname !== '/') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Room</title><body style="margin:24px;background:#0f1117;color:#e8eaf0;font:16px system-ui"><h1>인터넷 연결이 끊겼어요</h1><p>연결을 확인한 뒤 다시 열어 주세요.</p><a href="/" style="color:#a9bfff">다시 연결</a></body></html>',
    {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}}
  )));
});
`;
