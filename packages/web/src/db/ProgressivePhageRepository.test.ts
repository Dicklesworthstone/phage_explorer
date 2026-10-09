import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PhageSummary, PhageFull, LatentSpacePoint } from '@phage-explorer/core';
import type { PhageRepository } from './types';
import { ProgressivePhageRepository } from './ProgressivePhageRepository';
import { ProgressiveDatabaseLoader, type ProgressiveLoaderDependencies } from './ProgressiveDatabaseLoader';
import type { DatabaseLoadProgress } from './types';
import { VerifiedArtifactStore, type ArtifactCache } from './progressive-artifacts';
import { datasetByteLedger, progressiveIdentity, dataArtifactUrl, type DataArtifact, type ProgressiveManifest } from './progressive-manifest';

const BASE = 'https://example.test/data/phage.db.manifest.json';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const summary = (id: number): PhageSummary => ({ id, slug: `phage-${id}`, name: `Genome ${id}`, accession: `AC${id}`,
  family: null, host: null, genomeLength: 8, gcContent: 0.5, morphology: null, lifecycle: null });
function descriptor(text: string, extension: 'sqlite' | 'json' = 'sqlite'): DataArtifact {
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { path: `phage-data/${sha256}.${extension}`, sha256, bytes: Buffer.byteLength(text) };
}
class MemoryCache implements ArtifactCache {
  entries = new Map<string, Response>();
  async match(key: string) { return this.entries.get(key)?.clone(); }
  async put(key: string, response: Response) { this.entries.set(key, response.clone()); }
  async delete(key: string) { return this.entries.delete(key); }
  async keys() { return [...this.entries.keys()].map(key => new Request(key)); }
}
function identity(manifest: ProgressiveManifest): void {
  manifest.bytes = datasetByteLedger(manifest);
  manifest.contentVersion = createHash('sha256').update(progressiveIdentity(manifest)).digest('hex');
}
/** These adapters exercise routing and lifetime, not the SQL implementation. */
function fixture() {
  const lists = [summary(1), summary(2), summary(3)];
  const texts = ['catalog', 'genome:1', 'genome:2', 'genome:3'].map(text => text.padEnd(512, ' '));
  const artifacts = texts.map(text => descriptor(text));
  const manifest: ProgressiveManifest = { version: 3, layout: 'per-phage-sqlite-v1', generatedAt: '2026-01-01T00:00:00Z', contentVersion: '',
    catalog: artifacts[0], genomes: lists.map((phage, i) => ({ id: phage.id, genomeLength: 8, artifact: artifacts[i + 1] })), atlas: [],
    bytes: { catalog: 0, artifacts: 0, largestArtifact: 0, artifactCount: 0 } };
  identity(manifest);
  const cache = new MemoryCache();
  const network: string[] = [], opened: number[] = [], closed: number[] = [], calls: string[] = [];
  const responses = new Map(artifacts.map((item, index) => [dataArtifactUrl(BASE, item), texts[index]]));
  const sequence = new Map([[1, 'ACGTACGT'], [2, 'GGGGCCCC'], [3, 'TTTTAAAA']]);
  const behaviors = new Map<string, () => Promise<unknown>>();
  const run = async <T>(id: number, name: string, value: T): Promise<T> => {
    calls.push(`${id}:${name}`);
    return behaviors.has(`${id}:${name}`) ? await behaviors.get(`${id}:${name}`)!() as T : value;
  };
  const vectors = new Map<string, number[]>();
  const openRepository = (bytes: Uint8Array): PhageRepository => {
    const text = new TextDecoder().decode(bytes).trim(), id = text.startsWith('catalog') ? 0 : Number(text.split(':')[1]);
    opened.push(id);
    const phages = id ? [lists[id - 1]] : lists;
    const phage = (target: number): PhageFull | null => phages.some(item => item.id === target) ? {
      ...summary(target), description: null, baltimoreGroup: null, genomeType: null, pdbIds: [],
      genes: [{ id: target * 10, name: `gene-${target}`, locusTag: null, startPos: 0, endPos: 6, strand: '+', product: 'protein', type: 'CDS' }],
      codonUsage: { aaCounts: {}, codonCounts: {} }, hasModel: true,
    } : null;
    return {
      listPhages: () => run(id, 'list', structuredClone(phages)),
      getPhageById: target => run(id, 'phage', phage(target)),
      getPhageByIndex: async index => phage(phages[index]?.id),
      getPhageBySlug: async slug => phage(phages.find(item => item.slug === slug)?.id ?? -1),
      getFullGenomeLength: async target => sequence.get(target)?.length ?? 0,
      getSequenceWindow: (target, start, end) => run(id, 'sequence', (sequence.get(target) ?? '').slice(start, end)),
      getGenes: target => run(id, 'genes', phage(target)?.genes ?? []),
      getCodonUsage: target => run(id, 'codons', phage(target)?.codonUsage ?? null),
      hasModel: () => run(id, 'hasModel', true), getModelFrames: () => run(id, 'frames', ['frame']),
      searchPhages: async query => phages.filter(item => item.name.includes(query)),
      getPreference: async key => key === 'theme' ? 'dark' : null, setPreference: async () => {},
      getAnnotationMeta: key => run(id, 'meta', { source: key }), getHostTrnaPools: () => run(id, 'trna', []),
      getProteinDomains: () => run(id, 'domains', []), getAmgAnnotations: () => run(id, 'amgs', []),
      getDefenseSystems: () => run(id, 'defense', []), getCodonAdaptation: () => run(id, 'adaptation', []),
      getFoldEmbeddings: () => run(id, 'embeddings', []), getLatentSpaceAtlas: () => run(id, 'atlas', []),
      getBiasVector: async target => vectors.get(`bias:${target}`) ?? null,
      setBiasVector: async (target, vector) => { vectors.set(`bias:${target}`, vector); },
      getCodonVector: async target => vectors.get(`codons:${target}`) ?? null,
      setCodonVector: async (target, vector) => { vectors.set(`codons:${target}`, vector); },
      prefetchAround: async () => {}, close: async () => { closed.push(id); },
    };
  };
  const fetcher: typeof fetch = async input => {
    const url = String(input); network.push(url);
    const text = responses.get(url); if (text === undefined) throw new Error('offline');
    return new Response(text);
  };
  const store = () => new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => cache, fetch: fetcher });
  const open = (residentBytes = 1536) => ProgressivePhageRepository.open({ manifest, store: store(), openRepository, residentBytes });
  return { lists, manifest, cache, network, opened, closed, calls, responses, behaviors, openRepository, fetcher, store, open };
}
function addAtlas(f: ReturnType<typeof fixture>, points?: LatentSpacePoint[]): void {
  const values = points ?? [1, 2, 3].map(id => ({ id, phageId: id, phageName: `Genome ${id}`, geneId: id * 10,
    geneName: `gene-${id}`, locusTag: `locus-${id}`, product: 'protein', model: 'model', x: id * 2, y: -id, clusterId: -1, outlierScore: 0.1 }));
  const pages = values.map(point => {
    const text = JSON.stringify([point]), artifact = descriptor(text, 'json');
    f.responses.set(dataArtifactUrl(BASE, artifact), text); return artifact;
  });
  f.manifest.atlas = [{ model: 'model', count: values.length, pages }]; identity(f.manifest);
}

