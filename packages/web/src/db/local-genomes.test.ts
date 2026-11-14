import { afterEach, describe, expect, test } from 'bun:test';
import initSqlJs from 'sql.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { exportLocalGenomeBundle, importLocalGenomes } from '@phage-explorer/core';
import { BunSqliteRepository } from '@phage-explorer/db-runtime';
import { SqlJsRepository } from './SqlJsRepository';
import { createLocalGenomeRepository } from '@phage-explorer/db-runtime/local-genomes';
import { prepareCatalogGenomeSnapshot, useLocalGenomes } from './local-genomes';
import { executeResearchRequest } from '../workers/research-workflow.worker';

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

  test('admits exactly 50,000 preserved features and atomically rejects source or unmapped feature overflow', async () => {
    const input = (accession: string, features: string) => ({ name: `${accession}.gb`, text:
      `LOCUS       ${accession} 4 bp DNA linear\nACCESSION   ${accession}\nFEATURES             Location/Qualifiers\n${features}ORIGIN\n        1 acgt\n//\n` });
    // Only one CDS per record is mapped. The source rows and unsupported order()
    // location are nevertheless retained, and count toward the parser's budget.
    const features = '     source          1..4\n'.repeat(24998)
      + '     CDS             1..3\n     misc_feature    order(1..2,3..4)\n';
    const first = await importLocalGenomes(input('FEATURE_A', features));
    const second = await importLocalGenomes(input('FEATURE_B', features));
    expect(first.genomes[0].phage.genes).toHaveLength(1);
    expect(second.genomes[0].phage.genes).toHaveLength(1);
    expect(first.genomes[0].warnings).toHaveLength(1);
    const view = { contentId: second.genomes[0].phage.localGenome!.contentId,
      viewMode: 'dna' as const, readingFrame: 0 as const, scrollPosition: 2 };
    useLocalGenomes.getState().add(first, false, []);
    useLocalGenomes.getState().add({ ...second, view }, false, []);
    // Re-adding an already accepted source must not consume its budget again.
    useLocalGenomes.getState().add({ ...second, view }, false, []);
    const accepted = useLocalGenomes.getState();
    const bundle = exportLocalGenomeBundle(accepted.genomes, accepted.requestedView);
    const reopened = await importLocalGenomes({ name: 'combined-features.json', text: bundle });
    expect(reopened.genomes).toEqual([...first.genomes, ...second.genomes]);
    expect(reopened.view).toEqual(view);

    for (const [accession, feature] of [
      ['SOURCE_OVERFLOW', '     source          1..4\n'],
      ['UNMAPPED_OVERFLOW', '     misc_feature    order(1..2,3..4)\n'],
    ]) {
      const extra = await importLocalGenomes(input(accession, feature));
      expect(extra.genomes[0].phage.genes).toHaveLength(0);
      // Establish the real rejection that a saved bundle would otherwise hit.
      await expect(importLocalGenomes({ name: 'overflow.json',
        text: exportLocalGenomeBundle([...accepted.genomes, ...extra.genomes], view) })).rejects.toThrow('50,000-feature total limit');
      expect(() => useLocalGenomes.getState().add(extra, false, [])).toThrow('50,000-feature total limit');
      expect(useLocalGenomes.getState()).toBe(accepted);
      expect(exportLocalGenomeBundle(useLocalGenomes.getState().genomes, useLocalGenomes.getState().requestedView)).toBe(bundle);
    }
  });

  test('counts original duplicate records before accepting a combined portable session', async () => {
    const first = await importLocalGenomes({ name: 'first.fa', text: '>FIRST\nACGT\n'.repeat(60) });
    const second = await importLocalGenomes({ name: 'second.fa', text: '>SECOND\nTGCA\n'.repeat(40) });
    const extra = await importLocalGenomes({ name: 'third.fa', text: '>THIRD\nGGCC\n' });
    useLocalGenomes.getState().add(first, false, []);
    useLocalGenomes.getState().add(second, false, []);
    const accepted = useLocalGenomes.getState();
    expect(accepted.genomes).toHaveLength(2);
    const reopened = await importLocalGenomes({ name: 'hundred-records.json', text: exportLocalGenomeBundle(accepted.genomes) });
    expect(reopened.genomes).toEqual(accepted.genomes);
    await expect(importLocalGenomes({ name: 'overflow.json',
      text: exportLocalGenomeBundle([...accepted.genomes, ...extra.genomes]) })).rejects.toThrow('1–100 records');
    expect(() => useLocalGenomes.getState().add(extra, false, [])).toThrow('1–100 records');
    expect(useLocalGenomes.getState()).toBe(accepted);
  });
});

