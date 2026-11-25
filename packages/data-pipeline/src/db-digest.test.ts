import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildWebDatabase, checkWebDatabase, computeDatabaseContentDigest } from '../../../scripts/build-web-db';

async function publicationFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phage-publication-'));
  const source = join(directory, 'phage.db');
  const outputDirectory = join(directory, 'public');
  const db = new Database(source);
  try {
    db.exec(`CREATE TABLE genes (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE fold_embedding_coords (gene_id INTEGER REFERENCES genes(id), x REAL, y REAL);
      CREATE TABLE annotation_meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO genes VALUES (1, 'first'), (2, 'second');
      INSERT INTO fold_embedding_coords VALUES (1, 1.5, 2.5), (2, 3.5, 4.5);
      INSERT INTO annotation_meta VALUES ('coverage', '{"rows":2}');`);
  } finally { db.close(); }
  return { directory, source, outputDirectory };
}

function updateAtlas(source: string, value: number) {
  const db = new Database(source);
  try { db.query('UPDATE fold_embedding_coords SET x = ? WHERE gene_id = 1').run(value); }
  finally { db.close(); }
}

function atlasCoordinate(bytes: Uint8Array): number {
  const db = Database.deserialize(Buffer.from(bytes));
  try {
    return db.query<{ x: number }, []>('SELECT x FROM fold_embedding_coords WHERE gene_id = 1').get()!.x;
  } finally { db.close(); }
}

