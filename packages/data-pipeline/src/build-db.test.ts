import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  buildDatabase,
  findTrnaPool,
  calculateIntrinsicCai,
  calculateTai,
  detectAuxiliaryMetabolicGenes,
} from './build-db';
import type { PhageCatalogEntry } from './phage-catalog';
import type { NCBISequenceResult } from './ncbi-fetcher';

describe('findTrnaPool', () => {
  test('matches E. coli host strings', () => {
    const pool = findTrnaPool('Escherichia coli C');
    expect(pool).toBeArray();
    expect(pool?.length).toBeGreaterThan(0);
    expect(pool?.[0]).toHaveProperty('codon');
  });

  test('returns undefined for unknown hosts', () => {
    expect(findTrnaPool('Bacillus subtilis')).toBeUndefined();
  });

  test('is case-insensitive', () => {
    expect(findTrnaPool('escherichia coli')).toBeDefined();
    expect(findTrnaPool('ESCHERICHIA COLI')).toBeDefined();
  });
});

describe('calculateIntrinsicCai', () => {
  test('returns 1 for a gene matching the phage-wide codon usage exactly', () => {
    const phageCounts = { ATG: 10, AAA: 5, AAG: 5 };
    const geneCounts = { ATG: 2, AAA: 1, AAG: 1 };
    const cai = calculateIntrinsicCai(geneCounts, phageCounts);
    expect(cai).toBeCloseTo(1);
  });

  test('returns a value below 1 when a gene avoids preferred codons', () => {
    const phageCounts = { ATG: 10, AAA: 8, AAG: 2 };
    const geneCounts = { ATG: 2, AAA: 1, AAG: 1 };
    const cai = calculateIntrinsicCai(geneCounts, phageCounts);
    expect(cai).toBeLessThan(1);
    expect(cai).toBeGreaterThan(0);
  });

  test('does not produce NaN when a gene codon is absent from phage counts', () => {
    const phageCounts = { ATG: 10, TTC: 5 };
    const geneCounts = { ATG: 2, TTT: 1, TTC: 1 };
    const cai = calculateIntrinsicCai(geneCounts, phageCounts);
    expect(Number.isFinite(cai)).toBe(true);
  });

  test('returns 0 for an empty gene', () => {
    const phageCounts = { ATG: 10 };
    expect(calculateIntrinsicCai({}, phageCounts)).toBe(0);
  });
});

describe('detectAuxiliaryMetabolicGenes', () => {
  test('maps known AMG markers to KEGG orthologs', () => {
    const hits = detectAuxiliaryMetabolicGenes([
      { id: 1, name: 'psbA', locusTag: 'gp1', product: 'photosystem II D1 protein', type: 'CDS' },
      { id: 2, name: 'nrdB', locusTag: 'gp2', product: 'ribonucleotide reductase beta subunit', type: 'CDS' },
    ]);
    expect(hits).toHaveLength(2);
    expect(hits[0]?.keggOrtholog).toBe('K02703');
    expect(hits[1]?.keggOrtholog).toBe('K00526');
  });

  test('does not classify generic genes or non-CDS features', () => {
    const hits = detectAuxiliaryMetabolicGenes([
      { id: 1, name: 'capsid', locusTag: null, product: 'major capsid protein', type: 'CDS' },
      { id: 2, name: 'psbA', locusTag: null, product: null, type: 'gene' },
    ]);
    expect(hits).toEqual([]);
  });
});

describe('calculateTai', () => {
  test('returns 1 for a gene using only the most abundant tRNA codon', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    const geneCounts = { ATG: 5 };
    const tai = calculateTai(geneCounts, pool);
    expect(tai).toBeCloseTo(1);
  });

  test('returns a value below 1 when the gene uses a less abundant codon', () => {
    const pool = [
      { anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 },
      { anticodon: 'GUA', aminoAcid: 'Tyr', codon: 'TAT', copyNumber: 2 },
    ];
    const geneCounts = { ATG: 1, TAT: 1 };
    const tai = calculateTai(geneCounts, pool);
    expect(tai).toBeLessThan(1);
    expect(tai).toBeGreaterThan(0);
  });

  test('does not produce NaN for codons absent from the tRNA pool', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    const geneCounts = { ATG: 1, AAA: 1 };
    const tai = calculateTai(geneCounts, pool);
    expect(Number.isFinite(tai)).toBe(true);
  });

  test('returns 0 for an empty gene', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    expect(calculateTai({}, pool)).toBe(0);
  });

  test('ignores stop codons instead of penalizing the score', () => {
    const pool = [{ anticodon: 'CAU', aminoAcid: 'Met', codon: 'ATG', copyNumber: 10 }];
    const withStops = calculateTai({ ATG: 1, TAA: 1, TAG: 1, TGA: 1 }, pool);
    const withoutStops = calculateTai({ ATG: 1 }, pool);
    expect(withStops).toBeCloseTo(withoutStops);
  });
});