describe('catalog-first progressive repository', () => {
  test('startup, searches, and lengths use only the catalog; full records load their own shard', async () => {
    const f = fixture(), repo = await f.open();
    assert.deepEqual(f.opened, [0]); assert.equal(f.network.length, 1);
    assert.equal((await repo.searchPhages('2'))[0].id, 2); assert.equal(await repo.getFullGenomeLength(3), 8);
    const copy = await repo.listPhages(); copy[0].name = 'tampered';
    assert.equal((await repo.listPhages())[0].name, 'Genome 1');
    assert.equal(f.network.length, 1);
    assert.equal((await repo.getPhageById(2))?.genes[0].id, 20);
    assert.equal((await repo.getPhageBySlug('phage-2'))?.id, 2);
    assert.equal((await repo.getPhageByIndex(1))?.id, 2);
    assert.deepEqual(f.opened, [0, 2]); assert.equal(f.network.length, 2);
    await repo.close(); assert.deepEqual(f.closed.sort(), [0, 2]);
  });
  test('concurrent reads share one SQL opening and retain full annotations', async () => {
    const f = fixture(), repo = await f.open();
    await Promise.all([repo.getGenes(1), repo.getPhageById(1), repo.getProteinDomains(1), repo.getFoldEmbeddings(1)]);
    assert.deepEqual(f.opened, [0, 1]); assert.equal(f.network.length, 2);
    await repo.getAmgAnnotations(1); await repo.getDefenseSystems(1); await repo.getCodonAdaptation(1);
    await repo.getModelFrames(1); await repo.hasModel(1); await repo.getCodonUsage(1);
    for (const call of ['1:genes', '1:domains', '1:embeddings', '1:amgs', '1:defense', '1:adaptation', '1:frames', '1:hasModel', '1:codons']) assert.ok(f.calls.includes(call), call);
    await repo.close();
  });
  test('global references and computed vector caches do not read genome shards', async () => {
    const f = fixture(), repo = await f.open(1024);
    assert.deepEqual(await repo.getAnnotationMeta('pfam'), { source: 'pfam' });
    await repo.getHostTrnaPools('host'); await repo.setBiasVector(1, [1, 2]); await repo.setCodonVector(1, [3, 4]);
    await repo.getGenes(1); await repo.getGenes(2); // Evict genome 1, retaining the catalog's vector cache.
    assert.deepEqual(await repo.getBiasVector(1), [1, 2]); assert.deepEqual(await repo.getCodonVector(1), [3, 4]);
    assert.ok(f.calls.includes('0:meta')); assert.ok(f.calls.includes('0:trna')); await repo.close();
  });
  test('unknown IDs and empty windows never request fabricated data', async () => {
    const f = fixture(), repo = await f.open();
    assert.equal(await repo.getPhageById(99), null); assert.equal(await repo.getPhageByIndex(0.5), null);
    assert.equal(await repo.getPhageBySlug('missing'), null); assert.deepEqual(await repo.getGenes(99), []);
    assert.equal(await repo.getFullGenomeLength(99), 0); assert.equal(await repo.getSequenceWindow(99, 0, 8), '');
    assert.equal(await repo.getSequenceWindow(1, 4, 4), ''); assert.equal(f.network.length, 1);
    await assert.rejects(repo.getSequenceWindow(1, -1, 4), /coordinates/);
    assert.equal(await repo.getSequenceWindow(2, 1, 50), 'GGGCCCC'); await repo.close();
  });
  test('refuses a truncated sequence instead of inventing an empty result', async () => {
    const f = fixture(); f.behaviors.set('1:sequence', async () => 'A');
    const repo = await f.open(); await assert.rejects(repo.getSequenceWindow(1, 0, 8), /incomplete/); await repo.close();
  });
  test('validates catalog IDs and lengths before accepting a manifest', async () => {
    const f = fixture(); f.lists[0].genomeLength = 9;
    await assert.rejects(f.open(), /Catalog/); assert.deepEqual(f.closed, [0]);
  });
  test('refuses a validly hashed shard with the wrong owner', async () => {
    const f = fixture(); f.behaviors.set('1:list', async () => [summary(2)]);
    const repo = await f.open(); await assert.rejects(repo.getGenes(1), /catalog owner/);
    assert.deepEqual(f.closed, [1]); assert.equal(repo.getResidency().bytes, 512); await repo.close();
  });
  test('rejects byte budgets before transferring the catalog', async () => {
    const f = fixture(); await assert.rejects(f.open(700), /resident/); assert.equal(f.network.length, 0);
  });
});

