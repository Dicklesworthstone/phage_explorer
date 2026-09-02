/**
 * API Response Cache
 *
 * Provides localStorage-based caching for API responses to reduce
 * network requests and improve perceived performance.
 *
 * ## Why entries are versioned
 *
 * A cache entry outlives the code that produced it. That is normally harmless
 * and here it was not: the phylodynamics and environmental provenance overlays
 * cached an analysis under `{ source: 'real', result }` with a 24 hour TTL, and
 * `getCached` validated only the TTL. A user who opened the previous build
 * within that window had the new build read back the OLD analysis and render it
 * under a green "REAL DATA" banner. The thing being replayed was precisely the
 * fabricated output that the new build exists to remove.
 *
 * So every storage key carries a version, and the version defaults to the build
 * id. This is deliberately not a per-overlay constant that someone has to
 * remember to bump: the defect being fixed IS a discipline failure, and a fix
 * that needs discipline to work would reproduce it. A deploy invalidates
 * everything, automatically, because the build id changed.
 *
 * Entries written under a different version are unreachable by construction and
 * are swept from storage on the next write, so they cannot accumulate.
 */

import type { CacheEntry, CacheConfig } from './types';

/**
 * Build id, injected by Vite (see `define` in vite.config.ts).
 *
 * Falls back to 'dev' outside a Vite build, which covers `bun test` and any
 * direct Node import. That fallback is a constant on purpose: tests that need
 * two distinct versions pass them explicitly rather than depending on ambient
 * build state.
 */
declare const __CACHE_VERSION__: string | undefined;

export const BUILD_CACHE_VERSION: string =
  typeof __CACHE_VERSION__ === 'string' && __CACHE_VERSION__.length > 0
    ? __CACHE_VERSION__
    : 'dev';

const DEFAULT_CONFIG: CacheConfig = {
  defaultTTL: 24 * 60 * 60 * 1000, // 24 hours
  maxEntries: 100,
  storage: 'localStorage',
  version: BUILD_CACHE_VERSION,
};

const CACHE_ROOT = 'phage_api_cache_';
const CACHE_INDEX_KEY = 'phage_api_cache_index';

/** Storage key prefix for one version. Entries of other versions cannot collide. */
function prefixFor(version: string): string {
  return `${CACHE_ROOT}${version}_`;
}

/**
 * Remove every stored entry that does not belong to the current version.
 *
 * Called on write rather than on read: a read must stay cheap and side-effect
 * light, and a write is already touching the index. Without this, entries from
 * every previous build would sit in localStorage forever, unreachable but still
 * consuming the user's quota.
 */
function sweepOtherVersions(storage: Storage, version: string): void {
  const keep = prefixFor(version);
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith(CACHE_ROOT) && k !== CACHE_INDEX_KEY && !k.startsWith(keep)) {
      stale.push(k);
    }
  }
  for (const k of stale) storage.removeItem(k);
}

/**
 * Get storage backend based on config
 */
function getStorage(config: CacheConfig): Storage | null {
  if (typeof window === 'undefined') return null;

  switch (config.storage) {
    case 'localStorage':
      return window.localStorage;
    case 'sessionStorage':
      return window.sessionStorage;
    default:
      return null;
  }
}

/**
 * Generate cache key from API call parameters
 */
export function generateCacheKey(endpoint: string, params: Record<string, unknown>): string {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('&');

  return `${endpoint}:${paramStr}`;
}

/**
 * Get cache index (list of cached keys with timestamps)
 */
function getCacheIndex(storage: Storage): Map<string, number> {
  try {
    const indexStr = storage.getItem(CACHE_INDEX_KEY);
    if (!indexStr) return new Map();

    const indexArr: [string, number][] = JSON.parse(indexStr);
    return new Map(indexArr);
  } catch {
    return new Map();
  }
}

/**
 * Save cache index
 */
function saveCacheIndex(storage: Storage, index: Map<string, number>): void {
  try {
    const indexArr = Array.from(index.entries());
    storage.setItem(CACHE_INDEX_KEY, JSON.stringify(indexArr));
  } catch {
    // Storage full or unavailable
  }
}

/**
 * Evict oldest entries if over max entries limit
 */