describe('computeDatabaseContentDigest', () => {
  it('distinguishes complete NUL-bearing text from its prefix, other text and blobs', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE content (value); INSERT INTO content VALUES (NULL)');
      // SQLite quote() is intentionally lossy for these strings; the logical
      // dataset identity must not inherit that behavior.
      expect(db.query('SELECT quote(?) AS quoted').get('prefix\0first')).toEqual({ quoted: "'prefix'" });
      expect(db.query('SELECT quote(?) AS quoted').get('prefix\0second')).toEqual({ quoted: "'prefix'" });
      const values = [null, '', 'prefix', 'prefix\0', 'prefix\0first', 'prefix\0second',
        '\0prefix', 'prefix\0\0first', 'prefix\0"\',\nnext', 'TEXT:"prefix\\u0000first"',
        new TextEncoder().encode('prefix\0first')];
      const hashes = values.map(value => {
        db.query('UPDATE content SET value = ?').run(value);
        return computeDatabaseContentDigest(db);
      });
      expect(new Set(hashes).size).toBe(values.length);
    } finally { db.close(); }
  });

  it('preserves Unicode around NUL regardless of the SQLite text encoding', () => {
    const hashes: string[] = [];
    for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
      const db = new Database(':memory:');
      try {
        db.exec(`PRAGMA encoding = '${encoding}'; CREATE TABLE content (first TEXT, second TEXT)`);
        expect(db.query('PRAGMA encoding').get()).toEqual({ encoding });
        db.query('INSERT INTO content VALUES (?, ?)').run('é\0𝄞\uE000', 'text\0with,"\'\n\\boundaries');
        hashes.push(computeDatabaseContentDigest(db));
        db.exec('VACUUM');
        expect(computeDatabaseContentDigest(db)).toBe(hashes[hashes.length - 1]);
        db.query('UPDATE content SET first = ?').run('é\0𝄢\uE000');
        expect(computeDatabaseContentDigest(db)).not.toBe(hashes[hashes.length - 1]);
      } finally { db.close(); }
    }
    expect(new Set(hashes).size).toBe(1);
  });

  it('includes user tables and indexes whose names resemble the reserved prefix', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE genes (id INTEGER PRIMARY KEY)');
      const initial = computeDatabaseContentDigest(db);
      db.exec('CREATE TABLE sqlitex_annotations (value TEXT)');
      const tableAdded = computeDatabaseContentDigest(db);
      expect(tableAdded).not.toBe(initial);
      db.exec("INSERT INTO sqlitex_annotations VALUES ('first')");
      const rowAdded = computeDatabaseContentDigest(db);
      expect(rowAdded).not.toBe(tableAdded);
      db.exec("UPDATE sqlitex_annotations SET value = 'second'");
      const rowChanged = computeDatabaseContentDigest(db);
      expect(rowChanged).not.toBe(rowAdded);
      db.exec('CREATE INDEX sqlitex_lookup ON sqlitex_annotations(value)');
      expect(computeDatabaseContentDigest(db)).not.toBe(rowChanged);
    } finally { db.close(); }
  });

  it('is deterministic and invariant across VACUUM and REINDEX', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT, val REAL);
      INSERT INTO test_table VALUES (1, 'alpha', 3.14), (2, 'beta', 2.71);
    `);

    const hash1 = computeDatabaseContentDigest(db);
    db.run('VACUUM');
    const hash2 = computeDatabaseContentDigest(db);
    db.run('REINDEX');
    const hash3 = computeDatabaseContentDigest(db);

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
    db.close();
  });

  it('detects data changes and restores hash on revert', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT, val REAL);
      INSERT INTO test_table VALUES (1, 'alpha', 3.14);
    `);

    const baselineHash = computeDatabaseContentDigest(db);

    // Insert row
    db.run(`INSERT INTO test_table VALUES (2, 'gamma', 1.41)`);
    const changedHash = computeDatabaseContentDigest(db);
    expect(changedHash).not.toBe(baselineHash);

    // Delete row
    db.run(`DELETE FROM test_table WHERE id = 2`);
    const revertedHash = computeDatabaseContentDigest(db);
    expect(revertedHash).toBe(baselineHash);
    db.close();
  });

  it('includes column names, constraints, indexes and schema version', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ("same");');
      const original = computeDatabaseContentDigest(db);
      db.exec('ALTER TABLE sample RENAME COLUMN value TO renamed');
      const renamed = computeDatabaseContentDigest(db);
      expect(renamed).not.toBe(original);
      db.exec('CREATE UNIQUE INDEX unique_sample ON sample(renamed)');
      const indexed = computeDatabaseContentDigest(db);
      expect(indexed).not.toBe(renamed);
      db.exec('PRAGMA user_version=1');
      expect(computeDatabaseContentDigest(db)).not.toBe(indexed);
    } finally {
      db.close();
    }
  });

  it('handles quoted schema identifiers and insertion-order differences', () => {
    const first = new Database(':memory:');
    const second = new Database(':memory:');
    try {
      for (const db of [first, second]) db.exec('CREATE TABLE "a""b" ("c""d" TEXT)');
      first.exec('INSERT INTO "a""b" VALUES (\'a,b\'), (\'c\')');
      second.exec('INSERT INTO "a""b" VALUES (\'c\'), (\'a,b\')');
      expect(computeDatabaseContentDigest(first)).toBe(computeDatabaseContentDigest(second));
    } finally {
      first.close();
      second.close();
    }
  });
});