describe('bounded residency and request lifecycle', () => {
  test('evicts least-recently-used idle shards, then reopens from verified cache without transfer', async () => {
    const f = fixture(), repo = await f.open();
    await repo.getGenes(1); await repo.getGenes(2); await repo.getGenes(1); await repo.getGenes(3);
    assert.deepEqual(f.closed, [2]);
    await repo.getGenes(2); assert.equal(f.network.length, 4); assert.deepEqual(f.opened, [0, 1, 2, 3, 2]);
    assert.ok(repo.getResidency().peakBytes <= 1536); await repo.close();
  });
  test('simultaneous different shards never exceed the byte budget', async () => {
    const f = fixture(), repo = await f.open(1024);
    assert.deepEqual((await Promise.all([repo.getPhageById(1), repo.getPhageById(2), repo.getPhageById(3)])).map(phage => phage?.id), [1, 2, 3]);
    assert.equal(repo.getResidency().peakBytes, 1024); await repo.close();
  });
  test('does not close a leased SQL handle while another shard waits for memory', async () => {
    const f = fixture(); let release!: () => void;
    f.behaviors.set('1:genes', () => new Promise(resolve => { release = () => resolve([]); }));
    const repo = await f.open(1024), first = repo.getGenes(1);
    while (!release) await tick();
    const second = repo.getGenes(2); await tick();
    assert.deepEqual(f.opened, [0, 1]); assert.deepEqual(f.closed, []);
    release(); await Promise.all([first, second]); assert.deepEqual(f.closed, [1]); await repo.close();
  });
  test('failed reads free reservations, allowing a different queued genome to run and a retry to succeed', async () => {
    const f = fixture(), url = dataArtifactUrl(BASE, f.manifest.genomes[0].artifact), body = f.responses.get(url)!;
    f.responses.delete(url);
    const repo = await f.open(1024);
    const results = await Promise.allSettled([repo.getGenes(1), repo.getGenes(2)]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
    f.responses.set(url, body); assert.equal((await repo.getGenes(1))[0].id, 10); await repo.close();
  });
  test('close cancels queued admissions and blocks late results without closing active SQL early', async () => {
    const f = fixture(); let release!: () => void;
    f.behaviors.set('1:genes', () => new Promise(resolve => { release = () => resolve([]); }));
    const repo = await f.open(1024), first = repo.getGenes(1);
    while (!release) await tick();
    const pending = Promise.allSettled([first, repo.getGenes(2)]);
    await repo.close(); assert.ok(!f.closed.includes(1)); release();
    assert.ok((await pending).every(result => result.status === 'rejected'));
    assert.equal(f.closed.filter(id => id === 1).length, 1);
    await repo.close(); assert.equal(f.closed.filter(id => id === 0).length, 1);
    await assert.rejects(repo.getGenes(1), /closed/);
  });
  test('late network responses after close cannot reopen a SQL database', async () => {
    const f = fixture(); let resolve!: (value: Response) => void;
    const store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => f.cache,
      fetch: async (url, init) => String(url).includes(f.manifest.catalog.sha256) ? f.fetcher(url, init) : new Promise<Response>(done => { resolve = done; }) });
    const repo = await ProgressivePhageRepository.open({ manifest: f.manifest, store, openRepository: f.openRepository });
    const pending = Promise.allSettled([repo.getGenes(1)]);
    while (!resolve) await tick(); await repo.close();
    assert.equal((await pending)[0].status, 'rejected');
    resolve(new Response(f.responses.get(dataArtifactUrl(BASE, f.manifest.genomes[0].artifact))));
    await tick(); assert.deepEqual(f.opened, [0]);
  });
  test('reopens visited genomes offline but fails for uncached ones', async () => {
    const f = fixture(); const first = await f.open(); await first.getGenes(2); await first.close(); f.responses.clear();
    const offline = await f.open(); assert.equal((await offline.getGenes(2))[0].id, 20);
    await assert.rejects(offline.getGenes(1), /offline/); await offline.close();
  });
  test('prefetch is explicit and bounded rather than downloading the entire dataset at open', async () => {
    const f = fixture(), repo = await f.open(); assert.equal(f.network.length, 1);
    await repo.prefetchAround(0, 1); assert.deepEqual(f.opened, [0, 2]);
    await assert.rejects(repo.prefetchAround(0, Infinity), /radius/); await repo.close();
  });
});

