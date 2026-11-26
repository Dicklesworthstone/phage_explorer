/** Exact strand-aware interval comparisons retain complete original genomes.
 * Intervals are deliberate source-coordinate selections, never derivative FASTA
 * identities or inferred homologous loci. Alignment reuses the bounded unit-edit
 * producer; every accepted result includes a complete traceback.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../../core/src/analysis-result';
import { GENOME_IMPORT_LIMITS, getGeneMapSegments, importLocalGenomes, parseLocalFeatureLocation,
  type GenomeInput, type LocalGenome } from '../../core/src/genome-import';
import { reverseComplement } from '../../core/src/codons';
import type { GeneInfo } from '../../core/src/types';
import { WAVEFRONT_LIMITS } from '../../core/src/analysis/wavefront-alignment';
import { computeSequenceDiff, type SequenceDiffRun, type SequenceDiffStats } from './sequence-diff';

export const REGION_COMPARISON_LIMITS = {
  inputBytes: GENOME_IMPORT_LIMITS.bytes, recordBytes: 10 * 1024 * 1024, outputBytes: 10 * 1024 * 1024,
  regionBases: WAVEFRONT_LIMITS.length, annotationRows: 12000, annotationSegments: 50000,
} as const;
export const REGION_COMPARISON_METHOD = {
  id: 'genome-region-comparison', version: '1',
  implementation: 'exact source reimport; explicit interval/strand selection; bounded global unit-edit wavefront traceback; reversible source-coordinate and annotation-segment maps',
} as const;
export const REGION_COMPARISON_REFERENCES: AnalysisRecord['references'] = [
  { id: 'global-unit-edit-wavefront', version: '1',
    description: 'Exact unit-cost insertion, deletion and substitution alignment; deterministic traceback with bounded states/comparisons; equal IUPAC symbols match literally.' },
  { id: 'source-coordinate-convention', version: '0-based-half-open-v1',
    description: 'Intervals and edits use 0-based half-open source coordinates. Reverse intervals map [a,b) to [end-b,end-a); empty spans denote interbase boundaries.' },
];
const LIMITATIONS = [
  'Alignment compares the two explicitly selected, non-wrapping genomic intervals in the submitted strand orientations. It does not search for homologous loci, rotate a circular genome or infer rearrangements.',
  'Each insertion, deletion and substitution costs one. Equal-cost alignments can place edits differently in repetitive sequence. No gap-affine scoring, calibrated significance or evolutionary distance is claimed.',
  'IUPAC symbols match literally after uppercase normalization; an N/N match does not resolve either base. Identity is equal symbols divided by alignment columns, not resolved nucleotide identity.',
  'Source edit spans are 0-based half-open genomic intervals. Reverse-strand spans are reported with ascending source endpoints and explicit strand; zero-length spans identify insertion/deletion boundaries.',
  'Annotation context clips exact mapped source segments to the selected interval. Joined gaps are not filled, duplicates are retained, and partial overlaps do not produce clipped-CDS translations or gene-function consequences.',
  'Complete named source inputs, selected record identities and source warnings are embedded. Checksums identify those supplied inputs; they do not authenticate annotation provenance.',
];

export interface RegionInterval { start: number; end: number; strand: '+' | '-' }
export interface RegionComparisonOptions {
  recordA?: string | null;
  recordB?: string | null;
  regionA: RegionInterval;
  regionB: RegionInterval;
}
export interface ResolvedRegionComparisonOptions {
  recordA: string;
  recordB: string;
  regionA: RegionInterval;
  regionB: RegionInterval;
}
export interface RegionComparisonSource {
  name: string;
  accession: string;
  contentId: string;
  sequenceSha256: string;
  genomeLength: number;
  format: 'fasta' | 'genbank' | 'catalog-snapshot';
  topology: 'linear' | 'circular' | 'unknown';
}
export interface RegionAnnotationContext {
  gene: GeneInfo;
  fullyContained: boolean;
  segments: Array<{
    sourceStart: number; sourceEnd: number; regionStart: number; regionEnd: number;
    sourceStrand: string | null; regionStrand: string | null;
  }>;
}
export interface RegionComparisonRun extends SequenceDiffRun {
  sourceStartA: number; sourceEndA: number; sourceStartB: number; sourceEndB: number;
}
export interface RegionComparisonResult {
  sourceA: RegionComparisonSource;
  sourceB: RegionComparisonSource;
  regionA: RegionInterval & { sequence: string };
  regionB: RegionInterval & { sequence: string };
  alignedA: string;
  alignedB: string;
  runs: RegionComparisonRun[];
  stats: SequenceDiffStats;
  annotationsA: RegionAnnotationContext[];
  annotationsB: RegionAnnotationContext[];
  annotationWarnings: string[];
  diagnostics: { states: number; comparisons: number };
  limitations: string[];
}
export interface RegionComparisonExperiment {
  inputA: GenomeInput;
  inputB: GenomeInput;
  options: ResolvedRegionComparisonOptions;
  result: RegionComparisonResult;
  record: AnalysisRecord;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const same = (left: unknown, right: unknown) => JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right));
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Region comparison cancelled.', 'AbortError');
}
function bounded(content: string, limit: number, label: string): void {
  if (content.length > limit || new TextEncoder().encode(content).length > limit) throw new Error(label + ' exceeds the 10 MiB limit.');
}
function snapshotInput(value: GenomeInput, label: string): GenomeInput {
  if (!object(value) || Object.keys(value).some(key => key !== 'name' && key !== 'text')
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 2000 || typeof value.text !== 'string') {
    throw new Error(label + ' requires its complete named original genome input.');
  }
  bounded(value.text, REGION_COMPARISON_LIMITS.inputBytes, label);
  return { name: value.name, text: value.text };
}
function selector(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(label + ' must be an accession or complete content ID.');
  }
  return value;
}
function interval(value: unknown, label: string): RegionInterval {
  if (!object(value) || Object.keys(value).some(key => !['start', 'end', 'strand'].includes(key))
    || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || Number(value.start) < 0 || Number(value.end) <= Number(value.start)
    || value.strand !== '+' && value.strand !== '-') {
    throw new Error(label + ' requires a nonempty 0-based half-open interval and an explicit + or - strand. Origin-wrapping intervals are not inferred.');
  }
  if (Number(value.end) - Number(value.start) > REGION_COMPARISON_LIMITS.regionBases) {
    throw new Error(label + ' exceeds 250,000 selected bases. Choose a smaller source interval.');
  }
  return { start: Number(value.start), end: Number(value.end), strand: value.strand as '+' | '-' };
}
function snapshotOptions(value: RegionComparisonOptions): {
  recordA: string | null; recordB: string | null; regionA: RegionInterval; regionB: RegionInterval;
} {
  if (!object(value) || Object.keys(value).some(key => !['recordA', 'recordB', 'regionA', 'regionB'].includes(key))) {
    throw new Error('Unsupported region comparison settings.');
  }
  return { recordA: selector(value.recordA, 'Genome A record'), recordB: selector(value.recordB, 'Genome B record'),
    regionA: interval(value.regionA, 'Genome A region'), regionB: interval(value.regionB, 'Genome B region') };
}
async function selectedGenome(input: GenomeInput, record: string | null, region: RegionInterval,
  label: string, signal?: AbortSignal): Promise<LocalGenome> {
  const parsed = await importLocalGenomes(input);
  check(signal);
  const exact = record === null ? undefined : parsed.genomes.find(genome => genome.phage.localGenome!.contentId === record);
  const matches = exact ? [exact] : parsed.genomes.filter(genome => record === null || genome.phage.accession === record);
  if (matches.length !== 1) throw new Error(label + ': choose exactly one record by accession or complete content ID; multi-record inputs are never selected implicitly.');
  const genome = matches[0];
  if (region.end > genome.sequence.length) throw new Error(label + ' region is outside the complete ' + genome.sequence.length + '-base source.');
  return genome;
}
function sourceIdentity(genome: LocalGenome): RegionComparisonSource {
  const identity = genome.phage.localGenome!;
  return { name: genome.phage.name, accession: genome.phage.accession, contentId: identity.contentId,
    sequenceSha256: identity.sequenceSha256, genomeLength: genome.sequence.length,
    format: identity.format, topology: identity.topology };
}
function orientedRegion(genome: LocalGenome, region: RegionInterval): RegionInterval & { sequence: string } {
  const sequence = genome.sequence.slice(region.start, region.end);
  return { ...region, sequence: region.strand === '+' ? sequence : reverseComplement(sequence) };
}
function sourceSpan(region: RegionInterval, start: number, end: number): [number, number] {
  return region.strand === '+' ? [region.start + start, region.start + end] : [region.end - end, region.end - start];
}

/** Context uses the supplied transcript segments, not a CDS bounding box. */
function annotationContext(genome: LocalGenome, region: RegionInterval, label: string): {
  rows: RegionAnnotationContext[]; warnings: string[];
} {
  const rows: RegionAnnotationContext[] = [], warnings = genome.warnings.map(warning => label + ': ' + warning);
  let segmentCount = 0;
  for (const gene of genome.phage.genes) {
    if (gene.startPos >= region.end || gene.endPos <= region.start) continue;
    const raw = getGeneMapSegments(gene), qualifiers = gene.qualifiers ?? {};
    let invalid = raw.length === 0 || raw.length > GENOME_IMPORT_LIMITS.segments
      || Object.hasOwn(qualifiers, '_location') && typeof qualifiers._location !== 'string'
      || Object.hasOwn(qualifiers, '_segments') && (!Array.isArray(qualifiers._segments) || qualifiers._segments.length !== raw.length)
      || raw.some(part => !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end)
        || part.start < 0 || part.end <= part.start || part.end > genome.sequence.length || !['+', '-', null].includes(part.strand))
      || Math.min(...raw.map(part => part.start)) !== gene.startPos || Math.max(...raw.map(part => part.end)) !== gene.endPos;
    if (!invalid && typeof qualifiers._location === 'string') {
      try { invalid = !same(parseLocalFeatureLocation(qualifiers._location, genome.sequence.length), raw); }
      catch { invalid = true; }
    }
    if (invalid) {
      warnings.push(label + ': annotation ' + gene.id + ' has unavailable or inconsistent exact segments; no bounding-box context was substituted.');
      continue;
    }
    const segments: RegionAnnotationContext['segments'] = [];
    for (const part of raw) {
      const start = Math.max(part.start, region.start), end = Math.min(part.end, region.end);
      if (start >= end) continue;
      const regionStart = region.strand === '+' ? start - region.start : region.end - end;
      const regionEnd = region.strand === '+' ? end - region.start : region.end - start;
      const regionStrand = part.strand === null || region.strand === '+' ? part.strand : part.strand === '+' ? '-' : '+';
      segments.push({ sourceStart: start, sourceEnd: end, regionStart, regionEnd, sourceStrand: part.strand, regionStrand });
    }
    if (!segments.length) continue;
    segmentCount += segments.length;
    if (rows.length >= REGION_COMPARISON_LIMITS.annotationRows || segmentCount > REGION_COMPARISON_LIMITS.annotationSegments) {
      throw new Error(label + ' annotation context exceeds 12,000 rows or 50,000 segments. Choose a smaller region; no annotation rows were truncated.');
    }
    rows.push({ gene, fullyContained: raw.every(part => part.start >= region.start && part.end <= region.end), segments });
  }
  return { rows, warnings };
}