const catalog: PhageCatalogEntry[] = [1, 2].map(id => ({
  slug: `fixture-${id}`, name: `Synthetic catalog fixture ${id}`, accession: `FIXTURE_${id}.1`,
  family: 'Synthetic', genus: 'Synthetic', host: 'Unknown fixture host', morphology: 'unknown',
  lifecycle: 'unknown', genomeType: 'dsDNA', baltimoreGroup: 'I', description: 'Synthetic build fixture',
}));
function fetchedRecord(accession: string): NCBISequenceResult {
  const sequence = 'ATGAAAAAAAAAAAATAA' + (accession === catalog[0].accession ? 'N'.repeat(10001) : '');
  return {
    accession: accession.replace(/\.\d+$/, ''), sequence, length: sequence.length, gcContent: 0,
    metadata: { version: accession, warnings: '[]' },
    features: [{ type: 'CDS', location: '1..18', start: 0, end: 18, strand: '+',
      locusTag: 'fixture-cds', product: 'Synthetic test protein', qualifiers: {},
      segments: [{ start: 0, end: 18, strand: '+' }] }],
  };
}
async function buildFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'phage-atomic-build-'));
  const output = join(directory, 'phage.db');
  const previous = new Database(output);
  try {
    previous.exec(`CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('last usable dataset');
      CREATE TABLE fold_embedding_coords (gene_id INTEGER, x REAL); INSERT INTO fold_embedding_coords VALUES (1, 999);`);
  } finally { previous.close(); }
  const bytes = await readFile(output);
  return { directory, output, bytes, options: { output, catalog, fetchSequence: async (accession: string) => fetchedRecord(accession),
    tropismPath: join(directory, 'optional-tropism.json') } };
}
async function mutateCandidate(directory: string, sql: string): Promise<void> {
  const stages = (await readdir(directory)).filter(name => name.startsWith('.phage.db-build-'));
  expect(stages).toHaveLength(1);
  const candidate = new Database(join(directory, stages[0], 'phage.db'));
  try { candidate.exec(sql); } finally { candidate.close(); }
}

