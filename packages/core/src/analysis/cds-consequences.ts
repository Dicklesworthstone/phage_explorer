/** Post-alignment CDS projection: evaluate whole query haplotypes, not isolated SNVs.
 * Locations/codon_start: https://www.insdc.org/submitting-standards/feature-table/
 * Tables 1/11 and initiators: https://www.ncbi.nlm.nih.gov/Taxonomy/Utils/wprintgc.cgi
 * These descriptive sequence consequences are not functional/pathogenicity predictions.
 */
import { reverseComplement, translateSequence } from '../codons';
import { getGeneMapSegments, importLocalGenomes, type GenomeInput } from '../genome-import';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import type { GeneInfo } from '../types';

export const CDS_CONSEQUENCE_LIMITS = { sequences: 24, columns: 250000, cells: 4000000,
  comparisons: 12000, projectedColumns: 8000000 } as const;
export interface CdsAlignment {
  name: string; source: 'local' | 'demo';
  sequences: Array<{ id: string; description: string; sequence: string }>;
}
export interface CdsConsequenceOptions {
  referenceId: string;
  terminalGaps: 'missing' | 'alleles';
  /** Accession or full imported content ID. Required only when matching records are ambiguous. */
  annotationRecord?: string | null;
  geneIds?: number[] | null;
}
export type CdsEffect = 'unchanged' | 'synonymous' | 'amino-acid-change' | 'inframe-indel' |
  'frameshift' | 'frame-restored' | 'premature-stop' | 'terminal-stop-lost' | 'start-codon-lost' | 'cds-deleted';
interface Segment { start: number; end: number; strand: '+' | '-' }
export interface CdsReference {
  geneId: number; name: string; product: string | null; geneticCode: number; codonStart: number;
  segments: Segment[]; cds: string | null; protein: string | null; reasons: string[];
}
export interface CdsConsequence {
  geneId: number; sequenceId: string; status: 'available' | 'unavailable'; effects: CdsEffect[]; reasons: string[];
  queryCds: string | null; queryProtein: string | null;
  missingReferenceBases: number; ambiguousQueryBases: number; changedColumns: number;
  insertedBases: number; deletedBases: number; queryTrailingBases: number;
  /** Zero-based reference-CDS boundary and length; insertion/deletion runs in transcript order. */
  indels: Array<{ kind: 'insertion' | 'deletion'; cdsOffset: number; length: number }>;
  firstProteinDifference: number | null;
}
export interface CdsConsequenceExperiment {
  reference: { sequenceId: string; accession: string; contentId: string; warnings: string[] };
  genes: CdsReference[]; consequences: CdsConsequence[];
  summary: { genes: number; queries: number; comparisons: number; available: number; changed: number; unavailable: number };
  record: AnalysisRecord;
}
export const CDS_CONSEQUENCE_METHOD = { id: 'aligned-cds-consequences', version: '1',
  implementation: 'reference-coordinate transcript projection; whole-haplotype translation and alignment-conditional indel runs' };
