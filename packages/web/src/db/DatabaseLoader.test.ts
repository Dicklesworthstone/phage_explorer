import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { computeDatabaseContentDigest, createDatabaseManifest } from '../../../../scripts/build-web-db';
import { isDatabaseManifest, verifyDatabaseBytes } from './DatabaseLoader';

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
});
