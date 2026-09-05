/**
 * Database Loader for Phage Explorer Web
 *
 * Handles loading the SQLite database from network or IndexedDB cache,
 * initializing sql.js, and providing load progress callbacks.
 */

import type { Database, SqlJsStatic } from 'sql.js';
import { setDatabaseCacheVersion } from '../api/cache';
import { isWASMSupported, detectWASM } from '../utils/wasm';
import {
  DbTimingRecorder,
  storeDbTiming,
  logDbTiming,
  type DbLoadTiming,
} from './db-timing';
import {
  isQuotaError,
  safeCacheWrite,
  logCacheStats,
  type CacheWriteResult,
} from './db-cache';

// Cached sql.js instance - use dynamic import because sql.js is CommonJS
let sqlJsPromise: Promise<SqlJsStatic> | null = null;
async function getSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      // Dynamic import for CommonJS compatibility
      const SqlJs = await import('sql.js');
      // Access the init function - handle various module formats
      const mod = SqlJs as any;
      const initFn = mod.default ?? mod;
      if (typeof initFn === 'function') {
        return initFn(config);
      }
      // If mod.default is an object with default (double-wrapped), unwrap it
      if (typeof initFn?.default === 'function') {
        return initFn.default(config);
      }
      throw new Error(`Cannot find sql.js init function`);
    })().catch((error) => {
      // Allow retry on transient failures (network hiccups, CDN flake, etc.).
      sqlJsPromise = null;
      throw error;
    });
  }
  return sqlJsPromise;
}
import { SqlJsRepository } from './SqlJsRepository';
import type {
  PhageRepository,
  DatabaseLoaderConfig,
  DatabaseLoadProgress,
  DatabaseManifest,
} from './types';

const INDEXEDDB_NAME = 'phage-explorer-db';
const INDEXEDDB_STORE = 'database';
const INDEXEDDB_VERSION = 1;

interface CachedDatabase {
  version: 2;
  data: Uint8Array;
  contentVersion: string;
  sha256: string;
}

/** Reject the old ambiguous hash contract rather than blessing unchecked bytes. */
export function isDatabaseManifest(value: unknown): value is DatabaseManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<DatabaseManifest>;
  const digest = /^[a-f0-9]{64}$/;
  return manifest.version === 2 &&
    typeof manifest.contentVersion === 'string' && digest.test(manifest.contentVersion) && // ubs:ignore — public cache version, not a secret comparison.
    typeof manifest.sha256 === 'string' && digest.test(manifest.sha256) && // ubs:ignore — public artifact checksum, not authentication.
    typeof manifest.size === 'number' && Number.isSafeInteger(manifest.size) && manifest.size >= 16 &&
    typeof manifest.generatedAt === 'string'; // ubs:ignore — validates a public timestamp's type.
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(data));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyDatabaseBytes(data: Uint8Array, manifest: DatabaseManifest): Promise<void> {
  if (!isDatabaseManifest(manifest)) throw new Error('Unsupported database manifest. Refresh the application.');
  if (data.byteLength !== manifest.size || await sha256(data) !== manifest.sha256) { // ubs:ignore — these public integrity hashes contain no secret.
    throw new Error('Database integrity check failed. The download does not match its manifest; the previous cache has been preserved.');
  }
}

/**
 * Convert a Uint8Array view into an ArrayBuffer.
 *
 * Some Web APIs (Blob, WebCrypto) are typed in TS as requiring `ArrayBuffer`
 * (not `SharedArrayBuffer` / `ArrayBufferLike`). We only copy when necessary.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer) {
    if (byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  // SharedArrayBuffer (or other ArrayBufferLike): copy into a new ArrayBuffer.
  const copy = new Uint8Array(byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Open IndexedDB database
 */
function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEXEDDB_NAME, INDEXEDDB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(INDEXEDDB_STORE)) {
        db.createObjectStore(INDEXEDDB_STORE);
      }
    };
  });
}

