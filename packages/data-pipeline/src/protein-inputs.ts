/** One CDS-to-protein producer for catalog metrics, ESM2 and Pfam annotation. */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { GeneInfo } from '@phage-explorer/core';
import { reconstructCdsReference } from '../../core/src/analysis/cds-consequences';
import type { Database } from 'bun:sqlite';

export const PROTEIN_INPUT_METHOD = 'validated-genomic-cds-v1';
export type CodingGeneRow = Omit<GeneInfo, 'qualifiers'> & {
  phageId: number;
  qualifiers: string | Record<string, unknown> | null;
};
export interface ProteinInput {
  geneId: number;
  phageId: number;
  locusTag: string | null;
  /** Old catalogs stored one row per joined segment. These IDs describe one CDS. */
  sourceGeneIds: number[];
  cds: string;
  sequence: string;
  geneticCode: number;
  codonStart: number;
  cdsSha256: string;
  sequenceSha256: string;
}
export interface ProteinInputExclusion {
  geneId: number;
  phageId: number;
  locusTag: string | null;
  reasons: string[];
}
export interface ProteinInputs {
  format: 'phage-explorer-protein-inputs';
  version: 1;
  method: typeof PROTEIN_INPUT_METHOD;
  proteins: ProteinInput[];
  excluded: ProteinInputExclusion[];
  /** Legacy catalog parsers did not preserve every qualifier. */
  warnings: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function normalize(row: CodingGeneRow): { gene: GeneInfo; splitKey: string | null } {
  const value: unknown = typeof row.qualifiers === 'string' ? JSON.parse(row.qualifiers) : row.qualifiers ?? {};
  if (!object(value)) throw new Error('CDS qualifiers are not an object.');
  const qualifiers = { ...value };
  for (const key of ['transl_table', 'codon_start']) {
    const item = qualifiers[key];
    if (Object.hasOwn(qualifiers, key) && !(typeof item === 'string' && /^[1-9]\d*$/.test(item)
      || typeof item === 'number' && Number.isSafeInteger(item) && item > 0)) {
      throw new Error(`CDS /${key} must contain one positive integer.`);
    }
  }
  let splitKey: string | null = null;
  if (Object.hasOwn(qualifiers, '_segments')) {
    const encoded = typeof qualifiers._segments === 'string';
    const segments: unknown = encoded ? JSON.parse(qualifiers._segments as string) : qualifiers._segments;
    if (!Array.isArray(segments) || !segments.length || segments.length > 1000) {
      throw new Error('Invalid CDS segment list.');
    }
    qualifiers._segments = segments.map(segment => {
      if (!object(segment) || !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)) {
        throw new Error('Invalid CDS segment coordinates.');
      }
      // The old catalog representation lacked per-segment strands. Its order
      // is retained, and the complete reconstruction must match /translation.
      const strand = segment.strand ?? (encoded ? row.strand : null);
      if (strand !== '+' && strand !== '-') throw new Error('Missing CDS segment strand.');
      return { start: segment.start, end: segment.end, strand };
    });
    if (encoded) {
      splitKey = JSON.stringify([row.phageId, row.name, row.locusTag, row.product, row.strand, qualifiers]);
    }
  }
  return { gene: { ...row, qualifiers }, splitKey };
}

/**
 * Reconstruct complete transcript sequences, then validate the deposited
 * translation. Invalid or recoded CDSs are exclusions, never truncated proteins
 * or internal stops changed to X. Each accepted protein has a concrete gene ID.
 */
