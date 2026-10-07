import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PROGRESSIVE_LIMITS, dataArtifactUrl, datasetByteLedger, parseProgressiveManifest,
  progressiveIdentity, verifyProgressiveManifest, type DataArtifact, type ProgressiveManifest,
} from './progressive-manifest';
import { readBoundedResponse, VerifiedArtifactStore, type ArtifactCache } from './progressive-artifacts';

const base = 'https://example.test/research/phage.db.manifest.json';
function asset(text: string, extension = 'json'): DataArtifact {
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { path: `phage-data/${sha256}.${extension}`, sha256, bytes: Buffer.byteLength(text) };
}
function manifest(): ProgressiveManifest {
  const catalog = asset('c'.repeat(512), 'sqlite');
  const genome = asset('g'.repeat(512), 'sqlite');
  const data: ProgressiveManifest = {
    version: 3, layout: 'per-phage-sqlite-v1', contentVersion: '', generatedAt: '2026-01-01T00:00:00Z',
    catalog, genomes: [{ id: 1, genomeLength: 100, artifact: genome }], atlas: [],
    bytes: { catalog: 0, artifacts: 0, largestArtifact: 0, artifactCount: 0 },
  };
  data.bytes = datasetByteLedger(data);
  data.contentVersion = createHash('sha256').update(progressiveIdentity(data)).digest('hex');
  return data;
}
class MemoryCache implements ArtifactCache {
  entries = new Map<string, Response>();
  async match(key: string): Promise<Response | undefined> { return this.entries.get(key)?.clone(); }
  async put(key: string, value: Response): Promise<void> { this.entries.set(key, value.clone()); }
  async delete(key: string): Promise<boolean> { return this.entries.delete(key); }
  async keys(): Promise<Request[]> { return [...this.entries.keys()].map(key => new Request(key)); }
}
const noNetwork: typeof fetch = async () => { throw new Error('offline'); };

describe('progressive dataset contract', () => {
  test('round trips a versioned index and verifies its full content identity', async () => {
    const data = manifest();
    assert.deepEqual(parseProgressiveManifest(JSON.stringify(data)), data);
    await verifyProgressiveManifest(data);
    data.genomes[0].genomeLength++;
    await assert.rejects(verifyProgressiveManifest(data), /identity/);
  });
  test('deduplicates artifact bytes without omitting ownership from the identity', () => {
    const data = manifest();
    data.genomes.push({ ...data.genomes[0], id: 2 });
    assert.equal(datasetByteLedger(data).artifactCount, 2);
    assert.equal(datasetByteLedger(data).artifacts, 1024);
  });
  test('rejects a forged byte ledger', () => {
    const data = manifest(); data.bytes.artifacts++;
    assert.throws(() => parseProgressiveManifest(data), /ledger/);
  });
  test('rejects missing, duplicate, reversed, and noninteger genome identifiers', () => {
    for (const genomes of [[], [{ ...manifest().genomes[0], id: 1.2 }], [manifest().genomes[0], manifest().genomes[0]], [{ ...manifest().genomes[0], id: 2 }, manifest().genomes[0]]]) {
      assert.throws(() => parseProgressiveManifest({ ...manifest(), genomes }));
    }
  });
  test('rejects traversal, external URLs, and checksum/path disagreements', () => {
    for (const path of ['../phage.db', 'https://other.test/data.sqlite', '/phage.db', 'phage-data/not-a-hash.sqlite', `phage-data/${'f'.repeat(64)}.sqlite`]) {
      const data = manifest(); data.catalog.path = path;
      assert.throws(() => parseProgressiveManifest(data), /checksum-addressed/);
    }
  });
  test('rejects oversized catalogs, artifacts, and manifests', () => {
    const data = manifest(); data.catalog.bytes = PROGRESSIVE_LIMITS.catalogBytes + 1;
    assert.throws(() => parseProgressiveManifest(data), /byte count/);
    data.catalog.bytes = 512; data.genomes[0].artifact.bytes = PROGRESSIVE_LIMITS.artifactBytes + 1;
    assert.throws(() => parseProgressiveManifest(data), /byte count/);
    assert.throws(() => parseProgressiveManifest(' '.repeat(PROGRESSIVE_LIMITS.manifestBytes + 1)), /byte budget/);
  });
  test('resolves beside the manifest without inheriting cache-busting queries', () => {
    const item = manifest().catalog;
    assert.equal(dataArtifactUrl(base + '?v=123', item), `https://example.test/research/${item.path}`);
    assert.throws(() => dataArtifactUrl('https://user:pass@example.test/manifest.json', item), /credentials/);
    assert.throws(() => dataArtifactUrl('file:///tmp/manifest.json', item), /HTTP/);
  });
  test('counts response bytes rather than trusting a false Content-Length', async () => {
    await assert.rejects(readBoundedResponse(new Response('too much data', { headers: { 'content-length': '1' } }), 4), /budget/);
    assert.deepEqual(await readBoundedResponse(new Response('data'), 4), new TextEncoder().encode('data'));
    await assert.rejects(readBoundedResponse(new Response('missing', { status: 404 }), 100), /HTTP 404/);
  });
});

