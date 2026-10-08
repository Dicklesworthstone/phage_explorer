import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VerifiedArtifactStore, readBoundedResponse, type ArtifactCache, type OfflineDownloadProgress } from './progressive-artifacts';
import { dataArtifactUrl, type DataArtifact } from './progressive-manifest';

const BASE = 'https://example.test/data/phage.db.manifest.json';
const VERSION = 'a'.repeat(64);
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const asset = (text: string): DataArtifact => {
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { path: `phage-data/${sha256}.json`, sha256, bytes: Buffer.byteLength(text) };
};
class MemoryCache implements ArtifactCache {
  readonly entries = new Map<string, Response>();
  async match(key: string) { return this.entries.get(key)?.clone(); }
  async put(key: string, response: Response) { this.entries.set(key, response.clone()); }
  async delete(key: string) { return this.entries.delete(key); }
  async keys() { return [...this.entries.keys()].map(key => new Request(key)); }
}
function setup(budget = 30, cache = new MemoryCache()) {
  const requests: string[] = [];
  const bodies = ['[1]', '[2]', '[3]', '[4]'];
  const sources = new Map(bodies.map(body => [dataArtifactUrl(BASE, asset(body)), body]));
  const store = new VerifiedArtifactStore({ manifestUrl: BASE, cacheBudget: budget, openCache: async () => cache,
    fetch: async url => { requests.push(String(url)); const body = sources.get(String(url)); if (!body) throw new Error('missing fixture'); return new Response(body); } });
  return { cache, store, requests, bodies, sources };
}
async function dataBytes(cache: MemoryCache): Promise<number> {
  let bytes = 0;
  for (const [url, response] of cache.entries) if (!url.includes('__phage_offline_selection')) bytes += (await response.clone().arrayBuffer()).byteLength;
  return bytes;
}

describe('verified offline inventory', () => {
  test('distinguishes missing, corrupt, and verified without any network request', async () => {
    const { cache, store, requests } = setup();
    try {
      await cache.put(dataArtifactUrl(BASE, asset('[1]')), new Response('[1]'));
      await cache.put(dataArtifactUrl(BASE, asset('[2]')), new Response('[9]'));
      assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]'), asset('[3]')]), ['available', 'corrupt', 'missing']);
      assert.equal(requests.length, 0);
      assert.equal(await (await cache.match(dataArtifactUrl(BASE, asset('[2]'))))!.text(), '[9]');
    } finally { await store.close(); }
  });
  test('does not treat cache permissions failure as a negative availability finding', async () => {
    const store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => { throw new Error('denied'); } });
    try { assert.deepEqual(await store.inspect([asset('[1]')]), ['unavailable']); }
    finally { await store.close(); }
  });
  test('reports failure to enumerate or read storage', async () => {
    const { cache, store } = setup();
    try {
      cache.keys = async () => { throw new Error('denied'); };
      assert.deepEqual(await store.inspect([asset('[1]')]), ['unavailable']);
    } finally { await store.close(); }
  });
  test('a pending response stream is cancellable even when its producer never closes', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const result = readBoundedResponse(new Response(stream), 10, controller.signal);
    const rejected = assert.rejects(result, /cancelled/);
    controller.abort(); await rejected;
    assert.equal(cancelled, true);
  });
});