const LIMITATIONS = [
  'Consequences are conditional on the supplied alignment and reference annotations, not independently validated gene function or phenotype predictions.',
  'All query changes within a CDS are evaluated together. No isolated-variant attribution, donor, clinical impact, expression or host-range inference is made.',
  'Reference CDS boundaries are projected unchanged. Internal insertions are included; boundary insertions and noncontiguous inter-segment sequence are excluded. Splicing/regulatory changes and query-specific gene discovery are not modeled.',
  'Tables 1 and 11 only. Pseudogenes, recoding/slippage/exception qualifiers, mixed/overlapping transcript segments, incomplete reference codons and internal reference stops are unavailable.',
  'Frameshift refers to a non-triplet alignment gap run, even when a later run restores the frame. Stop/start labels describe the projected region; no downstream extension or initiation efficiency is inferred.',
  'Missing terminal coverage or ambiguous coding bases prevents a complete query consequence. Internal gaps are deletions conditional on the alignment, not proof of an assembly-independent event.',
  'Replay recomputes CDS projection and translation from the stored alignment and GenBank source; it does not rerun or validate the upstream alignment method.',
];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exactKeys(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(key => !allowed.includes(key))) throw new Error('Unsupported CDS comparison fields.');
}
function label(v: unknown, maximum: number, empty = false): v is string {
  return typeof v === 'string' && (empty || !!v.trim()) && v.length <= maximum && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
}
function validateAlignment(value: unknown): CdsAlignment {
  if (!object(value)) throw new Error('Invalid CDS alignment.');
  exactKeys(value, ['name', 'source', 'sequences']);
  if (!label(value.name, 512) || !['local', 'demo'].includes(String(value.source)) || !Array.isArray(value.sequences)
    || value.sequences.length < 2 || value.sequences.length > CDS_CONSEQUENCE_LIMITS.sequences) throw new Error('CDS comparison requires 2–24 aligned DNA sequences and a dataset name/source.');
  let cells = 0;
  const sequences = value.sequences.map(row => {
    if (!object(row)) throw new Error('Invalid aligned sequence.');
    exactKeys(row, ['id', 'description', 'sequence']);
    if (!label(row.id, 512) || /\s/.test(row.id) || !label(row.description, 2048, true)
      || typeof row.sequence !== 'string' || !row.sequence || row.sequence.length > CDS_CONSEQUENCE_LIMITS.columns
      || /[^ACGTRYSWKMBDHVN-]/i.test(row.sequence) || !/[ACGTRYSWKMBDHVN]/i.test(row.sequence)) throw new Error('Invalid aligned DNA, identifier or description.');
    cells += row.sequence.length;
    return { id: row.id, description: row.description, sequence: row.sequence.toUpperCase() };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (cells > CDS_CONSEQUENCE_LIMITS.cells || new Set(sequences.map(row => row.id)).size !== sequences.length
    || sequences.some(row => row.sequence.length !== sequences[0].sequence.length)) throw new Error('Alignment must have unique IDs, equal columns and at most 4,000,000 cells.');
  return { name: value.name, source: value.source as CdsAlignment['source'], sequences };
}
function validateOptions(value: CdsConsequenceOptions): Required<CdsConsequenceOptions> {
  if (!object(value)) throw new Error('Invalid CDS comparison options.');
  exactKeys(value, ['referenceId', 'terminalGaps', 'annotationRecord', 'geneIds']);
  if (!label(value.referenceId, 512) || !['missing', 'alleles'].includes(value.terminalGaps)
    || value.annotationRecord != null && !label(value.annotationRecord, 512)) throw new Error('Choose a reference, annotation record and explicit terminal-gap policy.');
  const ids = value.geneIds ?? null;
  if (ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > CDS_CONSEQUENCE_LIMITS.comparisons
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)) throw new Error('CDS IDs must be distinct positive integers.');
  return { referenceId: value.referenceId, terminalGaps: value.terminalGaps,
    annotationRecord: value.annotationRecord ?? null, geneIds: ids ? [...ids].sort((a, b) => a - b) : null };
}
// Initiator sets are NCBI's Starts rows, not the meanings of internal codons.
const STARTS: Record<number, readonly string[]> = { 1: ['TTG', 'CTG', 'ATG'], 11: ['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG'] };
function protein(cds: string, code: number, initiation: boolean): string {
  const translated = translateSequence(cds);
  return initiation && STARTS[code]?.includes(cds.slice(0, 3)) ? 'M' + translated.slice(1) : translated;
}
/** Reconstruct a validated transcript without changing its original coordinate system. */
export function reconstructCdsReference(gene: GeneInfo, genome: string): CdsReference {
  const q = gene.qualifiers ?? {}, reasons: string[] = [];
  // Zero is an explicit unsupported sentinel; never export NaN from malformed qualifiers.
  const table = Number(q.transl_table ?? 1), start = Number(q.codon_start ?? 1);
  const geneticCode = Number.isSafeInteger(table) ? table : 0, codonStart = Number.isSafeInteger(start) ? start : 0;
  const raw = getGeneMapSegments(gene);
  if (!STARTS[geneticCode]) reasons.push('Unsupported translation table.');
  if (![1, 2, 3].includes(codonStart)) reasons.push('Unsupported codon_start.');
  for (const qualifier of ['pseudo', 'pseudogene', 'exception', 'transl_except', 'ribosomal_slippage', 'trans_splicing', 'artificial_location']) {
    if (Object.hasOwn(q, qualifier)) reasons.push(`Unsupported /${qualifier} qualifier.`);
  }
  const sorted = [...raw].sort((a, b) => a.start - b.start);
  if (!raw.length || Array.isArray(q._segments) && q._segments.length !== raw.length
    || raw.some(s => !Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end) || s.start < 0 || s.end > genome.length
      || s.start >= s.end || !['+', '-'].includes(s.strand ?? '') || s.strand !== raw[0].strand)
    || sorted.some((s, i) => i > 0 && s.start < sorted[i - 1].end)) reasons.push('Unsupported mixed, overlapping or out-of-bounds CDS segments.');
  const base: CdsReference = { geneId: gene.id, name: gene.locusTag ?? gene.name ?? `CDS ${gene.id}`,
    product: gene.product, geneticCode, codonStart, segments: [], cds: null, protein: null, reasons };
  if (reasons.length) return base;
  // codon_start is measured in REFERENCE transcript coordinates, not query bases.
  let skip = codonStart - 1;
  for (const part of raw) {
    const remove = Math.min(skip, part.end - part.start); skip -= remove;
    const segment: Segment = { start: part.start + (part.strand === '+' ? remove : 0),
      end: part.end - (part.strand === '-' ? remove : 0), strand: part.strand as '+' | '-' };
    if (segment.start < segment.end) base.segments.push(segment);
  }
  base.cds = base.segments.map(s => s.strand === '+' ? genome.slice(s.start, s.end) : reverseComplement(genome.slice(s.start, s.end))).join('');
  if (!base.cds || base.cds.length % 3) reasons.push('Reference CDS lacks complete terminal codons.');
  if (/[^ACGT]/.test(base.cds)) reasons.push('Reference CDS contains unresolved bases.');
  if (!reasons.length) {
    base.protein = protein(base.cds, geneticCode, codonStart === 1);
    if (base.protein.slice(0, -1).includes('*')) reasons.push('Reference CDS has an internal stop; recoding is not inferred.');
    if (q.translation !== undefined && (typeof q.translation !== 'string'
      || q.translation.replace(/\s/g, '').replace(/\*$/, '') !== base.protein.replace(/\*$/, ''))) reasons.push('Deposited reference translation differs from reconstructed CDS.');
  }
  return base;
}

