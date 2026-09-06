import { analysisJson, createAnalysisRecord, type AnalysisField, type AnalysisJson, type AnalysisRecord, type ScoreUnits } from '@phage-explorer/core';
import type { AnalysisOptions, AnalysisRequest, AnalysisResult, AnalysisType } from './types';

type Descriptor = { label: string; units: ScoreUnits; limit: string };
type ResultKeys<T extends AnalysisType> = Exclude<keyof Extract<AnalysisResult, { type: T }>, 'type' | 'engine' | 'evidenceRecord' | 'evidenceError'>;
type ResultDescriptors = { [T in AnalysisType]: Record<ResultKeys<T>, Descriptor> };

/** Adding a worker result kind or property requires its interpretation here. */
const DESCRIPTORS: ResultDescriptors = {
  'gc-skew': {
    skew: { label: 'Window GC skew', units: 'dimensionless', limit: '(G−C)/(G+C); a window with no G/C is encoded as zero, not evidence of balanced composition.' },
    cumulative: { label: 'Sampled cumulative G-minus-C count', units: 'count', limit: 'Per-base signed G-C prefix through each sampled window start, inclusive; not a direct replication measurement.' },
    originPosition: { label: 'Cumulative-minimum candidate', units: 'base-pairs', limit: 'Zero-based candidate from cumulative skew; not an experimentally identified replication origin.' },
    terminusPosition: { label: 'Cumulative-maximum candidate', units: 'base-pairs', limit: 'Zero-based candidate from cumulative skew; not an experimentally identified replication terminus.' },
  },
  complexity: {
    entropy: { label: 'Normalized window nucleotide entropy', units: 'fraction', limit: 'Shannon entropy divided by 2 bits over counted A/C/G/T bases (U is T); not functional complexity. Zero with no counted bases is an encoding convention, not evidence of low complexity.' },
    linguistic: { label: 'Window linguistic diversity', units: 'score', limit: 'A bounded substring-diversity statistic, not a calibrated biological probability.' },
    lowComplexityRegions: { label: 'Low-complexity regions', units: 'records', limit: 'Thresholded sequence windows with zero-based coordinates; threshold choice affects calls.' },
  },
  bendability: {
    values: { label: 'Dinucleotide bendability scores', units: 'score', limit: 'Simplified dinucleotide lookup model, not a mechanical measurement.' },
    flexibleRegions: { label: 'High-score regions', units: 'records', limit: 'Thresholded model scores and zero-based coordinates; no physical flexibility units.' },
  },
  promoters: { sites: { label: 'Promoter and RBS motif hits', units: 'records', limit: 'Pattern hits and heuristic scores, capped at 100; absence does not establish absence of transcription.' } },
  repeats: {
    repeats: { label: 'Sequence repeat matches', units: 'records', limit: 'Zero-based, end-exclusive coordinates. Resolved arms/units only; ambiguity is allowed in spacers. Matches are bounded, not a complete repeat annotation or a physical structure prediction.' },
    search: { label: 'Repeat search coverage and limits', units: 'records', limit: 'Linear scan; sampled non-overlapping pairs, first matching partner, bounded detail prefixes. No circular-origin search.' },
  },
  'codon-usage': {
    usage: { label: 'Reading-frame codon counts', units: 'count', limit: 'Frame-zero DNA triplets; ambiguous triplets are skipped without shifting the frame. Not a CDS-aware transcriptome estimate.' },
    rscu: { label: 'Relative synonymous codon usage', units: 'dimensionless', limit: 'Normalized counts within synonymous codon families; no host reference is supplied.' },
    cai: { label: 'Host codon adaptation', units: 'score', limit: 'Requires an identified host reference codon distribution.' },
  },
  'kmer-spectrum': {
    kmerSize: { label: 'K-mer length', units: 'base-pairs', limit: 'Length used for the reported spectrum.' },
    spectrum: { label: 'K-mer counts and frequencies', units: 'records', limit: 'Reported k-mers may be truncated to the worker output limit; frequency is a proportion, not a calibrated probability.' },
    uniqueKmers: { label: 'Distinct k-mers', units: 'count', limit: 'Distinct valid k-mers counted under this encoding and k.' },
    totalKmers: { label: 'Counted k-mer windows', units: 'count', limit: 'Counted windows can differ from genome length minus k plus one when ambiguous bases are excluded.' },
  },
  'transcription-flow': {
    values: { label: 'Illustrative transcription scores', units: 'score', limit: 'Sequence-conditioned rule model without measured expression or fitted kinetic parameters.' },
    peaks: { label: 'Illustrative transcription peaks', units: 'records', limit: 'Model peaks, not observed transcripts or physical flux.' },
  },
};

