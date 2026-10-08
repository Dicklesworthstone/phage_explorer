import { PROGRESSIVE_LIMITS, dataArtifactUrl, sha256Bytes, type DataArtifact } from './progressive-manifest';

export const PROGRESSIVE_ASSET_CACHE = 'phage-explorer-data-v3';
const OFFLINE_MARKER = '__phage_offline_selection';
export interface ArtifactCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
}
export interface ArtifactStoreOptions {
  manifestUrl: string;
  fetch?: typeof globalThis.fetch;
  openCache?: () => Promise<ArtifactCache | undefined>;
  onStorageUnavailable?: (error: unknown) => void;
  forceDownload?: boolean;
  cacheBudget?: number;
}
export type ArtifactAvailability = 'available' | 'missing' | 'corrupt' | 'unavailable';
export interface OfflineArtifactSelection {
  version: 1;
  id: string;
  manifestUrl: string;
  contentVersion: string;
  artifacts: DataArtifact[];
}
export interface OfflineDownloadProgress {
  phase: 'downloading' | 'verifying';
  completed: number;
  total: number;
  completedBytes: number;
  totalBytes: number;
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Dataset operation cancelled.', 'AbortError');
}
function wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Dataset operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

// Shared by every store instance. Web Locks also serializes tabs/workers of the
// origin; the fallback is only realm-local, not a cross-tab durability claim.
let localWrites: Promise<unknown> = Promise.resolve();
export function withArtifactCacheLock<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(PROGRESSIVE_ASSET_CACHE, operation);
  }
  const next = localWrites.then(operation);
  localWrites = next.catch(() => {});
  return next;
}
function selectionKey(manifestUrl: string): string {
  const url = new URL(manifestUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid dataset URL.');
  url.hash = '';
  url.searchParams.set(OFFLINE_MARKER, '1');
  return url.href;
}
function isSelectionKey(key: string): boolean { return new URL(key).searchParams.get(OFFLINE_MARKER) === '1'; }
function descriptor(manifestUrl: string, value: DataArtifact): DataArtifact {
  if (!value || !Number.isSafeInteger(value.bytes) || value.bytes < 2 || value.bytes > PROGRESSIVE_LIMITS.artifactBytes) throw new Error('Invalid artifact size.');
  const url = dataArtifactUrl(manifestUrl, value);
  if (!/^[a-f0-9]{64}$/.test(value.sha256) || (!url.endsWith(`/${value.sha256}.sqlite`) && !url.endsWith(`/${value.sha256}.json`))) throw new Error('Artifact path and digest disagree.');
  return { path: value.path, sha256: value.sha256, bytes: value.bytes };
}
function uniqueArtifacts(manifestUrl: string, items: readonly DataArtifact[]): DataArtifact[] {
  if (!Array.isArray(items) || items.length > PROGRESSIVE_LIMITS.genomes + 10_001) throw new Error('Too many offline artifacts.');
  const byPath = new Map<string, DataArtifact>();
  for (const value of items) {
    const item = descriptor(manifestUrl, value), old = byPath.get(item.path);
    if (old && old.bytes !== item.bytes) throw new Error('Conflicting artifact descriptors.');
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}
async function parseSelection(response: Response, key: string): Promise<OfflineArtifactSelection> {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedResponse(response, PROGRESSIVE_LIMITS.manifestBytes)));
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
    || typeof value.manifestUrl !== 'string' || selectionKey(value.manifestUrl) !== key
    || typeof value.contentVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentVersion)) throw new Error('Invalid saved offline selection. Release it before preparing a replacement.');
  return { version: 1, id: value.id, manifestUrl: value.manifestUrl, contentVersion: value.contentVersion,
    artifacts: uniqueArtifacts(value.manifestUrl, value.artifacts) };
}