/**
 * Get value from IndexedDB
 */
async function getFromIndexedDB<T>(key: string): Promise<T | null> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(INDEXEDDB_STORE, 'readonly');
    const store = transaction.objectStore(INDEXEDDB_STORE);
    const request = store.get(key);

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result ?? null);

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(new Error('IndexedDB transaction aborted'));
    };
    transaction.oncomplete = () => db.close();
  });
}

/**
 * Set value in IndexedDB
 */
async function setInIndexedDB<T>(key: string, value: T): Promise<void> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(INDEXEDDB_STORE, 'readwrite');
    const store = transaction.objectStore(INDEXEDDB_STORE);
    const request = store.put(value, key);

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(new Error('IndexedDB transaction aborted'));
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

/**
 * Delete value from IndexedDB
 */
async function deleteFromIndexedDB(key: string): Promise<void> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(INDEXEDDB_STORE, 'readwrite');
    const store = transaction.objectStore(INDEXEDDB_STORE);
    const request = store.delete(key);

    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(new Error('IndexedDB transaction aborted'));
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}

/**
 * Fetch manifest with ETag-based conditional request.
 * Returns cached manifest if server returns 304 Not Modified.
 */
async function fetchManifestWithETag(
  manifestUrl: string
): Promise<{ manifest: DatabaseManifest | null; fromCache: boolean }> {
  let cachedEtag: string | null = null;
  let cachedManifest: DatabaseManifest | null = null;
  const cacheKey = `manifest:${manifestUrl}`;

  // Cache reads are best-effort; IDB may be unavailable (private mode / quota / permissions).
  try {
    const cached = await getFromIndexedDB<{ etag: string | null; manifest: unknown }>(cacheKey);
    if (cached && isDatabaseManifest(cached.manifest)) {
      cachedEtag = cached.etag;
      cachedManifest = cached.manifest;
    }
  } catch {
    cachedEtag = null;
    cachedManifest = null;
  }

  const fetchWith = async (headers?: HeadersInit) =>
    fetch(manifestUrl, { cache: 'no-cache', headers, signal: AbortSignal.timeout(10_000) });

  let response: Response;
  try {
    const headers: HeadersInit = {};
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }
    response = await fetchWith(headers);
  } catch {
    return { manifest: cachedManifest, fromCache: !!cachedManifest };
  }

  // 304 Not Modified - use cached manifest, but if the cache is missing fall back to a full fetch.
  if (response.status === 304) {
    if (cachedManifest) {
      return { manifest: cachedManifest, fromCache: true };
    }
    try {
      response = await fetchWith();
    } catch {
      return { manifest: null, fromCache: false };
    }
  }

  if (!response.ok) {
    // Offline or error - try to use cached manifest
    if (cachedManifest) {
      return { manifest: cachedManifest, fromCache: true };
    }
    return { manifest: null, fromCache: false };
  }

  let manifest: DatabaseManifest;
  try {
    const value: unknown = await response.json();
    if (!isDatabaseManifest(value)) throw new Error('Unsupported database manifest');
    manifest = value;
  } catch {
    if (cachedManifest) {
      return { manifest: cachedManifest, fromCache: true };
    }
    return { manifest: null, fromCache: false };
  }

  // Cache writes are best-effort; a quota/IDB failure should not block the app.
  try {
    await setInIndexedDB(cacheKey, { etag: response.headers.get('ETag'), manifest });
  } catch {
    // Ignore caching failures.
  }

  return { manifest, fromCache: false };
}

/**
 * Database loader class
 */
export class DatabaseLoader {
  private config: Required<DatabaseLoaderConfig>;
  private repository: SqlJsRepository | null = null;
  private sqlPromise: Promise<SqlJsStatic> | null = null;
  /** Current timing recorder (dev-only instrumentation) */
  private timing: DbTimingRecorder | null = null;