export async function createWorkerAnalysisRecord(result: AnalysisResult, sequence: string, options: AnalysisOptions,
  context: NonNullable<AnalysisRequest['evidenceContext']>, route: 'string' | 'shared'): Promise<AnalysisRecord> {
  const type = result.type;
  const parameters = analysisJson({ route, requestedOptions: options,
    ...(type === 'gc-skew' ? { windowSize: Math.max(1, Math.floor(options.windowSize || 1000)), stepSize: Math.max(1, Math.floor((options.windowSize || 1000) / 4)), cumulativeConvention: 'inclusive per-base G-C prefix sampled at each window start' } : {}),
    ...(type === 'complexity' ? { windowSize: options.windowSize || 100, entropyNormalization: 'Shannon bits / 2; U treated as T' } : {}),
    ...(type === 'bendability' ? { windowSize: options.windowSize || 50 } : {}),
    ...(type === 'repeats' ? { minLength: options.minLength ?? 8, maxGap: options.maxGap ?? 5000 } : {}),
    ...(type === 'kmer-spectrum' ? { kmerSize: options.kmerSize ?? 6, ambiguityPolicy: 'Unknown bases break windows; U treated as T', frequencyDenominator: 'counted valid windows' } : {}),
    ...(type === 'codon-usage' ? { frame: 0, ambiguityPolicy: 'Skip non-ACGT triplets without deleting positions' } : {}),
  }) as Record<string, AnalysisJson>;
  const fields: Record<string, AnalysisField> = {};
  let validBases = 0;
  for (const base of sequence) if ('ACGTacgt'.includes(base)) validBases++;
  const coverage = { available: validBases, total: sequence.length, unit: 'bases' as const };
  const noGc = type === 'gc-skew' && !/[GC]/i.test(sequence);
  for (const [name, descriptor] of Object.entries(DESCRIPTORS[type]) as [string, Descriptor][]) {
    const value = Reflect.get(result, name);
    const missing = value === undefined || type === 'gc-skew' && result.type === 'gc-skew' && (result.skew.length === 0 || noGc);
    const key = name;
    fields[key] = missing ? { label: descriptor.label, kind: 'unavailable', value: null, units: null,
      coverage: { ...coverage, available: 0 }, limitations: [descriptor.limit],
      missingInputs: [name === 'cai' ? 'Identified host reference codon distribution.' : noGc ? 'Sequence windows containing G or C; the GC-skew denominator is zero.' : 'Enough valid sequence windows for this statistic.'],
    } : type === 'transcription-flow' ? {
      label: descriptor.label, kind: 'simulation', units: descriptor.units, value: analysisJson(value), coverage,
      limitations: [descriptor.limit], assumptions: ['Built-in sequence-conditioned transcription rules with their default parameters.'],
    } : { label: descriptor.label, kind: 'sequence-score', units: descriptor.units, value: analysisJson(value), coverage, limitations: [descriptor.limit] };
  }
  let engine = 'worker pipeline; individual kernel path not reported';
  if (result.type === 'gc-skew') engine = result.engine ?? 'unreported worker path';
  if (result.type === 'repeats') engine = `JS pair scan; ${result.engine ?? 'unreported'} detailed kernels`;
  return createAnalysisRecord({ method: { id: `sequence-${type}`, version: ['codon-usage', 'kmer-spectrum', 'complexity', 'repeats'].includes(type) ? '2' : '1', implementation: engine }, inputs: [{
    id: 'sequence', accession: context.accession, source: context.source,
    description: 'Exact decoded nucleotide string supplied to this worker operation; SHA-256 identifies its canonical JSON encoding.', data: sequence,
  }], parameters, seed: null, references: [{ id: 'sequence-worker-method', version: '2026-09-05', description: 'Bundled algorithm and parameter defaults; no external biological reference supplied.' }], fields });
}