describe('complete atomic catalog builds', () => {
  test('publishes every genome and its derived inputs together, without stale tables from the previous generation', async () => {
    const fixture = await buildFixture();
    const result = await buildDatabase(fixture.options);
    expect(result).toEqual({ output: fixture.output, phageCount: 2 });
    const db = new Database(fixture.output, { readonly: true });
    try {
      expect(db.query('SELECT accession, slug FROM phages ORDER BY id').all()).toEqual(
        catalog.map(({ accession, slug }) => ({ accession, slug })),
      );
      for (const [index, entry] of catalog.entries()) {
        const chunks = db.query<{ sequence: string }, [number]>('SELECT sequence FROM sequences WHERE phage_id=? ORDER BY chunk_index').all(index + 1);
        expect(chunks.map(chunk => chunk.sequence).join('')).toBe(fetchedRecord(entry.accession).sequence);
      }
      expect(db.query('SELECT count(*) AS n FROM fold_embeddings').get()).toEqual({ n: 2 });
      expect(db.query('SELECT count(*) AS n FROM codon_usage').get()).toEqual({ n: 2 });
      expect(db.query("SELECT count(*) AS n FROM annotation_meta WHERE key LIKE 'coding_inputs:%'").get()).toEqual({ n: 2 });
      expect(db.query("SELECT value FROM annotation_meta WHERE key='domain_defense'").get()).toEqual({
        value: JSON.stringify({ count: 0, phages: 0, source: 'pfam-domain' }),
      });
      expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('preserved','fold_embedding_coords')").all()).toEqual([]);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.query('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    } finally { db.close(); }
  });

  test('keeps the old database byte-for-byte when a later fetch fails', async () => {
    const fixture = await buildFixture();
    const attempted: string[] = [];
    await expect(buildDatabase({ ...fixture.options, fetchSequence: async accession => {
      attempted.push(accession);
      if (accession === catalog[1].accession) throw new Error('Simulated upstream outage');
      return fetchedRecord(accession);
    } })).rejects.toThrow('Failed to fetch complete catalog record FIXTURE_2.1');
    expect(attempted).toEqual(catalog.map(entry => entry.accession));
    expect(await readFile(fixture.output)).toEqual(fixture.bytes);
  });

  test.each(['wrong-accession', 'wrong-version', 'incomplete-sequence'])('rejects %s before publishing a catalog record', async failure => {
    const fixture = await buildFixture();
    await expect(buildDatabase({ ...fixture.options, fetchSequence: async accession => {
      const record = fetchedRecord(accession);
      if (failure === 'wrong-accession') record.accession = 'UNRELATED';
      else if (failure === 'wrong-version') record.metadata.version = accession.replace('.1', '.2');
      else record.length++;
      return record;
    } })).rejects.toThrow('Failed to fetch complete catalog record');
    expect(await readFile(fixture.output)).toEqual(fixture.bytes);
  });

  test('rolls back a failed per-genome insertion and rejects the entire build', async () => {
    const fixture = await buildFixture();
    await expect(buildDatabase({ ...fixture.options, fetchSequence: async accession => ({
      ...fetchedRecord(accession), metadata: { version: accession, warnings: 'invalid annotation JSON' },
    }) })).rejects.toThrow('Failed to insert catalog record');
    expect(await readFile(fixture.output)).toEqual(fixture.bytes);
  });

  test('treats a malformed supplied annotation file as build failure', async () => {
    const fixture = await buildFixture();
    await writeFile(fixture.options.tropismPath, '{bad json');
    await expect(buildDatabase(fixture.options)).rejects.toThrow('Failed to load supplied tropism predictions');
    expect(await readFile(fixture.output)).toEqual(fixture.bytes);
  });

  test.each([
    ["UPDATE sequences SET sequence=replace(sequence, 'A', 'T') WHERE phage_id=1", 'sequence differs'],
    ["INSERT INTO genes (phage_id, start_pos, end_pos, type) VALUES (999, 0, 3, 'gene')", 'orphan annotations'],
    ["UPDATE genes SET end_pos=999999 WHERE phage_id=1", 'gene outside'],
    ["CREATE TRIGGER fail_derived BEFORE INSERT ON annotation_meta WHEN NEW.key='domain_defense' BEGIN SELECT RAISE(ABORT, 'derived annotation failure'); END", 'derived annotation failure'],
  ])('rejects failed final validation or derivation (%s)', async (sql, message) => {
    const fixture = await buildFixture();
    await expect(buildDatabase({ ...fixture.options, fetchSequence: async accession => {
      if (accession === catalog[1].accession) await mutateCandidate(fixture.directory, sql);
      return fetchedRecord(accession);
    } })).rejects.toThrow(message);
    expect(await readFile(fixture.output)).toEqual(fixture.bytes);
  });

  test('does not replace a database edited while the candidate is building', async () => {
    const fixture = await buildFixture();
    let concurrentBytes = fixture.bytes;
    await expect(buildDatabase({ ...fixture.options, fetchSequence: async accession => {
      if (accession === catalog[1].accession) {
        const db = new Database(fixture.output);
        try { db.exec("INSERT INTO preserved VALUES ('concurrent writer')"); } finally { db.close(); }
        concurrentBytes = await readFile(fixture.output);
      }
      return fetchedRecord(accession);
    } })).rejects.toThrow('destination changed');
    expect(await readFile(fixture.output)).toEqual(concurrentBytes);
  });

  test('refuses a destination with active SQLite WAL state without fetching', async () => {
    const fixture = await buildFixture();
    const db = new Database(fixture.output);
    try {
      db.exec("PRAGMA journal_mode=WAL; INSERT INTO preserved VALUES ('uncheckpointed write')");
      let fetched = false;
      await expect(buildDatabase({ ...fixture.options, fetchSequence: async accession => {
        fetched = true; return fetchedRecord(accession);
      } })).rejects.toThrow('SQLite sidecar');
      expect(fetched).toBe(false);
      expect(db.query('SELECT count(*) AS n FROM preserved').get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });

  test('CLI failure exits nonzero so chained annotation and publication cannot continue', async () => {
    const fixture = await buildFixture();
    const script = resolve(import.meta.dir, 'build-db.ts');
    const child = Bun.spawn([process.execPath, script, '--output', dirname(fixture.output)], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('regular file');
    expect(await readFile(fixture.output)).toEqual(fixture.bytes);
  });
});