describe('global projection pages', () => {
  test('loads exact atlas pages without downloading every genome and preserves model/ownership', async () => {
    const f = fixture(); addAtlas(f); const repo = await f.open();
    const result = await repo.getLatentSpaceAtlas({ model: 'model' });
    assert.deepEqual(result.map(point => [point.phageId, point.x]), [[1, 2], [2, 4], [3, 6]]);
    assert.deepEqual(f.opened, [0]); assert.equal(f.network.length, 4);
    assert.deepEqual(await repo.getLatentSpaceAtlas({ model: 'missing' }), []);
    await repo.getLatentSpaceAtlas({ phageId: 2, model: 'model' }); assert.ok(f.calls.includes('2:atlas'));
    await repo.close();
  });
  test('missing or malformed projection pages cannot become partial successful results', async () => {
    const f = fixture(); addAtlas(f); f.responses.delete(dataArtifactUrl(BASE, f.manifest.atlas[0].pages[1]));
    const repo = await f.open(); await assert.rejects(repo.getLatentSpaceAtlas({ model: 'model' }), /offline/); await repo.close();
  });
  test('rejects wrong counts, duplicate IDs, or incorrect names even with self-consistent hashes', async () => {
    for (const defect of ['count', 'duplicate', 'name']) {
      const f = fixture(); addAtlas(f);
      if (defect === 'count') { f.manifest.atlas[0].count++; identity(f.manifest); }
      else {
        const values = f.manifest.atlas[0].pages.map(page => JSON.parse(f.responses.get(dataArtifactUrl(BASE, page))!)[0]);
        if (defect === 'duplicate') values[1].id = values[0].id; else values[1].phageName = 'wrong genome';
        addAtlas(f, values);
      }
      const repo = await f.open(); await assert.rejects(repo.getLatentSpaceAtlas({ model: 'model' }), /incomplete|identity/); await repo.close();
    }
  });
  test('checks atlas byte limits before requesting any projection pages', async () => {
    const f = fixture(); addAtlas(f);
    const repo = await ProgressivePhageRepository.open({ manifest: f.manifest, store: f.store(), openRepository: f.openRepository, atlasBytes: 2 });
    await assert.rejects(repo.getLatentSpaceAtlas({ model: 'model' }), /budget/); assert.equal(f.network.length, 1); await repo.close();
  });
});

function loaderFixture() {
  const f = fixture(), manifestCache = new MemoryCache(), progress: DatabaseLoadProgress[] = [], versions: string[] = [];
  const manifestRequests: Array<RequestInit | undefined> = [], legacyOptions: Array<{ forceDownload?: boolean } | undefined> = [];
  const service = { respond: async (): Promise<Response> => new Response(JSON.stringify(f.manifest), { headers: { etag: '"snapshot"' } }) };
  const dependencies: ProgressiveLoaderDependencies = {
    fetch: async (input, init) => {
      if (String(input) !== BASE) return f.fetcher(input, init);
      manifestRequests.push(init); return service.respond();
    },
    openManifestCache: async () => manifestCache, openArtifactCache: async () => f.cache,
    sqlite: async () => f.openRepository,
    acceptVersion: version => { versions.push(version); },
    legacy: async () => ({ load: async options => { legacyOptions.push(options); return f.openRepository(new TextEncoder().encode('catalog')); }, close: async () => {} }),
  };
  const create = (overrides: ProgressiveLoaderDependencies = {}) => new ProgressiveDatabaseLoader({ databaseUrl: BASE.replace('.manifest.json', ''), onProgress: value => progress.push(value) }, { ...dependencies, ...overrides });
  return { f, manifestCache, progress, versions, manifestRequests, legacyOptions, service, dependencies, create };
}