/** Alignment-column slices in transcript order, including only internal/join-contiguous insertion slots. */
function transcriptRanges(segments: Segment[], positions: number[], columns: number, circular: boolean): Array<{ start: number; end: number; strand: '+' | '-' }> {
  const ranges: Segment[] = [], length = positions.length;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i], prev = segments[i - 1];
    if (prev) {
      if (s.strand === '+' && prev.end === s.start) ranges.push({ start: positions[prev.end - 1] + 1, end: positions[s.start], strand: '+' });
      else if (s.strand === '-' && prev.start === s.end) ranges.push({ start: positions[s.end - 1] + 1, end: positions[prev.start], strand: '-' });
      else if (circular && s.strand === '+' && prev.end === length && s.start === 0) {
        ranges.push({ start: positions[length - 1] + 1, end: columns, strand: '+' }, { start: 0, end: positions[0], strand: '+' });
      } else if (circular && s.strand === '-' && prev.start === 0 && s.end === length) {
        ranges.push({ start: 0, end: positions[0], strand: '-' }, { start: positions[length - 1] + 1, end: columns, strand: '-' });
      }
    }
    ranges.push({ start: positions[s.start], end: positions[s.end - 1] + 1, strand: s.strand });
  }
  return ranges;
}
function project(reference: CdsReference, ref: string, query: string, sequenceId: string, ranges: Segment[], terminalGaps: CdsConsequenceOptions['terminalGaps'], first: number, last: number): CdsConsequence {
  const row: CdsConsequence = { geneId: reference.geneId, sequenceId, status: 'unavailable', effects: [], reasons: [...reference.reasons],
    queryCds: null, queryProtein: null, missingReferenceBases: 0, ambiguousQueryBases: 0, changedColumns: 0,
    insertedBases: 0, deletedBases: 0, queryTrailingBases: 0, indels: [], firstProteinDifference: null };
  if (reference.reasons.length) return row;
  let consumed = 0, gapKind: 'insertion' | 'deletion' | null = null;
  const queryParts: string[] = [];
  for (const range of ranges) {
    // Runs are measured in the spliced coding alignment, including across joins.
    const r = ref.slice(range.start, range.end), q = query.slice(range.start, range.end);
    const a = range.strand === '+' ? r : reverseComplement(r), b = range.strand === '+' ? q : reverseComplement(q);
    queryParts.push(b.replaceAll('-', ''));
    for (let k = 0; k < a.length; k++) {
      const column = range.strand === '+' ? range.start + k : range.end - 1 - k;
      if (a[k] === '-' && b[k] === '-') continue;
      if (a[k] !== '-' && terminalGaps === 'missing' && (column < first || column > last)) row.missingReferenceBases++;
      if (b[k] !== '-' && !'ACGT'.includes(b[k])) row.ambiguousQueryBases++;
      if (a[k] !== b[k]) row.changedColumns++;
      const kind = a[k] === '-' ? 'insertion' : b[k] === '-' ? 'deletion' : null;
      if (kind) {
        if (kind !== gapKind) row.indels.push({ kind, cdsOffset: consumed, length: 0 });
        row.indels[row.indels.length - 1].length++;
        gapKind = kind;
        if (kind === 'insertion') row.insertedBases++; else row.deletedBases++;
      } else gapKind = null;
      if (a[k] !== '-') consumed++;
    }
  }
  row.queryCds = queryParts.join('');
  row.queryTrailingBases = row.queryCds.length % 3;
  if (row.missingReferenceBases) row.reasons.push('Missing terminal sequence overlaps the reference CDS.');
  if (row.ambiguousQueryBases) row.reasons.push('Query CDS contains unresolved bases.');
  if (row.reasons.length) return row;
  row.status = 'available';
  const cds = reference.cds!, originalProtein = reference.protein!;
  row.queryProtein = protein(row.queryCds, reference.geneticCode, reference.codonStart === 1);
  if (row.queryCds === cds) { row.effects = ['unchanged']; return row; }
  if (!row.queryCds) { row.effects = ['cds-deleted']; row.firstProteinDifference = 0; return row; }
  const disrupted = row.indels.some(indel => indel.length % 3 !== 0);
  if (disrupted) {
    row.effects.push('frameshift');
    if ((row.insertedBases - row.deletedBases) % 3 === 0) row.effects.push('frame-restored');
  } else if (row.indels.length) row.effects.push('inframe-indel');
  const firstStop = row.queryProtein.indexOf('*');
  if (firstStop >= 0 && firstStop < row.queryProtein.length - 1) row.effects.push('premature-stop');
  if (originalProtein.endsWith('*') && !row.queryProtein.endsWith('*')) row.effects.push('terminal-stop-lost');
  if (reference.codonStart === 1 && STARTS[reference.geneticCode].includes(cds.slice(0, 3))
    && !STARTS[reference.geneticCode].includes(row.queryCds.slice(0, 3))) row.effects.push('start-codon-lost');
  if (!disrupted && row.queryProtein === originalProtein) row.effects.push('synonymous');
  else if (!row.effects.length) row.effects.push('amino-acid-change');
  if (row.queryProtein !== originalProtein) {
    let at = 0;
    while (at < originalProtein.length && at < row.queryProtein.length && originalProtein[at] === row.queryProtein[at]) at++;
    row.firstProteinDifference = at;
  }
  return row;
}

