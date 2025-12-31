/**
 * Database Loader for Phage Explorer Web
 *
 * Handles loading the SQLite database from network or IndexedDB cache,
 * initializing sql.js, and providing load progress callbacks.
 */

import type { Database, SqlJsStatic } from 'sql.js';
import { isWASMSupported, detectWASM } from '../utils/wasm';
import {
  DbTimingRecorder,
  storeDbTiming,
  logDbTiming,
  type DbLoadTiming,
} from './db-timing';

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
    })();
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

// Cache keys for ETag-based conditional requests
const MANIFEST_ETAG_KEY = 'manifest-etag';
const MANIFEST_CACHE_KEY = 'manifest-cache';

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
  try {
    // Get cached ETag and manifest
    const cachedEtag = await getFromIndexedDB<string>(MANIFEST_ETAG_KEY);
    const cachedManifest = await getFromIndexedDB<DatabaseManifest>(MANIFEST_CACHE_KEY);

    const headers: HeadersInit = {};
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }

    const response = await fetch(manifestUrl, {
      cache: 'no-cache', // Revalidate but allow conditional response
      headers,
    });

    // 304 Not Modified - use cached manifest
    if (response.status === 304 && cachedManifest) {
      return { manifest: cachedManifest, fromCache: true };
    }

    if (!response.ok) {
      // Offline or error - try to use cached manifest
      if (cachedManifest) {
        return { manifest: cachedManifest, fromCache: true };
      }
      return { manifest: null, fromCache: false };
    }

    const manifest: DatabaseManifest = await response.json();

    // Cache the new manifest and ETag
    const newEtag = response.headers.get('ETag');
    if (newEtag) {
      await setInIndexedDB(MANIFEST_ETAG_KEY, newEtag);
    }
    await setInIndexedDB(MANIFEST_CACHE_KEY, manifest);

    return { manifest, fromCache: false };
  } catch {
    // Network error - try cached manifest
    const cachedManifest = await getFromIndexedDB<DatabaseManifest>(MANIFEST_CACHE_KEY);
    return { manifest: cachedManifest, fromCache: !!cachedManifest };
  }
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
  /** Last completed timing result (for external access) */
  private lastTiming: DbLoadTiming | null = null;

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
    cached = false
  ): void {
    this.config.onProgress({ stage, percent, message, cached });
  }

  /**
   * Check if cached database is valid
   */
  async checkCache(): Promise<{ valid: boolean; hash?: string }> {
    this.progress('checking', 0, 'Checking cache...');

    try {
      // Check if we have a cached database
      const cachedData = await getFromIndexedDB<Uint8Array>(`${this.config.dbName}:data`);
      const cachedHash = await getFromIndexedDB<string>(`${this.config.dbName}:hash`);

      if (!cachedData || !cachedHash) {
        return { valid: false };
      }

      // Try to fetch manifest with ETag support (much faster for unchanged manifests)
      const { manifest } = await fetchManifestWithETag(this.config.manifestUrl);
      if (manifest && manifest.hash !== cachedHash) {
        return { valid: false, hash: cachedHash };
      }

      return { valid: true, hash: cachedHash };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Load database from cache
   */
  async loadFromCache(): Promise<Database | null> {
    try {
      const cachedData = await getFromIndexedDB<Uint8Array>(`${this.config.dbName}:data`);
      if (!cachedData) {
        return null;
      }

      // Validate cached data has SQLite header
      if (!this.isValidSqliteData(cachedData)) {
        console.warn('Cached data is not valid SQLite, clearing cache');
        await this.clearCache();
        return null;
      }

      this.progress('initializing', 90, 'Initializing from cache...', true);
      const SQL = await this.getSqlJs();
      return new SQL.Database(cachedData);
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
    // SQLite files start with "SQLite format 3\0"
    const header = new TextDecoder().decode(data.slice(0, 16));
    return header.startsWith('SQLite format 3');
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
    try {
      const mod: any = await import('pako');
      const ungzip: unknown = mod?.ungzip ?? mod?.default?.ungzip;
      if (typeof ungzip !== 'function') return null;
      return {
        label: 'pako',
        decompress: async (data) => {
          const result = ungzip(data);
          return result instanceof Uint8Array ? result : new Uint8Array(result);
        },
      };
    } catch {
      return null;
    }
  }

  private async decompressGzip(data: Uint8Array): Promise<Uint8Array> {
    const ctor = (globalThis as any).DecompressionStream as undefined | (new (format: string) => TransformStream);
    if (!ctor) {
      throw new Error('DecompressionStream not available');
    }
    const ds = new ctor('gzip');
    const decompressedStream = new Blob([data]).stream().pipeThrough(ds);
    const buffer = await new Response(decompressedStream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  private async fetchBytes(url: string, label: string): Promise<Uint8Array> {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to download database: ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;

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
        const percent = Math.round((loaded / total) * 40) + 10;
        this.progress('downloading', percent, `${label}: ${Math.round(loaded / 1024)}KB`);
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
   * Save database to cache
   */
  async saveToCache(db: Database, hash: string): Promise<void> {
    try {
      const data = db.export();
      await setInIndexedDB(`${this.config.dbName}:data`, data);
      await setInIndexedDB(`${this.config.dbName}:hash`, hash);
    } catch (error) {
      console.error('Failed to save to cache:', error);
      // Non-fatal - continue without caching
    }
  }

  /**
   * Clear the cache
   */
  async clearCache(): Promise<void> {
    await deleteFromIndexedDB(`${this.config.dbName}:data`);
    await deleteFromIndexedDB(`${this.config.dbName}:hash`);
  }

  /**
   * Download and initialize the database
   */
  async downloadDatabase(expectedHash?: string): Promise<{ db: Database; hash: string }> {
    this.progress('downloading', 10, 'Downloading database...');

    const downloadUrl = (() => {
      if (!expectedHash) return this.config.databaseUrl;
      if (typeof window === 'undefined') return this.config.databaseUrl;

      try {
        const url = new URL(this.config.databaseUrl, window.location.href);
        // Cache-bust any service-worker CacheFirst/SWR behavior by making the request URL unique per version.
        url.searchParams.set('v', expectedHash);
        return url.toString();
      } catch {
        const separator = this.config.databaseUrl.includes('?') ? '&' : '?';
        return `${this.config.databaseUrl}${separator}v=${encodeURIComponent(expectedHash)}`;
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

    // Validate downloaded data is a valid SQLite database
    if (!this.isValidSqliteData(combined)) {
      // Debug: log what we actually received
      const headerBytes = Array.from(combined.slice(0, 32));
      const headerHex = headerBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
      const headerStr = new TextDecoder().decode(combined.slice(0, 64));
      console.error('Invalid SQLite data received:', {
        length: combined.length,
        headerHex,
        headerStr: headerStr.replace(/[^\x20-\x7E]/g, '.'),
      });
      throw new Error(`Downloaded data is not a valid SQLite database (received ${combined.length} bytes, header: "${headerStr.slice(0, 32).replace(/[^\x20-\x7E]/g, '.')}"). The file may be corrupted or the server returned an error page.`);
    }

    this.progress('initializing', 80, 'Initializing database...');

    this.timing?.startStage('sqlJsInit');
    const SQL = await this.getSqlJs();
    this.timing?.endStage('sqlJsInit');

    // Calculate hash from data
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    if (expectedHash && hash !== expectedHash) {
      throw new Error(
        `Database hash mismatch (expected ${expectedHash.slice(0, 16)}…, got ${hash.slice(0, 16)}…). ` +
          'This can happen if a service worker served a stale cached database.'
      );
    }

    this.timing?.startStage('dbOpen');
    const db = new SQL.Database(combined);
    // Run a simple query to warm up the database
    db.exec('SELECT 1');
    this.timing?.endStage('dbOpen');

    return { db, hash };
  }

  /**
   * Load the database (from cache or network)
   */
  async load(): Promise<PhageRepository> {
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
      const cacheStatus = await this.checkCache();
      this.timing.endStage('cacheCheck');

      if (cacheStatus.valid) {
        this.progress('initializing', 80, 'Loading from cache...', true);
        this.timing.setCached(true);
        this.timing.setSource('cache');

        this.timing.startStage('cacheRead');
        const cachedData = await getFromIndexedDB<Uint8Array>(`${this.config.dbName}:data`);
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

          this.progress('ready', 100, 'Database ready (cached)', true);
          this.repository = new SqlJsRepository(db);

          // Finalize and log timing
          this.finalizeTiming();

          // Check for updates in background
          void this.checkForUpdates();

          return this.repository;
        }
      }

      // Cold load path
      this.timing.setCached(false);

      // Try to fetch the manifest so we can cache-bust service worker DB caching and validate the hash.
      let expectedHash: string | undefined;
      try {
        const { manifest } = await fetchManifestWithETag(this.config.manifestUrl);
        expectedHash = manifest?.hash;
      } catch {
        expectedHash = undefined;
      }

      // Download fresh copy (timing is recorded inside downloadDatabase)
      const { db, hash } = await this.downloadDatabase(expectedHash);

      // Save to cache
      this.progress('initializing', 95, 'Saving to cache...');
      this.timing.startStage('cacheWrite');
      await this.saveToCache(db, hash);
      this.timing.endStage('cacheWrite');

      this.progress('ready', 100, 'Database ready');
      this.repository = new SqlJsRepository(db);

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
    try {
      // Use ETag-based conditional request for efficient checking
      const { manifest, fromCache } = await fetchManifestWithETag(this.config.manifestUrl);

      if (!manifest) {
        return false;
      }

      // If we got a cached manifest via 304, no update needed
      if (fromCache) {
        return false;
      }

      const cachedHash = await getFromIndexedDB<string>(`${this.config.dbName}:hash`);

      if (manifest.hash !== cachedHash) {
        if (import.meta.env.DEV) {
          console.log('Database update available, downloading in background...');
        }
        // Download new version
        const { db, hash } = await this.downloadDatabase(manifest.hash);
        await this.saveToCache(db, hash);

        // Note: The old repository is still valid until reload
        if (import.meta.env.DEV) {
          console.log('Database updated, reload to use new version');
        }
        return true;
      }

      return false;
    } catch {
      // Offline or error - ignore
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
