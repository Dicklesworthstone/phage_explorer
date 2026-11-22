import {
  analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisJson, type AnalysisRecord, type CodonUsageData, type GeneInfo,
} from '@phage-explorer/core';
import { compareGenomes } from './comparison-engine';
import type { ComparisonConfig, GenomeComparisonResult } from './types';

/** Exact inputs, including annotations and supplied codon counts, travel with the
 * experiment. Numeric catalog/local IDs are labels, never a content identity.
 */
export interface ComparisonGenomeInput {
  phage: { id: number; name: string; accession: string };
  source: 'catalog' | 'local' | 'external';
  sequence: string;
  genes: GeneInfo[];
  codonUsage: CodonUsageData | null;
}
export interface GenomeComparisonOptions {
  kmerSizes: number[];
  maxEditDistanceLength: number;
  editDistanceWindowSize: number;
  editDistanceWindowCount: number;
}
export interface GenomeComparisonExperiment {
  genomeA: ComparisonGenomeInput;
  genomeB: ComparisonGenomeInput;
  options: GenomeComparisonOptions;
  result: GenomeComparisonResult;
  record: AnalysisRecord;
}
export const GENOME_COMPARISON_METHOD = {
  id: 'genome-comparison', version: '2', implementation: 'typescript-comparison-engine',
} as const;
export const GENOME_COMPARISON_LIMITS = {
  sequenceBases: 1_000_000, genes: 20_000, recordBytes: 10 * 1024 * 1024,
  kmerSizes: 8, kmerSize: 31, exactLength: 10_000, windowSize: 2_000, windowCount: 100,
} as const;
export const DEFAULT_GENOME_COMPARISON_OPTIONS: Readonly<GenomeComparisonOptions> = {
  kmerSizes: [3, 5, 7, 11], maxEditDistanceLength: 10000,
  editDistanceWindowSize: 1000, editDistanceWindowCount: 20,
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;

/** Only operational engine options are exposed. Gene/codon evidence and the
 * separate bounded exact alignment are always included in a full experiment.
 */
export function resolveGenomeComparisonOptions(value: unknown = {}): GenomeComparisonOptions {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_GENOME_COMPARISON_OPTIONS, key))) {
    throw new Error('Unsupported genome comparison settings.');
  }
  const options = { ...DEFAULT_GENOME_COMPARISON_OPTIONS, ...value };
  if (!Array.isArray(options.kmerSizes) || !options.kmerSizes.length || options.kmerSizes.length > GENOME_COMPARISON_LIMITS.kmerSizes
      || options.kmerSizes.some(k => !integer(k, 1, GENOME_COMPARISON_LIMITS.kmerSize))
      || new Set(options.kmerSizes).size !== options.kmerSizes.length
      || !integer(options.maxEditDistanceLength, 0, GENOME_COMPARISON_LIMITS.exactLength)
      || !integer(options.editDistanceWindowSize, 1, GENOME_COMPARISON_LIMITS.windowSize)
      || !integer(options.editDistanceWindowCount, 1, GENOME_COMPARISON_LIMITS.windowCount)) {
    throw new Error('Use 1–8 distinct k-mer sizes (1–31), an exact edit limit of 0–10000 bp, windows of 1–2000 bp and 1–100 windows.');
  }
  // Copy before any worker or hashing await can outlive a caller's settings.
  return { ...options, kmerSizes: [...options.kmerSizes] };
}

export function genomeComparisonConfig(options: GenomeComparisonOptions): ComparisonConfig {
  return { ...resolveGenomeComparisonOptions(options), includeGeneComparison: true,
    includeCodonUsage: true, includeStructuralVariants: true };
}

function input(value: unknown, label: string): ComparisonGenomeInput {
  const phage = object(value) ? value.phage : null;
  if (!object(value) || Object.keys(value).some(key => !['phage', 'source', 'sequence', 'genes', 'codonUsage'].includes(key))
      || !object(phage) || Object.keys(phage).some(key => !['id', 'name', 'accession'].includes(key))
      || !Number.isSafeInteger(phage.id)
      || !['name', 'accession'].every(key => typeof phage[key] === 'string' && String(phage[key]).trim().length > 0)
      || !['catalog', 'local', 'external'].includes(String(value.source))) {
    throw new Error(`${label} needs its exact genome label and declared source.`);
  }
  const sequence = value.sequence;
  if (typeof sequence !== 'string' || !sequence.length || sequence.length > GENOME_COMPARISON_LIMITS.sequenceBases
      || /[^ACGTRYSWKMBDHVNacgtryswkmbdhvn]/.test(sequence)) {
    throw new Error(`${label} requires complete ungapped IUPAC DNA, at most ${GENOME_COMPARISON_LIMITS.sequenceBases} bases. Unsupported symbols are not replaced.`);
  }
  if (!Array.isArray(value.genes) || value.genes.length > GENOME_COMPARISON_LIMITS.genes
      || value.genes.some(gene => !object(gene) || !Number.isSafeInteger(gene.id)
        || !integer(gene.startPos, 0, sequence.length) || !integer(gene.endPos, 0, sequence.length)
        || Number(gene.endPos) <= Number(gene.startPos)
        || ![null, '+', '-'].includes(gene.strand as null | string)
        || !['name', 'locusTag', 'product', 'type'].every(key => gene[key] === null || typeof gene[key] === 'string')
        || gene.domains !== undefined && (!Array.isArray(gene.domains) || gene.domains.some(domain => typeof domain !== 'string'))
        || gene.qualifiers !== undefined && gene.qualifiers !== null && !object(gene.qualifiers))) {
    throw new Error(`${label} has invalid or out-of-range annotations. Coordinates must be 0-based, half-open source intervals.`);
  }
  if (value.codonUsage !== null) {
    const counts = value.codonUsage;
    if (!object(counts) || Object.keys(counts).some(key => !['aaCounts', 'codonCounts'].includes(key))
        || !['aaCounts', 'codonCounts'].every(key => object(counts[key])
          && Object.keys(counts[key]).every(symbol => (key === 'codonCounts' ? /^[ACGTRYSWKMBDHVN]{3}$/ : /^[ACDEFGHIKLMNPQRSTVWY*X]$/).test(symbol))
          && Object.values(counts[key]).every(count => integer(count, 0, Number.MAX_SAFE_INTEGER))
          && Number.isSafeInteger(Object.values(counts[key]).reduce<number>((sum, count) => sum + Number(count), 0)))) {
      throw new Error(`${label} codon usage must contain finite nonnegative integer counts, or be null for the stated sequence-frame fallback.`);
    }
  }
  return analysisJson(value) as unknown as ComparisonGenomeInput;
}

