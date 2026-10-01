// Minimal service worker for the AMBRA Gig Call PWA. Doesn't cache anything
// yet — its only job right now is to satisfy "installable" criteria so
// iOS/Android treat Add to Home Screen as a real app shortcut. Push
// notification handling gets added here once that's built (step 3).
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  // Pass-through — no offline caching yet.
});