export function collectProteinInputs(genome: string, rows: readonly CodingGeneRow[]): ProteinInputs {
  const result: ProteinInputs = { format: 'phage-explorer-protein-inputs', version: 1,
    method: PROTEIN_INPUT_METHOD, proteins: [], excluded: [], warnings: [] };
  const groups = new Map<string, Array<{ row: CodingGeneRow; gene: GeneInfo; split: boolean }>>();
  const seen = new Set<number>();
  let ownerId: number | undefined;
  let legacyAnnotations = false;
  const sequenceSource = genome.toUpperCase();
  const exclude = (row: CodingGeneRow, reasons: string[]) => {
    result.excluded.push({ geneId: row.id, phageId: row.phageId, locusTag: row.locusTag, reasons });
  };
  for (const row of rows) {
    if (row.type !== 'CDS') continue;
    if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.phageId) || seen.has(row.id)) {
      throw new Error('CDS inputs require unique integer gene IDs and explicit genome ownership.');
    }
    if (ownerId !== undefined && ownerId !== row.phageId) throw new Error('One genome sequence cannot describe CDS rows from multiple phages.');
    ownerId = row.phageId;
    seen.add(row.id);
    try {
      const { gene, splitKey } = normalize(row);
      if (typeof gene.qualifiers?._location !== 'string' || !Number.isSafeInteger(gene.qualifiers?._sourceFeatureIndex)) legacyAnnotations = true;
      const key = splitKey === null ? `gene:${row.id}` : `split:${splitKey}`;
      const group = groups.get(key) ?? [];
      group.push({ row, gene, split: splitKey !== null });
      groups.set(key, group);
    } catch (error) {
      exclude(row, [error instanceof Error ? error.message : 'Invalid CDS annotations.']);
    }
  }
  if (legacyAnnotations) result.warnings.push('Genome ' + ownerId + ': legacy catalog annotations may have lost valueless or recoding qualifiers. Deposited translation checks validate sequence reconstruction, not the absence of lost flags; rebuild from the original GenBank source to recover annotations.');
  for (const group of groups.values()) {
    group.sort((a, b) => a.row.id - b.row.id);
    const { row, gene, split } = group[0];
    if (split) {
      if (typeof gene.qualifiers!.translation !== 'string' || !gene.qualifiers!.translation.trim()) {
        for (const item of group) exclude(item.row, ['Legacy joined CDS rows require a deposited translation to validate their reconstruction.']);
        continue;
      }
      const segments = gene.qualifiers!._segments as Array<{ start: number; end: number }>;
      const expected = segments.map(segment => `${segment.start}:${segment.end}`).sort();
      const actual = group.map(item => `${item.row.startPos}:${item.row.endPos}`).sort();
      // Do not coalesce merely matching names, or guess which partial row is
      // the protein. The old row group must represent every segment once.
      if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
        for (const item of group) exclude(item.row, ['Incomplete or duplicated rows for a joined CDS; rebuild annotations from the original GenBank record.']);
        continue;
      }
    }
    const reference = reconstructCdsReference(gene, sequenceSource);
    const sequence = reference.protein?.replace(/\*$/, '') ?? '';
    if (reference.reasons.length || !reference.cds || !sequence || /[^ACDEFGHIKLMNPQRSTVWY]/.test(sequence)) {
      const reasons = reference.reasons.length ? reference.reasons : ['CDS does not yield a complete unambiguous protein.'];
      for (const item of group) exclude(item.row, reasons);
      continue;
    }
    result.proteins.push({ geneId: row.id, phageId: row.phageId, locusTag: row.locusTag,
      sourceGeneIds: group.map(item => item.row.id), cds: reference.cds, sequence,
      geneticCode: reference.geneticCode, codonStart: reference.codonStart,
      cdsSha256: digest(reference.cds), sequenceSha256: digest(sequence) });
  }
  result.proteins.sort((a, b) => a.geneId - b.geneId);
  result.excluded.sort((a, b) => a.geneId - b.geneId);
  return result;
}

/** Read one consistent SQLite snapshot; this function never alters source rows. */
export function readProteinInputs(db: Database): ProteinInputs {
  const result: ProteinInputs = { format: 'phage-explorer-protein-inputs', version: 1,
    method: PROTEIN_INPUT_METHOD, proteins: [], excluded: [], warnings: [] };
  db.exec('BEGIN');
  try {
    const genomes = db.query<{ id: number; genome_length: number }, []>('SELECT id, genome_length FROM phages ORDER BY id').all();
    for (const genome of genomes) {
      const chunks = db.query<{ chunk_index: number; sequence: string }, [number]>(
        'SELECT chunk_index, sequence FROM sequences WHERE phage_id = ? ORDER BY chunk_index').all(genome.id);
      if (!Number.isSafeInteger(genome.genome_length) || genome.genome_length < 0 || chunks.some((chunk, index) =>
        chunk.chunk_index !== index || chunk.sequence.length !== Math.min(10000, genome.genome_length - index * 10000))) {
        throw new Error(`Genome ${genome.id} contains incomplete sequence chunks.`);
      }
      const sequence = chunks.map(chunk => chunk.sequence).join('');
      if (sequence.length !== genome.genome_length) throw new Error(`Genome ${genome.id} sequence length differs from its catalog.`);
      const rows = db.query<CodingGeneRow, [number]>(`SELECT id, phage_id AS phageId, name, locus_tag AS locusTag,
        start_pos AS startPos, end_pos AS endPos, strand, product, type, qualifiers
        FROM genes WHERE phage_id = ? AND type = 'CDS' ORDER BY id`).all(genome.id);
      const inputs = collectProteinInputs(sequence, rows);
      result.proteins.push(...inputs.proteins); result.excluded.push(...inputs.excluded);
      result.warnings.push(...inputs.warnings);
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, allowPositionals: false,
      options: { database: { type: 'string' } } });
    if (!values.database) throw new Error('Supply --database with the source SQLite file.');
    const { Database: Sqlite } = await import('bun:sqlite');
    const db = new Sqlite(values.database, { readonly: true });
    try { console.log(JSON.stringify(readProteinInputs(db))); }
    finally { db.close(); }
  } catch (error) {
    console.error('Protein input extraction failed:', error instanceof Error ? error.message : 'invalid source');
    process.exitCode = 1;
  }
}