  // --- gzip decompression worker (pako fallback) ---
  private gzipWorker: Worker | null = null;
  private gzipWorkerNextId = 1;
  private gzipWorkerRequests = new Map<
    number,
    { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }
  >();
  /** Last completed timing result (for external access) */
  private lastTiming: DbLoadTiming | null = null;
  private updatePromise: Promise<boolean> | null = null;

  constructor(config: DatabaseLoaderConfig) {
    this.config = {
      databaseUrl: config.databaseUrl,
      manifestUrl: config.manifestUrl ?? `${config.databaseUrl}.manifest.json`,
      dbName: config.dbName ?? 'phage-db',
      onProgress: config.onProgress ?? (() => {}),
    };
  }

  /**
   * Initialize sql.js (lazy, cached)
   */
  private async getSqlJs(): Promise<SqlJsStatic> {
    if (!this.sqlPromise) {
      this.sqlPromise = getSqlJs({
        // Load WASM from CDN
        locateFile: (file: string) =>
          `https://sql.js.org/dist/${file}`,
      });
    }
    return this.sqlPromise;
  }

  /**
   * Report progress
   */
  private progress(
    stage: DatabaseLoadProgress['stage'],
    percent: number,
    message: string,
    cached = false,
    updateStatus?: DatabaseLoadProgress['updateStatus']
  ): void {
    if (this.repository && stage !== 'ready' && stage !== 'error') {
      this.config.onProgress({ stage: 'ready', percent: 100, message: 'Updating the database in the background. Your cached data remains available.', cached: true, updateStatus: 'pending' });
      return;
    }
    this.config.onProgress({ stage, percent, message, cached, updateStatus });
  }

  /**
   * Check if cached database is valid
   */
  async checkCache(): Promise<{
    valid: boolean;
    entry?: CachedDatabase;
    stale?: boolean;
  }> {
    this.progress('checking', 0, 'Checking cache...');

    try {
      // Check if we have a cached database
      const entry = await this.readVerifiedCache();
      if (!entry) return { valid: false };

      // Try to fetch manifest with ETag support (much faster for unchanged manifests)
      const { manifest } = await fetchManifestWithETag(this.config.manifestUrl);
      return { valid: true, entry, stale: !!manifest && manifest.contentVersion !== entry.contentVersion };
    } catch {
      return { valid: false };
    }
  }

  private async readVerifiedCache(): Promise<CachedDatabase | null> {
    const entry = await getFromIndexedDB<CachedDatabase>(`${this.config.dbName}:snapshot`);
    if (!entry || entry.version !== 2 || !(entry.data instanceof Uint8Array) ||
        !this.isValidSqliteData(entry.data) ||
        !/^[a-f0-9]{64}$/.test(entry.contentVersion) || await sha256(entry.data) !== entry.sha256) {
      return null;
    }
    return entry;
  }

  /**
   * Load database from cache
   */
  async loadFromCache(): Promise<Database | null> {
    try {
      const entry = await this.readVerifiedCache();
      if (!entry) return null;

      this.progress('initializing', 90, 'Initializing from cache...', true);
      const SQL = await this.getSqlJs();
      return new SQL.Database(entry.data);
    } catch (error) {
      console.error('Failed to load from cache:', error);
      // Clear potentially corrupted cache
      await this.clearCache().catch(() => {});
      return null;
    }
  }

  /**
   * Validate data has SQLite file header
   */
  private isValidSqliteData(data: Uint8Array): boolean {
    if (data.length < 16) return false;
    // SQLite files start with the 16-byte header: "SQLite format 3\0"
    // Compare bytes directly to avoid depending on TextDecoder (browser compatibility).
    return (
      data[0] === 0x53 && // S
      data[1] === 0x51 && // Q
      data[2] === 0x4c && // L
      data[3] === 0x69 && // i
      data[4] === 0x74 && // t
      data[5] === 0x65 && // e
      data[6] === 0x20 && // ' '
      data[7] === 0x66 && // f
      data[8] === 0x6f && // o
      data[9] === 0x72 && // r
      data[10] === 0x6d && // m
      data[11] === 0x61 && // a
      data[12] === 0x74 && // t
      data[13] === 0x20 && // ' '
      data[14] === 0x33 && // 3
      data[15] === 0x00
    );
  }