/** Inputs and settings are copied before hashing, parsing or caller callbacks can yield. */
export async function createRegionComparisonExperiment(rawA: GenomeInput, rawB: GenomeInput,
  settings: RegionComparisonOptions, signal?: AbortSignal): Promise<RegionComparisonExperiment> {
  check(signal);
  const inputA = snapshotInput(rawA, 'Genome A input'), inputB = snapshotInput(rawB, 'Genome B input');
  const requested = snapshotOptions(settings);
  bounded(JSON.stringify([inputA, inputB]), REGION_COMPARISON_LIMITS.recordBytes, 'Combined original sources');
  const genomeA = await selectedGenome(inputA, requested.recordA, requested.regionA, 'Genome A', signal);
  const genomeB = await selectedGenome(inputB, requested.recordB, requested.regionB, 'Genome B', signal);
  check(signal);
  const sourceA = sourceIdentity(genomeA), sourceB = sourceIdentity(genomeB);
  const options: ResolvedRegionComparisonOptions = {
    recordA: sourceA.contentId, recordB: sourceB.contentId, regionA: requested.regionA, regionB: requested.regionB,
  };
  const regionA = orientedRegion(genomeA, options.regionA), regionB = orientedRegion(genomeB, options.regionB);
  const annotationsA = annotationContext(genomeA, options.regionA, 'Genome A');
  const annotationsB = annotationContext(genomeB, options.regionB, 'Genome B');
  const diff = computeSequenceDiff(regionA.sequence, regionB.sequence);
  if (diff.status !== 'complete') throw new Error('Exact region alignment unavailable: ' + diff.reason);
  check(signal);
  const a: string[] = [], b: string[] = [];
  const runs = diff.runs.map((run): RegionComparisonRun => {
    const left = regionA.sequence.slice(run.startA, run.endA), right = regionB.sequence.slice(run.startB, run.endB);
    a.push(run.operation === 'insertion' ? '-'.repeat(right.length) : left);
    b.push(run.operation === 'deletion' ? '-'.repeat(left.length) : right);
    const [sourceStartA, sourceEndA] = sourceSpan(options.regionA, run.startA, run.endA);
    const [sourceStartB, sourceEndB] = sourceSpan(options.regionB, run.startB, run.endB);
    return { ...run, sourceStartA, sourceEndA, sourceStartB, sourceEndB };
  });
  const result: RegionComparisonResult = {
    sourceA, sourceB, regionA, regionB, alignedA: a.join(''), alignedB: b.join(''), runs, stats: diff.stats,
    annotationsA: annotationsA.rows, annotationsB: annotationsB.rows,
    annotationWarnings: [...annotationsA.warnings, ...annotationsB.warnings],
    diagnostics: { states: diff.states, comparisons: diff.comparisons }, limitations: [...LIMITATIONS],
  };
  check(signal);
  const record = await createAnalysisRecord({
    method: REGION_COMPARISON_METHOD, inputs: [
      { id: 'genomeA', source: 'local', accession: sourceA.accession,
        description: 'Complete named original source for region A; captured catalog snapshots retain their declared provenance.', data: analysisJson(inputA) },
      { id: 'genomeB', source: 'local', accession: sourceB.accession,
        description: 'Complete named original source for region B; captured catalog snapshots retain their declared provenance.', data: analysisJson(inputB) },
    ], parameters: analysisJson(options) as AnalysisRecord['parameters'], seed: null, references: REGION_COMPARISON_REFERENCES,
    fields: { comparison: { label: 'Complete selected-region alignment, source coordinates and exact annotation context',
      kind: 'sequence-score', units: 'records', value: analysisJson(result),
      coverage: { available: regionA.sequence.length + regionB.sequence.length,
        total: genomeA.sequence.length + genomeB.sequence.length, unit: 'bases' }, limitations: [...LIMITATIONS] } },
  });
  check(signal);
  return { inputA, inputB, options, result, record };
}

