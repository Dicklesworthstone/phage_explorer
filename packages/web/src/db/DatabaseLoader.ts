/**
 * Database Loader for Phage Explorer Web
 *
 * Handles loading the SQLite database from network or IndexedDB cache,
 * initializing sql.js, and providing load progress callbacks.
 */

import type { Database, SqlJsStatic } from 'sql.js';
import { isWASMSupported, detectWASM } from '../utils/wasm';

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
  async downloadDatabase(): Promise<{ db: Database; hash: string }> {
    this.progress('downloading', 10, 'Downloading database...');

    // Fetch the database
    const response = await fetch(this.config.databaseUrl);
    if (!response.ok) {
      throw new Error(`Failed to download database: ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;

    // Stream the download with progress
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;

      if (total > 0) {
        const percent = Math.round((loaded / total) * 40) + 10;
        this.progress('downloading', percent, `Downloading: ${Math.round(loaded / 1024)}KB`);
      }
    }

    // Combine chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

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
    const SQL = await this.getSqlJs();

    // Calculate hash from data
    const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const db = new SQL.Database(combined);
    return { db, hash };
  }

  /**
   * Load the database (from cache or network)
   */
  async load(): Promise<PhageRepository> {
    if (this.repository) {
      return this.repository;
    }

    // Early check for WASM support - fail fast with clear error
    if (!isWASMSupported()) {
      const wasmStatus = await detectWASM();
      const reason = wasmStatus.supported ? 'unknown' : wasmStatus.reason;
      this.progress('error', 0, `WebAssembly not supported: ${reason}. This browser cannot run Phage Explorer.`);
      throw new Error(`WebAssembly is not supported in this browser: ${reason}. Phage Explorer requires WebAssembly to run the SQLite database engine.`);
    }

    try {
      // Check cache first
      const cacheStatus = await this.checkCache();

      if (cacheStatus.valid) {
        this.progress('initializing', 80, 'Loading from cache...', true);
        const db = await this.loadFromCache();
        if (db) {
          this.progress('ready', 100, 'Database ready (cached)', true);
          this.repository = new SqlJsRepository(db);

          // Check for updates in background
          void this.checkForUpdates();

          return this.repository;
        }
      }

      // Download fresh copy
      const { db, hash } = await this.downloadDatabase();

      // Save to cache
      this.progress('initializing', 95, 'Saving to cache...');
      await this.saveToCache(db, hash);

      this.progress('ready', 100, 'Database ready');
      this.repository = new SqlJsRepository(db);
      return this.repository;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.progress('error', 0, `Failed to load database: ${message}`);
      throw error;
    }
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
        console.log('Database update available, downloading in background...');
        // Download new version
        const { db, hash } = await this.downloadDatabase();
        await this.saveToCache(db, hash);

        // Note: The old repository is still valid until reload
        console.log('Database updated, reload to use new version');
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
