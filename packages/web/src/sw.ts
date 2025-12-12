/**
 * Service Worker for Phage Explorer Web
 *
 * Provides offline support using Workbox caching strategies.
 */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope;

// Clean up old caches from previous versions
cleanupOutdatedCaches();

// Precache static assets (injected by build tool)
precacheAndRoute(self.__WB_MANIFEST || []);

// Cache database with StaleWhileRevalidate (use cached, update in background)
registerRoute(
  ({ url }) => url.pathname.endsWith('.db'),
  new StaleWhileRevalidate({
    cacheName: 'phage-database',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 2, // Current + one backup
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
      }),
    ],
  })
);

// Cache manifest with NetworkFirst (always try to get fresh)
registerRoute(
  ({ url }) => url.pathname.endsWith('.manifest.json'),
  new NetworkFirst({
    cacheName: 'phage-manifest',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 5,
        maxAgeSeconds: 24 * 60 * 60, // 1 day
      }),
    ],
  })
);

// Cache WASM files with CacheFirst (immutable)
registerRoute(
  ({ url }) => url.pathname.endsWith('.wasm'),
  new CacheFirst({
    cacheName: 'wasm-cache',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// Cache fonts with CacheFirst
registerRoute(
  ({ url }) =>
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// Cache sql.js WASM from CDN
registerRoute(
  ({ url }) => url.origin === 'https://sql.js.org',
  new CacheFirst({
    cacheName: 'sql-js-wasm',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 5,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// Cache images
registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: 'images',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
      }),
    ],
  })
);

// Cache JS and CSS with StaleWhileRevalidate
registerRoute(
  ({ request }) =>
    request.destination === 'script' || request.destination === 'style',
  new StaleWhileRevalidate({
    cacheName: 'static-resources',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
      }),
    ],
  })
);

// Handle navigation requests
const navigationHandler = new NetworkFirst({
  cacheName: 'pages',
  plugins: [
    new ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 24 * 60 * 60, // 1 day
    }),
  ],
});

registerRoute(new NavigationRoute(navigationHandler));

// Listen for skip waiting message
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Log service worker activation
self.addEventListener('activate', () => {
  console.log('[SW] Activated');
});