describe('verified on-demand artifacts', () => {
  test('coalesces concurrent loads and rechecks bytes on offline reuse', async () => {
    const cache = new MemoryCache(); const item = asset('[1]'); let calls = 0;
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: async () => { calls++; return new Response('[1]'); } });
    const results = await Promise.all([store.read(item), store.read(item), store.read(item)]);
    assert.equal(calls, 1); assert.equal(results[0].cached, false);
    assert.equal((await store.read(item)).cached, true);
    const offline = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: noNetwork });
    assert.equal((await offline.read(item)).cached, true);
    assert.equal(store.getTransferLedger().networkBytes, 3);
    await store.close(); await offline.close();
  });
  test('rejects corrupt or truncated network bytes without saving them', async () => {
    const item = asset('[123]'); const cache = new MemoryCache();
    for (const text of ['[999]', '[1]', '[123456]']) {
      const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: async () => new Response(text) });
      await assert.rejects(store.read(item), /integrity|budget/);
      assert.equal(cache.entries.size, 0); await store.close();
    }
  });
  test('repairs a corrupt cached artifact only from verified network bytes', async () => {
    const item = asset('[1]'); const cache = new MemoryCache(); const url = dataArtifactUrl(base, item);
    await cache.put(url, new Response('[9]'));
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: async () => new Response('[1]') });
    assert.equal((await store.read(item)).cached, false);
    assert.equal(await (await cache.match(url))!.text(), '[1]'); await store.close();
  });
  test('an uncached offline shard fails instead of pretending data are empty', async () => {
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => new MemoryCache(), fetch: noNetwork });
    await assert.rejects(store.read(asset('[1]')), /offline/); await store.close();
  });
  test('a forced refresh does not silently return old offline data', async () => {
    const item = asset('[1]'); const cache = new MemoryCache();
    await cache.put(dataArtifactUrl(base, item), new Response('[1]'));
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: noNetwork, forceDownload: true });
    await assert.rejects(store.read(item), /offline/); await store.close();
  });
  test('storage failure preserves usable verified data and is reported', async () => {
    let warnings = 0;
    const cache = new MemoryCache(); cache.put = async () => { throw new Error('quota'); };
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: async () => new Response('[1]'), onStorageUnavailable: () => { warnings++; } });
    assert.equal(new TextDecoder().decode((await store.read(asset('[1]'))).data), '[1]');
    assert.equal(warnings, 1); assert.equal(store.getTransferLedger().storageAvailable, false); await store.close();
  });
  test('bounds persistent bytes while pinning the current catalog', async () => {
    const cache = new MemoryCache(); const texts = ['[1]', '[2]', '[3]'];
    const byUrl = new Map(texts.map(text => [dataArtifactUrl(base, asset(text)), text]));
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, cacheBudget: 6,
      fetch: async input => new Response(byUrl.get(String(input))) });
    store.pin(asset(texts[0]));
    for (const text of texts) await store.read(asset(text));
    assert.equal(cache.entries.size, 2);
    assert.ok(cache.entries.has(dataArtifactUrl(base, asset('[1]'))));
    assert.ok(!cache.entries.has(dataArtifactUrl(base, asset('[2]')))); await store.close();
  });
  test('limits concurrency and cancels both active and queued requests', async () => {
    let active = 0; let peak = 0;
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => undefined,
      fetch: async (_input, init) => {
        active++; peak = Math.max(peak, active);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => { active--; reject(new Error('cancelled')); }, { once: true });
        });
      } });
    const pending = Array.from({ length: 9 }, (_, i) => store.read(asset(`[${i}]`)));
    const settled = Promise.allSettled(pending);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(peak, PROGRESSIVE_LIMITS.concurrentLoads);
    await store.close();
    assert.ok((await settled).every(result => result.status === 'rejected'));
    assert.equal(active, 0);
  });
});
