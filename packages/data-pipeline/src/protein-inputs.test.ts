import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { collectProteinInputs, readProteinInputs, type CodingGeneRow } from './protein-inputs';
import { featureGeneValues, retainedCatalogFeatures, calculateIntrinsicCai } from './build-db';

const row = (changes: Partial<CodingGeneRow> = {}): CodingGeneRow => ({
  id: 1, phageId: 1, name: 'example', locusTag: 'CDS1', startPos: 0, endPos: 9,
  strand: '+', type: 'CDS', product: 'example protein', qualifiers: { transl_table: '11' }, ...changes,
});
const segments = [{ start: 0, end: 3, strand: '+' }, { start: 5, end: 11, strand: '+' }];

describe('validated CDS annotation inputs', () => {
  test('joins an intron once, without including the genomic gap', () => {
    const report = collectProteinInputs('ATGCCAAATAA', [row({ endPos: 11,
      qualifiers: { _segments: segments, translation: 'MK', transl_table: '11' } })]);
    expect(report.excluded).toEqual([]);
    expect(report.proteins).toHaveLength(1);
    expect(report.proteins[0]).toMatchObject({ geneId: 1, sourceGeneIds: [1], cds: 'ATGAAATAA', sequence: 'MK' });
  });

  test('reverse-complements each transcript segment in deposited order', () => {
    const report = collectProteinInputs('TTATTTCCCAT', [row({ strand: '-', endPos: 11,
      qualifiers: { _segments: [{ start: 8, end: 11, strand: '-' }, { start: 0, end: 6, strand: '-' }], translation: 'MK' } })]);
    expect(report.excluded).toEqual([]);
    expect(report.proteins[0].cds).toBe('ATGAAATAA');
    expect(report.proteins[0].sequence).toBe('MK');
  });

  test('keeps a circular-origin join in transcript order', () => {
    const report = collectProteinInputs('AAATAACCCATG', [row({ endPos: 12,
      qualifiers: { _segments: [{ start: 9, end: 12, strand: '+' }, { start: 0, end: 6, strand: '+' }], translation: 'MK' } })]);
    expect(report.excluded).toEqual([]);
    expect(report.proteins[0].cds).toBe('ATGAAATAA');
  });

  test('applies codon_start once, even when it consumes a whole first segment', () => {
    const report = collectProteinInputs('GCCCATGAAATAA', [row({ endPos: 13,
      qualifiers: { _segments: [{ start: 0, end: 1, strand: '+' }, { start: 3, end: 13, strand: '+' }],
        codon_start: '3', translation: 'MK' } })]);
    expect(report.excluded).toEqual([]);
    expect(report.proteins[0]).toMatchObject({ cds: 'ATGAAATAA', sequence: 'MK', codonStart: 3 });
  });

  test.each([
    [1, 'ATGAAATAA', 'MK'], [4, 'TTATGATAA', 'MW'], [11, 'GTGAAATAA', 'MK'],
    [15, 'ATGTAGTAA', 'MQ'], [25, 'TTGTGATAA', 'MG'],
  ])('uses NCBI table %i and its initiators', (table, genome, expected) => {
    const report = collectProteinInputs(genome as string, [row({ qualifiers: { transl_table: String(table), translation: expected } })]);
    expect(report.excluded).toEqual([]);
    expect(report.proteins[0]).toMatchObject({ sequence: expected, geneticCode: table });
  });

  test.each(['pseudo', 'pseudogene', 'exception', 'transl_except', 'ribosomal_slippage', 'trans_splicing'])('refuses /%s instead of inventing a protein', key => {
    const report = collectProteinInputs('ATGAAATAA', [row({ qualifiers: { [key]: '' } })]);
    expect(report.proteins).toEqual([]);
    expect(report.excluded[0].reasons.join(' ')).toContain('/' + key);
  });

  test.each([
    ['ATGAAATA', {}, 'terminal codons'], ['ATGNNNTAA', {}, 'unresolved bases'],
    ['ATGTAGTAA', {}, 'internal stop'], ['ATGAAATAA', { translation: 'MN' }, 'differs'],
    ['ATGAAATAA', { transl_table: ['11', '4'] }, 'one positive integer'],
    ['ATGAAATAA', { codon_start: ['1'] }, 'one positive integer'],
    ['ATGAAATAA', { transl_table: '99' }, 'Unsupported translation table'],
    ['ATGAAATAA', { translation: ['MK', 'MN'] }, 'differs'],
  ])('excludes unsupported input %s %j', (genome, qualifiers, reason) => {
    const report = collectProteinInputs(genome as string, [row({ endPos: (genome as string).length, qualifiers: qualifiers as Record<string, unknown> })]);
    expect(report.proteins).toEqual([]);
    expect(report.excluded[0].reasons.join(' ')).toContain(reason as string);
  });

  test('does not fall back to the genomic span for malformed, mixed, or overlapping segments', () => {
    for (const parts of [[], [{ start: 0, end: 3 }], [{ start: 0, end: 3, strand: '+' }, { start: 3, end: 9, strand: '-' }],
      [{ start: 0, end: 6, strand: '+' }, { start: 3, end: 9, strand: '+' }]]) {
      expect(collectProteinInputs('ATGAAATAA', [row({ qualifiers: { _segments: parts } })]).proteins).toEqual([]);
    }
  });

  test('coalesces only a complete set of legacy split rows with a matching deposited translation', () => {
    const qualifiers = JSON.stringify({ _segments: JSON.stringify(segments.map(({ start, end }) => ({ start, end }))), translation: 'MK', transl_table: '11' });
    const rows = [row({ id: 11, startPos: 5, endPos: 11, qualifiers }), row({ id: 10, endPos: 3, qualifiers })];
    const report = collectProteinInputs('ATGCCAAATAA', rows);
    expect(report.excluded).toEqual([]);
    expect(report.proteins).toHaveLength(1);
    expect(report.proteins[0]).toMatchObject({ geneId: 10, sourceGeneIds: [10, 11], cds: 'ATGAAATAA', sequence: 'MK' });
    expect(rows[0].qualifiers).toBe(qualifiers);
    for (const incomplete of [rows.slice(0, 1), [...rows, row({ ...rows[0], id: 12 })]]) {
      const rejected = collectProteinInputs('ATGCCAAATAA', incomplete);
      expect(rejected.proteins).toEqual([]);
      expect(rejected.excluded).toHaveLength(incomplete.length);
    }
    const noTranslation = rows.map(item => ({ ...item, qualifiers: { _segments: JSON.stringify(segments) } }));
    expect(collectProteinInputs('ATGCCAAATAA', noTranslation).proteins).toEqual([]);
  });

  test('validates either legacy minus-strand order without sorting circular-origin joins', () => {
    for (const { genome, parts } of [
      { genome: 'TTATTTCCCAT', parts: [{ start: 0, end: 6 }, { start: 8, end: 11 }] },
      { genome: 'TTATTTCCCAT', parts: [{ start: 8, end: 11 }, { start: 0, end: 6 }] },
      { genome: 'CATCCCTTATTT', parts: [{ start: 0, end: 3 }, { start: 6, end: 12 }] },
      { genome: 'CATCCCTTATTT', parts: [{ start: 6, end: 12 }, { start: 0, end: 3 }] },
    ]) {
      const qualifiers = JSON.stringify({ _segments: JSON.stringify(parts), translation: 'MK', transl_table: '11' });
      const rows = parts.map((part, index) => row({ id: 10 + index, startPos: part.start,
        endPos: part.end, strand: '-', qualifiers }));
      const before = JSON.stringify(rows);
      const report = collectProteinInputs(genome, rows);
      expect(report.excluded).toEqual([]);
      expect(report.proteins).toHaveLength(1);
      expect(report.proteins[0]).toMatchObject({ geneId: 10, sourceGeneIds: [10, 11], cds: 'ATGAAATAA', sequence: 'MK' });
      expect(JSON.stringify(rows)).toBe(before);
    }
  });

  test('never recovers legacy minus-strand joins without an exact deposited translation', () => {
    const parts = [{ start: 0, end: 6 }, { start: 8, end: 11 }];
    const qualifiers = { _segments: JSON.stringify(parts), translation: 'MN' };
    const rows = parts.map((part, index) => row({ id: 10 + index, startPos: part.start,
      endPos: part.end, strand: '-', qualifiers }));
    const report = collectProteinInputs('TTATTTCCCAT', rows);
    expect(report.proteins).toEqual([]);
    expect(report.excluded.map(item => item.geneId)).toEqual([10, 11]);
  });

  test('keeps explicit segment strands authoritative even when serialized as a string', () => {
    const parts = [{ start: 0, end: 6, strand: '-' }, { start: 8, end: 11, strand: '-' }];
    for (const encoded of [false, true]) {
      const qualifiers = { _segments: encoded ? JSON.stringify(parts) : parts, translation: 'MK' };
      const rows = encoded
        ? parts.map((part, index) => row({ id: 10 + index, startPos: part.start, endPos: part.end, strand: '-', qualifiers }))
        : [row({ endPos: 11, strand: '-', qualifiers })];
      const report = collectProteinInputs('TTATTTCCCAT', rows);
      expect(report.proteins).toEqual([]);
      expect(report.excluded).toHaveLength(rows.length);
    }
  });

  test('requires unique owned gene IDs and ignores non-CDS features', () => {
    expect(() => collectProteinInputs('ATGAAATAA', [row(), row()])).toThrow('unique integer gene IDs');
    expect(collectProteinInputs('ATGAAATAA', [row({ type: 'source' })]).proteins).toEqual([]);
    expect(() => collectProteinInputs('ATGAAATAA', [row(), row({ id: 2, phageId: 2 })])).toThrow('multiple phages');
  });

  test('persists exactly one row per feature with transcript order, location and repeated qualifiers', () => {
    const qualifiers = { translation: 'MK', note: ['first', 'second'] };
    const values = featureGeneValues(3, [{ type: 'CDS', start: 0, end: 11, strand: '+',
      gene: 'joined', locusTag: 'join1', product: 'protein', qualifiers,
      location: 'join(1..3,6..11)', segments: segments as Array<{ start: number; end: number; strand: '+' }> }]);
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ phageId: 3, startPos: 0, endPos: 11 });
    expect(JSON.parse(values[0].qualifiers)).toEqual({ ...qualifiers, _segments: segments, _location: 'join(1..3,6..11)', _sourceFeatureIndex: 0 });
    expect(qualifiers).toEqual({ translation: 'MK', note: ['first', 'second'] });
  });

  test('retains source and unsupported annotations without storing invalid gene intervals', () => {
    const sourceFeature = { type: 'source', location: '1..9', start: 0, end: 9, strand: '+' as const,
      segments: [{ start: 0, end: 9, strand: '+' as const }], qualifiers: { mol_type: 'genomic RNA' } };
    const unsupported = { type: 'CDS', location: 'join(1..3,REMOTE:7..9)', start: 0, end: 0, strand: null,
      segments: [], qualifiers: { product: 'retained protein', pseudo: '' } };
    const valid = { ...sourceFeature, type: 'CDS', qualifiers: { translation: 'MK' } };
    const features = [sourceFeature, unsupported, valid];
    const mapped = featureGeneValues(1, features);
    expect(mapped).toHaveLength(1);
    expect(JSON.parse(mapped[0].qualifiers)._sourceFeatureIndex).toBe(2);
    const retained = retainedCatalogFeatures(features);
    expect(retained.map(item => item.sourceFeatureIndex)).toEqual([0, 1]);
    expect(retained[0].feature).toEqual(sourceFeature);
    expect(retained[1].feature).toEqual(unsupported);
    expect(retained[1].reason).toContain('no local gene interval');
    const fresh = collectProteinInputs('ATGAAATAA', [{ id: 1, ...mapped[0] }]);
    expect(fresh.warnings).toEqual([]);
    expect(fresh.proteins[0].sequence).toBe('MK');
    expect(collectProteinInputs('ATGAAATAA', [row({ qualifiers: { translation: 'MK' } })]).warnings.join(' ')).toContain('lost');
  });

  test('intrinsic CAI uses the specified code when TAG is glutamine', () => {
    expect(calculateIntrinsicCai({ TAG: 1 }, { CAA: 8, CAG: 4, TAG: 2 }, 15)).toBeCloseTo(0.25);
    expect(calculateIntrinsicCai({ TAG: 1 }, { CAA: 8, CAG: 4, TAG: 2 }, 11)).toBe(0);
  });
});