describe('resumable protected offline selections', () => {
  test('saves explicit inputs, reports byte progress, verifies persisted bytes and publishes only afterward', async () => {
    const { store, requests } = setup();
    const progress: OfflineDownloadProgress[] = []; let published = false;
    try {
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]'), asset('[2]')], {
        onProgress: value => progress.push(value),
        onVerified: async () => { assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]')]), ['available', 'available']); published = true; },
      });
      assert.equal(published, true); assert.equal(requests.length, 2);
      assert.deepEqual(progress.map(p => [p.phase, p.completedBytes, p.totalBytes]), [['downloading', 0, 6], ['downloading', 3, 6], ['verifying', 6, 6]]);
      assert.deepEqual((await store.getOfflineSelection())?.artifacts, [asset('[1]'), asset('[2]')]);
      assert.equal((await store.getOfflineSelection())?.contentVersion, VERSION);
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]);
      assert.equal(requests.length, 2, 'resume reuses verified saved data');
    } finally { await store.close(); }
  });
  test('survives store recreation and protects chosen files from ordinary eviction', async () => {
    const { store, cache } = setup(6);
    await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]); await store.close();
    const next = setup(6, cache);
    try {
      assert.equal((await next.store.getOfflineSelection())?.artifacts.length, 2);
      assert.equal(new TextDecoder().decode((await next.store.read(asset('[3]'))).data), '[3]', 'uncacheable foreground data remain usable online');
      assert.deepEqual(await next.store.inspect([asset('[1]'), asset('[2]'), asset('[3]')]), ['available', 'available', 'missing']);
      assert.equal(await dataBytes(cache), 6);
    } finally { await next.store.close(); }
  });
  test('reserves missing bytes so concurrent foreground reads cannot consume the selection budget', async () => {
    const { store, cache, sources } = setup(6);
    sources.delete(dataArtifactUrl(BASE, asset('[2]')));
    try {
      await assert.rejects(store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]), /missing fixture/);
      assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]')]), ['available', 'missing']);
      await store.read(asset('[3]'));
      assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]'), asset('[3]')]), ['available', 'missing', 'missing']);
      sources.set(dataArtifactUrl(BASE, asset('[2]')), '[2]');
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]);
      assert.equal(await dataBytes(cache), 6);
    } finally { await store.close(); }
  });
  test('over-budget replacement fails before data transfer, eviction, or selection replacement', async () => {
    const { store, cache, requests } = setup(6);
    try {
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]);
      const original = await store.getOfflineSelection();
      await assert.rejects(store.prepareOffline(VERSION, [asset('[1]'), asset('[2]'), asset('[3]')]), /budget/);
      assert.deepEqual(await store.getOfflineSelection(), original);
      assert.equal(requests.length, 2); assert.equal(await dataBytes(cache), 6);
    } finally { await store.close(); }
  });
  test('metadata quota failure preserves the previous reservation and saved files', async () => {
    const { store, cache } = setup(3);
    try {
      await store.prepareOffline(VERSION, [asset('[1]')]);
      const original = await store.getOfflineSelection(), put = cache.put.bind(cache);
      cache.put = async (key, response) => { if (key.includes('__phage_offline_selection')) throw new Error('quota'); await put(key, response); };
      await assert.rejects(store.prepareOffline(VERSION, [asset('[2]')]), /quota/);
      assert.deepEqual(await store.getOfflineSelection(), original);
      assert.deepEqual(await store.inspect([asset('[1]')]), ['available']);
    } finally { await store.close(); }
  });
  test('successful network responses with rejected storage writes are not offline success', async () => {
    const { store, cache } = setup(); let published = false;
    try {
      const put = cache.put.bind(cache);
      cache.put = async (key, response) => { if (!key.includes('__phage_offline_selection')) throw new Error('disk full'); await put(key, response); };
      await assert.rejects(store.prepareOffline(VERSION, [asset('[1]')], { onVerified: async () => { published = true; } }), /incomplete/);
      assert.equal(published, false); assert.deepEqual(await store.inspect([asset('[1]')]), ['missing']);
    } finally { await store.close(); }
  });
  test('read-back corruption is rejected even if Cache.put resolved successfully', async () => {
    const { store, cache } = setup();
    try {
      const put = cache.put.bind(cache);
      cache.put = async (key, response) => put(key, key.includes('__phage_offline_selection') ? response : new Response('[9]'));
      await assert.rejects(store.prepareOffline(VERSION, [asset('[1]')]), /incomplete/);
    } finally { await store.close(); }
  });
  test('repairs a corrupt selected file and leaves valid files untouched', async () => {
    const { store, cache, requests } = setup();
    try {
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]);
      await cache.put(dataArtifactUrl(BASE, asset('[2]')), new Response('[9]'));
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]);
      assert.deepEqual(requests, [dataArtifactUrl(BASE, asset('[1]')), dataArtifactUrl(BASE, asset('[2]')), dataArtifactUrl(BASE, asset('[2]'))]);
      assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]')]), ['available', 'available']);
    } finally { await store.close(); }
  });
  test('release removes only the reservation, not any saved data', async () => {
    const { store, cache } = setup(6);
    try {
      await store.prepareOffline(VERSION, [asset('[1]'), asset('[2]')]);
      await store.releaseOfflineSelection(); assert.equal(await store.getOfflineSelection(), null);
      assert.equal(await dataBytes(cache), 6);
      await store.read(asset('[3]'));
      assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]'), asset('[3]')]), ['missing', 'available', 'available']);
    } finally { await store.close(); }
  });
  test('a missing or unsupported Cache API fails explicitly, while foreground reads still work', async () => {
    const store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => undefined, fetch: async () => new Response('[1]') });
    try {
      await assert.rejects(store.prepareOffline(VERSION, [asset('[1]')]), /unavailable/);
      assert.equal(new TextDecoder().decode((await store.read(asset('[1]'))).data), '[1]');
    } finally { await store.close(); }
  });
  test('rejects empty, sparse, forged, and conflicting descriptors before fetching', async () => {
    const { store, requests } = setup();
    try {
      for (const items of [[], [asset('[1]'), { ...asset('[1]'), bytes: 4 }], [{ ...asset('[1]'), path: '../private' }], new Array<DataArtifact>(1)]) {
        await assert.rejects(store.prepareOffline(VERSION, items));
      }
      await assert.rejects(store.prepareOffline('wrong-version', [asset('[1]')])); assert.equal(requests.length, 0);
    } finally { await store.close(); }
  });
  test('content metadata cannot spoof another dataset reservation', async () => {
    const { store, cache } = setup();
    try {
      await store.prepareOffline(VERSION, [asset('[1]')]);
      const key = [...cache.entries.keys()].find(key => key.includes('__phage_offline_selection'))!;
      const selection = await store.getOfflineSelection();
      await cache.put(key, new Response(JSON.stringify({ ...selection, manifestUrl: 'https://other.test/dataset.json' })));
      await assert.rejects(store.getOfflineSelection(), /Invalid saved/);
      await store.releaseOfflineSelection(); assert.equal(await store.getOfflineSelection(), null);
    } finally { await store.close(); }
  });
});