/** Exact GenBank/reference identity is mandatory; accession equality is insufficient. */
export async function createCdsConsequenceExperiment(input: CdsAlignment, annotation: GenomeInput,
  settings: CdsConsequenceOptions): Promise<CdsConsequenceExperiment> {
  const alignment = validateAlignment(input), options = validateOptions(settings);
  const source = analysisJson(annotation) as unknown as GenomeInput; // capture before hashing/parsing awaits
  if (!object(source)) throw new Error('GenBank annotation source is missing.');
  exactKeys(source, ['name', 'text']);
  const ref = alignment.sequences.find(row => row.id === options.referenceId);
  if (!ref) throw new Error('The CDS reference is not in the alignment.');
  const refSequence = ref.sequence.replaceAll('-', '');
  const parsed = await importLocalGenomes(source);
  const matches = parsed.genomes.filter(g => g.phage.localGenome?.format === 'genbank' && g.sequence === refSequence
    && (options.annotationRecord === null || g.phage.accession === options.annotationRecord || g.phage.localGenome?.contentId === options.annotationRecord));
  if (matches.length !== 1) throw new Error('Choose exactly one GenBank record whose bases and origin exactly match the aligned reference. Use its accession or content ID to disambiguate.');
  const genome = matches[0]; options.annotationRecord = genome.phage.localGenome!.contentId;
  const codingGenes = genome.phage.genes.filter(g => g.type === 'CDS');
  if (options.geneIds?.some(id => !codingGenes.some(g => g.id === id))) throw new Error('A selected CDS ID is absent from the matched annotation.');
  const chosen = codingGenes.filter(g => !options.geneIds || options.geneIds.includes(g.id));
  if (!chosen.length) throw new Error('No supported mapped CDS annotations were supplied.');
  const queries = alignment.sequences.filter(row => row.id !== options.referenceId);
  if (chosen.length * queries.length > CDS_CONSEQUENCE_LIMITS.comparisons) throw new Error('More than 12,000 CDS/query comparisons; select fewer CDS or sequences.');
  const queryBounds = new Map(queries.map(query => {
    const first = query.sequence.search(/[^-]/); let last = query.sequence.length - 1;
    while (last >= 0 && query.sequence[last] === '-') last--;
    return [query.id, { first, last }];
  }));
  const positions: number[] = [];
  for (let c = 0; c < ref.sequence.length; c++) if (ref.sequence[c] !== '-') positions.push(c);
  let work = 0;
  const referenceWork = chosen.reduce((sum, gene) => sum + getGeneMapSegments(gene).reduce((n, s) => n + s.end - s.start, 0), 0);
  if (referenceWork * (queries.length + 1) > CDS_CONSEQUENCE_LIMITS.projectedColumns) throw new Error('CDS projection exceeds 8,000,000 bases; select fewer CDS or sequences.');
  const genes = chosen.map(gene => reconstructCdsReference(gene, refSequence)), consequences: CdsConsequence[] = [];
  for (const gene of genes) {
    const ranges = transcriptRanges(gene.segments, positions, ref.sequence.length, genome.phage.localGenome!.topology === 'circular');
    work += ranges.reduce((sum, range) => sum + range.end - range.start, 0) * queries.length;
    if (work > CDS_CONSEQUENCE_LIMITS.projectedColumns) throw new Error('CDS projection exceeds 8,000,000 columns; select fewer CDS or sequences.');
    for (const query of queries) {
      const { first, last } = queryBounds.get(query.id)!;
      consequences.push(project(gene, ref.sequence, query.sequence, query.id, ranges, options.terminalGaps, first, last));
    }
  }
  const available = consequences.filter(row => row.status === 'available');
  const summary = { genes: genes.length, queries: queries.length, comparisons: consequences.length,
    available: available.length, changed: available.filter(row => !row.effects.includes('unchanged')).length,
    unavailable: consequences.length - available.length };
  const reference = { sequenceId: ref.id, accession: genome.phage.accession, contentId: genome.phage.localGenome!.contentId, warnings: genome.warnings };
  const coverage = { available: summary.available, total: summary.comparisons, unit: 'records' as const };
  const field = (label: string, value: unknown) => alignment.source === 'demo'
    ? { label, value: analysisJson(value), kind: 'demo' as const, units: 'records' as const, coverage,
        limitations: LIMITATIONS, assumptions: ['User explicitly marked the alignment as synthetic.'] }
    : { label, value: analysisJson(value), kind: 'sequence-score' as const, units: 'records' as const, coverage, limitations: LIMITATIONS };
  const record = await createAnalysisRecord({ method: CDS_CONSEQUENCE_METHOD, seed: null,
    inputs: [
      { id: 'alignment', accession: null, source: alignment.source, description: 'Exact submitted aligned sequences; upstream alignment is conditional input.', data: analysisJson(alignment) },
      { id: 'genbank', accession: genome.phage.accession, source: 'local', description: 'Original GenBank source, reparsed during replay; one exact sequence-matched record supplies CDS.', data: analysisJson(source) },
    ], parameters: analysisJson(options) as AnalysisRecord['parameters'],
    references: [{ id: 'insdc-feature-table', version: 'CDS-codon-start-1-2-3', description: 'Transcript-order joined/complement locations; codon_start locates the first complete codon.' },
      { id: 'ncbi-genetic-codes', version: 'tables-1-and-11', description: 'Standard internal codon meanings and table-specific initiator methionine.' }],
    fields: { reference: field('Matched reference annotation and parser coverage warnings', reference),
      genes: field('Reference coding transcripts and conceptual translation', genes),
      consequences: field('Combined query-haplotype coding consequences', consequences), summary: field('Available, changed and unavailable comparisons', summary) } });
  return { reference, genes, consequences, summary, record };
}
export async function replayCdsConsequenceExperiment(content: string): Promise<CdsConsequenceExperiment> {
  const saved = await parseAnalysisRecord(content, { methodId: CDS_CONSEQUENCE_METHOD.id, methodVersion: CDS_CONSEQUENCE_METHOD.version });
  if (saved.inputs.length !== 2) throw new Error('Unexpected CDS experiment inputs.');
  const alignment = saved.inputs.find(i => i.id === 'alignment')?.data;
  const annotation = saved.inputs.find(i => i.id === 'genbank')?.data;
  const fresh = await createCdsConsequenceExperiment(alignment as unknown as CdsAlignment, annotation as unknown as GenomeInput,
    saved.parameters as unknown as CdsConsequenceOptions);
  if (fresh.record.cacheKey !== saved.cacheKey || fresh.record.resultId !== saved.resultId) throw new Error('Recomputed CDS inputs, method, transcripts or consequences differ from the saved result.');
  return fresh;
}

