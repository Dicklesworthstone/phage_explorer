/**
 * Service Worker for Phage Explorer Web
 *
 * Provides offline support using Workbox caching strategies.
 *
 * Cache Strategy Summary:
 * - Precache: Build assets (HTML, JS, CSS) - versioned by build tool
 * - CacheFirst: WASM, fonts, PDB structures, images - immutable content
 * - CacheFirst (versioned): Database assets requested with `?v=<hash>`
 * - StaleWhileRevalidate: Unversioned DB only (fallback for offline)
 * - Precache: Navigation - keep the app shell and its assets on the same build
 *
 * Note: JS/CSS are NOT cached with StaleWhileRevalidate to prevent stale code bugs.
 * The precache with content-hashed filenames handles JS/CSS versioning.
 */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL, matchPrecache } from 'workbox-precaching';
import { registerRoute, NavigationRoute, setCatchHandler } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope;

// =============================================================================
// Configuration
// =============================================================================

/** Cache names for organization and debugging */
const CACHE_NAMES = {
  // v2: Removed StaleWhileRevalidate for JS/CSS to fix stale code bugs
  precache: 'phage-precache-v2',
  database: 'phage-database-v2',
  wasm: 'wasm-cache-v2',
  sqlJs: 'sql-js-wasm-v2',
  pdb: 'pdb-structures-v2',
  fonts: 'google-fonts-v2',
  images: 'images-v2',
} as const;

// =============================================================================
// Cache Cleanup
// =============================================================================

// Clean up old caches from previous versions
cleanupOutdatedCaches();

// Also clean up v1 caches that may contain stale JS
const OLD_CACHE_PREFIXES = [
  'phage-precache-v1',
  'phage-database',
  'wasm-cache',
  'sql-js-wasm',
  'pdb-structures',
  'google-fonts',
  'images',
  'static-resources', // v1 JS/CSS cache that caused stale code bugs
  'pages-v2',
];

/** Delete old v1 caches */
async function deleteOldCaches(): Promise<void> {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => OLD_CACHE_PREFIXES.some((prefix) => name === prefix))
      .map((name) => {
        if (import.meta.env.DEV) {
          console.log('[SW] Deleting old cache:', name);
        }
        return caches.delete(name);
      })
  );
}

// Precache static assets (injected by build tool)
precacheAndRoute(self.__WB_MANIFEST || []);

// =============================================================================
// Application Data Caching
// =============================================================================

const isDbAssetRequest = (url: URL, request: Request): boolean => {
  // Keep DB caching tightly scoped to our own static asset(s) to avoid cache pollution.
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  return url.pathname.endsWith('/phage.db') || url.pathname.endsWith('/phage.db.gz');
};

// Cache DB assets with a version-aware strategy.
//
// The app fetches a manifest hash and then requests `phage.db(.gz)?v=<hash>`:
// - For versioned URLs, CacheFirst avoids re-downloading on every cold start.
// - For unversioned URLs (manifest unavailable), SWR provides a best-effort offline fallback.
registerRoute(
  ({ url, request }) => isDbAssetRequest(url, request) && url.searchParams.has('v'),
  new CacheFirst({
    cacheName: CACHE_NAMES.database,
    matchOptions: { ignoreSearch: false },
    plugins: [
      new ExpirationPlugin({
        maxEntries: 2, // Current + one backup
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
        purgeOnQuotaError: true,
      }),
    ],
  })
);

registerRoute(
  ({ url, request }) => isDbAssetRequest(url, request) && !url.searchParams.has('v'),
  new StaleWhileRevalidate({
    cacheName: CACHE_NAMES.database,
    matchOptions: { ignoreSearch: false },
    plugins: [],
  })
);

// =============================================================================
// PDB Structure Caching (NEW - Critical for 3D viewer)
// =============================================================================

// Cache PDB/mmCIF structure files from RCSB.
// Keep this route tightly scoped to avoid caching unintended third-party origins.
// Structures are immutable (PDB IDs don't change), so CacheFirst is optimal.
registerRoute(
  ({ url, request }) =>
    request.method === 'GET' &&
    url.origin === 'https://files.rcsb.org' &&
    url.pathname.startsWith('/download/'),
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
  ({ url }) => url.origin === self.location.origin && url.pathname.endsWith('.wasm'),
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

// NOTE: JS/CSS caching for build assets is handled by precacheAndRoute above,
// which uses content-hashed filenames (e.g., index-abc123.js) for proper versioning.
// We intentionally do NOT add a fallback StaleWhileRevalidate route for scripts/styles
// because it can serve stale cached versions when precache misses, causing bugs.
// If a script isn't in the precache manifest, it will be fetched fresh from network.

// =============================================================================
// Navigation Handling (App Shell)
// =============================================================================

// Serve the precached app shell for navigations to avoid mismatched HTML/assets.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// Catch handler: if navigation fails and index.html is unavailable offline, fall back to offline.html
setCatchHandler(async ({ request }) => {
  if (request.destination === 'document') {
    return (await matchPrecache('/offline.html')) || (await caches.match('/offline.html')) || Response.error();
  }
  return Response.error();
});

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

// Claim clients immediately on activation and clean up old caches
self.addEventListener('activate', (event) => {
  if (import.meta.env.DEV) {
    console.log('[SW] Activated');
  }
  // Delete old v1 caches that may contain stale JS, then take control
  // Use .catch() to ensure clients.claim() is called even if cache deletion fails
  event.waitUntil(
    deleteOldCaches()
      .catch((err) => {
        if (import.meta.env.DEV) {
          console.warn('[SW] Failed to delete old caches:', err);
        }
      })
      .then(() => self.clients.claim())
  );
});

// Updates remain waiting until the user accepts the reload prompt. The first
// installation activates normally because there is no previous worker.

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