/** Count decoded bytes while streaming: a missing or forged Content-Length is not a budget bypass. */
export async function readBoundedResponse(response: Response, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Dataset request failed: HTTP ${response.status}.`);
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid response byte budget.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Dataset response has no readable body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      cancelled(signal);
      const { done, value } = await wait(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error('Dataset response exceeds its declared byte budget.');
      chunks.push(value);
    }
  } catch (error) {
    // Do not await a transport's possibly stalled cancellation promise.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Verified on-demand data plus explicitly reserved, resumable offline selections. */
export class VerifiedArtifactStore {
  private readonly controller = new AbortController();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cachePromise: Promise<ArtifactCache | undefined>;
  private readonly inFlight = new Map<string, Promise<{ data: Uint8Array; cached: boolean }>>();
  private readonly pinned = new Map<string, DataArtifact>();
  private readonly waiting: Array<() => void> = [];
  private active = 0;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  private storageAvailable = true;
  private networkBytes = 0;
  private cachedBytes = 0;
  private requests = 0;
  private readonly budget: number;

  constructor(private readonly options: ArtifactStoreOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.budget = options.cacheBudget ?? PROGRESSIVE_LIMITS.cacheBytes;
    if (!Number.isSafeInteger(this.budget) || this.budget < 0) throw new Error('Invalid artifact cache budget.');
    this.cachePromise = Promise.resolve().then(options.openCache ?? (async () => {
      if (typeof caches === 'undefined') return undefined;
      return caches.open(PROGRESSIVE_ASSET_CACHE);
    })).then(cache => {
      if (!cache) this.unavailable(new Error('Offline artifact storage is unavailable.'));
      return cache;
    }).catch(error => { this.unavailable(error); return undefined; });
  }

  pin(item: DataArtifact): void { this.pinned.set(dataArtifactUrl(this.options.manifestUrl, item), descriptor(this.options.manifestUrl, item)); }
  unpin(item: DataArtifact): void { this.pinned.delete(dataArtifactUrl(this.options.manifestUrl, item)); }
  getCacheBudget(): number { return this.budget; }
  getTransferLedger(): { networkBytes: number; cachedBytes: number; requests: number; storageAvailable: boolean } {
    return { networkBytes: this.networkBytes, cachedBytes: this.cachedBytes, requests: this.requests, storageAvailable: this.storageAvailable };
  }
  private unavailable(error: unknown): void {
    this.storageAvailable = false;
    this.options.onStorageUnavailable?.(error);
  }
  private assertOpen(): void { if (this.closed) throw new Error('Dataset loader is closed.'); }
  private async verified(response: Response, item: DataArtifact, signal = this.controller.signal): Promise<Uint8Array> {
    const bytes = await readBoundedResponse(response, item.bytes, signal);
    if (bytes.length !== item.bytes || await wait(sha256Bytes(bytes), signal) !== item.sha256) throw new Error(`Dataset integrity check failed for ${item.path}.`);
    this.assertOpen(); cancelled(signal);
    return bytes;
  }
  private async requireCache(): Promise<ArtifactCache> {
    const cache = await wait(this.cachePromise, this.controller.signal);
    this.assertOpen();
    if (!cache) throw new Error('Offline artifact storage is unavailable.');
    return cache;
  }

  /** No network, no repair, no eviction: availability means bytes were read and hashed now. */
  async inspect(items: readonly DataArtifact[], signal?: AbortSignal): Promise<ArtifactAvailability[]> {
    this.assertOpen();
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const checked = Array.from(items, item => descriptor(this.options.manifestUrl, item));
    cancelled(combined);
    const cache = await wait(this.cachePromise, combined);
    if (!cache) return checked.map(() => 'unavailable');
    let keys: Set<string>;
    try { keys = new Set((await wait(cache.keys(), combined)).map(key => key.url)); }
    catch (error) { cancelled(combined); this.unavailable(error); return checked.map(() => 'unavailable'); }
    const result: ArtifactAvailability[] = [];
    for (const item of checked) {
      cancelled(combined);
      const url = dataArtifactUrl(this.options.manifestUrl, item);
      if (!keys.has(url)) { result.push('missing'); continue; }
      let response: Response | undefined;
      try { response = await wait(cache.match(url), combined); }
      catch (error) { cancelled(combined); this.unavailable(error); result.push('unavailable'); continue; }
      if (!response) { result.push('missing'); continue; }
      try { await this.verified(response, item, combined); result.push('available'); }
      catch { cancelled(combined); result.push('corrupt'); }
    }
    return result;
  }
  async getOfflineSelection(): Promise<OfflineArtifactSelection | null> {
    const cache = await this.requireCache(), key = selectionKey(this.options.manifestUrl);
    const response = await cache.match(key);
    return response ? parseSelection(response, key) : null;
  }
  async releaseOfflineSelection(): Promise<void> {
    await withArtifactCacheLock(async () => {
      const cache = await this.requireCache();
      await cache.delete(selectionKey(this.options.manifestUrl));
    });
  }
  /** Under the shared cache lock: missing protected bytes still reserve budget. */
  private async protections(cache: ArtifactCache, replacement?: OfflineArtifactSelection): Promise<Map<string, DataArtifact>> {
    const protectedItems = new Map(this.pinned);
    const add = (base: string, items: DataArtifact[]) => {
      for (const item of items) {
        const url = dataArtifactUrl(base, item), previous = protectedItems.get(url);
        if (previous && previous.bytes !== item.bytes) throw new Error('Conflicting offline reservations.');
        protectedItems.set(url, item);
      }
    };
    for (const key of await cache.keys()) {
      if (!isSelectionKey(key.url) || (replacement && key.url === selectionKey(replacement.manifestUrl))) continue;
      const response = await cache.match(key.url);
      if (response) { const selection = await parseSelection(response, key.url); add(selection.manifestUrl, selection.artifacts); }
    }
    if (replacement) add(replacement.manifestUrl, replacement.artifacts);
    return protectedItems;
  }
  private async makeRoom(cache: ArtifactCache, protectedItems: Map<string, DataArtifact>, incoming?: { url: string; bytes: number }): Promise<void> {
    let occupied = [...protectedItems.values()].reduce((sum, item) => sum + item.bytes, 0);
    if (incoming && !protectedItems.has(incoming.url)) occupied += incoming.bytes;
    if (occupied > this.budget) throw new Error('Offline selection and protected catalogs exceed the cache byte budget. Choose fewer genomes or release an older selection.');
    const evictable: Array<{ url: string; size: number }> = [];
    for (const key of await cache.keys()) {
      if (isSelectionKey(key.url) || protectedItems.has(key.url) || key.url === incoming?.url) continue;
      const response = await cache.match(key.url);
      if (!response) continue;
      const size = Number(response.headers.get('x-phage-bytes'));
      if (!Number.isSafeInteger(size) || size < 2 || size > PROGRESSIVE_LIMITS.artifactBytes) { await cache.delete(key.url); continue; }
      evictable.push({ url: key.url, size }); occupied += size;
    }
    for (const item of evictable) {
      if (occupied <= this.budget) break;
      await cache.delete(item.url); occupied -= item.size;
    }
  }

  /** Reserve before downloading. An interrupted selection remains resumable, not falsely complete. */
  async prepareOffline(contentVersion: string, items: readonly DataArtifact[], options: {
    signal?: AbortSignal;
    onProgress?: (progress: OfflineDownloadProgress) => void;
    /** Runs under the same lock after verification; e.g. publish the catalog manifest pointer. */
    onVerified?: () => Promise<void>;
  } = {}): Promise<void> {
    const artifacts = uniqueArtifacts(this.options.manifestUrl, items);
    if (!artifacts.length || !/^[a-f0-9]{64}$/.test(contentVersion)) throw new Error('A content-bound nonempty offline selection is required.');
    const signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal;
    const selection: OfflineArtifactSelection = { version: 1, id: crypto.randomUUID(), manifestUrl: this.options.manifestUrl, contentVersion, artifacts };
    const text = JSON.stringify(selection), key = selectionKey(this.options.manifestUrl);
    if (new TextEncoder().encode(text).length > PROGRESSIVE_LIMITS.manifestBytes) throw new Error('Offline selection metadata exceeds its byte budget.');
    await withArtifactCacheLock(async () => {
      cancelled(signal);
      const cache = await this.requireCache();
      const protectedItems = await this.protections(cache, selection);
      cancelled(signal);
      if ([...protectedItems.values()].reduce((sum, item) => sum + item.bytes, 0) > this.budget) {
        throw new Error('Offline selection and protected catalogs exceed the cache byte budget. Choose fewer genomes or release an older selection.');
      }
      // A failed metadata write must not evict the previous saved selection.
      await cache.put(key, new Response(text, { headers: { 'content-type': 'application/json' } }));
      await this.makeRoom(cache, protectedItems);
    });
    const job = new VerifiedArtifactStore({ ...this.options, forceDownload: false, openCache: () => this.cachePromise });
    // A download cancellation never aborts unrelated foreground repository reads.
    const stop = () => { void job.close(); };
    signal.addEventListener('abort', stop, { once: true });
    const totalBytes = artifacts.reduce((sum, item) => sum + item.bytes, 0);
    let completedBytes = 0;
    const current = async () => {
      cancelled(signal);
      if ((await this.getOfflineSelection())?.id !== selection.id) throw new Error('Offline selection changed in another operation. Recheck the saved selection.');
      cancelled(signal);
    };
    try {
      for (let i = 0; i < artifacts.length; i++) {
        await current();
        options.onProgress?.({ phase: 'downloading', completed: i, total: artifacts.length, completedBytes, totalBytes });
        await wait(job.read(artifacts[i]), signal);
        completedBytes += artifacts[i].bytes;
      }
      options.onProgress?.({ phase: 'verifying', completed: artifacts.length, total: artifacts.length, completedBytes, totalBytes });
      await withArtifactCacheLock(async () => {
        await current();
        if ((await job.inspect(artifacts, signal)).some(status => status !== 'available')) throw new Error('Offline download is incomplete: some files were not saved or failed verification. Retry to resume.');
        await options.onVerified?.();
        cancelled(signal);
      });
    } finally { signal.removeEventListener('abort', stop); await job.close(); }
  }

  read(item: DataArtifact): Promise<{ data: Uint8Array; cached: boolean }> {
    if (this.closed) return Promise.reject(new Error('Dataset loader is closed.'));
    try { item = descriptor(this.options.manifestUrl, item); }
    catch (error) { return Promise.reject(error); }
    const url = dataArtifactUrl(this.options.manifestUrl, item);
    const existing = this.inFlight.get(url);
    if (existing) return existing;
    const promise = this.readOnce(url, item).finally(() => { this.inFlight.delete(url); });
    this.inFlight.set(url, promise);
    return promise;
  }
  private async readOnce(url: string, item: DataArtifact): Promise<{ data: Uint8Array; cached: boolean }> {
    while (this.active >= PROGRESSIVE_LIMITS.concurrentLoads) {
      await new Promise<void>(resolve => this.waiting.push(resolve));
      this.assertOpen();
    }
    this.assertOpen(); this.active++;
    try {
      const cache = await wait(this.cachePromise, this.controller.signal);
      this.assertOpen();
      if (cache && !this.options.forceDownload) {
        let cached: Response | undefined;
        try { cached = await wait(cache.match(url), this.controller.signal); } catch (error) { this.assertOpen(); this.unavailable(error); }
        if (cached) {
          try {
            const data = await this.verified(cached, item);
            this.cachedBytes += data.length;
            return { data, cached: true };
          } catch { this.assertOpen(); /* A corrupt entry will be replaced only by verified bytes. */ }
        }
      }
      this.requests++;
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(60_000)]);
      const response = await wait(this.fetcher(url, { signal, cache: this.options.forceDownload ? 'reload' : 'default' }), signal);
      const data = await this.verified(response, item, signal);
      this.networkBytes += data.length;
      if (cache) await this.save(cache, url, data);
      this.assertOpen();
      return { data, cached: false };
    } finally { this.active--; this.waiting.shift()?.(); }
  }
  private save(cache: ArtifactCache, url: string, bytes: Uint8Array): Promise<void> {
    this.writes = this.writes.then(() => withArtifactCacheLock(async () => {
      if (this.closed) return;
      try {
        await this.makeRoom(cache, await this.protections(cache), { url, bytes: bytes.length });
        this.assertOpen();
        await cache.put(url, new Response(new Uint8Array(bytes).buffer, { headers: { 'x-phage-bytes': String(bytes.length), 'content-type': 'application/octet-stream' } }));
      } catch (error) { this.unavailable(error); }
    }));
    return this.writes;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    for (const resume of this.waiting.splice(0)) resume();
    await this.writes;
  }
}