/** Shared UI/CLI selection syntax; blank explicitly means all mapped CDS. */
export function parseCdsGeneIds(value: string): number[] | null {
  if (typeof value !== 'string') throw new Error('CDS selection must be comma-separated IDs.');
  if (!value.trim()) return null;
  if (value.length > CDS_CONSEQUENCE_LIMITS.comparisons * 17) throw new Error('Too many CDS IDs.');
  const parts = value.split(',').map(part => part.trim());
  if (parts.length > CDS_CONSEQUENCE_LIMITS.comparisons || parts.some(part => !/^[1-9]\d*$/.test(part))) {
    throw new Error('CDS IDs must be comma-separated positive integers.');
  }
  const ids = parts.map(Number);
  if (ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) throw new Error('CDS IDs must be distinct safe integers.');
  return ids.sort((a, b) => a - b);
}

/** Tabular report over a freshly computed/verified experiment, including every unavailable row.
 * Escape controls/backslashes, and prefix spreadsheet formula-like text with an apostrophe.
 * Exact unescaped annotations and sequences remain in the experiment JSON.
 */
export function exportCdsConsequenceTable(experiment: CdsConsequenceExperiment): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value).replace(/\\/g, '\\\\').replace(/[\u0000-\u001f\u007f-\u009f]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  };
  const genes = new Map(experiment.genes.map(gene => [gene.geneId, gene]));
  const source = experiment.record.inputs.find(input => input.id === 'alignment')?.source ?? 'unknown';
  const header = ['cds_result_id', 'source', 'reference_sequence', 'annotation_accession', 'annotation_content_id',
    'gene_id', 'gene_name', 'product', 'genetic_code', 'codon_start', 'reference_segments_0based_half_open',
    'query_sequence', 'status', 'effects', 'reasons', 'reference_cds_bases', 'query_cds_bases',
    'reference_protein_symbols', 'query_protein_symbols', 'first_protein_difference_0based',
    'inserted_bases', 'deleted_bases', 'missing_reference_bases', 'ambiguous_query_bases', 'query_trailing_bases'];
  const rows = experiment.consequences.map(row => {
    const gene = genes.get(row.geneId);
    if (!gene) throw new Error('CDS report refers to a missing reference gene.');
    return [experiment.record.resultId, source, experiment.reference.sequenceId, experiment.reference.accession,
      experiment.reference.contentId, gene.geneId, gene.name, gene.product, gene.geneticCode, gene.codonStart,
      gene.segments.map(segment => `${segment.start}:${segment.end}:${segment.strand}`).join(';'),
      row.sequenceId, row.status, row.effects.join(';'), row.reasons.join(' | '), gene.cds?.length, row.queryCds?.length,
      gene.protein?.length, row.queryProtein?.length, row.firstProteinDifference, row.insertedBases,
      row.deletedBases, row.missingReferenceBases, row.ambiguousQueryBases, row.queryTrailingBases].map(cell).join('\t');
  });
  return [header.join('\t'), ...rows, ''].join('\n');
}