describe('published-layout browser startup', () => {
  test('accepts a v3 publication through catalog-first load without requesting the whole database', async () => {
    const h = loaderFixture(), loader = h.create();
    const first = loader.load(), second = loader.load(); assert.equal(first, second);
    const repo = await first; assert.ok(repo instanceof ProgressivePhageRepository);
    assert.equal(h.manifestRequests.length, 1); assert.equal(h.f.network.length, 1); assert.deepEqual(h.legacyOptions, []);
    assert.deepEqual(h.versions, [h.f.manifest.contentVersion]); assert.equal(h.progress.at(-1)?.cacheStatus, 'saved');
    assert.equal((await repo.getPhageById(2))?.id, 2); assert.equal(h.f.network.length, 2);
    assert.ok(!h.f.network.some(url => url.endsWith('/phage.db') || url.endsWith('.gz')));
    await loader.close();
  });
  test('v2 publications continue through the existing loader with forced-refresh mode intact', async () => {
    const h = loaderFixture(); h.service.respond = async () => new Response('{"version":2}');
    const loader = h.create(); await loader.load({ forceDownload: true });
    assert.deepEqual(h.legacyOptions, [{ forceDownload: true }]); assert.deepEqual(h.f.network, []);
    assert.deepEqual(h.versions, []); await loader.close();
  });
  test('a conditional 304 reuses the verified manifest and cached catalog', async () => {
    const h = loaderFixture(), initial = h.create(); await initial.load(); await initial.close();
    h.service.respond = async () => new Response(null, { status: 304 });
    const loader = h.create(); await loader.load();
    assert.equal(new Headers(h.manifestRequests.at(-1)?.headers).get('if-none-match'), '"snapshot"');
    assert.equal(h.f.network.length, 1); assert.equal(h.progress.at(-1)?.cached, true); await loader.close();
  });
  test('offline reload uses the accepted manifest and visited shards, not invented empty data', async () => {
    const h = loaderFixture(), initial = h.create(), first = await initial.load(); await first.getGenes(2); await initial.close();
    h.service.respond = async () => { throw new Error('offline'); }; h.f.responses.clear();
    const loader = h.create(), repo = await loader.load();
    assert.equal((await repo.getGenes(2))[0].id, 20); await assert.rejects(repo.getGenes(1), /offline/);
    assert.deepEqual(h.legacyOptions, []); await loader.close();
  });
  test('forced refresh never succeeds by using a cached manifest or a 304', async () => {
    const h = loaderFixture(), first = h.create(); await first.load(); await first.close();
    for (const status of ['offline', '304']) {
      h.service.respond = async () => { if (status === 'offline') throw new Error('offline'); return new Response(null, { status: 304 }); };
      const loader = h.create(); await assert.rejects(loader.load({ forceDownload: true }), /refresh|download failed/);
      assert.equal(new Headers(h.manifestRequests.at(-1)?.headers).get('if-none-match'), null); await loader.close();
    }
    assert.deepEqual(h.legacyOptions, []);
  });
  test('invalid manifest identity and unknown layouts fail closed without replacing the accepted snapshot', async () => {
    const h = loaderFixture(), first = h.create(); await first.load(); await first.close();
    const before = await (await h.manifestCache.match(BASE))!.text();
    for (const value of [{ ...h.f.manifest, contentVersion: '0'.repeat(64) }, { ...h.f.manifest, version: 4 }, { ...h.f.manifest, layout: 'unknown' }]) {
      h.service.respond = async () => new Response(JSON.stringify(value));
      const loader = h.create(); await assert.rejects(loader.load(), /identity|layout/); await loader.close();
      assert.equal(await (await h.manifestCache.match(BASE))!.text(), before);
    }
    assert.deepEqual(h.legacyOptions, []);
  });
  test('a catalog that disagrees with a valid new manifest cannot publish its snapshot pointer', async () => {
    const h = loaderFixture(), first = h.create(); await first.load(); await first.close();
    const before = await (await h.manifestCache.match(BASE))!.text();
    h.f.manifest.genomes[0].genomeLength = 9; identity(h.f.manifest);
    const loader = h.create(); await assert.rejects(loader.load(), /Catalog/);
    assert.equal(await (await h.manifestCache.match(BASE))!.text(), before); await loader.close();
  });
  test('storage denial allows verified in-memory use, but cannot claim durable forced-refresh success', async () => {
    const h = loaderFixture();
    const loader = h.create({ openArtifactCache: async () => undefined });
    const repo = await loader.load(); assert.equal((await repo.listPhages()).length, 3);
    assert.equal(h.progress.at(-1)?.cacheStatus, 'unavailable'); assert.equal(h.manifestCache.entries.size, 0); await loader.close();
    const forced = h.create({ openArtifactCache: async () => undefined });
    await assert.rejects(forced.load({ forceDownload: true }), /could not be saved/); await forced.close();
  });
  test('quota failure for a later genome updates offline availability without discarding usable data', async () => {
    const h = loaderFixture(), loader = h.create(), repo = await loader.load();
    h.f.cache.put = async () => { throw new Error('quota'); };
    assert.equal((await repo.getGenes(1))[0].id, 10);
    assert.equal(h.progress.at(-1)?.cacheStatus, 'unavailable'); assert.equal(h.progress.at(-1)?.stage, 'ready'); await loader.close();
  });
  test('a failed new snapshot commit cannot evict the previous catalog', async () => {
    const h = loaderFixture(), initial = h.create(); await initial.load(); await initial.close();
    const old = h.f.manifest.catalog, before = await (await h.manifestCache.match(BASE))!.text();
    for (const id of ['a', 'b']) await h.f.cache.put(`https://example.test/old-${id}`, new Response('old', { headers: { 'x-phage-bytes': String(64 * 1024 * 1024) } }));
    const text = 'catalog-next'.padEnd(512, ' '); h.f.manifest.catalog = descriptor(text); identity(h.f.manifest);
    h.f.responses.set(dataArtifactUrl(BASE, h.f.manifest.catalog), text);
    h.manifestCache.put = async () => { throw new Error('manifest quota'); };
    const loader = h.create(); await assert.rejects(loader.load({ forceDownload: true }), /could not be saved/);
    assert.ok(await h.f.cache.match(dataArtifactUrl(BASE, old)));
    assert.equal(await (await h.manifestCache.match(BASE))!.text(), before); await loader.close();
  });
  test('cancelled manifest fetches settle even when the provider ignores abort', async () => {
    const h = loaderFixture(); let resolve!: (response: Response) => void;
    h.service.respond = () => new Promise(done => { resolve = done; });
    const loader = h.create(), pending = Promise.allSettled([loader.load()]);
    while (!resolve) await tick(); await loader.close();
    assert.equal((await pending)[0].status, 'rejected');
    resolve(new Response(JSON.stringify(h.f.manifest))); await tick();
    assert.deepEqual(h.f.opened, []); assert.deepEqual(h.versions, []);
  });
  test('close during a stalled manifest write releases the already-opened catalog', async () => {
    const h = loaderFixture(); let resolve!: () => void;
    h.manifestCache.put = () => new Promise(done => { resolve = done; });
    const loader = h.create(), pending = Promise.allSettled([loader.load()]);
    while (!resolve) await tick(); await loader.close();
    assert.equal((await pending)[0].status, 'rejected'); assert.deepEqual(h.f.closed, [0]);
    resolve(); await tick(); assert.deepEqual(h.versions, []);
  });
  test('an in-flight load cannot silently change between normal and forced mode', async () => {
    const h = loaderFixture(), loader = h.create(), first = loader.load();
    await assert.rejects(loader.load({ forceDownload: true }), /refresh mode/); await first; await loader.close();
  });
  test('malformed fresh manifests do not get cached or disable a later retry', async () => {
    const h = loaderFixture(); h.service.respond = async () => new Response('not JSON');
    const loader = h.create(); await assert.rejects(loader.load()); assert.equal(h.manifestCache.entries.size, 0);
    h.service.respond = async () => new Response(JSON.stringify(h.f.manifest));
    await loader.load(); assert.deepEqual(h.versions, [h.f.manifest.contentVersion]); await loader.close();
  });
  test('late legacy results are closed rather than installed after cancellation', async () => {
    const h = loaderFixture(); h.service.respond = async () => new Response('{"version":2}');
    let release!: (repo: PhageRepository) => void;
    const loader = h.create({ legacy: async () => ({ load: () => new Promise(resolve => { release = resolve; }), close: async () => {} }) });
    const pending = Promise.allSettled([loader.load()]); while (!release) await tick(); await loader.close();
    assert.equal((await pending)[0].status, 'rejected');
    release(h.f.openRepository(new TextEncoder().encode('catalog'))); await tick();
    assert.deepEqual(h.f.closed, [0]); assert.deepEqual(h.versions, []);
  });
});

