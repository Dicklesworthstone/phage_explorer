import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { BunSqliteRepository } from './bun-repository';

const oneHot = (dimensions: number, index: number) => Array.from({ length: dimensions }, (_, i) => Number(i === index));
const aa = oneHot(16, 0), cc = oneHot(16, 5), aaa = oneHot(64, 0), ccc = oneHot(64, 21);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phage-sequence-vector-'));
  const path = join(directory, 'phage.db');
  const writer = new Database(path);
  writer.exec(`CREATE TABLE phages (id INTEGER PRIMARY KEY, genome_length INTEGER);
    CREATE TABLE sequences (phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
    INSERT INTO phages VALUES (1, 12), (2, 12);
    INSERT INTO sequences VALUES (1, 0, 'AAAAAAAAAAAA'), (2, 0, 'CCCCCCCCCCCC');`);
  writer.close();
  return path;
}
async function persist(path: string) {
  const repository = new BunSqliteRepository(path);
  try {
    await repository.setBiasVector(1, aa);
    await repository.setCodonVector(1, aaa);
    await repository.setBiasVector(2, cc);
    await repository.setCodonVector(2, ccc);
  } finally { await repository.close(); }
}

describe('native sequence-owned vector persistence', () => {
  it('reuses exact genomes but invalidates same-path, same-ID and same-length replacements', async () => {
    const path = await fixture();
    await persist(path);
    let repository = new BunSqliteRepository(path);
    try {
      expect(await repository.getBiasVector(1)).toEqual(aa);
      expect(await repository.getCodonVector(1)).toEqual(aaa);
    } finally { await repository.close(); }
    const writer = new Database(path);
    writer.query('UPDATE sequences SET sequence = ? WHERE phage_id = 1').run('CCCCCCCCCCCC');
    writer.close();
    repository = new BunSqliteRepository(path);
    try {
      expect(await repository.getBiasVector(1)).toBeNull();
      expect(await repository.getCodonVector(1)).toBeNull();
      expect(await repository.getBiasVector(2)).toEqual(cc);
      expect(await repository.getCodonVector(2)).toEqual(ccc);
      await repository.setBiasVector(1, cc);
      await repository.setCodonVector(1, ccc);
    } finally { await repository.close(); }
    repository = new BunSqliteRepository(path, { readonly: true });
    try {
      expect(await repository.getBiasVector(1)).toEqual(cc);
      expect(await repository.getCodonVector(1)).toEqual(ccc);
    } finally { await repository.close(); }
  });

  it('does not carry vectors across a catalog file replacement that reassigns numeric IDs', async () => {
    // The installer replaces phage.db by renaming a new catalog over it and
    // leaves the adjacent phage.db.cache.json in place.
    const path = await fixture();
    await persist(path);
    const sidecar = await readFile(path + '.cache.json', 'utf8');
    const next = join(dirname(path), 'next-catalog.db');
    const writer = new Database(next);
    writer.exec(`CREATE TABLE phages (id INTEGER PRIMARY KEY, genome_length INTEGER);
      CREATE TABLE sequences (phage_id INTEGER, chunk_index INTEGER, sequence TEXT);
      INSERT INTO phages VALUES (1, 12), (2, 12), (3, 12);
      INSERT INTO sequences VALUES (1, 0, 'CCCCCCCCCCCC'), (2, 0, 'CCCCCCCCCCCC'), (3, 0, 'AAAAAAAAAAAA');`);
    writer.close();
    await rename(next, path);
    expect(await readFile(path + '.cache.json', 'utf8')).toBe(sidecar);
    const repository = new BunSqliteRepository(path, { readonly: true });
    try {
      // ID 1 now names a different genome; its old genome moved to ID 3.
      expect(await repository.getBiasVector(1)).toBeNull();
      expect(await repository.getCodonVector(1)).toBeNull();
      expect(await repository.getBiasVector(3)).toBeNull();
      expect(await repository.getCodonVector(3)).toBeNull();
      // ID 2 is byte-identical in both catalogs, so its vectors stay valid.
      expect(await repository.getBiasVector(2)).toEqual(cc);
      expect(await repository.getCodonVector(2)).toEqual(ccc);
    } finally { await repository.close(); }
  });

  it('observes committed WAL bases and refuses late old vectors even on the same open repository', async () => {
    const path = await fixture();
    await persist(path);
    const writer = new Database(path);
    writer.exec('PRAGMA journal_mode=WAL');
    const repository = new BunSqliteRepository(path);
    try {
      expect(await repository.getBiasVector(1)).toEqual(aa);
      writer.query('UPDATE sequences SET sequence = ? WHERE phage_id = 1').run('CCCCCCCCCCCC');
      expect(await repository.getBiasVector(1)).toBeNull();
      expect(await repository.getCodonVector(1)).toBeNull();
      await expect(repository.setBiasVector(1, aa)).rejects.toThrow('complete current genome');
      await expect(repository.setCodonVector(1, aaa)).rejects.toThrow('complete current genome');
      await repository.setBiasVector(1, cc);
      await repository.setCodonVector(1, ccc);
      expect(await repository.getBiasVector(1)).toEqual(cc);
      expect(await repository.getCodonVector(1)).toEqual(ccc);
    } finally { await repository.close(); writer.close(); }
  });

  it('does not adopt legacy ID-only entries or rewrite sidecars during a readonly session', async () => {
    const path = await fixture();
    const sidecar = JSON.stringify({ bias: { 1: cc }, codon: { 1: ccc } });
    await writeFile(path + '.cache.json', sidecar);
    const repository = new BunSqliteRepository(path, { readonly: true });
    try {
      expect(await repository.getBiasVector(1)).toBeNull();
      expect(await repository.getCodonVector(1)).toBeNull();
      await repository.setBiasVector(1, aa);
      expect(await repository.getBiasVector(1)).toEqual(aa);
    } finally { await repository.close(); }
    expect(await readFile(path + '.cache.json', 'utf8')).toBe(sidecar);
  });

  it('ignores malformed vectors, fingerprints and method versions in persisted data', async () => {
    const path = await fixture();
    await persist(path);
    const original = JSON.parse(await readFile(path + '.cache.json', 'utf8'));
    for (const corrupt of [
      (value: typeof original) => { value.bias['1'].vector = [1]; },
      (value: typeof original) => { value.bias['1'].vector[0] = null; },
      (value: typeof original) => { value.bias['1'].vector[0] = '1'; },
      (value: typeof original) => { value.bias['1'].vector[0] = -1; },
      (value: typeof original) => { value.bias['1'].vector[0] = 0.5; },
      (value: typeof original) => { value.bias['1'].sequenceSha256 = 'not-a-sha256'; },
      (value: typeof original) => { value.version = 999; },
    ]) {
      const altered = structuredClone(original);
      corrupt(altered);
      await writeFile(path + '.cache.json', JSON.stringify(altered));
      const repository = new BunSqliteRepository(path, { readonly: true });
      try { expect(await repository.getBiasVector(1)).toBeNull(); }
      finally { await repository.close(); }
    }
  });

  it('copies stored and returned values and rejects malformed writes without replacing valid data', async () => {
    const repository = new BunSqliteRepository(await fixture());
    try {
      const input = aa.slice();
      await repository.setBiasVector(1, input);
      input[0] = 0;
      const returned = (await repository.getBiasVector(1))!;
      returned[0] = 0;
      expect(await repository.getBiasVector(1)).toEqual(aa);
      for (const invalid of [[1], Array(16).fill(1), [NaN, ...aa.slice(1)], [-1, ...aa.slice(1)]]) {
        await expect(repository.setBiasVector(1, invalid)).rejects.toThrow('normalized 16-element');
        expect(await repository.getBiasVector(1)).toEqual(aa);
      }
      await expect(repository.setCodonVector(1, aa)).rejects.toThrow('normalized 64-element');
    } finally { await repository.close(); }
  });

  it('refuses caches for incomplete chunk layouts and unknown genomes', async () => {
    const path = await fixture();
    await persist(path);
    const writer = new Database(path);
    writer.exec('UPDATE sequences SET chunk_index = 1 WHERE phage_id = 1');
    writer.close();
    const repository = new BunSqliteRepository(path);
    try {
      expect(await repository.getBiasVector(1)).toBeNull();
      expect(await repository.getCodonVector(1)).toBeNull();
      expect(await repository.getBiasVector(99)).toBeNull();
      await expect(repository.setBiasVector(1, aa)).rejects.toThrow('complete current genome');
      await expect(repository.setBiasVector(99, aa)).rejects.toThrow('complete current genome');
    } finally { await repository.close(); }
  });
});
