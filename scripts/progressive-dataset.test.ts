import { describe, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publishProgressiveDataset, type DatasetSqlite } from './progressive-dataset';
import { verifyProgressiveManifest, type DataArtifact } from '../packages/web/src/db/progressive-manifest';

const schema = `
PRAGMA user_version=7;
CREATE TABLE phages (id INTEGER PRIMARY KEY, name TEXT, genome_length INTEGER);
CREATE TABLE genes (id INTEGER PRIMARY KEY, phage_id INTEGER, name TEXT, locus_tag TEXT, product TEXT);
CREATE TABLE sequences (id INTEGER PRIMARY KEY, phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
CREATE UNIQUE INDEX chunks ON sequences(phage_id,chunk_index);
CREATE TABLE codon_usage (phage_id INTEGER PRIMARY KEY, aa_counts TEXT, codon_counts TEXT);
CREATE TABLE models (id INTEGER PRIMARY KEY, phage_id INTEGER, obj_data BLOB);
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE annotation_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE fold_embedding_coords (id INTEGER PRIMARY KEY, phage_id INTEGER, gene_id INTEGER, model TEXT, x REAL, y REAL, cluster_id INTEGER, outlier_score REAL);
CREATE TABLE extra_annotations (id INTEGER PRIMARY KEY, phage_id INTEGER, evidence TEXT);
`;
function database(): DatasetSqlite { return new Database(':memory:') as unknown as DatasetSqlite; }
function fixture(total = 2): DatasetSqlite {
  const db = database(); db.exec(schema);
  db.query('INSERT INTO preferences VALUES (?,?)').run('theme', 'contrast');
  db.query('INSERT INTO annotation_meta VALUES (?,?)').run('tool', '{"name":"fixture","version":"1"}');
  for (let id = 1; id <= total; id++) {
    const sequence = 'ACGT'.repeat(2500) + 'AACGTAA';
    db.query('INSERT INTO phages VALUES (?,?,?)').run(id, `Phage ${id} — synthetic`, sequence.length);
    db.query('INSERT INTO genes VALUES (?,?,?,?,?)').run(id, id, `gene ${id}`, `locus-${id}`, 'Known annotation');
    db.query('INSERT INTO sequences VALUES (?,?,?,?)').run(id * 2, id, 0, sequence.slice(0, 10000));
    db.query('INSERT INTO sequences VALUES (?,?,?,?)').run(id * 2 + 1, id, 1, sequence.slice(10000));
    db.query('INSERT INTO codon_usage VALUES (?,?,?)').run(id, '{"A":10}', '{"GCT":10}');
    db.query('INSERT INTO models VALUES (?,?,?)').run(id, id, new Uint8Array(8192).fill(id));
    db.query('INSERT INTO fold_embedding_coords VALUES (?,?,?,?,?,?,?,?)').run(id, id, id, 'fixture-model', id / 10, id / 20, id % 2, 0.1);
    db.query('INSERT INTO extra_annotations VALUES (?,?,?)').run(id, id, `Evidence ${id}`);
  }
  return db;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function collector() {
  const artifacts = new Map<string, { descriptor: DataArtifact; bytes: Uint8Array }>();
  return { artifacts, writeArtifact: async (descriptor: DataArtifact, bytes: Uint8Array) => {
    artifacts.set(descriptor.path, { descriptor, bytes: new Uint8Array(bytes) });
  } };
}
function open(bytes: Uint8Array): DatasetSqlite { return Database.deserialize(bytes) as unknown as DatasetSqlite; }
function all(db: DatasetSqlite, sql: string) { return Array.from(db.query(sql).iterate()); }

describe('progressive SQLite publication', () => {
  test('preserves every table row, annotations, blobs, and global references without changing the source', async () => {
    const source = fixture(); const output = collector(); const before = sha(source.serialize());
    try {
      const manifest = await publishProgressiveDataset({ source, createDatabase: database, ...output });
      await verifyProgressiveManifest(manifest);
      assert.equal(sha(source.serialize()), before);
      const catalog = open(output.artifacts.get(manifest.catalog.path)!.bytes);
      try {
        assert.deepEqual(all(catalog, 'SELECT * FROM phages ORDER BY id'), all(source, 'SELECT * FROM phages ORDER BY id'));
        assert.deepEqual(all(catalog, 'SELECT * FROM annotation_meta'), all(source, 'SELECT * FROM annotation_meta'));
        assert.deepEqual(all(catalog, 'SELECT * FROM preferences'), all(source, 'SELECT * FROM preferences'));
        assert.equal(all(catalog, 'SELECT * FROM sequences').length, 0);
        assert.equal(all(catalog, 'SELECT * FROM genes').length, 0);
        assert.equal((catalog.query('PRAGMA user_version').get() as {user_version:number}).user_version, 7);
      } finally { catalog.close(); }
      for (const genome of manifest.genomes) {
        const artifact = output.artifacts.get(genome.artifact.path)!;
        assert.equal(sha(artifact.bytes), artifact.descriptor.sha256);
        const shard = open(artifact.bytes);
        try {
          assert.equal(all(shard, 'SELECT * FROM phages').length, 1);
          for (const table of ['genes', 'sequences', 'models', 'codon_usage', 'fold_embedding_coords', 'extra_annotations']) {
            assert.deepEqual(all(shard, `SELECT * FROM ${table} ORDER BY 1`), all(source, `SELECT * FROM ${table} WHERE phage_id=${genome.id} ORDER BY 1`));
          }
        } finally { shard.close(); }
      }
      const points = manifest.atlas.flatMap(group => group.pages.flatMap(page => JSON.parse(Buffer.from(output.artifacts.get(page.path)!.bytes).toString('utf8'))));
      assert.equal(points.length, 2);
      assert.ok(points.some(point => point.phageName === 'Phage 2 — synthetic' && point.product === 'Known annotation'));
      assert.equal(manifest.bytes.artifacts, [...output.artifacts.values()].reduce((sum, item) => sum + item.bytes.length, 0));
    } finally { source.close(); }
  });
  test('dataset identity is reproducible and independent of publication timestamps', async () => {
    const source = fixture();
    try {
      const a = await publishProgressiveDataset({ source, createDatabase: database, ...collector(), generatedAt: '2026-01-01T00:00:00Z' });
      const b = await publishProgressiveDataset({ source, createDatabase: database, ...collector(), generatedAt: '2026-02-01T00:00:00Z' });
      assert.equal(a.contentVersion, b.contentVersion);
      source.query('UPDATE extra_annotations SET evidence=? WHERE id=1').run('Different measurement');
      const c = await publishProgressiveDataset({ source, createDatabase: database, ...collector() });
      assert.notEqual(c.contentVersion, b.contentVersion);
      assert.equal(c.catalog.sha256, b.catalog.sha256);
      assert.notEqual(c.genomes[0].artifact.sha256, b.genomes[0].artifact.sha256);
      assert.equal(c.genomes[1].artifact.sha256, b.genomes[1].artifact.sha256);
    } finally { source.close(); }
  });
  test('larger datasets keep the startup catalog independent of sequence/model payloads', async () => {
    const source = fixture(48);
    try {
      const manifest = await publishProgressiveDataset({ source, createDatabase: database, ...collector() });
      assert.equal(manifest.genomes.length, 48);
      assert.ok(manifest.catalog.bytes < manifest.bytes.artifacts / 20);
      assert.ok(manifest.bytes.largestArtifact < manifest.bytes.artifacts / 10);
    } finally { source.close(); }
  });
  test('rejects orphaned ownership instead of dropping rows', async () => {
    const source = fixture();
    try {
      source.query('INSERT INTO extra_annotations VALUES (?,?,?)').run(999, 999, 'Do not lose this row');
      await assert.rejects(publishProgressiveDataset({ source, createDatabase: database, ...collector() }), /without a catalog genome/);
      assert.equal(all(source, 'SELECT * FROM extra_annotations').length, 3);
    } finally { source.close(); }
  });
  test('rejects missing/truncated/misordered sequence chunks before publishing a usable manifest', async () => {
    for (const mutation of ['UPDATE sequences SET sequence=\'A\' WHERE id=2', 'UPDATE sequences SET chunk_index=5 WHERE id=2', 'UPDATE phages SET genome_length=20000 WHERE id=1']) {
      const source = fixture();
      try {
        source.exec(mutation);
        await assert.rejects(publishProgressiveDataset({ source, createDatabase: database, ...collector() }), /chunks|declares/);
      } finally { source.close(); }
    }
  });
  test('artifact write failure releases the read transaction and leaves the source unchanged', async () => {
    const source = fixture(); const before = sha(source.serialize());
    try {
      await assert.rejects(publishProgressiveDataset({ source, createDatabase: database, writeArtifact: async () => { throw new Error('disk full'); } }), /disk full/);
      assert.equal(sha(source.serialize()), before);
      await publishProgressiveDataset({ source, createDatabase: database, ...collector() });
    } finally { source.close(); }
  });
  test('rejects cross-genome atlas gene references', async () => {
    const source = fixture();
    try {
      source.exec('UPDATE fold_embedding_coords SET gene_id=2 WHERE id=1');
      await assert.rejects(publishProgressiveDataset({ source, createDatabase: database, ...collector() }), /orphaned gene references/);
    } finally { source.close(); }
  });
  test('refuses an empty catalog instead of declaring successful readiness', async () => {
    const source = fixture(0);
    try { await assert.rejects(publishProgressiveDataset({ source, createDatabase: database, ...collector() }), /empty/); }
    finally { source.close(); }
  });
});
