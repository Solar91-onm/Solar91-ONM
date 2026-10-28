// Solar91 service worker. It only shows a friendly page when the internet is down.
// It never stores app data or login details, so nobody can see old or someone else's data.
const OFFLINE = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
  '<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#009710;color:#fff;text-align:center">' +
  '<div><h2>No internet connection</h2><p>Solar91 needs the internet to show live plant data.<br>Please reconnect and try again.</p>' +
  '<button onclick="location.reload()" style="padding:10px 22px;border:0;border-radius:8px;font-size:16px">Try again</button></div>';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
// Tapping a Solar91 notification brings the open portal to the front, or opens it.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const open = list.find(c => new URL(c.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, {headers: {'Content-Type': 'text/html; charset=utf-8'}})));
  }
});