/** Even self-consistently rehashed imported outputs must match fresh source reimport and alignment. */
export async function replayRegionComparisonExperiment(content: string, signal?: AbortSignal): Promise<RegionComparisonExperiment> {
  check(signal);
  if (typeof content !== 'string') throw new Error('Saved region comparison must be JSON text.');
  bounded(content, REGION_COMPARISON_LIMITS.recordBytes, 'Saved region comparison');
  const saved = await parseAnalysisRecord(content.replace(/^\uFEFF/, ''),
    { methodId: REGION_COMPARISON_METHOD.id, methodVersion: REGION_COMPARISON_METHOD.version });
  check(signal);
  const envelopeKeys = ['format', 'version', 'method', 'inputs', 'parameters', 'seed', 'references', 'fields', 'cacheKey', 'resultId'];
  const inputKeys = ['id', 'accession', 'source', 'description', 'data', 'sha256'];
  if (Object.keys(saved).some(key => !envelopeKeys.includes(key))
    || !same(saved.method, REGION_COMPARISON_METHOD) || !same(saved.references, REGION_COMPARISON_REFERENCES) || saved.seed !== null
    || saved.inputs.length !== 2 || saved.inputs[0].id !== 'genomeA' || saved.inputs[1].id !== 'genomeB'
    || saved.inputs.some(input => input.source !== 'local' || Object.keys(input).some(key => !inputKeys.includes(key)))
    || typeof saved.parameters.recordA !== 'string' || !/^[a-f0-9]{64}$/.test(saved.parameters.recordA)
    || typeof saved.parameters.recordB !== 'string' || !/^[a-f0-9]{64}$/.test(saved.parameters.recordB)) {
    throw new Error('Saved region comparison method, source roles or resolved selections differ from the supported contract.');
  }
  const fresh = await createRegionComparisonExperiment(saved.inputs[0].data as unknown as GenomeInput,
    saved.inputs[1].data as unknown as GenomeInput, saved.parameters as unknown as RegionComparisonOptions, signal);
  if (fresh.record.resultId !== saved.resultId || fresh.record.cacheKey !== saved.cacheKey) {
    throw new Error('Recomputed region alignment, original source identity or coordinate evidence differs from the saved result.');
  }
  return fresh;
}

