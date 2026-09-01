/**
 * MinHash Signature Cache
 *
 * LRU cache for MinHash signatures with strict memory bounds.
 * Enables fast reuse across:
 * - Repeated overlay opens
 * - Window comparisons in HGT inference
 * - Multi-reference donor ranking
 *
 * @see phage_explorer-vk7b.2.2
 */

// ============================================================================
// Configuration
// ============================================================================

const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;

/** Maximum number of cached signatures */
const DEFAULT_MAX_ENTRIES = 256;

/** Maximum total bytes for cached signatures (16MB) */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

// ============================================================================
// Types
// ============================================================================

export interface CacheConfig {
  /** Maximum number of entries (default: 256) */
  maxEntries?: number;
  /** Maximum total bytes (default: 16MB) */
  maxBytes?: number;
}

export interface CacheStats {
  /** Number of cached entries */
  entries: number;
  /** Total bytes used */
  bytes: number;
  /** Cache hit count */
  hits: number;
  /** Cache miss count */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
}

interface CacheEntry {
  /** The cached signature */
  signature: Uint32Array;
  /** Size in bytes */
  bytes: number;
  /** Last access timestamp for LRU ordering */
  lastAccess: number;
}

// ============================================================================
// Cache Key Generation
// ============================================================================

/**
 * FNV-1a 64-bit hash for fast string hashing.
 * Uses a larger output than 32-bit FNV to avoid collisions on long sequences.
 */
function fnv1a64(str: string): string {
  const FNV_OFFSET = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  const MASK = (1n << 64n) - 1n;
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16);
}

/**
 * Generate a cache key from sequence and parameters.
 * Uses a 64-bit FNV-1a hash of sequence to avoid storing large strings as keys
 * while keeping collision risk negligible for MinHash signature caching.
 */
function makeCacheKey(
  sequence: string,
  k: number,
  numHashes: number,
  canonical: boolean
): string {
  const seqHash = fnv1a64(sequence);
  return `${seqHash}:${sequence.length}:${k}:${numHashes}:${canonical ? 'c' : 'n'}`;
}

/**
 * Generate a cache key from sequence ID (for reference libraries).
 * Use this when sequences have stable IDs to avoid hashing entire sequences.
 */
export function makeCacheKeyFromId(
  sequenceId: string,
  k: number,
  numHashes: number,
  canonical: boolean
): string {
  return `id:${sequenceId}:${k}:${numHashes}:${canonical ? 'c' : 'n'}`;
}

// ============================================================================
// LRU Cache Implementation
// ============================================================================

/**
 * LRU cache for MinHash signatures with memory bounds.
 *
 * Eviction policy:
 * 1. When maxEntries exceeded: evict least recently used
 * 2. When maxBytes exceeded: evict largest entries first, then LRU
 */
export class MinHashCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  private maxBytes: number;
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig = {}) {
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Get a cached signature, or null if not found.
   * Updates LRU access time on hit.
   */
  get(key: string): Uint32Array | null {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastAccess = Date.now();
      this.hits++;
      return entry.signature;
    }
    this.misses++;
    return null;
  }

  /**
   * Get or compute a signature, caching the result.
   * This is the primary API for transparent caching.
   */
  getOrCompute(
    sequence: string,
    k: number,
    numHashes: number,
    canonical: boolean,
    computeFn: () => Uint32Array | null
  ): Uint32Array | null {
    const key = makeCacheKey(sequence, k, numHashes, canonical);
    const cached = this.get(key);
    if (cached) {
      return cached;
    }

    const signature = computeFn();
    if (signature) {
      this.set(key, signature);
    }
    return signature;
  }

  /**
   * Store a signature in the cache.
   */
  set(key: string, signature: Uint32Array): void {
    // Remove existing entry if present
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.cache.delete(key);
    }

    const bytes = signature.byteLength;

    // Evict if necessary to make room
    this.evictIfNeeded(bytes);

    // Store the new entry
    this.cache.set(key, {
      signature,
      bytes,
      lastAccess: Date.now(),
    });
    this.totalBytes += bytes;
  }

  /**
   * Check if a key exists in the cache.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Remove a specific entry from the cache.
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.totalBytes -= entry.bytes;
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
    if (isDev) {
      console.log('[minhash-cache] Cache cleared');
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      bytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset hit/miss counters (useful for per-analysis tracking).
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Log cache stats to console (dev-only).
   */
  printStats(): void {
    if (!isDev) return;

    const stats = this.getStats();
    console.log('[minhash-cache] Stats:', {
      entries: stats.entries,
      bytesUsed: `${(stats.bytes / 1024 / 1024).toFixed(2)}MB`,
      hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
      hits: stats.hits,
      misses: stats.misses,
    });
  }

  /**
   * Evict entries to make room for a new entry of the given size.
   */
  private evictIfNeeded(newBytes: number): void {
    // Check if new entry alone exceeds budget
    if (newBytes > this.maxBytes) {
      if (isDev) {
        console.warn(
          `[minhash-cache] Single entry (${newBytes} bytes) exceeds max budget (${this.maxBytes} bytes)`
        );
      }
      return;
    }

    // Evict by count if needed
    while (this.cache.size >= this.maxEntries) {
      this.evictLRU();
    }

    // Evict by bytes if needed
    while (this.totalBytes + newBytes > this.maxBytes && this.cache.size > 0) {
      // First try evicting largest entries
      if (!this.evictLargest()) {
        // Fall back to LRU if no large entries
        this.evictLRU();
      }
    }
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): boolean {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      this.totalBytes -= entry.bytes;
      this.cache.delete(oldestKey);
      if (isDev) {
        console.log(`[minhash-cache] Evicted LRU entry: ${oldestKey}`);
      }
      return true;
    }
    return false;
  }

  /**
   * Evict the largest entry (for memory pressure situations).
   */
  private evictLargest(): boolean {
    let largestKey: string | null = null;
    let largestBytes = 0;

    for (const [key, entry] of this.cache) {
      if (entry.bytes > largestBytes) {
        largestBytes = entry.bytes;
        largestKey = key;
      }
    }

    if (largestKey && largestBytes > 1024) {
      // Only evict if entry is significant (> 1KB)
      const entry = this.cache.get(largestKey)!;
      this.totalBytes -= entry.bytes;
      this.cache.delete(largestKey);
      if (isDev) {
        console.log(
          `[minhash-cache] Evicted largest entry: ${largestKey} (${largestBytes} bytes)`
        );
      }
      return true;
    }
    return false;
  }
}

// ============================================================================
// Global Cache Instance
// ============================================================================

/**
 * Shared global cache instance for MinHash signatures.
 * Use this for cross-component caching within the same thread.
 */
let globalCache: MinHashCache | null = null;

/**
 * Get the global MinHash cache instance.
 * Creates a new instance with default config if not initialized.
 */
export function getMinHashCache(): MinHashCache {
  if (!globalCache) {
    globalCache = new MinHashCache();
  }
  return globalCache;
}

/**
 * Initialize the global cache with custom configuration.
 * Call this early if you need non-default settings.
 */
export function initMinHashCache(config: CacheConfig): MinHashCache {
  globalCache = new MinHashCache(config);
  return globalCache;
}

/**
 * Clear the global cache and reset stats.
 * Useful for memory pressure situations or test cleanup.
 */
export function clearMinHashCache(): void {
  if (globalCache) {
    globalCache.clear();
  }
}
