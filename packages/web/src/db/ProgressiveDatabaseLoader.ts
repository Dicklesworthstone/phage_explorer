/** Auto-select the published layout; version 3 never falls back to a monolithic download. */
import type { DatabaseLoaderConfig, DatabaseLoadProgress, PhageRepository } from './types';
import { ProgressivePhageRepository } from './ProgressivePhageRepository';
import { VerifiedArtifactStore, readBoundedResponse, withArtifactCacheLock, type ArtifactCache } from './progressive-artifacts';
import { PROGRESSIVE_LIMITS, parseProgressiveManifest, verifyProgressiveManifest, type ProgressiveManifest } from './progressive-manifest';

export const PROGRESSIVE_MANIFEST_CACHE = 'phage-explorer-manifests-v3';
export interface RepositoryLoader {
  load(options?: { forceDownload?: boolean }): Promise<PhageRepository>;
  close(): Promise<void>;
}
export interface ProgressiveLoaderDependencies {
  fetch?: typeof globalThis.fetch;
  openManifestCache?: () => Promise<Pick<ArtifactCache, 'match' | 'put'> | undefined>;
  openArtifactCache?: () => Promise<ArtifactCache | undefined>;
  sqlite?: () => Promise<(bytes: Uint8Array) => PhageRepository>;
  legacy?: (config: DatabaseLoaderConfig) => Promise<RepositoryLoader>;
  acceptVersion?: (version: string) => void | Promise<void>;
  manifestTimeoutMs?: number;
}
interface CachedManifest { manifest: ProgressiveManifest; etag: string | null }
let sqliteReady: Promise<(bytes: Uint8Array) => PhageRepository> | null = null;
async function openSqlite(): Promise<(bytes: Uint8Array) => PhageRepository> {
  if (!sqliteReady) {
    sqliteReady = Promise.all([import('sql.js'), import('./SqlJsRepository')]).then(async ([module, { SqlJsRepository }]) => {
      // Vite resolves sql.js to the existing bundled-WASM runtime. No new CDN is introduced.
      const SQL = await module.default();
      return (bytes: Uint8Array) => {
        const db = new SQL.Database(bytes);
        try { return new SqlJsRepository(db); }
        catch (error) { db.close(); throw error; }
      };
    }).catch(error => { sqliteReady = null; throw error; });
  }
  return sqliteReady;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new DOMException('Dataset load cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
function manifestAddress(config: DatabaseLoaderConfig): string {
  const base = typeof location === 'undefined' ? undefined : location.href;
  const url = new URL(config.manifestUrl ?? config.databaseUrl, base);
  if (!config.manifestUrl) url.pathname += '.manifest.json';
  url.hash = '';
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Dataset manifest must use credential-free HTTP(S).');
  return url.href;
}

/** A load owns one immutable dataset version until close; reload uses a new loader. */
export class ProgressiveDatabaseLoader implements RepositoryLoader {
  private readonly lifetime = new AbortController();
  private readonly manifestUrl: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeout: number;
  private repository: PhageRepository | null = null;
  private legacy: RepositoryLoader | null = null;
  private store: VerifiedArtifactStore | null = null;
  private loading: Promise<PhageRepository> | null = null;
  private closing: Promise<void> | null = null;
  private forced = false;

  constructor(private readonly config: DatabaseLoaderConfig, private readonly dependencies: ProgressiveLoaderDependencies = {}) {
    this.manifestUrl = manifestAddress(config);
    this.fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeout = dependencies.manifestTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000) throw new Error('Invalid dataset manifest timeout.');
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new DOMException('Dataset load cancelled.', 'AbortError');
  }
  private report(progress: DatabaseLoadProgress): void {
    if (!this.lifetime.signal.aborted) this.config.onProgress?.(progress);
  }
  private async cached(cache: Pick<ArtifactCache, 'match' | 'put'> | undefined): Promise<CachedManifest | null> {
    if (!cache) return null;
    try {
      const response = await abortable(cache.match(this.manifestUrl), this.lifetime.signal);
      if (!response) return null;
      const bytes = await abortable(readBoundedResponse(response, PROGRESSIVE_LIMITS.manifestBytes), this.lifetime.signal);
      const manifest = parseProgressiveManifest(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      await abortable(verifyProgressiveManifest(manifest), this.lifetime.signal);
      return { manifest, etag: response.headers.get('etag') };
    } catch { this.assertOpen(); return null; }
  }
  private async legacyLoad(forceDownload: boolean): Promise<PhageRepository> {
    this.assertOpen();
    const create = this.dependencies.legacy ?? (async (config: DatabaseLoaderConfig) => {
      const { DatabaseLoader } = await import('./DatabaseLoader');
      return new DatabaseLoader(config);
    });
    const constructing = create({ ...this.config, onProgress: progress => this.report(progress) });
    void constructing.then(legacy => {
      if (this.lifetime.signal.aborted) void legacy.close().catch(() => {});
    }, () => {});
    const legacy = await abortable(constructing, this.lifetime.signal);
    this.assertOpen();
    this.legacy = legacy;
    // Always observe the actual completion, even if cancellation won the caller's race.
    const pending = legacy.load({ forceDownload });
    void pending.then(repository => {
      if (this.lifetime.signal.aborted) void repository.close().catch(() => {});
    }, () => {});
    const repository = await abortable(pending, this.lifetime.signal);
    this.assertOpen();
    this.repository = repository;
    return repository;
  }

  load(options: { forceDownload?: boolean } = {}): Promise<PhageRepository> {
    if (this.lifetime.signal.aborted) return Promise.reject(new DOMException('Dataset load cancelled.', 'AbortError'));
    if (this.repository) return Promise.resolve(this.repository);
    if (this.loading) {
      if (!!options.forceDownload !== this.forced) return Promise.reject(new Error('Create a new loader to change refresh mode during a load.'));
      return this.loading;
    }
    this.forced = !!options.forceDownload;
    this.loading = this.loadOnce(this.forced).catch(async error => {
      await Promise.allSettled([...(this.store ? [this.store.close()] : []), ...(this.legacy ? [this.legacy.close()] : [])]);
      this.store = null; this.legacy = null;
      this.report({ stage: 'error', percent: 0, message: error instanceof Error ? error.message : 'Dataset load failed.' });
      throw error;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  private async loadOnce(forceDownload: boolean): Promise<PhageRepository> {
    this.report({ stage: 'checking', percent: 0, message: 'Checking the published dataset layout...', cached: false });
    let cache: Pick<ArtifactCache, 'match' | 'put'> | undefined;
    try {
      cache = await abortable((this.dependencies.openManifestCache ?? (async () =>
        typeof caches === 'undefined' ? undefined : caches.open(PROGRESSIVE_MANIFEST_CACHE)))(), this.lifetime.signal);
    } catch { this.assertOpen(); }
    // Even forced refreshes protect the previous catalog while preparing a replacement.
    const cached = await this.cached(cache);
    const request = new AbortController();
    const cancel = () => request.abort();
    this.lifetime.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, this.timeout);
    let manifest: ProgressiveManifest | null = null;
    let etag: string | null = null;
    let fromCache = false;
    try {
      this.assertOpen();
      let response: Response | undefined;
      try {
        response = await abortable(this.fetcher(this.manifestUrl, {
          signal: request.signal, cache: forceDownload ? 'reload' : 'no-cache',
          headers: !forceDownload && cached?.etag ? { 'If-None-Match': cached.etag } : {},
        }), request.signal);
      } catch {
        this.assertOpen();
        if (forceDownload) throw new Error('A forced dataset refresh requires a successful manifest download.');
      }
      if (response?.status === 304 && cached && !forceDownload) {
        manifest = cached.manifest; etag = cached.etag; fromCache = true;
      } else if (!response?.ok) {
        if (forceDownload) throw new Error(`Dataset manifest download failed${response ? ` (HTTP ${response.status})` : ''}.`);
        if (cached) { manifest = cached.manifest; etag = cached.etag; fromCache = true; }
        // No known v3 snapshot: let the existing v2 loader use its verified offline cache.
      } else {
        const bytes = await abortable(readBoundedResponse(response, PROGRESSIVE_LIMITS.manifestBytes), request.signal);
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dataset manifest.');
        if ('version' in value && value.version === 2) return await this.legacyLoad(forceDownload);
        // An invalid/unsupported v3 deployment is an error, never a request for the old whole DB.
        manifest = parseProgressiveManifest(value);
        await abortable(verifyProgressiveManifest(manifest), this.lifetime.signal);
        etag = response.headers.get('etag');
      }
    } finally {
      clearTimeout(timer); this.lifetime.signal.removeEventListener('abort', cancel);
    }
    this.assertOpen();
    if (!manifest) return this.legacyLoad(forceDownload);
    this.report({ stage: 'initializing', percent: 30, message: 'Opening the catalog. Genome data will load on demand.', cached: fromCache });
    const openRepository = await abortable((this.dependencies.sqlite ?? openSqlite)(), this.lifetime.signal);
    this.assertOpen();
    const store = new VerifiedArtifactStore({ manifestUrl: this.manifestUrl, fetch: this.fetcher,
      openCache: this.dependencies.openArtifactCache, forceDownload,
      onStorageUnavailable: () => {
        if (this.repository && !this.legacy) this.report({ stage: 'ready', percent: 100, cacheStatus: 'unavailable',
          message: 'Dataset remains usable, but newly requested data could not be saved for offline use.' });
      },
    });
    if (cached) store.pin(cached.manifest.catalog);
    this.store = store;
    const selectedManifest = manifest;
    const manifestResponse = () => {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (etag) headers.set('etag', etag);
      return new Response(JSON.stringify(selectedManifest), { headers });
    };
    const offlineManifest = {
      available: async () => (await this.cached(cache))?.manifest.contentVersion === selectedManifest.contentVersion,
      // The store calls this under withArtifactCacheLock, after checking all files.
      publish: async () => {
        this.assertOpen();
        if (!cache) throw new Error('Offline startup manifest storage is unavailable.');
        const previous = await this.cached(cache);
        if (previous && previous.manifest.contentVersion !== selectedManifest.contentVersion) {
          throw new Error('Another dataset version is saved for startup. Reload this tab before preparing an offline selection.');
        }
        this.assertOpen();
        await abortable(cache.put(this.manifestUrl, manifestResponse()), this.lifetime.signal);
        if (!(await offlineManifest.available())) throw new Error('Offline startup manifest could not be verified after saving.');
      },
    };
    const repository = await ProgressivePhageRepository.open({ manifest, store, openRepository, offlineManifest, signal: this.lifetime.signal });
    try {
      this.assertOpen();
      // Artifact persistence precedes the manifest pointer: a failed catalog never replaces the old snapshot.
      let persisted = false;
      if (cache && store.getTransferLedger().storageAvailable) {
        try {
          await withArtifactCacheLock(async () => {
            this.assertOpen();
            await abortable(cache!.put(this.manifestUrl, manifestResponse()), this.lifetime.signal);
            persisted = await offlineManifest.available();
          });
        } catch { /* Verified in-memory data remain usable; offline availability is reported separately. */ }
      }
      this.assertOpen();
      if (forceDownload && !persisted) throw new Error('The refreshed catalog could not be saved for offline use; the previous manifest was preserved.');
      if (this.dependencies.acceptVersion) {
        await abortable(Promise.resolve(this.dependencies.acceptVersion(manifest.contentVersion)), this.lifetime.signal);
      } else {
        const { setDatabaseCacheVersion } = await abortable(import('../api/cache'), this.lifetime.signal);
        this.assertOpen(); setDatabaseCacheVersion(manifest.contentVersion);
      }
      this.assertOpen();
      this.repository = repository;
      if (persisted && cached && cached.manifest.catalog.path !== manifest.catalog.path) store.unpin(cached.manifest.catalog);
      this.report({ stage: 'ready', percent: 100,
        message: persisted ? 'Catalog ready. Only previously fetched genomes and projections are available offline.' : 'Catalog ready. Offline storage is unavailable.',
        cached: store.getTransferLedger().networkBytes === 0, cacheStatus: persisted ? 'saved' : 'unavailable' });
      return repository;
    } catch (error) { await repository.close(); throw error; }
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.lifetime.abort();
      this.closing = Promise.allSettled([
        ...(this.repository && !this.legacy ? [this.repository.close()] : []),
        ...(this.legacy ? [this.legacy.close()] : []),
        ...(this.store ? [this.store.close()] : []),
      ]).then(() => {});
    }
    return this.closing;
  }
}

export function createProgressiveDatabaseLoader(databaseUrl: string, onProgress?: (progress: DatabaseLoadProgress) => void): ProgressiveDatabaseLoader {
  return new ProgressiveDatabaseLoader({ databaseUrl, onProgress });
}