function checkedOutput(content: string): string {
  bounded(content, REGION_COMPARISON_LIMITS.outputBytes, 'Region comparison export');
  return content;
}
/** Every alignment run and every source annotation context; all coordinates are 0-based half-open. */
export function exportRegionComparisonTsv(experiment: RegionComparisonExperiment): string {
  const { result, record } = experiment;
  const lines = [
    '# method\t' + record.method.id + '\t' + record.method.version,
    '# result_id\t' + record.resultId,
    '# source_A\t' + JSON.stringify(result.sourceA),
    '# source_B\t' + JSON.stringify(result.sourceB),
    '# input_A_sha256\t' + record.inputs[0].sha256,
    '# input_B_sha256\t' + record.inputs[1].sha256,
    '# selected_regions\t' + JSON.stringify(experiment.options),
    '# stats\t' + JSON.stringify(result.stats),
    '# All intervals are 0-based half-open. Empty source spans are interbase boundaries; source endpoints stay ascending on either strand.',
    ...result.annotationWarnings.map(warning => '# annotation_warning\t' + JSON.stringify(warning)),
    ...result.limitations.map(limit => '# limitation\t' + JSON.stringify(limit)),
    ...result.annotationsA.map(row => '# annotation_A\t' + JSON.stringify(row)),
    ...result.annotationsB.map(row => '# annotation_B\t' + JSON.stringify(row)),
    ['operation', 'region_start_A', 'region_end_A', 'region_start_B', 'region_end_B',
      'source_start_A', 'source_end_A', 'source_strand_A', 'source_start_B', 'source_end_B', 'source_strand_B', 'aligned_columns'].join('\t'),
    ...result.runs.map(run => [run.operation, run.startA, run.endA, run.startB, run.endB,
      run.sourceStartA, run.sourceEndA, result.regionA.strand, run.sourceStartB, run.sourceEndB, result.regionB.strand,
      Math.max(run.endA - run.startA, run.endB - run.startB)].join('\t')),
  ];
  return checkedOutput(lines.join('\n') + '\n');
}
/** Complete two-row gapped alignment. Original coordinate/source identities stay in both FASTA headers. */
export function exportRegionComparisonFasta(experiment: RegionComparisonExperiment): string {
  const { result, record } = experiment, lines: string[] = [];
  const token = (value: string) => encodeURIComponent(value);
  for (const [role, source, region, aligned, input] of [
    ['A', result.sourceA, result.regionA, result.alignedA, record.inputs[0]],
    ['B', result.sourceB, result.regionB, result.alignedB, record.inputs[1]],
  ] as const) {
    lines.push('>region-' + role + ' accession=' + token(source.accession) + ' name=' + token(source.name)
      + ' source_interval_1based=' + (region.start + 1) + '..' + region.end + ' strand=' + region.strand
      + ' content_id=' + source.contentId + ' genome_sha256=' + source.sequenceSha256 + ' input_sha256=' + input.sha256
      + ' result_id=' + record.resultId + ' gapped_alignment=true');
    for (let position = 0; position < aligned.length; position += 80) lines.push(aligned.slice(position, position + 80));
  }
  return checkedOutput(lines.join('\n') + '\n');
}