  private formatAsciiPreview(data: Uint8Array, maxBytes: number): string {
    const limit = Math.min(data.length, maxBytes);
    let out = '';
    for (let i = 0; i < limit; i++) {
      const b = data[i];
      out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
    }
    return out;
  }

  private canUseGzipDecompressionStream(): boolean {
    const ctor = (globalThis as any).DecompressionStream as undefined | (new (format: string) => TransformStream);
    if (!ctor) return false;
    try {
      // Some environments may expose the ctor but not support gzip.
      new ctor('gzip');
      return true;
    } catch {
      return false;
    }
  }

  private withGzipSuffix(url: string): string {
    const qIndex = url.indexOf('?');
    const base = qIndex >= 0 ? url.slice(0, qIndex) : url;
    const query = qIndex >= 0 ? url.slice(qIndex) : '';
    if (base.endsWith('.gz')) return url;
    return `${base}.gz${query}`;
  }

  private async getGzipDecompressor(): Promise<
    | { label: string; decompress: (data: Uint8Array) => Promise<Uint8Array> }
    | null
  > {
    if (this.canUseGzipDecompressionStream()) {
      return { label: 'native', decompress: (data) => this.decompressGzip(data) };
    }

    // Fallback for browsers without `DecompressionStream('gzip')` (e.g., older Safari):
    // dynamically import pako so modern browsers don't pay the cost.
    return { label: 'pako', decompress: (data) => this.decompressGzipWithPako(data) };
  }