function evictOldEntries(
  storage: Storage,
  index: Map<string, number>,
  maxEntries: number,
  version: string
): void {
  if (index.size <= maxEntries) return;

  // Sort by timestamp and remove oldest
  const sorted = Array.from(index.entries())
    .sort(([, a], [, b]) => a - b);

  const toRemove = sorted.slice(0, index.size - maxEntries);

  for (const [key] of toRemove) {
    storage.removeItem(prefixFor(version) + key);
    index.delete(key);
  }
}

/**
 * Get cached value if it exists and is not expired
 */
export function getCached<T>(
  key: string,
  config: Partial<CacheConfig> = {}
): T | null {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const storage = getStorage(fullConfig);
  if (!storage) return null;

  try {
    const entryStr = storage.getItem(prefixFor(fullConfig.version) + key);
    if (!entryStr) return null;

    const entry: CacheEntry<T> = JSON.parse(entryStr);
    const now = Date.now();

    // Check if expired
    if (now > entry.timestamp + entry.ttl) {
      storage.removeItem(prefixFor(fullConfig.version) + key);
      const index = getCacheIndex(storage);
      index.delete(key);
      saveCacheIndex(storage, index);
      return null;
    }

    return entry.data;
  } catch {
    return null;
  }
}

/**
 * Store value in cache
 */
export function setCache<T>(
  key: string,
  data: T,
  config: Partial<CacheConfig> & { ttl?: number } = {}
): boolean {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const storage = getStorage(fullConfig);
  if (!storage) return false;

  const ttl = config.ttl ?? fullConfig.defaultTTL;
  const now = Date.now();

  const entry: CacheEntry<T> = {
    data,
    timestamp: now,
    ttl,
  };

  try {
    sweepOtherVersions(storage, fullConfig.version);
    storage.setItem(prefixFor(fullConfig.version) + key, JSON.stringify(entry));

    // Update index
    const index = getCacheIndex(storage);
    index.set(key, now);
    evictOldEntries(storage, index, fullConfig.maxEntries, fullConfig.version);
    saveCacheIndex(storage, index);

    return true;
  } catch {
    // Storage full - try to make room
    const index = getCacheIndex(storage);
    evictOldEntries(storage, index, Math.floor(fullConfig.maxEntries / 2), fullConfig.version);
    saveCacheIndex(storage, index);

    // Retry
    try {
      storage.setItem(prefixFor(fullConfig.version) + key, JSON.stringify(entry));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Remove a specific cache entry
 */
export function removeCache(
  key: string,
  config: Partial<CacheConfig> = {}
): void {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const storage = getStorage(fullConfig);
  if (!storage) return;

  storage.removeItem(prefixFor(fullConfig.version) + key);
  const index = getCacheIndex(storage);
  index.delete(key);
  saveCacheIndex(storage, index);
}

/**
 * Clear all cache entries
 */
export function clearCache(config: Partial<CacheConfig> = {}): void {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const storage = getStorage(fullConfig);
  if (!storage) return;

  const index = getCacheIndex(storage);

  for (const key of index.keys()) {
    storage.removeItem(prefixFor(fullConfig.version) + key);
  }

  storage.removeItem(CACHE_INDEX_KEY);
}

/**
 * Get cache statistics
 */
export function getCacheStats(
  config: Partial<CacheConfig> = {}
): { entries: number; totalSize: number; oldestEntry: Date | null } {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const storage = getStorage(fullConfig);
  if (!storage) return { entries: 0, totalSize: 0, oldestEntry: null };

  const index = getCacheIndex(storage);
  let totalSize = 0;
  let oldestTimestamp = Infinity;

  for (const [key, timestamp] of index.entries()) {
    const item = storage.getItem(prefixFor(fullConfig.version) + key);
    if (item) {
      totalSize += item.length * 2; // Rough estimate (2 bytes per char)
    }
    if (timestamp < oldestTimestamp) {
      oldestTimestamp = timestamp;
    }
  }

  return {
    entries: index.size,
    totalSize,
    oldestEntry: oldestTimestamp === Infinity ? null : new Date(oldestTimestamp),
  };
}

/**
 * Higher-order function to wrap API calls with caching
 */
export function withCache<T, A extends unknown[]>(
  fn: (...args: A) => Promise<T>,
  keyGenerator: (...args: A) => string,
  options: { ttl?: number } = {}
): (...args: A) => Promise<T> {
  return async (...args: A): Promise<T> => {
    const key = keyGenerator(...args);

    // Try cache first
    const cached = getCached<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Fetch and cache
    const result = await fn(...args);
    setCache(key, result, { ttl: options.ttl });
    return result;
  };
}