describe('offline job isolation and shared capacity', () => {
  test('cancellation stops the batch, preserves completed data, and does not abort foreground reads', async () => {
    const cache = new MemoryCache(), controller = new AbortController();
    const requested: string[] = [];
    const store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => cache, fetch: async (url, init) => {
      requested.push(String(url));
      if (String(url) === dataArtifactUrl(BASE, asset('[2]'))) return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('job aborted')), { once: true });
      });
      return new Response(String(url) === dataArtifactUrl(BASE, asset('[1]')) ? '[1]' : '[3]');
    } });
    try {
      const pending = store.prepareOffline(VERSION, [asset('[1]'), asset('[2]'), asset('[4]')], { signal: controller.signal });
      const rejected = assert.rejects(pending, /cancelled|aborted/);
      while (requested.length < 2) await tick();
      controller.abort(); await rejected;
      assert.deepEqual(await store.inspect([asset('[1]'), asset('[2]')]), ['available', 'missing']);
      assert.equal(new TextDecoder().decode((await store.read(asset('[3]'))).data), '[3]');
      assert.ok(!requested.includes(dataArtifactUrl(BASE, asset('[4]'))));
    } finally { await store.close(); }
  });
  test('late transport completion after cancellation cannot publish a completed offline selection', async () => {
    const cache = new MemoryCache(), controller = new AbortController();
    let release!: (response: Response) => void, published = false;
    const store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => cache,
      fetch: () => new Promise<Response>(resolve => { release = resolve; }) });
    try {
      const pending = store.prepareOffline(VERSION, [asset('[1]')], { signal: controller.signal, onVerified: async () => { published = true; } });
      const rejected = assert.rejects(pending, /cancelled/);
      while (!release) await tick(); controller.abort(); await rejected;
      release(new Response('[1]')); await tick();
      assert.equal(published, false); assert.deepEqual(await store.inspect([asset('[1]')]), ['missing']);
    } finally { await store.close(); }
  });
  test('a replaced selection prevents a superseded download from publishing success', async () => {
    const cache = new MemoryCache(); let release!: (response: Response) => void, published = false;
    const slow = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => cache,
      fetch: () => new Promise<Response>(resolve => { release = resolve; }) });
    const next = setup(30, cache);
    try {
      const pending = slow.prepareOffline(VERSION, [asset('[1]')], { onVerified: async () => { published = true; } });
      const rejected = assert.rejects(pending, /changed/);
      while (!release) await tick(); await next.store.prepareOffline(VERSION, [asset('[2]')]);
      release(new Response('[1]')); await rejected;
      assert.equal(published, false); assert.deepEqual((await next.store.getOfflineSelection())!.artifacts, [asset('[2]')]);
    } finally { await slow.close(); await next.store.close(); }
  });
  test('different datasets share one byte budget and cannot race reservations beyond it', async () => {
    const cache = new MemoryCache();
    const make = (name: string, body: string) => new VerifiedArtifactStore({ manifestUrl: `https://example.test/${name}/manifest.json`, cacheBudget: 3,
      openCache: async () => cache, fetch: async () => new Response(body) });
    const first = make('one', '[1]'), second = make('two', '[2]');
    try {
      const result = await Promise.allSettled([first.prepareOffline(VERSION, [asset('[1]')]), second.prepareOffline(VERSION, [asset('[2]')])]);
      assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(await dataBytes(cache), 3);
      assert.equal(cache.entries.size, 2, 'one selection record and one data file');
    } finally { await first.close(); await second.close(); }
  });
  test('closing the owner cancels an active batch', async () => {
    const cache = new MemoryCache(); let requested = false;
    const store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => cache,
      fetch: async () => { requested = true; return new Promise<Response>(() => {}); } });
    const pending = store.prepareOffline(VERSION, [asset('[1]')]);
    const rejected = assert.rejects(pending, /cancelled/);
    while (!requested) await tick(); await store.close(); await rejected;
  });
});