/** Real loader + artifact store; only SQLite queries are the routing adapters above. */
async function offlineFixture(atlas = false) {
  const h = loaderFixture(); if (atlas) addAtlas(h.f);
  const loader = h.create(), repo = await loader.load(), offline = repo.getOfflineDataset?.();
  assert.ok(offline);
  return { ...h, loader, repo, offline };
}
const selection = (genomeIds: number[] = [], atlasModels: string[] = []) => ({ genomeIds, atlasModels });

describe('user-selectable offline datasets through the application repository', () => {
  test('describes and plans exact catalog IDs without network or genome SQL opening', async () => {
    const h = await offlineFixture(true);
    try {
      const info = h.offline.describe(); assert.equal(info.genomes.length, 3); assert.equal(info.atlases[0].count, 3);
      info.genomes[0].name = 'changed'; assert.equal(h.offline.describe().genomes[0].name, 'Genome 1');
      assert.deepEqual(h.offline.plan(selection([3, 1])), { contentVersion: h.f.manifest.contentVersion,
        selection: selection([1, 3]), totalBytes: 1536, artifactCount: 3, withinBudget: true });
      assert.equal(await h.offline.saved(), null);
      const inventory = await h.offline.inspect(selection([2]));
      assert.equal(inventory.ready, false); assert.equal(inventory.catalog, 'available');
      assert.equal(inventory.startupManifestAvailable, true); assert.equal(inventory.verifiedBytes, 512);
      assert.deepEqual(inventory.genomes, [{ id: 2, status: 'missing' }]);
      assert.equal(h.f.network.length, 1); assert.deepEqual(h.f.opened, [0]);
    } finally { await h.loader.close(); }
  });
  test('rejects unknown, private, duplicate and sparse selections before any I/O', async () => {
    const h = await offlineFixture(true);
    try {
      for (const value of [selection([-1]), selection([99]), selection([1, 1]), selection(new Array(1)),
        selection([], ['absent']), selection([], ['model', 'model'])]) assert.throws(() => h.offline.plan(value));
      await assert.rejects(h.offline.prepare(selection([99])), /catalog/);
      assert.equal(h.f.network.length, 1); assert.equal(await h.offline.saved(), null);
    } finally { await h.loader.close(); }
  });
  test('prepares only chosen genomes and whole atlas pages without opening their SQLite handles', async () => {
    const h = await offlineFixture(true), progress: string[] = [];
    try {
      const report = await h.offline.prepare(selection([2], ['model']), { onProgress: value => progress.push(value.phase) });
      assert.equal(report.ready, true); assert.equal(report.verifiedBytes, report.totalBytes);
      assert.deepEqual(report.genomes, [{ id: 2, status: 'available' }]);
      assert.deepEqual(report.atlases, [{ model: 'model', status: 'available' }]);
      assert.deepEqual(progress.at(-1), 'verifying');
      assert.deepEqual(h.f.opened, [0]);
      assert.ok(!h.f.network.includes(dataArtifactUrl(BASE, h.f.manifest.genomes[0].artifact)));
      assert.ok(!h.f.network.includes(dataArtifactUrl(BASE, h.f.manifest.genomes[2].artifact)));
      assert.deepEqual((await h.offline.saved())?.selection, selection([2], ['model']));
    } finally { await h.loader.close(); }
  });
  test('prepared genomes and global atlas reopen through a new loader while offline', async () => {
    const h = await offlineFixture(true);
    await h.offline.prepare(selection([2], ['model'])); await h.loader.close();
    h.service.respond = async () => { throw new Error('offline'); }; h.f.responses.clear();
    const next = h.create(), repo = await next.load(), api = repo.getOfflineDataset!()!;
    try {
      const before = h.f.network.length;
      assert.deepEqual((await api.saved())?.selection, selection([2], ['model']));
      assert.equal((await api.inspect(selection([2], ['model']))).ready, true);
      assert.equal(await repo.getSequenceWindow(2, 0, 8), 'GGGGCCCC');
      assert.equal((await repo.getLatentSpaceAtlas!({ model: 'model' })).length, 3);
      assert.equal(h.f.network.length, before);
      await assert.rejects(repo.getGenes(1), /offline/);
    } finally { await next.close(); }
  });
  test('changing caller-owned selections during download cannot add another genome', async () => {
    const h = await offlineFixture(), draft = selection([1]);
    try {
      const pending = h.offline.prepare(draft); draft.genomeIds.push(3);
      assert.deepEqual((await pending).selection, selection([1]));
      assert.ok(!h.f.network.includes(dataArtifactUrl(BASE, h.f.manifest.genomes[2].artifact)));
    } finally { await h.loader.close(); }
  });
  test('missing one atlas page is not a fully available global projection', async () => {
    const h = await offlineFixture(true);
    try {
      await h.offline.prepare(selection([], ['model']));
      h.f.cache.entries.delete(dataArtifactUrl(BASE, h.f.manifest.atlas[0].pages[1]));
      const before = h.f.network.length, report = await h.offline.inspect(selection([], ['model']));
      assert.equal(report.ready, false); assert.equal(report.atlases[0].status, 'missing');
      assert.ok(report.verifiedBytes < report.totalBytes); assert.equal(h.f.network.length, before);
    } finally { await h.loader.close(); }
  });
  test('corrupt saved bytes are reported without a download, then repaired only explicitly', async () => {
    const h = await offlineFixture(), selected = selection([1]);
    try {
      await h.offline.prepare(selected);
      await h.f.cache.put(dataArtifactUrl(BASE, h.f.manifest.genomes[0].artifact), new Response('bad bytes'));
      const before = h.f.network.length, report = await h.offline.inspect(selected);
      assert.equal(report.genomes[0].status, 'corrupt'); assert.equal(report.ready, false);
      assert.equal(h.f.network.length, before);
      assert.equal((await h.offline.prepare(selected)).ready, true); assert.equal(h.f.network.length, before + 1);
    } finally { await h.loader.close(); }
  });
  test('reservations from a different version cannot silently select reused numeric genome IDs', async () => {
    const h = await offlineFixture();
    try {
      await h.offline.prepare(selection([1]));
      const key = [...h.f.cache.entries.keys()].find(key => key.includes('__phage_offline_selection'))!;
      const saved = await (await h.f.cache.match(key))!.json(); saved.contentVersion = 'a'.repeat(64);
      await h.f.cache.put(key, new Response(JSON.stringify(saved)));
      const restored = await h.offline.saved(); assert.equal(restored?.selection, null);
      assert.equal(restored?.contentVersion, 'a'.repeat(64)); assert.equal(restored?.totalBytes, 1024);
      assert.equal(h.f.network.length, 2);
    } finally { await h.loader.close(); }
  });
  test('a partial atlas reservation cannot be restored as the complete model', async () => {
    const h = await offlineFixture(true), store = h.f.store();
    try {
      await store.prepareOffline(h.f.manifest.contentVersion, [h.f.manifest.catalog, h.f.manifest.atlas[0].pages[0]]);
      assert.equal((await h.offline.saved())?.selection, null);
    } finally { await store.close(); await h.loader.close(); }
  });
  test('over-budget plans cannot change an existing saved reservation or begin downloads', async () => {
    const f = fixture(), store = new VerifiedArtifactStore({ manifestUrl: BASE, openCache: async () => f.cache, fetch: f.fetcher, cacheBudget: 1024 });
    const repo = await ProgressivePhageRepository.open({ manifest: f.manifest, store, openRepository: f.openRepository,
      offlineManifest: { available: async () => true, publish: async () => {} } });
    const api = repo.getOfflineDataset()!;
    try {
      await api.prepare(selection([1])); const before = await api.saved(), transfers = f.network.length;
      assert.equal(api.plan(selection([1, 2])).withinBudget, false);
      await assert.rejects(api.prepare(selection([1, 2])), /budget/);
      assert.deepEqual(await api.saved(), before); assert.equal(f.network.length, transfers);
    } finally { await repo.close(); }
  });
  test('a saved catalog file without its startup pointer is not offline readiness', async () => {
    const h = loaderFixture(); const put = h.manifestCache.put.bind(h.manifestCache);
    h.manifestCache.put = async () => { throw new Error('manifest quota'); };
    const loader = h.create(), repo = await loader.load(), api = repo.getOfflineDataset!()!;
    try {
      const report = await api.inspect(selection());
      assert.equal(report.filesAvailable, true); assert.equal(report.startupManifestAvailable, false); assert.equal(report.ready, false);
      await assert.rejects(api.prepare(selection([1])), /manifest quota/);
      h.manifestCache.put = put;
      assert.equal((await api.prepare(selection([1]))).ready, true);
      assert.equal(JSON.parse(await (await h.manifestCache.match(BASE))!.text()).contentVersion, h.f.manifest.contentVersion);
    } finally { await loader.close(); }
  });
  test('successful-looking but discarded manifest writes cannot declare preparation successful', async () => {
    const h = loaderFixture(); h.manifestCache.put = async () => {};
    const loader = h.create(), repo = await loader.load(), api = repo.getOfflineDataset!()!;
    try {
      assert.equal(h.progress.at(-1)?.cacheStatus, 'unavailable');
      await assert.rejects(api.prepare(selection([1])), /manifest could not be verified/);
      assert.equal((await api.inspect(selection([1]))).ready, false);
    } finally { await loader.close(); }
  });
  test('an old tab cannot overwrite a newer startup dataset during offline preparation', async () => {
    const h = await offlineFixture();
    try {
      const newer = structuredClone(h.f.manifest); newer.genomes[0].genomeLength++; identity(newer);
      await h.manifestCache.put(BASE, new Response(JSON.stringify(newer)));
      assert.equal((await h.offline.inspect(selection())).startupManifestAvailable, false);
      await assert.rejects(h.offline.prepare(selection([1])), /Another dataset version/);
      assert.equal(JSON.parse(await (await h.manifestCache.match(BASE))!.text()).contentVersion, newer.contentVersion);
    } finally { await h.loader.close(); }
  });
  test('unavailable browser storage stays distinct from missing or verified data', async () => {
    const h = loaderFixture(), loader = h.create({ openArtifactCache: async () => undefined });
    const repo = await loader.load(), api = repo.getOfflineDataset!()!;
    try {
      assert.equal((await api.inspect(selection([1]))).genomes[0].status, 'unavailable');
      await assert.rejects(api.prepare(selection([1])), /storage is unavailable/);
      assert.equal((await repo.listPhages()).length, 3);
    } finally { await loader.close(); }
  });
  test('cancel preserves verified partial data and resume avoids downloading it again', async () => {
    const h = await offlineFixture(), controller = new AbortController(), chosen = selection([1, 2]);
    try {
      await assert.rejects(h.offline.prepare(chosen, { signal: controller.signal,
        onProgress: progress => { if (progress.completed === 2) controller.abort(); } }), { name: 'AbortError' });
      assert.deepEqual((await h.offline.saved())?.selection, chosen);
      const partial = await h.offline.inspect(chosen);
      assert.deepEqual(partial.genomes.map(row => row.status), ['available', 'missing']);
      const firstUrl = dataArtifactUrl(BASE, h.f.manifest.genomes[0].artifact);
      assert.equal((await h.offline.prepare(chosen)).ready, true);
      assert.equal(h.f.network.filter(url => url === firstUrl).length, 1);
      assert.equal((await h.repo.getGenes(3))[0].id, 30); // Foreground reads still work after cancellation.
    } finally { await h.loader.close(); }
  });
  test('release removes only the reservation, not verified files or the live catalog', async () => {
    const h = await offlineFixture();
    try {
      await h.offline.prepare(selection([1])); await h.offline.release();
      assert.equal(await h.offline.saved(), null);
      assert.equal((await h.offline.inspect(selection([1]))).ready, true);
      assert.equal(await h.repo.getSequenceWindow(1, 0, 8), 'ACGTACGT');
    } finally { await h.loader.close(); }
  });
  test('a cancelled release waiting for the cache lock cannot delete the retained selection', async () => {
    const { withArtifactCacheLock } = await import('./progressive-artifacts');
    const h = await offlineFixture(), controller = new AbortController(); let unlock!: () => void;
    try {
      await h.offline.prepare(selection([1]));
      const holding = withArtifactCacheLock(() => new Promise<void>(resolve => { unlock = resolve; }));
      while (!unlock) await tick();
      const released = h.offline.release(controller.signal); controller.abort(); unlock();
      await holding; await assert.rejects(released, { name: 'AbortError' });
      assert.deepEqual((await h.offline.saved())?.selection, selection([1]));
    } finally { unlock?.(); await h.loader.close(); }
  });
  test('closed repositories reject retained download capabilities instead of starting another job', async () => {
    const h = await offlineFixture(); await h.loader.close();
    assert.throws(() => h.offline.plan(selection([1])), { name: 'AbortError' });
    await assert.rejects(h.offline.prepare(selection([1])), { name: 'AbortError' });
    await assert.rejects(h.offline.inspect(selection([1])), { name: 'AbortError' });
    assert.equal(h.f.network.length, 1);
  });
});