function database(): Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE phages (id INTEGER PRIMARY KEY, genome_length INTEGER);'
    + 'CREATE TABLE sequences (phage_id INTEGER, chunk_index INTEGER, sequence TEXT);'
    + 'CREATE TABLE genes (id INTEGER PRIMARY KEY, phage_id INTEGER, name TEXT, locus_tag TEXT,'
    + 'start_pos INTEGER, end_pos INTEGER, strand TEXT, product TEXT, type TEXT, qualifiers TEXT);'
    + "INSERT INTO phages VALUES (1, 9); INSERT INTO sequences VALUES (1, 0, 'ATGAAATAA');"
    + "INSERT INTO genes VALUES (7, 1, 'gene', 'locus', 0, 9, '+', 'protein', 'CDS', '{\"translation\":\"MK\"}');");
  return db;
}

describe('catalog protein extraction', () => {
  test('reads consistent sequence chunks and leaves source rows intact', () => {
    const db = database();
    try {
      const before = db.serialize();
      expect(readProteinInputs(db).proteins[0]).toMatchObject({ geneId: 7, sequence: 'MK' });
      expect(db.serialize()).toEqual(before);
    } finally { db.close(); }
  });

  test('fails on missing, truncated, duplicated, or reordered sequence chunks', () => {
    for (const mutation of ["DELETE FROM sequences", "UPDATE sequences SET sequence = 'ATGAAA'",
      'UPDATE sequences SET chunk_index = 1', "INSERT INTO sequences VALUES (1, 0, 'ATGAAATAA')"]) {
      const db = database();
      try {
        db.exec(mutation);
        expect(() => readProteinInputs(db)).toThrow();
        expect(db.query('SELECT COUNT(*) AS n FROM phages').get()).toEqual({ n: 1 });
      } finally { db.close(); }
    }
  });

  test('reconstructs shipped T4 intron and phiX174 origin joins against deposited proteins', () => {
    const db = new Database(new URL('../../web/public/phage.db', import.meta.url).pathname, { readonly: true });
    try {
      const report = readProteinInputs(db);
      for (const locus of ['T4p076', 'T4p230', 'T4p237', 'phiX174p03']) {
        const protein = report.proteins.find(item => item.locusTag === locus);
        expect(protein, locus).toBeDefined();
        const original = db.query<{ id: number; qualifiers: string }, [string]>(
          "SELECT id, qualifiers FROM genes WHERE locus_tag = ? AND type = 'CDS' ORDER BY id").all(locus);
        expect(original).toHaveLength(2);
        expect(protein!.sourceGeneIds).toEqual(original.map(item => item.id));
        expect(protein!.sequence).toBe(JSON.parse(original[0].qualifiers).translation);
        expect(protein!.cds.length).toBe((protein!.sequence.length + 1) * 3);
      }
      expect(report.proteins.find(item => item.locusTag === 'phiX174p03')!.cds).toHaveLength(363);
      const represented = report.proteins.flatMap(item => item.sourceGeneIds).concat(report.excluded.map(item => item.geneId));
      const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM genes WHERE type = 'CDS'").get()!.n;
      expect(represented).toHaveLength(total);
      expect(new Set(represented).size).toBe(total);
    } finally { db.close(); }
  });
});
