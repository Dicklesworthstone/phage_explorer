import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { computeDatabaseContentDigest, createDatabaseManifest } from '../../../../scripts/build-web-db';
import { databaseDownloadUrls, verifyDatabaseBytes } from './DatabaseLoader';
import { isDatabaseManifest } from './types';

describe('database producer-to-consumer identity', () => {
  it('rejects stale gzip after an atlas-only change even when raw sizes match', async () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE fold_embedding_coords (gene_id INTEGER, x REAL, y REAL); INSERT INTO fold_embedding_coords VALUES (1, 1.5, 2.5)');
      const oldBytes = db.serialize();
      const oldManifest = createDatabaseManifest(computeDatabaseContentDigest(db), oldBytes);
      const staleGzip = gzipSync(oldBytes);
      db.exec('UPDATE fold_embedding_coords SET x=3.5 WHERE gene_id=1');
      const newBytes = db.serialize();
      const current = createDatabaseManifest(computeDatabaseContentDigest(db), newBytes);
      expect(current.size).toBe(oldManifest.size);
      expect(current.contentVersion).not.toBe(oldManifest.contentVersion);
      await verifyDatabaseBytes(newBytes, current);
      await expect(verifyDatabaseBytes(gunzipSync(staleGzip), current)).rejects.toThrow('integrity');
    } finally {
      db.close();
    }
  });
  it('accepts real SQLite bytes with content identity independent of page layout', async () => {
    const smallPages = new Database(':memory:');
    const largePages = new Database(':memory:');
    try {
      smallPages.exec('PRAGMA page_size=1024');
      largePages.exec('PRAGMA page_size=8192');
      for (const db of [smallPages, largePages]) {
        db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample VALUES (1, \'same\')');
      }
      const a = createDatabaseManifest(computeDatabaseContentDigest(smallPages), smallPages.serialize());
      const b = createDatabaseManifest(computeDatabaseContentDigest(largePages), largePages.serialize());
      expect(a.contentVersion).toBe(b.contentVersion);
      expect(a.sha256).not.toBe(b.sha256);
      expect(a.contentVersion).not.toBe(a.sha256);
      expect(isDatabaseManifest(a)).toBe(true);
      await verifyDatabaseBytes(smallPages.serialize(), a);
      await verifyDatabaseBytes(largePages.serialize(), b);
      await expect(verifyDatabaseBytes(largePages.serialize(), a)).rejects.toThrow('integrity');
    } finally {
      smallPages.close();
      largePages.close();
    }
  });

  it('rejects corrupted payloads and the old ambiguous manifest', async () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sample (id INTEGER)');
      const bytes = db.serialize();
      const manifest = createDatabaseManifest(computeDatabaseContentDigest(db), bytes);
      const corrupt = bytes.slice();
      corrupt[corrupt.length - 1] ^= 1;
      await expect(verifyDatabaseBytes(corrupt, manifest)).rejects.toThrow('integrity');
      await expect(verifyDatabaseBytes(bytes.subarray(0, bytes.length - 1), manifest)).rejects.toThrow('integrity');
      expect(isDatabaseManifest({ version: 1, hash: manifest.contentVersion, size: bytes.length })).toBe(false);
      expect(isDatabaseManifest({ ...manifest, sha256: 'invalid' })).toBe(false);
      expect(isDatabaseManifest({ ...manifest, size: NaN })).toBe(false);
    } finally {
      db.close();
    }
  });

  it('pins immutable URLs to the manifest directory while preserving portable URLs', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sample (id INTEGER)');
      const manifest = createDatabaseManifest(computeDatabaseContentDigest(db), db.serialize());
      const config = { databaseUrl: 'https://example.test/data/phage.db?tenant=public', manifestUrl: 'https://example.test/release/phage.db.manifest.json' };
      const portable = databaseDownloadUrls(config, manifest);
      expect(portable.sqlite).toBe(`https://example.test/data/phage.db?tenant=public&v=${manifest.contentVersion}`);
      expect(portable.gzip).toBe(`https://example.test/data/phage.db.gz?tenant=public&v=${manifest.contentVersion}`);
      manifest.artifacts = {
        sqlite: { path: `phage-data/${manifest.sha256}.db`, sha256: manifest.sha256, size: manifest.size },
        gzip: { path: `phage-data/${'a'.repeat(64)}.db.gz`, sha256: 'a'.repeat(64), size: 100 },
      };
      expect(isDatabaseManifest(manifest)).toBe(true);
      expect(databaseDownloadUrls(config, manifest)).toEqual({
        sqlite: `https://example.test/release/${manifest.artifacts.sqlite.path}`,
        gzip: `https://example.test/release/${manifest.artifacts.gzip.path}`,
      });
      expect(() => databaseDownloadUrls({ ...config, manifestUrl: 'https://user:password@example.test/phage.db.manifest.json' }, manifest)).toThrow('credential-free');
    } finally { db.close(); }
  });

  it('rejects escaped, conflicting or incomplete artifact descriptors before any download', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE sample (id INTEGER)');
      const manifest = createDatabaseManifest(computeDatabaseContentDigest(db), db.serialize());
      const sqlite = { path: `phage-data/${manifest.sha256}.db`, sha256: manifest.sha256, size: manifest.size };
      const gzip = { path: `phage-data/${'a'.repeat(64)}.db.gz`, sha256: 'a'.repeat(64), size: 100 };
      for (const artifacts of [
        null, {}, { sqlite }, { gzip },
        { sqlite: { ...sqlite, path: '../phage.db' }, gzip },
        { sqlite: { ...sqlite, path: 'https://elsewhere.test/phage.db' }, gzip },
        { sqlite: { ...sqlite, path: `${sqlite.path}?unchecked=1` }, gzip },
        { sqlite: { ...sqlite, size: sqlite.size + 1 }, gzip },
        { sqlite: { ...sqlite, sha256: 'b'.repeat(64), path: `phage-data/${'b'.repeat(64)}.db` }, gzip },
        { sqlite, gzip: { ...gzip, path: 'phage-data/%2e%2e/phage.db.gz' } },
        { sqlite, gzip: { ...gzip, size: -1 } },
        { sqlite, gzip: { ...gzip, size: Infinity } },
      ]) expect(isDatabaseManifest({ ...manifest, artifacts })).toBe(false);
    } finally { db.close(); }
  });
});
