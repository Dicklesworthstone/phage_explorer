/**
 * IndexedDB Cache Utilities for Database Loader
 *
 * Provides robust caching with:
 * - Quota error detection and graceful fallback
 * - Storage usage estimation
 * - Cache eviction for old versions
 *
 * @see phage_explorer-rrqx.3
 */

const isDev = import.meta.env?.DEV ?? false;

// ============================================================================
// Types
// ============================================================================

export interface CacheWriteResult {
  success: boolean;
  /** True if failed due to storage quota */
  quotaExceeded: boolean;
  /** Error message if failed */
  error?: string;
  /** Bytes written (if successful) */
  bytesWritten?: number;
}

export interface CacheStats {
  /** Estimated storage usage in bytes */
  usageBytes: number;
  /** Estimated storage quota in bytes (0 if unknown) */
  quotaBytes: number;
  /** Usage as percentage of quota (0-100, or -1 if unknown) */
  usagePercent: number;
}

// ============================================================================
// Quota Error Detection
// ============================================================================

/**
 * Check if an error is a quota exceeded error.
 *
 * IndexedDB quota errors can appear in various forms:
 * - DOMException with name "QuotaExceededError"
 * - DOMException with code 22 (legacy)
 * - Error message containing "quota"
 */
export function isQuotaError(error: unknown): boolean {
  if (!error) return false;

  // DOMException with QuotaExceededError name
  if (error instanceof DOMException) {
    if (error.name === 'QuotaExceededError') return true;
    // Legacy code 22 = QUOTA_EXCEEDED_ERR
    if (error.code === 22) return true;
  }

  // Check error message for quota-related keywords
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('quota') ||
    lowerMessage.includes('storage') ||
    lowerMessage.includes('disk') ||
    lowerMessage.includes('space')
  );
}

// ============================================================================
// Storage Estimation
// ============================================================================

/**
 * Get estimated storage usage and quota.
 *
 * Uses the Storage API when available, returns zeros otherwise.
 */
export async function getStorageEstimate(): Promise<CacheStats> {
  try {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage ?? 0;
      const quota = estimate.quota ?? 0;
      const percent = quota > 0 ? Math.round((usage / quota) * 100) : -1;
      return { usageBytes: usage, quotaBytes: quota, usagePercent: percent };
    }
  } catch {
    // Storage API not available or failed
  }
  return { usageBytes: 0, quotaBytes: 0, usagePercent: -1 };
}

/**
 * Check if we have enough storage for a given byte size.
 *
 * Returns true if:
 * - Storage API is not available (optimistic)
 * - Quota is unknown (optimistic)
 * - Remaining quota >= required bytes with 10% buffer
 */
export async function hasStorageSpace(requiredBytes: number): Promise<boolean> {
  const stats = await getStorageEstimate();

  // If quota unknown, be optimistic
  if (stats.quotaBytes === 0) return true;

  // Require 10% buffer to avoid edge cases
  const buffer = stats.quotaBytes * 0.1;
  const available = stats.quotaBytes - stats.usageBytes - buffer;

  return available >= requiredBytes;
}

// ============================================================================
// Safe Cache Operations
// ============================================================================

/**
 * Safely write to IndexedDB with quota error handling.
 *
 * @returns Result indicating success or quota error
 */
export async function safeCacheWrite(
  db: IDBDatabase,
  storeName: string,
  key: string,
  value: unknown
): Promise<CacheWriteResult> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.put(value, key);

      const bytesWritten =
        value instanceof Uint8Array
          ? value.byteLength
          : value instanceof ArrayBuffer
            ? value.byteLength
            : typeof value === 'string'
              ? value.length * 2
              : JSON.stringify(value).length * 2;

      request.onerror = () => {
        const error = request.error;
        const quotaExceeded = isQuotaError(error);
        resolve({
          success: false,
          quotaExceeded,
          error: error?.message ?? 'Unknown write error',
        });
      };

      transaction.onerror = () => {
        const error = transaction.error;
        const quotaExceeded = isQuotaError(error);
        resolve({
          success: false,
          quotaExceeded,
          error: error?.message ?? 'Transaction error',
        });
      };

      transaction.onabort = () => {
        const error = transaction.error;
        const quotaExceeded = isQuotaError(error);
        resolve({
          success: false,
          quotaExceeded,
          error: error?.message ?? 'Transaction aborted',
        });
      };

      transaction.oncomplete = () => {
        resolve({ success: true, quotaExceeded: false, bytesWritten });
      };
    } catch (error) {
      const quotaExceeded = isQuotaError(error);
      resolve({
        success: false,
        quotaExceeded,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// ============================================================================
// Cache Eviction
// ============================================================================

/**
 * List all cache keys matching a prefix.
 */
export async function listCacheKeys(
  db: IDBDatabase,
  storeName: string,
  prefix: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.getAllKeys();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const keys = (request.result as IDBValidKey[])
        .filter((key): key is string => typeof key === 'string')
        .filter((key) => key.startsWith(prefix));
      resolve(keys);
    };

    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Delete cache entries by keys.
 */
export async function deleteCacheKeys(
  db: IDBDatabase,
  storeName: string,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) return;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);

    for (const key of keys) {
      store.delete(key);
    }

    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

/**
 * Evict old cache entries, keeping only the specified keys.
 *
 * This is useful for keeping only the latest DB version cached.
 */
export async function evictOldCacheEntries(
  db: IDBDatabase,
  storeName: string,
  prefix: string,
  keepKeys: string[]
): Promise<number> {
  const allKeys = await listCacheKeys(db, storeName, prefix);
  const keepSet = new Set(keepKeys);
  const toDelete = allKeys.filter((key) => !keepSet.has(key));

  if (toDelete.length > 0) {
    await deleteCacheKeys(db, storeName, toDelete);
    if (isDev) {
      console.log(`[db-cache] Evicted ${toDelete.length} old cache entries`);
    }
  }

  return toDelete.length;
}

// ============================================================================
// Logging
// ============================================================================

/**
 * Log cache statistics (dev-only).
 */
export async function logCacheStats(): Promise<void> {
  if (!isDev) return;

  const stats = await getStorageEstimate();
  const formatBytes = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)}KB`
        : `${bytes}B`;

  console.log(
    `[db-cache] Storage: ${formatBytes(stats.usageBytes)} / ${formatBytes(stats.quotaBytes)} (${stats.usagePercent}%)`
  );
}
