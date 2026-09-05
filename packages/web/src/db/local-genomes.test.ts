import { afterEach, describe, expect, test } from 'bun:test';
import initSqlJs from 'sql.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { importLocalGenomes } from '@phage-explorer/core';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { SqlJsRepository } from './SqlJsRepository';
import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
import { useLocalGenomes } from './local-genomes';

afterEach(() => useLocalGenomes.setState({ genomes: [], requestedId: null, requestedView: undefined }));

describe('local repository with actual curated SQLite', () => {
  test('native read-only repository shares private records without writing catalog or cache', async () => {
    const dbPath = fileURLToPath(new URL('../../public/phage.db', import.meta.url));
    const before = await readFile(dbPath);
    const cachePath = `${dbPath}.cache.json`;
    const beforeCache = await Bun.file(cachePath).exists() ? await readFile(cachePath) : null;
    const base = new BunSqliteRepository(dbPath, { readonly: true });
    const imported = await importLocalGenomes({ name: 'native.fa', text: '>NATIVE_LOCAL\nACGTRYN\n>NATIVE_SECOND\nGGCC' });
    const repo = createLocalGenomeRepository(base, imported.genomes);
    try {
      expect(await repo.listPhages()).toHaveLength(26);
      expect((await repo.getPhageByIndex(24))?.accession).toBe('NATIVE_LOCAL');
      expect(await repo.getSequenceWindow(imported.genomes[0].phage.id, 0, 7)).toBe('ACGTRYN');
      await repo.setBiasVector(imported.genomes[0].phage.id, [1, 2]);
      expect(await repo.getBiasVector(imported.genomes[0].phage.id)).toEqual([1, 2]);
      expect(await base.getBiasVector(imported.genomes[0].phage.id)).toBeNull();
      await repo.setPreference('local-import-readonly-probe', 'must-not-persist');
      expect(await repo.getPreference('local-import-readonly-probe')).toBeNull();
    } finally { await repo.close(); }
    expect(await readFile(dbPath)).toEqual(before);
    const afterCache = await Bun.file(cachePath).exists() ? await readFile(cachePath) : null;
    expect(afterCache).toEqual(beforeCache);
  });

  test('local selection, windows, search and annotations share the existing interface without changing curated tables', async () => {
    const sql = await initSqlJs({ locateFile: () => fileURLToPath(new URL('./sql-wasm.wasm', import.meta.resolve('sql.js'))) });
    const bytes = await readFile(new URL('../../public/phage.db', import.meta.url));
    const db = new sql.Database(bytes);
    const base = new SqlJsRepository(db);
    try {
      const snapshot = () => {
        const schema = db.exec("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name")[0];
        return createHash('sha256').update(JSON.stringify(schema.values.map(([name, ddl]: unknown[]) => {
          const table = String(name).replaceAll('"', '""');
          return { name, ddl, rows: db.exec(`SELECT * FROM "${table}"`) };
        }))).digest('hex');
      };
      const before = snapshot();
      const catalog = await base.listPhages();
      expect(catalog).toHaveLength(24);
      const imported = await importLocalGenomes({ name: 'local.fa', text: '>NC_001416.1 user version\nACGTRYN\n>private β\nGGCC' });
      const repo = createLocalGenomeRepository(base, imported.genomes);
      expect(await repo.listPhages()).toHaveLength(26);
      expect((await repo.getPhageByIndex(0))?.id).toBe(catalog[0].id);
      expect((await repo.getPhageByIndex(24))?.id).toBe(imported.genomes[0].phage.id);
      const id = imported.genomes[0].phage.id;
      expect(await repo.getSequenceWindow(id, 1, 6)).toBe('CGTRY');
      expect(await repo.getFullGenomeLength(id)).toBe(7);
      expect((await repo.getPhageBySlug(imported.genomes[1].phage.slug!))?.name).toBe('private β');
      expect((await repo.searchPhages('private')).map(phage => phage.id)).toEqual([imported.genomes[1].phage.id]);
      expect(await repo.getGenes(id)).toEqual([]);
      expect(await repo.getCodonUsage(id)).toBeNull();
      expect(await repo.getProteinDomains?.(id)).toEqual([]);
      expect(await repo.getDefenseSystems?.(id)).toEqual([]);
      expect(await repo.getFoldEmbeddings?.(id)).toEqual([]);
      expect(await repo.getLatentSpaceAtlas?.({ phageId: id })).toEqual([]);
      expect(await repo.hasModel(id)).toBe(false);
      expect(await repo.getModelFrames(id)).toBeNull();
      await repo.setBiasVector?.(id, [1, 2]);
      expect(await repo.getBiasVector?.(id)).toEqual([1, 2]);
      expect(await base.getBiasVector(id)).toBeNull();
      await repo.prefetchAround(24, 2);
      expect(await repo.getSequenceWindow(catalog[0].id, 0, 30)).toBe(await base.getSequenceWindow(catalog[0].id, 0, 30));
      expect(snapshot()).toBe(before);
      expect(await repo.getPhageByIndex(-1)).toBeNull();
      expect(await repo.getPhageByIndex(0.5)).toBeNull();
      await expect(repo.getSequenceWindow(id, -1, 2)).rejects.toThrow('Invalid local sequence interval');
      expect(() => useLocalGenomes.getState().add(imported, false, catalog)).toThrow('already exists');
      expect(useLocalGenomes.getState().genomes).toEqual([]);
      useLocalGenomes.getState().add(imported, true, catalog);
      expect(useLocalGenomes.getState().genomes).toHaveLength(2);
      expect(await base.listPhages()).toHaveLength(24);
    } finally { await base.close(); }
  });

  test('duplicates are idempotent, accession conflicts are atomic, and local-only access needs no database', async () => {
    const first = await importLocalGenomes({ name: 'first.fa', text: '>same\nACGT' });
    const second = await importLocalGenomes({ name: 'second.fa', text: '>new\nGGGG\n>same\nTGCA' });
    useLocalGenomes.getState().add(first, false, []);
    useLocalGenomes.getState().add(first, false, []);
    expect(useLocalGenomes.getState().genomes).toHaveLength(1);
    expect(() => useLocalGenomes.getState().add(second, false, [])).toThrow('already exists');
    expect(useLocalGenomes.getState().genomes).toHaveLength(1);
    useLocalGenomes.getState().add(second, true, []);
    const repo = createLocalGenomeRepository(null, useLocalGenomes.getState().genomes);
    expect(await repo.listPhages()).toHaveLength(3);
    expect(await repo.getSequenceWindow(first.genomes[0].phage.id, 0, 4)).toBe('ACGT');
    expect(await repo.getPhageById(1)).toBeNull();
  });

  test('rejects a session whose preserved originals cannot fit a reimportable bundle', async () => {
    const first = await importLocalGenomes({ name: 'first.fa', text: '>first\nACGT' });
    useLocalGenomes.getState().add(first, false, []);
    const second = await importLocalGenomes({ name: 'second.fa', text: `>second\n${' '.repeat(10 * 1024 * 1024 - 16)}ACGT` });
    expect(() => useLocalGenomes.getState().add(second, false, [])).toThrow('portable bundle limit');
    expect(useLocalGenomes.getState().genomes).toEqual(first.genomes);
  });
});