/** Operational timestamps are deliberately excluded. Every numerical metric,
 * unavailable reason, exact alignment run and display-mask byte is retained.
 */
export function genomeComparisonResultData(result: GenomeComparisonResult): AnalysisJson {
  const { computedAt: _computedAt, computeTimeMs: _computeTimeMs, sequenceDiff, ...metrics } = result;
  return analysisJson({ ...metrics, sequenceDiff: sequenceDiff?.status === 'complete'
    ? { ...sequenceDiff, mask: Array.from(sequenceDiff.mask) } : sequenceDiff });
}

export async function createGenomeComparisonExperiment(genomeA: ComparisonGenomeInput, genomeB: ComparisonGenomeInput,
  settings: Partial<GenomeComparisonOptions> = {}): Promise<GenomeComparisonExperiment> {
  const a = input(genomeA, 'Genome A'), b = input(genomeB, 'Genome B');
  const options = resolveGenomeComparisonOptions(settings);
  if (new TextEncoder().encode(JSON.stringify([a, b])).length > GENOME_COMPARISON_LIMITS.recordBytes) {
    throw new Error('Comparison inputs exceed the 10 MiB portable-record budget.');
  }
  const result = await compareGenomes(a.phage, b.phage, a.sequence, b.sequence,
    a.genes, b.genes, a.codonUsage, b.codonUsage, genomeComparisonConfig(options));
  const record = await createAnalysisRecord({
    method: { ...GENOME_COMPARISON_METHOD },
    inputs: [a, b].map((genome, index) => ({ id: index === 0 ? 'genomeA' : 'genomeB', source: genome.source,
      accession: genome.phage.accession, description: `Genome ${index === 0 ? 'A' : 'B'}: complete bases, annotations and supplied codon counts.`,
      data: analysisJson(genome) })),
    parameters: analysisJson(options) as Record<string, AnalysisJson>, seed: null, references: [],
    fields: { comparison: { kind: 'sequence-score', label: 'Complete descriptive genome comparison', units: 'score',
      value: genomeComparisonResultData(result), coverage: {
        available: result.biological.gcResolvedBasesA + result.biological.gcResolvedBasesB,
        total: a.sequence.length + b.sequence.length, unit: 'bases',
      }, limitations: [
        'This composite contains the declared metrics, their units and coverage; it is not a measured biological relationship or a species/host assignment.',
        'K-mer and composition resemblance do not establish homology. Position-paired information and sampled edit windows depend on the submitted strand and origin.',
        'The sampled edit-distance operation breakdown is heuristic. The separate sequenceDiff and structuralVariants fields contain the bounded exact alignment or its explicit unavailable reason.',
        'Supplied codon counts are used as recorded; null uses frame zero of the complete sequence, not an inferred set of coding genes. Ambiguous triplets are excluded from resolved codon tests, while the rank comparison retains supplied frequency bins. Gene-name overlap does not establish orthology.',
        'Runtime and wall-clock timestamps are operational metadata and are excluded from result identity. All numerical outputs, annotations, coordinates and display-mask bytes remain bound.',
      ] } },
  });
  return { genomeA: a, genomeB: b, options, result, record };
}

/** Checksums detect edits; fresh production computation establishes that every
 * stored result belongs to the stated inputs and supported method/settings.
 */
export async function replayGenomeComparisonExperiment(content: string): Promise<GenomeComparisonExperiment> {
  const record = await parseAnalysisRecord(content, { methodId: GENOME_COMPARISON_METHOD.id, methodVersion: GENOME_COMPARISON_METHOD.version });
  if (record.inputs.length !== 2 || record.inputs[0].id !== 'genomeA' || record.inputs[1].id !== 'genomeB'
      || record.method.implementation !== GENOME_COMPARISON_METHOD.implementation) {
    throw new Error('Unsupported comparison input roles or implementation.');
  }
  const a = input(record.inputs[0].data, 'Genome A'), b = input(record.inputs[1].data, 'Genome B');
  const options = resolveGenomeComparisonOptions(record.parameters);
  const experiment = await createGenomeComparisonExperiment(a, b, options);
  if (serializeAnalysisRecord(experiment.record) !== serializeAnalysisRecord(record)) {
    throw new Error('The saved comparison does not match fresh computation of its exact inputs, settings and complete results.');
  }
  return experiment;
}
