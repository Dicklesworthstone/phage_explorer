import { PROGRESSIVE_LIMITS, dataArtifactUrl, sha256Bytes, type DataArtifact } from './progressive-manifest';

export const PROGRESSIVE_ASSET_CACHE = 'phage-explorer-data-v3';
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

/** Count decoded bytes while streaming: a missing or forged Content-Length is not a budget bypass. */
export async function readBoundedResponse(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Dataset request failed: HTTP ${response.status}.`);
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid response byte budget.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Dataset response has no readable body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new Error('Dataset response exceeds its declared byte budget.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Content-addressed offline storage with integrity checks, coalescing, and bounded I/O. */
export class VerifiedArtifactStore {
  private readonly controller = new AbortController();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cachePromise: Promise<ArtifactCache | undefined>;
  private readonly inFlight = new Map<string, Promise<{ data: Uint8Array; cached: boolean }>>();
  private readonly pinned = new Set<string>();
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
    this.cachePromise = (options.openCache ?? (async () => {
      if (typeof caches === 'undefined') return undefined;
      return caches.open(PROGRESSIVE_ASSET_CACHE);
    }))().then(cache => {
      if (!cache) this.unavailable(new Error('Offline artifact storage is unavailable.'));
      return cache;
    }).catch(error => { this.unavailable(error); return undefined; });
  }

  pin(item: DataArtifact): void { this.pinned.add(dataArtifactUrl(this.options.manifestUrl, item)); }
  getTransferLedger(): { networkBytes: number; cachedBytes: number; requests: number; storageAvailable: boolean } {
    return { networkBytes: this.networkBytes, cachedBytes: this.cachedBytes, requests: this.requests, storageAvailable: this.storageAvailable };
  }
  private unavailable(error: unknown): void {
    this.storageAvailable = false;
    this.options.onStorageUnavailable?.(error);
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('Dataset loader is closed.');
  }
  private async verified(response: Response, item: DataArtifact): Promise<Uint8Array> {
    const bytes = await readBoundedResponse(response, item.bytes);
    if (bytes.length !== item.bytes || await sha256Bytes(bytes) !== item.sha256) throw new Error(`Dataset integrity check failed for ${item.path}.`);
    this.assertOpen();
    return bytes;
  }

  read(item: DataArtifact): Promise<{ data: Uint8Array; cached: boolean }> {
    if (this.closed) return Promise.reject(new Error('Dataset loader is closed.'));
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 2 || item.bytes > PROGRESSIVE_LIMITS.artifactBytes) return Promise.reject(new Error('Invalid artifact size.'));
    const url = dataArtifactUrl(this.options.manifestUrl, item);
    if (!url.endsWith(`/${item.sha256}.sqlite`) && !url.endsWith(`/${item.sha256}.json`)) return Promise.reject(new Error('Artifact path and digest disagree.'));
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
    this.assertOpen();
    this.active++;
    try {
      const cache = await this.cachePromise;
      this.assertOpen();
      if (cache && !this.options.forceDownload) {
        let cached: Response | undefined;
        try { cached = await cache.match(url); } catch (error) { this.unavailable(error); }
        if (cached) {
          try {
            const data = await this.verified(cached, item);
            this.cachedBytes += data.length;
            return { data, cached: true };
          } catch {
            this.assertOpen();
            // A corrupt cache entry is never evidence; try the immutable network asset.
            try { await cache.delete(url); } catch (error) { this.unavailable(error); }
          }
        }
      }
      this.requests++;
      const response = await this.fetcher(url, { signal: this.controller.signal, cache: this.options.forceDownload ? 'reload' : 'default' });
      const data = await this.verified(response, item);
      this.networkBytes += data.length;
      if (cache) await this.save(cache, url, data);
      this.assertOpen();
      return { data, cached: false };
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
  private save(cache: ArtifactCache, url: string, bytes: Uint8Array): Promise<void> {
    this.writes = this.writes.then(async () => {
      if (this.closed) return;
      try {
        // FIFO eviction bounds persistent storage; repository residency has its own LRU.
        // The open catalog is pinned and cannot be evicted by a large analysis.
        const entries: Array<{ key: string; size: number }> = [];
        let occupied = 0;
        for (const key of await cache.keys()) {
          if (key.url === url) continue;
          const cached = await cache.match(key.url);
          if (!cached) continue;
          const size = Number(cached.headers.get('x-phage-bytes'));
          if (!Number.isSafeInteger(size) || size < 2 || size > PROGRESSIVE_LIMITS.artifactBytes) {
            if (!this.pinned.has(key.url)) await cache.delete(key.url);
            else throw new Error('Pinned offline artifact has invalid byte metadata.');
            continue;
          }
          entries.push({ key: key.url, size }); occupied += size;
        }
        if (bytes.length > this.budget) throw new Error('Artifact exceeds the offline cache budget.');
        for (const entry of entries) {
          if (occupied + bytes.length <= this.budget) break;
          if (!this.pinned.has(entry.key)) { await cache.delete(entry.key); occupied -= entry.size; }
        }
        if (occupied + bytes.length > this.budget) throw new Error('Pinned data fill the offline cache budget.');
        this.assertOpen();
        await cache.put(url, new Response(new Uint8Array(bytes).buffer, { headers: { 'x-phage-bytes': String(bytes.length), 'content-type': 'application/octet-stream' } }));
      } catch (error) { this.unavailable(error); }
    });
    return this.writes;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    for (const resume of this.waiting.splice(0)) resume();
    await this.writes;
  }
}
