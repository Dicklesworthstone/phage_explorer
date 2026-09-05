import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { computeDatabaseContentDigest } from '../../../scripts/build-web-db';

describe('computeDatabaseContentDigest', () => {
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