  private async decompressGzip(data: Uint8Array): Promise<Uint8Array> {
    const ctor = (globalThis as any).DecompressionStream as undefined | (new (format: string) => TransformStream);
    if (!ctor) {
      throw new Error('DecompressionStream not available');
    }
    const ds = new ctor('gzip');
    const decompressedStream = new Blob([toArrayBuffer(data)]).stream().pipeThrough(ds);
    const buffer = await new Response(decompressedStream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  private canUseModuleWorker(): boolean {
    return typeof Worker !== 'undefined';
  }

  private ensureGzipWorker(): Worker {
    if (this.gzipWorker) return this.gzipWorker;

    if (!this.canUseModuleWorker()) {
      throw new Error('Worker not available');
    }

    let worker: Worker;
    try {
      // Prefer module workers (fastest path in modern browsers).
      worker = new Worker(new URL('./gzip-decompress.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      // Fallback for older browsers that support Workers but not module workers.
      worker = new Worker(new URL('./gzip-decompress.worker.ts', import.meta.url));
    }

    worker.onmessage = (event: MessageEvent) => {
      const payload = event.data as
        | { id: number; ok: true; buffer: ArrayBuffer }
        | { id: number; ok: false; error: string };

      const pending = this.gzipWorkerRequests.get(payload.id);
      if (!pending) return;
      this.gzipWorkerRequests.delete(payload.id);

      if (!payload.ok) {
        pending.reject(new Error(payload.error));
        return;
      }

      pending.resolve(new Uint8Array(payload.buffer));
    };

    worker.onerror = () => {
      const error = new Error('gzip worker error');
      for (const pending of this.gzipWorkerRequests.values()) {
        pending.reject(error);
      }
      this.gzipWorkerRequests.clear();

      // Reset so future calls can attempt to recreate a fresh worker.
      // Always null the reference unconditionally - the worker is terminated
      // and cannot be reused. If a new worker was created concurrently, this
      // will cause it to be recreated on next use, which is safe.
      worker.terminate();
      this.gzipWorker = null;
    };

    this.gzipWorker = worker;
    return worker;
  }

  private async decompressGzipWithPakoWorker(data: Uint8Array): Promise<Uint8Array> {
    const worker = this.ensureGzipWorker();
    const id = this.gzipWorkerNextId++;

    return new Promise<Uint8Array>((resolve, reject) => {
      this.gzipWorkerRequests.set(id, { resolve, reject });

      try {
        // Do NOT transfer the input buffer so we can safely fall back to the main-thread path on error.
        worker.postMessage({ id, data });
      } catch (error) {
        this.gzipWorkerRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async decompressGzipWithPakoMainThread(data: Uint8Array): Promise<Uint8Array> {
    const mod: any = await import('pako');
    const ungzip: unknown = mod?.ungzip ?? mod?.default?.ungzip;
    if (typeof ungzip !== 'function') {
      throw new Error('pako.ungzip not available');
    }
    const result = ungzip(data);
    return result instanceof Uint8Array ? result : new Uint8Array(result);
  }

  private async decompressGzipWithPako(data: Uint8Array): Promise<Uint8Array> {
    // Prefer worker decompression to avoid main-thread stalls on Safari-class browsers.
    if (this.canUseModuleWorker()) {
      try {
        return await this.decompressGzipWithPakoWorker(data);
      } catch {
        // Fall back to main-thread pako; still better than failing DB load entirely.
      }
    }

    return this.decompressGzipWithPakoMainThread(data);
  }

  private async fetchBytes(url: string, label: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      const offlineHint =
        typeof navigator !== 'undefined' && navigator.onLine === false
          ? ' (offline?)'
          : '';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Network error while downloading database${offlineHint}: ${message}`);
    }
    if (!response.ok) {
      const statusLabel = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
      throw new Error(`Database download failed (${statusLabel}). URL: ${url}`);
    }

    const contentEncoding = response.headers.get('content-encoding');
    // When Content-Encoding is present, browsers transparently decode the body stream, but
    // Content-Length (if set) may refer to the encoded (compressed) byte length. In that case,
    // progress ratios become meaningless and can exceed 100%.
    const canTrustContentLength = !contentEncoding || contentEncoding === 'identity';
    const contentLength = canTrustContentLength ? response.headers.get('content-length') : null;
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;
    let lastReportedLoaded = 0;

    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = await response.arrayBuffer();
      this.progress('downloading', 50, `${label}: ${Math.round(buffer.byteLength / 1024)}KB`);
      return new Uint8Array(buffer);
    }

    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;

      if (total > 0) {
        const percent = Math.min(50, Math.round((loaded / total) * 40) + 10);
        this.progress('downloading', percent, `${label}: ${Math.round(loaded / 1024)}KB`);
      } else {
        // Best-effort progress when total size is unknown/unreliable.
        // We cap this to the "download" phase range (10–50).
        if (loaded - lastReportedLoaded >= 256 * 1024) {
          lastReportedLoaded = loaded;
          const approxPercent = Math.min(
            50,
            10 + Math.round((loaded / (1024 * 1024)) * 6)
          );
          this.progress('downloading', approxPercent, `${label}: ${Math.round(loaded / 1024)}KB`);
        }
      }
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return combined;
  }

  /**
   * Save database to cache with quota error handling.
   *
   * @returns Result indicating success or quota error
   */
  async saveToCache(data: Uint8Array, manifest: DatabaseManifest): Promise<CacheWriteResult> {
    try {
      await verifyDatabaseBytes(data, manifest);
      const idb = await openIndexedDB();

      try {
        // A single IDB record/transaction binds identity to the exact verified
        // download. Exporting a live sql.js DB can change its byte layout.
        const dataResult = await safeCacheWrite(
          idb,
          INDEXEDDB_STORE,
          `${this.config.dbName}:snapshot`,
          { version: 2, data, contentVersion: manifest.contentVersion, sha256: manifest.sha256 } satisfies CachedDatabase
        );

        if (!dataResult.success) {
          if (dataResult.quotaExceeded) {
            console.warn(
              '[DatabaseLoader] Cache quota exceeded, falling back to network-only mode. ' +
                `Tried to cache ${(data.byteLength / 1024 / 1024).toFixed(1)}MB.`
            );
            // Log storage stats for debugging
            if (import.meta.env?.DEV) {
              await logCacheStats();
            }
          } else {
            console.error('[DatabaseLoader] Failed to cache database:', dataResult.error);
          }
          idb.close();
          return dataResult;
        }

        idb.close();
        if (import.meta.env?.DEV) {
          console.log(
            `[DatabaseLoader] Cached ${(data.byteLength / 1024 / 1024).toFixed(1)}MB database (version: ${manifest.contentVersion.slice(0, 8)}...)`
          );
        }

        return {
          success: true,
          quotaExceeded: false,
          bytesWritten: data.byteLength,
        };
      } catch (error) {
        idb.close();
        throw error;
      }
    } catch (error) {
      const quotaExceeded = isQuotaError(error);
      if (quotaExceeded) {
        console.warn('[DatabaseLoader] Cache quota exceeded during save');
      } else {
        console.error('[DatabaseLoader] Failed to save to cache:', error);
      }
      return {
        success: false,
        quotaExceeded,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Clear the cache
   */
  async clearCache(): Promise<void> {
    await deleteFromIndexedDB(`${this.config.dbName}:snapshot`);
    await deleteFromIndexedDB(`${this.config.dbName}:data`);
    await deleteFromIndexedDB(`${this.config.dbName}:hash`);
  }

  /**
   * Download and initialize the database
   */
  async downloadDatabase(manifest: DatabaseManifest): Promise<{ db: Database; data: Uint8Array }> {
    if (!isDatabaseManifest(manifest)) throw new Error('A valid database manifest is required.');
    this.progress('downloading', 10, 'Downloading database...');

    const downloadUrl = (() => {
      try {
        const url = new URL(this.config.databaseUrl, typeof window === 'undefined' ? undefined : window.location.href);
        // Cache-bust any service-worker CacheFirst/SWR behavior by making the request URL unique per version.
        url.searchParams.set('v', manifest.contentVersion);
        return url.toString();
      } catch {
        const separator = this.config.databaseUrl.includes('?') ? '&' : '?';
        return `${this.config.databaseUrl}${separator}v=${encodeURIComponent(manifest.contentVersion)}`;
      }
    })();

    let combined: Uint8Array | null = null;

    // Prefer a pre-compressed asset (`.db.gz`) when supported to cut first-load latency.
    // Fallback to the raw `.db` if decompression isn't available or the `.gz` is missing.
    const gz = await this.getGzipDecompressor();
    if (gz) {
      const gzUrl = this.withGzipSuffix(downloadUrl);
      try {
        this.progress('downloading', 10, 'Downloading database (compressed)...');

        this.timing?.startStage('fetch');
        const compressed = await this.fetchBytes(gzUrl, 'Downloading (gzip)');
        this.timing?.endStage('fetch');
        this.timing?.setBytesTransferred(compressed.length);

        // In some deployments the server may auto-decompress; if so, accept the bytes as-is.
        if (this.isValidSqliteData(compressed)) {
          combined = compressed;
          this.timing?.setSource('db');
          this.timing?.setDecompressionMethod('none');
        } else {
          this.progress(
            'decompressing',
            55,
            gz.label === 'native' ? 'Decompressing database...' : 'Decompressing database (fallback)...'
          );

          this.timing?.startStage('decompress');
          combined = await gz.decompress(compressed);
          this.timing?.endStage('decompress');

          this.timing?.setSource('db.gz');
          this.timing?.setDecompressionMethod(gz.label === 'native' ? 'native' : 'pako');
        }
      } catch {
        combined = null;
      }
    }

    if (!combined) {
      this.progress('downloading', 10, 'Downloading database...');

      this.timing?.startStage('fetch');
      combined = await this.fetchBytes(downloadUrl, 'Downloading');
      this.timing?.endStage('fetch');

      this.timing?.setBytesTransferred(combined.length);
      this.timing?.setSource('db');
      this.timing?.setDecompressionMethod('none');
    }

    this.timing?.setBytesDecompressed(combined.length);
    this.progress('decompressing', 60, 'Processing database...');
    await verifyDatabaseBytes(combined, manifest);

    // Validate downloaded data is a valid SQLite database
    if (!this.isValidSqliteData(combined)) {
      // Debug: log what we actually received
      const headerBytes = Array.from(combined.slice(0, 32));
      const headerHex = headerBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
      const headerStr = this.formatAsciiPreview(combined, 64);
      console.error('Invalid SQLite data received:', {
        length: combined.length,
        headerHex,
        headerStr,
      });
      throw new Error(
        `Downloaded data is not a valid SQLite database (received ${combined.length} bytes, header: "${headerStr.slice(0, 32)}"). ` +
          'The file may be corrupted or the server returned an error page.'
      );
    }

    this.progress('initializing', 80, 'Initializing database...');

    this.timing?.startStage('sqlJsInit');
    const SQL = await this.getSqlJs();
    this.timing?.endStage('sqlJsInit');

    this.timing?.startStage('dbOpen');
    const db = new SQL.Database(combined);
    // Run a simple query to warm up the database
    db.exec('SELECT 1');
    this.timing?.endStage('dbOpen');

    return { db, data: combined };
  }

  /**
   * Load the database (from cache or network)
   */
  async load(options: { forceDownload?: boolean } = {}): Promise<PhageRepository> {
    if (this.repository) {
      return this.repository;
    }

    // Initialize timing recorder (dev-only instrumentation)
    this.timing = new DbTimingRecorder();

    // Early check for WASM support - fail fast with clear error
    if (!isWASMSupported()) {
      const wasmStatus = await detectWASM();
      const reason = wasmStatus.supported ? 'unknown' : wasmStatus.reason;
      this.progress('error', 0, `WebAssembly not supported: ${reason}. This browser cannot run Phage Explorer.`);
      throw new Error(`WebAssembly is not supported in this browser: ${reason}. Phage Explorer requires WebAssembly to run the SQLite database engine.`);
    }

    try {
      // Check cache first
      this.timing.startStage('cacheCheck');
      const cacheStatus: Awaited<ReturnType<DatabaseLoader['checkCache']>> = options.forceDownload
        ? { valid: false }
        : await this.checkCache();
      this.timing.endStage('cacheCheck');

      if (cacheStatus.valid && cacheStatus.entry) {
        const stale = cacheStatus.stale === true;
        this.progress(
          'initializing',
          80,
          stale ? 'Loading cached database (update available)...' : 'Loading from cache...',
          true
        );
        this.timing.setCached(true);
        this.timing.setSource('cache');

        this.timing.startStage('cacheRead');
        const cachedData = cacheStatus.entry.data;
        this.timing.endStage('cacheRead');

        if (cachedData && this.isValidSqliteData(cachedData)) {
          this.timing.setBytesDecompressed(cachedData.length);

          this.timing.startStage('sqlJsInit');
          const SQL = await this.getSqlJs();
          this.timing.endStage('sqlJsInit');

          this.timing.startStage('dbOpen');
          const db = new SQL.Database(cachedData);
          // Run a simple query to warm up the database
          db.exec('SELECT 1');
          this.timing.endStage('dbOpen');

          this.progress(
            'ready',
            100,
            stale ? 'Database ready (cached, update available)' : 'Database ready (cached)',
            true
          );
          this.repository = new SqlJsRepository(db);
          setDatabaseCacheVersion(cacheStatus.entry.contentVersion);

          // Finalize and log timing
          this.finalizeTiming();

          // Check for updates in background
          if (stale) void this.checkForUpdates();

          return this.repository;
        }
      }

      // Cold load path
      this.timing.setCached(false);

      const { manifest } = await fetchManifestWithETag(this.config.manifestUrl);
      if (!manifest) throw new Error('Database manifest unavailable or unsupported. Connect to the network and refresh the application.');

      // Download fresh copy (timing is recorded inside downloadDatabase)
      const { db, data } = await this.downloadDatabase(manifest);

      // Save to cache
      this.progress('initializing', 95, 'Saving to cache...');
      this.timing.startStage('cacheWrite');
      await this.saveToCache(data, manifest);
      this.timing.endStage('cacheWrite');

      this.progress('ready', 100, 'Database ready');
      this.repository = new SqlJsRepository(db);
      setDatabaseCacheVersion(manifest.contentVersion);

      // Finalize and log timing
      this.finalizeTiming();

      return this.repository;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.progress('error', 0, `Failed to load database: ${message}`);
      throw error;
    }
  }

  /**
   * Finalize timing and log/store results (dev-only)
   */
  private finalizeTiming(): void {
    if (!this.timing) return;

    this.lastTiming = this.timing.finalize();
    logDbTiming(this.lastTiming);
    storeDbTiming(this.lastTiming);
    this.timing = null;
  }

  /**
   * Get the last timing result (for external access/testing)
   */
  getLastTiming(): DbLoadTiming | null {
    return this.lastTiming;
  }

  /**
   * Check for database updates in background
   */
  async checkForUpdates(): Promise<boolean> {
    if (!this.updatePromise) {
      this.updatePromise = this.refreshCache().finally(() => { this.updatePromise = null; });
    }
    return this.updatePromise;
  }

  private async refreshCache(): Promise<boolean> {
    try {
      // Use ETag-based conditional request for efficient checking
      const { manifest } = await fetchManifestWithETag(this.config.manifestUrl);

      if (!manifest) {
        return false;
      }

      const cached = await this.readVerifiedCache();
      if (manifest.contentVersion !== cached?.contentVersion) { // ubs:ignore — compares public dataset versions, not credentials.
        if (import.meta.env?.DEV) {
          console.log('Database update available, downloading in background...');
        }
        // Download new version
        const { db, data } = await this.downloadDatabase(manifest);
        let saved: CacheWriteResult;
        try {
          saved = await this.saveToCache(data, manifest);
        } finally {
          db.close();
        }
        if (!saved.success) {
          this.progress('ready', 100, 'The database update could not be saved. Your verified cached database is still in use.', true, 'failed');
          return false;
        }

        // Note: The old repository is still valid until reload
        if (import.meta.env?.DEV) {
          console.log('Database updated, reload to use new version');
        }
        this.progress('ready', 100, 'Database update downloaded. Reload to use it.', true, 'ready');
        return true;
      }

      return false;
    } catch {
      if (this.repository) {
        this.progress('ready', 100, 'Database update failed. Your verified cached database is still in use.', true, 'failed');
      }
      return false;
    }
  }

  /**
   * Get the repository (must call load() first)
   */
  getRepository(): PhageRepository {
    if (!this.repository) {
      throw new Error('Database not loaded. Call load() first.');
    }
    return this.repository;
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    if (this.repository) {
      await this.repository.close();
      this.repository = null;
    }

    if (this.gzipWorker) {
      this.gzipWorker.terminate();
      this.gzipWorker = null;
    }
    for (const pending of this.gzipWorkerRequests.values()) {
      pending.reject(new Error('DatabaseLoader closed'));
    }
    this.gzipWorkerRequests.clear();
  }
}

/**
 * Create a database loader with default configuration
 */
export function createDatabaseLoader(
  databaseUrl: string,
  onProgress?: (progress: DatabaseLoadProgress) => void
): DatabaseLoader {
  return new DatabaseLoader({
    databaseUrl,
    onProgress,
  });
}

export default DatabaseLoader;
