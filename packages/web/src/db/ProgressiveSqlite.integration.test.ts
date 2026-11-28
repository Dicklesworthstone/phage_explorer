import { describe, test } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import initSqlJs from 'sql.js';
import { publishProgressiveDataset, type DatasetSqlite } from '../../../../scripts/progressive-dataset';
import { SqlJsRepository } from './SqlJsRepository';
import { ProgressivePhageRepository } from './ProgressivePhageRepository';
import { ProgressiveDatabaseLoader } from './ProgressiveDatabaseLoader';
import { VerifiedArtifactStore, type ArtifactCache } from './progressive-artifacts';
import { dataArtifactUrl, type DataArtifact } from './progressive-manifest';

// Exercise the existing native publisher AND real sql.js consumer, not a second
// implementation of either query semantics or partitioning. Fixtures are synthetic.
const require = createRequire(import.meta.url);
const base = 'https://example.test/data/phage.db.manifest.json';
const model = 'fixture-protein-model';
const schema = `
CREATE TABLE phages (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, accession TEXT,
 family TEXT, host TEXT, genome_length INTEGER, gc_content REAL, morphology TEXT,
 lifecycle TEXT, description TEXT, baltimore_group TEXT, genome_type TEXT, pdb_ids TEXT);
CREATE TABLE genes (id INTEGER PRIMARY KEY, phage_id INTEGER, name TEXT, locus_tag TEXT,
 start_pos INTEGER, end_pos INTEGER, strand TEXT, product TEXT, type TEXT, qualifiers TEXT);
CREATE TABLE sequences (id INTEGER PRIMARY KEY, phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
CREATE UNIQUE INDEX chunks ON sequences(phage_id,chunk_index);
CREATE TABLE codon_usage (phage_id INTEGER PRIMARY KEY, aa_counts TEXT, codon_counts TEXT);
CREATE TABLE models (id INTEGER PRIMARY KEY, phage_id INTEGER, ascii_frames TEXT);
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE annotation_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE protein_domains (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
 locus_tag TEXT, domain_id TEXT, domain_name TEXT, domain_type TEXT, start INTEGER,
 end INTEGER, score REAL, e_value REAL, description TEXT);
CREATE TABLE fold_embeddings (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
 model TEXT, dims INTEGER, vector BLOB);
CREATE TABLE fold_embedding_coords (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
 model TEXT, x REAL, y REAL, cluster_id INTEGER, outlier_score REAL);
CREATE TABLE host_trna_pools (id INTEGER PRIMARY KEY, host_name TEXT, host_tax_id INTEGER,
 anticodon TEXT, amino_acid TEXT, codon TEXT, copy_number INTEGER, relative_abundance REAL);
CREATE TABLE tropism_predictions (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER,
 locus_tag TEXT, receptor TEXT, confidence REAL, evidence TEXT, source TEXT);
`;
const sequenceFor = (id: number) => (id === 1 ? 'ACGT' : 'TGCA').repeat(2500) + 'AACGTAA';
function database(): DatasetSqlite { return new BunDatabase(':memory:') as unknown as DatasetSqlite; }
function fixture(): DatasetSqlite {
  const db = database(); db.exec(schema);
  db.query('INSERT INTO preferences VALUES (?,?)').run('theme', 'contrast');
  db.query('INSERT INTO annotation_meta VALUES (?,?)').run('domains', '{"tool":"fixture","version":"1"}');
  db.query('INSERT INTO host_trna_pools VALUES (?,?,?,?,?,?,?,?)').run(1, 'Synthetic host', null, 'AGC', 'A', 'GCT', 2, 0.5);
  for (const id of [1, 2]) {
    const sequence = sequenceFor(id);
    db.query('INSERT INTO phages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, `fixture-${id}`, `Phage ${id} — synthetic`, `SYNTHETIC_${id}`,
      null, 'Synthetic host', sequence.length, 50, null, 'unknown', 'Synthetic fixture only', null, 'dsDNA', '[]');
    db.query('INSERT INTO genes VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, id, id === 1 ? 'gene one' : null, `locus-${id}`, 0, 12, '+', 'Synthetic protein', 'CDS', '{"note":"preserved qualifier"}');
    db.query('INSERT INTO sequences VALUES (?,?,?,?)').run(id * 2, id, 0, sequence.slice(0, 10000));
    db.query('INSERT INTO sequences VALUES (?,?,?,?)').run(id * 2 + 1, id, 1, sequence.slice(10000));
    db.query('INSERT INTO codon_usage VALUES (?,?,?)').run(id, '{"A":4}', '{"GCT":4}');
    db.query('INSERT INTO models VALUES (?,?,?)').run(id, id, '["frame one","frame two"]');
    db.query('INSERT INTO protein_domains VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, id, id, `locus-${id}`, 'PF_SYNTHETIC', 'Synthetic domain', 'fixture', 1, 3, 5, 0.1, 'Not an empirical annotation');
    const vector = new Uint8Array(8); const view = new DataView(vector.buffer);
    view.setFloat32(0, id, true); view.setFloat32(4, id / 2, true);
    db.query('INSERT INTO fold_embeddings VALUES (?,?,?,?,?,?)').run(id, id, id, model, 2, vector);
    db.query('INSERT INTO fold_embedding_coords VALUES (?,?,?,?,?,?,?,?)').run(id, id, id, model, id / 10, id / 20, id, 0.1);
    db.query('INSERT INTO tropism_predictions VALUES (?,?,?,?,?,?,?,?)').run(id, id, id, `locus-${id}`, 'Synthetic receptor', 0.5, '["fixture evidence"]', 'Synthetic source');
  }
  return db;
}
class MemoryCache implements ArtifactCache {
  entries = new Map<string, Response>();
  async match(key: string): Promise<Response | undefined> { return this.entries.get(key)?.clone(); }
  async put(key: string, response: Response): Promise<void> { this.entries.set(key, response.clone()); }
  async delete(key: string): Promise<boolean> { return this.entries.delete(key); }
  async keys(): Promise<Request[]> { return [...this.entries.keys()].map(key => new Request(key)); }
}
async function publish(edit?: (source: DatasetSqlite) => void) {
  const source = fixture();
  const artifacts = new Map<string, Uint8Array>();
  try {
    edit?.(source);
    const monolithic = new Uint8Array(source.serialize());
    const manifest = await publishProgressiveDataset({ source, createDatabase: database,
      writeArtifact: async (item: DataArtifact, bytes: Uint8Array) => { artifacts.set(dataArtifactUrl(base, item), new Uint8Array(bytes)); },
      generatedAt: '2026-01-01T00:00:00Z' });
    assert.deepEqual(new Uint8Array(source.serialize()), monolithic, 'publication leaves the original database unchanged');
    return { monolithic, manifest, artifacts };
  } finally { source.close(); }
}
async function sqlite() {
  // Explicit local WASM bytes avoid any CDN or fixture-network dependency.
  const wasmBinary = await readFile(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary });
  return (bytes: Uint8Array) => new SqlJsRepository(new SQL.Database(bytes));
}

describe('native publication to browser SQLite interoperability', () => {
  test('offline startup restores the selected publication when a newer catalog reuses its row IDs', async () => {
    const first = await publish();
    const second = await publish(source => {
      source.exec("UPDATE phages SET name='New record' WHERE id=2; UPDATE genes SET name='replacement' WHERE phage_id=2");
    });
    const manifests = new MemoryCache(), reserved = new MemoryCache(), artifacts = new MemoryCache();
    const openRepository = await sqlite();
    let publication = first, offline = false;
    const requests: string[] = [];
    const load = () => new ProgressiveDatabaseLoader({ databaseUrl: base.replace('.manifest.json', '') }, {
      openManifestCache: async () => manifests, openReservedManifestCache: async () => reserved,
      openArtifactCache: async () => artifacts, sqlite: async () => openRepository, acceptVersion: () => {},
      fetch: async input => {
        const url = String(input); requests.push(url);
        if (offline) throw new Error('offline');
        if (url === base) return Response.json(publication.manifest);
        const bytes = publication.artifacts.get(url);
        return bytes ? new Response(new Uint8Array(bytes).buffer) : new Response(null, { status: 404 });
      },
    });
    const chosen = { genomeIds: [2], atlasModels: [] };
    const original = load();
    try {
      const repo = await original.load();
      assert.equal((await repo.getOfflineDataset!()!.prepare(chosen)).ready, true);
    } finally { await original.close(); }
    publication = second;
    const updated = load();
    try {
      const repo = await updated.load();
      assert.equal((await repo.getPhageById(2))?.name, 'New record');
      assert.equal((await repo.getGenes(2))[0].name, 'replacement');
    } finally { await updated.close(); }
    offline = true;
    const count = requests.length, restored = load();
    try {
      const repo = await restored.load(), api = repo.getOfflineDataset!()!;
      assert.equal(api.describe().contentVersion, first.manifest.contentVersion);
      assert.equal((await api.inspect(chosen)).ready, true);
      assert.equal((await repo.getPhageById(2))?.name, 'Phage 2 — synthetic');
      assert.equal((await repo.getGenes(2))[0].name, null);
      assert.deepEqual(requests.slice(count), [base]);
      assert.equal((await (await manifests.match(base))!.json()).contentVersion, second.manifest.contentVersion);
    } finally { await restored.close(); }
  });
  test('preserves full records, qualifiers, models, annotations, vectors and chunk boundaries', async () => {
    const published = await publish(); const openRepository = await sqlite();
    const requests: string[] = []; const cache = new MemoryCache();
    const store = new VerifiedArtifactStore({ manifestUrl: base, openCache: async () => cache, fetch: async input => {
      const url = String(input); requests.push(url);
      const bytes = published.artifacts.get(url);
      return bytes ? new Response(new Uint8Array(bytes).buffer) : new Response('missing', { status: 404 });
    } });
    const original = openRepository(published.monolithic);
    const repository = await ProgressivePhageRepository.open({ manifest: published.manifest, store, openRepository,
      residentBytes: published.manifest.catalog.bytes + Math.max(...published.manifest.genomes.map(item => item.artifact.bytes)) });
    try {
      assert.deepEqual(requests, [dataArtifactUrl(base, published.manifest.catalog)]);
      assert.deepEqual(await repository.listPhages(), await original.listPhages());
      assert.deepEqual(await repository.searchPhages('fixture-2'), await original.searchPhages('fixture-2'));
      assert.equal(await repository.getPreference('theme'), 'contrast');
      assert.deepEqual(await repository.getAnnotationMeta('domains'), { tool: 'fixture', version: '1' });
      assert.deepEqual(await repository.getHostTrnaPools('Synthetic host'), await original.getHostTrnaPools('Synthetic host'));
      assert.equal(requests.length, 1, 'catalog queries never open genome shards');
      for (const id of [1, 2, 1]) {
        assert.deepEqual(await repository.getPhageById(id), await original.getPhageById(id));
        assert.deepEqual(await repository.getGenes(id), await original.getGenes(id));
        assert.deepEqual(await repository.getProteinDomains(id), await original.getProteinDomains(id));
        assert.deepEqual(await repository.getFoldEmbeddings(id, model), await original.getFoldEmbeddings(id, model));
        assert.deepEqual((await repository.getFoldEmbeddings(id, model))[0].vector, [id, id / 2]);
        assert.equal(await repository.getSequenceWindow(id, 9998, 10007), sequenceFor(id).slice(9998));
        assert.equal(await repository.getSequenceWindow(id, 0, 10007), sequenceFor(id));
        assert.deepEqual(await repository.getModelFrames(id), ['frame one', 'frame two']);
        assert.deepEqual(await repository.getCodonUsage(id), { aaCounts: { A: 4 }, codonCounts: { GCT: 4 } });
      }
      assert.equal(requests.length, 3, 'returning to an evicted SQL handle reuses verified cached bytes');
      assert.deepEqual(await repository.getLatentSpaceAtlas({ model }), await original.getLatentSpaceAtlas({ model }));
      assert.deepEqual(await repository.getLatentSpaceAtlas({ phageId: 2, model }), await original.getLatentSpaceAtlas({ phageId: 2, model }));
      assert.ok(repository.getResidency().peakBytes <= repository.getResidency().budget);
    } finally { await repository.close(); await original.close(); }
  });

  test('the production loader opens published artifacts and reopens only visited genomes offline', async () => {
    const published = await publish(); const openRepository = await sqlite();
    const manifests = new MemoryCache(); const artifacts = new MemoryCache(); const requests: string[] = [];
    const makeLoader = (offline: boolean) => new ProgressiveDatabaseLoader({ databaseUrl: 'https://example.test/data/phage.db' }, {
      openManifestCache: async () => manifests, openArtifactCache: async () => artifacts,
      sqlite: async () => openRepository, acceptVersion: () => {},
      fetch: async input => {
        if (offline) throw new Error('offline');
        const url = String(input); requests.push(url);
        if (url === base) return new Response(JSON.stringify(published.manifest));
        const bytes = published.artifacts.get(url);
        return bytes ? new Response(new Uint8Array(bytes).buffer) : new Response('missing', { status: 404 });
      },
      legacy: async () => { throw new Error('A v3 deployment must never request the monolithic database.'); },
    });
    const online = makeLoader(false);
    try {
      const repository = await online.load();
      assert.equal((await repository.listPhages()).length, 2);
      assert.equal(await repository.getSequenceWindow(1, 9998, 10007), sequenceFor(1).slice(9998));
      assert.equal(requests.length, 3, 'one manifest, catalog, and selected genome only');
    } finally { await online.close(); }
    const offline = makeLoader(true);
    try {
      const repository = await offline.load();
      assert.equal((await repository.getPhageBySlug('fixture-1'))?.genes[0].qualifiers?.note, 'preserved qualifier');
      assert.equal(await repository.getSequenceWindow(1, 0, 10007), sequenceFor(1));
      await assert.rejects(repository.getPhageById(2), /offline/);
    } finally { await offline.close(); }
  });
});

// These fixtures bypass the progressive publisher deliberately: legacy browser
// datasets and native user databases must enforce the same exact-window contract.
const windowSequence = 'A'.repeat(10000) + 'C'.repeat(10000) + 'G'.repeat(10000) + 'TRYSWKM';
const windowChunks = Array.from({ length: 4 }, (_, chunkIndex) => ({
  chunkIndex, sequence: windowSequence.slice(chunkIndex * 10000, (chunkIndex + 1) * 10000),
}));
async function withWindowRepository(
  backend: 'native' | 'browser',
  chunks: readonly { chunkIndex: number; sequence: string }[],
  genomeLength: number,
  verify: (repository: Pick<SqlJsRepository, 'getSequenceWindow'>) => Promise<void>,
): Promise<void> {
  const source = database();
  let repository: SqlJsRepository | BunSqliteRepository | null = null;
  try {
    source.exec(schema);
    source.query('INSERT INTO phages (id,slug,name,accession,genome_length,pdb_ids) VALUES (?,?,?,?,?,?)')
      .run(1, 'window-fixture', 'Synthetic chunk fixture', 'SYNTHETIC_WINDOW', genomeLength, '[]');
    for (const chunk of chunks) {
      source.query('INSERT INTO sequences (phage_id,chunk_index,sequence) VALUES (?,?,?)')
        .run(1, chunk.chunkIndex, chunk.sequence);
    }
    const bytes = new Uint8Array(source.serialize());
    if (backend === 'browser') repository = (await sqlite())(bytes);
    else {
      const directory = await mkdtemp(join(tmpdir(), 'phage-sequence-window-'));
      const path = join(directory, 'fixture.db');
      await writeFile(path, bytes);
      repository = new BunSqliteRepository(path, { readonly: true });
    }
    await verify(repository);
  } finally {
    await repository?.close();
    source.close();
  }
}

for (const backend of ['native', 'browser'] as const) {
  describe(backend + ' SQLite exact sequence windows', () => {
    test('preserves bases across all chunk boundaries and clips only at the genome end', async () => {
      await withWindowRepository(backend, windowChunks, windowSequence.length, async repository => {
        const offsets = [0, 1, 9998, 9999, 10000, 10001, 19999, 20000, 29999, 30000, 30006, 30007, 40000];
        for (const start of offsets) {
          for (const end of offsets.filter(value => value >= start)) {
            assert.equal(await repository.getSequenceWindow(1, start, end), windowSequence.slice(start, end),
              'exact interval [' + start + ', ' + end + ')');
          }
        }
        assert.equal(await repository.getSequenceWindow(999, 0, 10), '');
      });
    });

    test('rejects a missing interior chunk even when later bases could fill the requested length', async () => {
      await withWindowRepository(backend, windowChunks.filter(chunk => chunk.chunkIndex !== 1), windowSequence.length, async repository => {
        // The previous inclusive end-chunk query returned 10,000 Gs here:
        // the length looked correct, but every base belonged to chunk 2.
        await assert.rejects(repository.getSequenceWindow(1, 10000, 20000), /Incomplete genome sequence/);
        await assert.rejects(repository.getSequenceWindow(1, 9998, 20004), /Incomplete genome sequence/);
        await assert.rejects(repository.getSequenceWindow(1, 0, windowSequence.length), /Incomplete genome sequence/);
        assert.equal(await repository.getSequenceWindow(1, 0, 10000), 'A'.repeat(10000));
        assert.equal(await repository.getSequenceWindow(1, 20000, 20004), 'GGGG');
      });
    });

    test('rejects short and long interior chunks instead of shifting neighboring bases', async () => {
      for (const sequence of ['A'.repeat(9999), 'A'.repeat(10001)]) {
        const chunks = [{ chunkIndex: 0, sequence }, ...windowChunks.slice(1)];
        await withWindowRepository(backend, chunks, windowSequence.length, async repository => {
          // With 9,999 As, the previous join/substr returned ACCCCC rather than AACCCC.
          await assert.rejects(repository.getSequenceWindow(1, 9998, 10004), /Incomplete genome sequence/);
          assert.equal(await repository.getSequenceWindow(1, 10000, 10004), 'CCCC');
        });
      }
    });

    test('requires the terminal chunk and its full declared length', async () => {
      for (const terminal of ['', 'TRYSWK', 'TRYSWKMA']) {
        const chunks = [...windowChunks.slice(0, 3), { chunkIndex: 3, sequence: terminal }];
        await withWindowRepository(backend, chunks, windowSequence.length, async repository => {
          await assert.rejects(repository.getSequenceWindow(1, 30000, 30001), /Incomplete genome sequence/);
          await assert.rejects(repository.getSequenceWindow(1, 29999, 40000), /Incomplete genome sequence/);
          // A half-open interval ending at this boundary does not depend on chunk 3.
          assert.equal(await repository.getSequenceWindow(1, 29998, 30000), 'GG');
        });
      }
      await withWindowRepository(backend, [], windowSequence.length, async repository => {
        await assert.rejects(repository.getSequenceWindow(1, 0, 1), /Incomplete genome sequence/);
      });
    });

    test('rejects invalid coordinates rather than truncating or reversing them', async () => {
      await withWindowRepository(backend, windowChunks, windowSequence.length, async repository => {
        for (const [start, end] of [[-1, 4], [4, 1], [0.5, 4], [0, 4.5], [NaN, 4], [0, NaN], [0, Infinity], [0, Number.MAX_SAFE_INTEGER + 1]]) {
          await assert.rejects(repository.getSequenceWindow(1, start, end), /Invalid sequence window coordinates/);
        }
      });
    });

    test('rejects invalid declared lengths instead of returning unbound bases', async () => {
      for (const length of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        await withWindowRepository(backend, windowChunks, length, async repository => {
          await assert.rejects(repository.getSequenceWindow(1, 0, 1), /Invalid genome length/);
        });
      }
    });
  });
}