describe('catalog snapshots enter the existing research repository', () => {
  const dbPath = fileURLToPath(new URL('../../public/phage.db', import.meta.url));
  const parser = async (input: Parameters<typeof importLocalGenomes>[0]) => {
    const response = await executeResearchRequest({ type: 'parse', input });
    if (response.type !== 'parsed') throw new Error('Expected parsed snapshot');
    return response.result;
  };

  test('captures real catalog bases and annotations, reviews collisions, and reopens independently of SQLite', async () => {
    const before = await readFile(dbPath);
    const repo = new BunSqliteRepository(dbPath, { readonly: true });
    try {
      const catalog = await repo.listPhages(), phage = await repo.getPhageBySlug('lambda');
      if (!phage) throw new Error('Expected the actual Lambda catalog genome');
      const genes = [...phage.genes].sort((a, b) => a.id - b.id);
      expect(phage.accession).toBe('NC_001416.1');
      expect(genes).toHaveLength(174);
      const sequence = await repo.getSequenceWindow(phage.id, 0, phage.genomeLength!);
      const snapshot = await prepareCatalogGenomeSnapshot(repo, phage, {
        signal: new AbortController().signal, isCurrent: () => true, parse: parser,
      });
      const captured = snapshot.genomes[0];
      expect(captured.phage.localGenome?.format).toBe('catalog-snapshot');
      expect(captured.sequence).toBe(sequence);
      expect(captured.phage.genes).toEqual(genes);
      expect(JSON.parse(captured.original.text).genome.genes).toEqual(genes);
      expect(JSON.parse(captured.original.text).provenance).toEqual({ phageId: phage.id, slug: 'lambda', contentVersion: null });
      expect(captured.phage.localGenome?.topology).toBe('unknown');
      expect(captured.phage.hasModel).toBe(false);
      expect(captured.phage.id).toBeLessThan(0);
      expect(captured.phage.localGenome?.sequenceSha256).toBe(createHash('sha256').update(sequence).digest('hex'));
      expect(useLocalGenomes.getState().genomes).toHaveLength(0);
      expect(() => useLocalGenomes.getState().add(snapshot, false, catalog)).toThrow('already exists');
      expect(useLocalGenomes.getState().genomes).toHaveLength(0);
      useLocalGenomes.getState().add(snapshot, true, catalog);
      expect(useLocalGenomes.getState().genomes).toHaveLength(1);
      const reopened = await importLocalGenomes({ name: 'catalog-workspace.json', text: exportLocalGenomeBundle(snapshot.genomes) });
      expect(reopened.genomes[0]).toEqual(captured);
      const standalone = createLocalGenomeRepository(null, reopened.genomes);
      expect(await standalone.getSequenceWindow(captured.phage.id, 0, sequence.length)).toBe(sequence);
      expect(await standalone.getGenes(captured.phage.id)).toEqual(genes);
      expect(await repo.listPhages()).toEqual(catalog);
      expect(await repo.getPhageById(phage.id)).toEqual(phage);
    } finally { await repo.close(); }
    expect(await readFile(dbPath)).toEqual(before);
  });

  test('retains real T4 split annotations in the source without offering incomplete CDS as mapped genes', async () => {
    const repo = new BunSqliteRepository(dbPath, { readonly: true });
    try {
      const phage = await repo.getPhageBySlug('t4');
      if (!phage) throw new Error('Expected the actual T4 catalog genome');
      // These eight stored rows split four joined CDS into independent intervals.
      // Their legacy _segments strings must remain exact in the original source.
      const splitIds = [180, 181, 328, 329, 658, 659, 673, 674];
      const genes = [...phage.genes].sort((a, b) => a.id - b.id);
      expect(genes.filter(gene => typeof gene.qualifiers?._segments === 'string').map(gene => gene.id)).toEqual(splitIds);
      const snapshot = await prepareCatalogGenomeSnapshot(repo, phage, {
        signal: new AbortController().signal, isCurrent: () => true, parse: parser,
      });
      const captured = snapshot.genomes[0];
      expect(captured.sequence).toBe(await repo.getSequenceWindow(phage.id, 0, 168903));
      expect(JSON.parse(captured.original.text).genome.genes).toEqual(genes);
      expect(captured.phage.genes).toEqual(genes.filter(gene => !splitIds.includes(gene.id)));
      for (const id of splitIds) expect(captured.warnings.some(warning => warning.includes(`Catalog gene ${id} `))).toBe(true);
      const reopened = await importLocalGenomes({ name: 't4-snapshot.json', text: exportLocalGenomeBundle(snapshot.genomes) });
      expect(reopened.genomes[0]).toEqual(captured);
      expect(await repo.getGenes(phage.id)).toEqual(phage.genes);
    } finally { await repo.close(); }
  });

  test('copies annotations before asynchronous sequence loading and never follows later mutable metadata', async () => {
    const repo = new BunSqliteRepository(dbPath, { readonly: true });
    try {
      const phage = await repo.getPhageBySlug('lambda');
      if (!phage || !phage.genes.length) throw new Error('Expected annotated catalog data');
      const original = structuredClone(phage.genes).sort((a, b) => a.id - b.id);
      const snapshot = await prepareCatalogGenomeSnapshot({
        getFullGenomeLength: async id => {
          phage.genes[0].name = 'changed after capture began';
          return repo.getFullGenomeLength(id);
        },
        getSequenceWindow: (id, start, end) => repo.getSequenceWindow(id, start, end),
      }, phage, { signal: new AbortController().signal, isCurrent: () => true, parse: parser });
      expect(snapshot.genomes[0].phage.genes).toEqual(original);
      expect(JSON.parse(snapshot.genomes[0].original.text).genome.genes).toEqual(original);
      expect(phage.genes[0].name).toBe('changed after capture began');
    } finally { await repo.close(); }
  });

  test('rejects stale selection and incomplete sequence before publishing or parsing a snapshot', async () => {
    const repo = new BunSqliteRepository(dbPath, { readonly: true });
    try {
      const phage = await repo.getPhageBySlug('lambda');
      if (!phage) throw new Error('Expected catalog data');
      let current = true, parses = 0;
      const options = { signal: new AbortController().signal, isCurrent: () => current,
        parse: async (input: Parameters<typeof importLocalGenomes>[0]) => { parses++; return parser(input); } };
      await expect(prepareCatalogGenomeSnapshot({
        getFullGenomeLength: id => repo.getFullGenomeLength(id),
        getSequenceWindow: async (id, start, end) => { const bases = await repo.getSequenceWindow(id, start, end); current = false; return bases; },
      }, phage, options)).rejects.toThrow('changed during capture');
      current = true;
      await expect(prepareCatalogGenomeSnapshot({
        getFullGenomeLength: id => repo.getFullGenomeLength(id),
        getSequenceWindow: async (id, start, end) => (await repo.getSequenceWindow(id, start, end)).slice(1),
      }, phage, options)).rejects.toThrow('complete catalog sequence');
      expect(parses).toBe(0);
      expect(useLocalGenomes.getState().genomes).toHaveLength(0);
    } finally { await repo.close(); }
  });

  test('refuses a catalog generation change while reading bases and never invokes offline writes', async () => {
    const repo = new BunSqliteRepository(dbPath, { readonly: true });
    try {
      const phage = await repo.getPhageBySlug('lambda');
      if (!phage) throw new Error('Expected Lambda catalog data');
      let contentVersion = '1'.repeat(64), parses = 0;
      const unused = () => { throw new Error('Capture must not change offline files'); };
      await expect(prepareCatalogGenomeSnapshot({
        getFullGenomeLength: id => repo.getFullGenomeLength(id),
        getSequenceWindow: async (id, start, end) => {
          const sequence = await repo.getSequenceWindow(id, start, end);
          contentVersion = '2'.repeat(64);
          return sequence;
        },
        getOfflineDataset: () => ({
          describe: () => ({ contentVersion, catalogBytes: 0, cacheBudget: 0, genomes: [], atlases: [] }),
          plan: unused, saved: unused, inspect: unused, prepare: unused, release: unused,
        }),
      }, phage, { signal: new AbortController().signal, isCurrent: () => true,
        parse: async input => { parses++; return parser(input); } })).rejects.toThrow('catalog version changed');
      expect(parses).toBe(0);
      expect(useLocalGenomes.getState().genomes).toHaveLength(0);
    } finally { await repo.close(); }
  });

  test('cancels a repository read promptly and never accepts its late completion', async () => {
    const repo = new BunSqliteRepository(dbPath, { readonly: true });
    let release!: (value: number) => void;
    try {
      const phage = await repo.getPhageBySlug('lambda');
      if (!phage) throw new Error('Expected catalog data');
      const controller = new AbortController();
      let sequences = 0, parses = 0;
      const task = prepareCatalogGenomeSnapshot({
        getFullGenomeLength: () => new Promise<number>(resolve => { release = resolve; }),
        getSequenceWindow: async () => { sequences++; return 'ACGT'; },
      }, phage, { signal: controller.signal, isCurrent: () => true,
        parse: async input => { parses++; return parser(input); } });
      controller.abort();
      await expect(task).rejects.toMatchObject({ name: 'AbortError' });
      release(phage.genomeLength!);
      await Promise.resolve();
      expect(sequences).toBe(0); expect(parses).toBe(0);
      expect(useLocalGenomes.getState().genomes).toHaveLength(0);
    } finally { await repo.close(); }
  });
});
