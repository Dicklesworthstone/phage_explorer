/**
 * Service Worker for Phage Explorer Web
 *
 * Provides offline support using Workbox caching strategies.
 *
 * Cache Strategy Summary:
 * - Precache: Build assets (HTML, JS, CSS) - versioned by build tool
 * - CacheFirst: WASM, fonts, PDB structures - immutable content
 * - StaleWhileRevalidate: Database, static resources - use cache, update background
 * - NetworkFirst: Navigation - prefer fresh but fallback to cache
 *
 * Note: The DB manifest is fetched by the app with its own ETag + IndexedDB cache.
 */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope;

// =============================================================================
// Configuration
// =============================================================================

/** Cache names for organization and debugging */
const CACHE_NAMES = {
  precache: 'phage-precache-v1',
  database: 'phage-database',
  wasm: 'wasm-cache',
  sqlJs: 'sql-js-wasm',
  pdb: 'pdb-structures',
  fonts: 'google-fonts',
  images: 'images',
  static: 'static-resources',
  pages: 'pages',
} as const;

/** Network timeout before falling back to cache (ms) */
const NETWORK_TIMEOUT_MS = 3000;

// =============================================================================
// Cache Cleanup
// =============================================================================

// Clean up old caches from previous versions
cleanupOutdatedCaches();

// Precache static assets (injected by build tool)
precacheAndRoute(self.__WB_MANIFEST || []);

// =============================================================================
// Application Data Caching
// =============================================================================

// Cache database with StaleWhileRevalidate (use cached, update in background)
// Database is critical for app function, so we prefer cached data for speed
registerRoute(
  ({ url }) => url.pathname.endsWith('.db'),
  new StaleWhileRevalidate({
    cacheName: CACHE_NAMES.database,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 2, // Current + one backup
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
      }),
    ],
  })
);

// =============================================================================
// PDB Structure Caching (NEW - Critical for 3D viewer)
// =============================================================================

// Cache PDB structure files from RCSB
// These are immutable (PDB IDs don't change), so CacheFirst is optimal
registerRoute(
  ({ url }) =>
    url.origin === 'https://files.rcsb.org' ||
    url.origin === 'https://data.rcsb.org' ||
    (url.origin.includes('rcsb.org') && url.pathname.includes('/pdb/')),
  new CacheFirst({
    cacheName: CACHE_NAMES.pdb,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50, // Limit to 50 structures to manage storage
        maxAgeSeconds: 90 * 24 * 60 * 60, // 90 days
      }),
    ],
  })
);

// =============================================================================
// WASM Caching (Critical for database engine)
// =============================================================================

// Cache local WASM files with CacheFirst (immutable, versioned by build)
registerRoute(
  ({ url }) => url.pathname.endsWith('.wasm'),
  new CacheFirst({
    cacheName: CACHE_NAMES.wasm,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// Cache sql.js WASM from CDN
// This is the SQLite engine - critical for app function
registerRoute(
  ({ url }) => url.origin === 'https://sql.js.org',
  new CacheFirst({
    cacheName: CACHE_NAMES.sqlJs,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 5,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// =============================================================================
// Static Asset Caching
// =============================================================================

// Cache fonts with CacheFirst (immutable)
registerRoute(
  ({ url }) =>
    url.origin === 'https://fonts.googleapis.com' ||
    url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: CACHE_NAMES.fonts,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
      }),
    ],
  })
);

// Cache images with CacheFirst
registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: CACHE_NAMES.images,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
      }),
    ],
  })
);

// Cache JS and CSS with StaleWhileRevalidate
// These may update between deployments, so SWR ensures we get updates
registerRoute(
  ({ request }) =>
    request.destination === 'script' || request.destination === 'style',
  new StaleWhileRevalidate({
    cacheName: CACHE_NAMES.static,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
      }),
    ],
  })
);

// =============================================================================
// Navigation Caching
// =============================================================================

// Handle navigation requests with NetworkFirst + timeout
// Falls back to cache quickly on slow connections
const navigationHandler = new NetworkFirst({
  cacheName: CACHE_NAMES.pages,
  networkTimeoutSeconds: NETWORK_TIMEOUT_MS / 1000,
  plugins: [
    new ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 24 * 60 * 60, // 1 day
    }),
  ],
});

registerRoute(new NavigationRoute(navigationHandler));

// =============================================================================
// Service Worker Lifecycle
// =============================================================================

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Report cache storage usage when requested
  if (event.data?.type === 'GET_CACHE_STATS') {
    getCacheStats().then((stats) => {
      event.ports[0]?.postMessage(stats);
    });
  }
});

// Claim clients immediately on activation
self.addEventListener('activate', (event) => {
  if (import.meta.env.DEV) {
    console.log('[SW] Activated');
  }
  // Take control of all pages immediately
  event.waitUntil(self.clients.claim());
});

// Log installation
self.addEventListener('install', () => {
  if (import.meta.env.DEV) {
    console.log('[SW] Installed');
  }
});

// =============================================================================
// Cache Statistics Helper
// =============================================================================

/**
 * Get statistics about cache storage usage.
 * Useful for debugging and monitoring cache health.
 */
async function getCacheStats(): Promise<{
  caches: Record<string, { entries: number; estimatedSize: number }>;
  totalEstimatedSize: number;
}> {
  const stats: Record<string, { entries: number; estimatedSize: number }> = {};
  let totalSize = 0;

  try {
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      // Estimate ~50KB average per cached response (rough heuristic)
      const estimatedSize = keys.length * 50 * 1024;
      stats[name] = { entries: keys.length, estimatedSize };
      totalSize += estimatedSize;
    }
  } catch {
    // Cache API may not be available in all contexts
  }

  return { caches: stats, totalEstimatedSize: totalSize };
}