/** Export supported reference sequences and nonempty, available projected query sequences.
 * Includes complete conceptual protein translations with '*' stop symbols; these are not
 * deposited/query-annotated proteins. Unavailable or deleted sequences are never invented.
 * Call only with a freshly computed/verified experiment; this formatter is not a verifier.
 */
export function exportCdsConsequenceFasta(experiment: CdsConsequenceExperiment, molecule: 'cds' | 'protein'): string {
  if (molecule !== 'cds' && molecule !== 'protein') throw new Error('Choose CDS or protein FASTA.');
  const source = experiment.record.inputs.find(input => input.id === 'alignment')?.source ?? 'unknown';
  const blocks: string[] = [];
  // Percent-encoded metadata cannot inject FASTA records or whitespace-delimited fields.
  const encoded = (text: string): string => Array.from(new TextEncoder().encode(text), byte =>
    byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 95 || byte === 46
      ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  const add = (id: string, sequence: string | null, sequenceId: string, gene: CdsReference, role: string, effects: string[]) => {
    if (!sequence) return;
    const lines: string[] = [];
    for (let i = 0; i < sequence.length; i += 80) lines.push(sequence.slice(i, i + 80));
    blocks.push(`>${id} molecule=${molecule} role=${role} source=${source} sequence=${encoded(sequenceId)} gene_id=${gene.geneId} gene=${encoded(gene.name)} effects=${effects.join(',')} cds_result=${experiment.record.resultId}\n${lines.join('\n')}\n`);
  };
  const genes = new Map(experiment.genes.map(gene => [gene.geneId, gene]));
  for (const gene of experiment.genes) {
    if (!gene.reasons.length) add(`reference_g${gene.geneId}`, molecule === 'cds' ? gene.cds : gene.protein,
      experiment.reference.sequenceId, gene, 'reference', []);
  }
  experiment.consequences.forEach((row, index) => {
    const gene = genes.get(row.geneId);
    if (!gene) throw new Error('CDS FASTA refers to a missing reference gene.');
    if (row.status === 'available' && !gene.reasons.length) add(`query_${index + 1}_g${gene.geneId}`,
      molecule === 'cds' ? row.queryCds : row.queryProtein, row.sequenceId, gene, 'projected-query', row.effects);
  });
  if (!blocks.length) throw new Error('No supported nonempty sequences are available for this FASTA export. Export the consequence table for unavailable reasons.');
  return blocks.join('');
}