describe('verified database publication', () => {
  it('changes the published identity when an annotation changes after a NUL', async () => {
    const fixture = await publicationFixture();
    const update = (value: string) => {
      const db = new Database(fixture.source);
      try { db.query('UPDATE genes SET name = ? WHERE id = 1').run(value); }
      finally { db.close(); }
    };
    update('protein\0first');
    const previous = await buildWebDatabase({ ...fixture, immutable: true });
    update('protein\0second');
    const current = await buildWebDatabase({ ...fixture, immutable: true });
    expect(current.contentVersion).not.toBe(previous.contentVersion);
    expect(await checkWebDatabase(fixture.outputDirectory)).toEqual(current);
    const bytes = await readFile(join(fixture.outputDirectory, current.artifacts!.sqlite.path));
    const published = Database.deserialize(bytes);
    try {
      expect(published.query('SELECT name FROM genes WHERE id = 1').get()).toEqual({ name: 'protein\0second' });
    } finally { published.close(); }
    // The previous immutable generation remains independently verifiable.
    expect(await checkWebDatabase(fixture.outputDirectory, previous)).toEqual(previous);
  });

  it('keeps portable release output complete and source bytes unchanged', async () => {
    const fixture = await publicationFixture();
    const original = await readFile(fixture.source);
    const manifest = await buildWebDatabase(fixture);
    const raw = await readFile(join(fixture.outputDirectory, 'phage.db'));
    const compressed = await readFile(join(fixture.outputDirectory, 'phage.db.gz'));
    expect(manifest.artifacts).toBeUndefined();
    expect(await readFile(fixture.source)).toEqual(original);
    expect(gunzipSync(compressed)).toEqual(raw);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.sha256);
    expect(atlasCoordinate(raw)).toBe(1.5);
    expect(await checkWebDatabase(fixture.outputDirectory)).toEqual(manifest);
  });

  it('preserves old generations across atlas-only updates and alias edits', async () => {
    const fixture = await publicationFixture();
    const old = await buildWebDatabase({ ...fixture, immutable: true });
    const oldRaw = await readFile(join(fixture.outputDirectory, old.artifacts!.sqlite.path));
    const oldGzip = await readFile(join(fixture.outputDirectory, old.artifacts!.gzip.path));
    updateAtlas(fixture.source, 9.5);
    const original = await readFile(fixture.source);
    const current = await buildWebDatabase({ ...fixture, immutable: true });
    expect(await readFile(fixture.source)).toEqual(original);
    expect(current.contentVersion).not.toBe(old.contentVersion);
    expect(current.artifacts!.sqlite.path).not.toBe(old.artifacts!.sqlite.path);
    expect(atlasCoordinate(await readFile(join(fixture.outputDirectory, current.artifacts!.sqlite.path)))).toBe(9.5);
    expect(atlasCoordinate(oldRaw)).toBe(1.5);
    expect(await readFile(join(fixture.outputDirectory, old.artifacts!.sqlite.path))).toEqual(oldRaw);
    expect(await readFile(join(fixture.outputDirectory, old.artifacts!.gzip.path))).toEqual(oldGzip);
    expect(await readFile(join(fixture.outputDirectory, 'phage.db'))).toEqual(await readFile(join(fixture.outputDirectory, current.artifacts!.sqlite.path)));
    // Simulate an older producer overwriting the conventional raw alias. The
    // immutable generation must have a different inode and stay unchanged.
    await writeFile(join(fixture.outputDirectory, 'phage.db'), oldRaw);
    expect(await checkWebDatabase(fixture.outputDirectory)).toEqual(current);
    expect(await checkWebDatabase(fixture.outputDirectory, old)).toEqual(old);
  });

  it('leaves the previous manifest and referenced files usable after late publication failure', async () => {
    const fixture = await publicationFixture();
    const old = await buildWebDatabase({ ...fixture, immutable: true });
    const manifestPath = join(fixture.outputDirectory, 'phage.db.manifest.json');
    const previous = await readFile(manifestPath);
    const oldRaw = await readFile(join(fixture.outputDirectory, old.artifacts!.sqlite.path));
    updateAtlas(fixture.source, 8.5);
    const original = await readFile(fixture.source);
    // A real filesystem fault after immutable objects are published: a
    // directory prevents replacement of the portable gzip alias. No mocks.
    await rename(join(fixture.outputDirectory, 'phage.db.gz'), join(fixture.outputDirectory, 'previous.db.gz'));
    await mkdir(join(fixture.outputDirectory, 'phage.db.gz'));
    await expect(buildWebDatabase({ ...fixture, immutable: true })).rejects.toThrow();
    expect(await readFile(fixture.source)).toEqual(original);
    expect(await readFile(manifestPath)).toEqual(previous);
    expect(await checkWebDatabase(fixture.outputDirectory)).toEqual(old);
    expect(await readFile(join(fixture.outputDirectory, old.artifacts!.sqlite.path))).toEqual(oldRaw);
    expect(atlasCoordinate(oldRaw)).toBe(1.5);
  });

  it('rejects a corrupt existing immutable object without replacing the published dataset', async () => {
    const fixture = await publicationFixture();
    const old = await buildWebDatabase({ ...fixture, immutable: true });
    updateAtlas(fixture.source, 7.5);
    const preparedDirectory = join(fixture.directory, 'prepared');
    const next = await buildWebDatabase({ source: fixture.source, outputDirectory: preparedDirectory, immutable: true });
    const artifact = next.artifacts!.gzip;
    const corrupt = await readFile(join(preparedDirectory, artifact.path));
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(join(fixture.outputDirectory, artifact.path), corrupt);
    await expect(buildWebDatabase({ ...fixture, immutable: true })).rejects.toThrow('checksum mismatch');
    expect(await checkWebDatabase(fixture.outputDirectory)).toEqual(old);
    expect(await readFile(join(fixture.outputDirectory, artifact.path))).toEqual(corrupt);
  });

  it('fails before publishing any aliases when source foreign keys are invalid', async () => {
    const fixture = await publicationFixture();
    await buildWebDatabase(fixture);
    const paths = ['phage.db', 'phage.db.gz', 'phage.db.manifest.json'];
    const previous = await Promise.all(paths.map(path => readFile(join(fixture.outputDirectory, path))));
    const db = new Database(fixture.source);
    try { db.exec('PRAGMA foreign_keys=OFF; UPDATE fold_embedding_coords SET gene_id=999 WHERE gene_id=1'); }
    finally { db.close(); }
    await expect(buildWebDatabase(fixture)).rejects.toThrow('foreign-key');
    for (let i = 0; i < paths.length; i++) expect(await readFile(join(fixture.outputDirectory, paths[i]))).toEqual(previous[i]);
  });

  it('rejects an in-place uncheckpointed source but can publish its read snapshot elsewhere', async () => {
    const fixture = await publicationFixture();
    const baseline = await buildWebDatabase({ source: fixture.source, outputDirectory: fixture.directory, immutable: true });
    const writer = new Database(fixture.source);
    try {
      writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE fold_embedding_coords SET x=6.5 WHERE gene_id=1');
      const bytes = await readFile(fixture.source);
      const walBytes = await readFile(`${fixture.source}-wal`);
      expect(bytes[18]).toBe(2);
      expect(bytes[19]).toBe(2);
      await expect(buildWebDatabase({ source: fixture.source, outputDirectory: fixture.directory, immutable: true })).rejects.toThrow('uncheckpointed WAL');
      expect(await checkWebDatabase(fixture.directory)).toEqual(baseline);
      for (const immutable of [false, true]) {
        const snapshot = await buildWebDatabase({ ...fixture, immutable });
        const raw = await readFile(join(fixture.outputDirectory, snapshot.artifacts?.sqlite.path ?? 'phage.db'));
        expect(await readFile(fixture.source)).toEqual(bytes);
        expect(await readFile(`${fixture.source}-wal`)).toEqual(walBytes);
        expect(writer.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        expect(raw[18]).toBe(1);
        expect(raw[19]).toBe(1);
        expect(atlasCoordinate(raw)).toBe(6.5);
        expect(snapshot.contentVersion).not.toBe(baseline.contentVersion);
        expect(snapshot.contentVersion).toBe(computeDatabaseContentDigest(writer));
        expect(await checkWebDatabase(fixture.outputDirectory)).toEqual(snapshot);
      }
    } finally { writer.close(); }
  });

  it('detects stale portable gzip and makes --check fail without modifying the dataset', async () => {
    const fixture = await publicationFixture();
    await buildWebDatabase(fixture);
    const oldGzip = await readFile(join(fixture.outputDirectory, 'phage.db.gz'));
    updateAtlas(fixture.source, 5.5);
    await buildWebDatabase(fixture);
    await writeFile(join(fixture.outputDirectory, 'phage.db.gz'), oldGzip);
    await expect(checkWebDatabase(fixture.outputDirectory)).rejects.toThrow('does not match');
    const manifest = await readFile(join(fixture.outputDirectory, 'phage.db.manifest.json'));
    const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../../../scripts/build-web-db.ts'), '--check', '--output', fixture.outputDirectory]);
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain('does not match');
    expect(await readFile(join(fixture.outputDirectory, 'phage.db.manifest.json'))).toEqual(manifest);
  });
});
