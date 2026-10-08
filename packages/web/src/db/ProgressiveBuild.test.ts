import { describe, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWebPublicAssets, verifyWebDataset } from '../../build';
import { publishProgressiveDatasetToDirectory } from '../../../../scripts/build-progressive-web-db';
import type { DatasetSqlite } from '../../../../scripts/progressive-dataset';
import { datasetArtifacts } from './progressive-manifest';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const createDatabase = (): DatasetSqlite => new Database(':memory:') as unknown as DatasetSqlite;
const openSource = (path: string): DatasetSqlite => new Database(path, { readonly: true }) as unknown as DatasetSqlite;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phage-build-test-'));
  const publicDirectory = join(root, 'public'), stagingParent = join(root, 'staged');
  await mkdir(publicDirectory); await mkdir(stagingParent);
  const path = join(publicDirectory, 'phage.db');
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE phages (id INTEGER PRIMARY KEY, name TEXT, genome_length INTEGER);
      CREATE TABLE genes (id INTEGER PRIMARY KEY, phage_id INTEGER, product TEXT);
      CREATE TABLE sequences (id INTEGER PRIMARY KEY, phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
      CREATE TABLE models (id INTEGER PRIMARY KEY, phage_id INTEGER, obj_data BLOB);
      CREATE TABLE codon_usage (phage_id INTEGER PRIMARY KEY, aa_counts TEXT, codon_counts TEXT);
      CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE annotation_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE extra_annotations (id INTEGER PRIMARY KEY, phage_id INTEGER, evidence TEXT);`);
    db.query('INSERT INTO annotation_meta VALUES (?,?)').run('fixture', 'Original synthetic reference');
    for (const id of [1, 2]) {
      db.query('INSERT INTO phages VALUES (?,?,?)').run(id, `Synthetic ${id}`, 4);
      db.query('INSERT INTO genes VALUES (?,?,?)').run(id, id, `Deposited annotation ${id}`);
      db.query('INSERT INTO sequences VALUES (?,?,?,?)').run(id, id, 0, id === 1 ? 'ACGT' : 'TGCA');
      db.query('INSERT INTO models VALUES (?,?,?)').run(id, id, new Uint8Array([0, id, 255]));
      db.query('INSERT INTO extra_annotations VALUES (?,?,?)').run(id, id, `Source evidence ${id}`);
    }
  } finally { db.close(); }
  await writeFile(join(root, 'phage.db'), 'wrong build intermediate');
  await writeFile(join(publicDirectory, 'phage.db.manifest.json'), '{"version":2,"old":true}');
  await writeFile(join(publicDirectory, 'phage.db.gz'), 'old gzip');
  // An empty inactive journal is valid. A forged hot journal requires recovery
  // writes and would correctly make a read-only source unusable.
  await writeFile(join(publicDirectory, 'phage.db-journal'), new Uint8Array());
  await mkdir(join(publicDirectory, 'phage-data'));
  await writeFile(join(publicDirectory, 'phage-data', 'old-generation.json'), 'old unreferenced data');
  await writeFile(join(publicDirectory, 'offline.html'), '<h1>Offline page</h1>');
  await mkdir(join(publicDirectory, 'images'));
  await writeFile(join(publicDirectory, 'images', 'icon.png'), new Uint8Array([137, 80, 78, 71]));
  return { root, path, publicDirectory, stagingParent, openSource, createDatabase };
}

describe('production catalog-first publication', () => {
  test('stages only the new generation and leaves canonical and terminal assets untouched', async () => {
    const input = await fixture();
    const sourceBefore = hash(await readFile(input.path));
    const result = await prepareWebPublicAssets(input);
    assert.notEqual(result.directory, input.publicDirectory);
    assert.equal(result.manifest.version, 3);
    assert.equal(result.manifest.genomes.length, 2);
    assert.deepEqual((await readdir(result.directory)).sort(), ['images', 'offline.html', 'phage-data', 'phage.db.manifest.json']);
    assert.equal(await readFile(join(result.directory, 'offline.html'), 'utf8'), '<h1>Offline page</h1>');
    assert.deepEqual(await readFile(join(result.directory, 'images', 'icon.png')), Buffer.from([137, 80, 78, 71]));
    assert.equal(hash(await readFile(input.path)), sourceBefore);
    assert.equal(await readFile(join(input.publicDirectory, 'phage.db.manifest.json'), 'utf8'), '{"version":2,"old":true}');
    assert.equal(await readFile(join(input.publicDirectory, 'phage.db.gz'), 'utf8'), 'old gzip');
    assert.equal(await readFile(join(input.publicDirectory, 'phage-data', 'old-generation.json'), 'utf8'), 'old unreferenced data');
    assert.equal(await readFile(join(input.root, 'phage.db'), 'utf8'), 'wrong build intermediate');
    assert.equal((await readdir(join(result.directory, 'phage-data'))).length, datasetArtifacts(result.manifest).length);
  });
  test('retains annotated rows and binary model bytes in the correct real SQLite shards', async () => {
    const input = await fixture(); const { directory, manifest } = await prepareWebPublicAssets(input);
    const catalog = new Database(join(directory, manifest.catalog.path), { readonly: true });
    try {
      assert.equal((catalog.query('SELECT COUNT(*) AS n FROM phages').get() as {n:number}).n, 2);
      assert.equal((catalog.query('SELECT COUNT(*) AS n FROM genes').get() as {n:number}).n, 0);
      assert.equal((catalog.query('SELECT value FROM annotation_meta').get() as {value:string}).value, 'Original synthetic reference');
    } finally { catalog.close(); }
    for (const genome of manifest.genomes) {
      const db = new Database(join(directory, genome.artifact.path), { readonly: true });
      try {
        assert.equal((db.query('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check, 'ok');
        assert.equal((db.query('SELECT sequence FROM sequences').get() as {sequence:string}).sequence, genome.id === 1 ? 'ACGT' : 'TGCA');
        assert.equal((db.query('SELECT evidence FROM extra_annotations').get() as {evidence:string}).evidence, `Source evidence ${genome.id}`);
        assert.deepEqual(new Uint8Array((db.query('SELECT obj_data FROM models').get() as {obj_data:Uint8Array}).obj_data), new Uint8Array([0, genome.id, 255]));
      } finally { db.close(); }
    }
  });
  test('repeated builds have the same content identity without inheriting stale artifacts', async () => {
    const input = await fixture();
    const first = await prepareWebPublicAssets(input), second = await prepareWebPublicAssets(input);
    assert.notEqual(first.directory, second.directory);
    assert.equal(first.manifest.contentVersion, second.manifest.contentVersion);
    await verifyWebDataset(first.directory, second.manifest);
  });
  test('never substitutes the repository-root intermediate when canonical input is absent', async () => {
    const input = await fixture(); await rename(input.path, input.path + '.preserved');
    await assert.rejects(prepareWebPublicAssets(input), /ENOENT/);
    assert.deepEqual(await readdir(input.stagingParent), []);
  });
  test('incomplete sequences fail before any new usable manifest or source overwrite', async () => {
    const input = await fixture(); const db = new Database(input.path);
    try { db.exec("UPDATE sequences SET sequence='A' WHERE phage_id=2"); } finally { db.close(); }
    const before = hash(await readFile(input.path));
    await assert.rejects(prepareWebPublicAssets(input), /chunks|declares/);
    for (const stage of await readdir(input.stagingParent)) {
      await assert.rejects(readFile(join(input.stagingParent, stage, 'phage.db.manifest.json')), /ENOENT/);
    }
    assert.equal(hash(await readFile(input.path)), before);
    assert.equal(await readFile(join(input.publicDirectory, 'phage.db.manifest.json'), 'utf8'), '{"version":2,"old":true}');
  });
  test('a post-build verification detects truncated and same-size corrupted artifacts', async () => {
    const input = await fixture(); const { directory, manifest } = await prepareWebPublicAssets(input);
    const path = join(directory, manifest.genomes[0].artifact.path), bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    await assert.rejects(verifyWebDataset(directory, manifest), /size\/type/);
    bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
    await assert.rejects(verifyWebDataset(directory, manifest), /checksum/);
  });
  test('a post-build verification detects a valid manifest from the wrong dataset', async () => {
    const input = await fixture(); const first = await prepareWebPublicAssets(input);
    const db = new Database(input.path);
    try { db.exec("UPDATE extra_annotations SET evidence='Changed source' WHERE phage_id=2"); } finally { db.close(); }
    const second = await prepareWebPublicAssets(input);
    assert.notEqual(first.manifest.contentVersion, second.manifest.contentVersion);
    await assert.rejects(verifyWebDataset(first.directory, second.manifest), /differs/);
  });
  test('post-build verification also detects missing artifacts', async () => {
    const input = await fixture(); const { directory, manifest } = await prepareWebPublicAssets(input);
    const path = join(directory, manifest.catalog.path); await rename(path, path + '.preserved');
    await assert.rejects(verifyWebDataset(directory, manifest), /ENOENT/);
  });
  test('the standalone writer preserves the old pointer when a referenced artifact is corrupt', async () => {
    const input = await fixture(); const { directory, manifest } = await prepareWebPublicAssets(input);
    const pointer = await readFile(join(directory, 'phage.db.manifest.json'), 'utf8');
    const path = join(directory, manifest.catalog.path), bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
    const source = openSource(input.path);
    try { await assert.rejects(publishProgressiveDatasetToDirectory({ source, createDatabase, outputDirectory: directory }), /immutable artifact is corrupt/); }
    finally { source.close(); }
    assert.equal(await readFile(join(directory, 'phage.db.manifest.json'), 'utf8'), pointer);
  });
  test('the completed public tree survives a bundler-style copy and retains valid byte identities', async () => {
    const input = await fixture(); const { directory, manifest } = await prepareWebPublicAssets(input);
    const output = join(input.root, 'dist'); await cp(directory, output, { recursive: true });
    await verifyWebDataset(output, manifest);
    for (const item of datasetArtifacts(manifest)) assert.equal(hash(await readFile(join(output, item.path))), item.sha256);
  });
  (process.platform === 'win32' ? test.skip : test)('rejects symlinked public assets instead of following paths outside the source tree', async () => {
    const input = await fixture(); await symlink(join(input.root, 'phage.db'), join(input.publicDirectory, 'images', 'unexpected'));
    await assert.rejects(prepareWebPublicAssets(input), /symbolic links/);
  });
});
