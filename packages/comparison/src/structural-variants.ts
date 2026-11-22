/**
 * Exact aligned indels, relative to input A. Gene annotations supply context
 * only: neither names, missing annotations nor gene order establish a variant.
 * A single global unit-edit alignment cannot infer rearrangement mechanisms.
 */
import type { GeneInfo } from '@phage-explorer/core';
import { WAVEFRONT_LIMITS, type WavefrontOptions } from '../../core/src/analysis/wavefront-alignment';
import { computeSequenceDiff, SEQUENCE_DIFF_METHOD, type SequenceDiffResult } from './sequence-diff';
import type { StructuralVariantCall, StructuralVariantReport } from './types';

export interface StructuralVariantOptions extends WavefrontOptions {
  /** Explicit reporting threshold, not a confidence or biological classification. */
  minGapBp?: number;
}
const DEFAULT_MIN_GAP_BP = 50;
const MAX_REPORTED_INDELS = 10000;
const LIMITATIONS = [
  'Insertions and deletions describe runs in one exact global unit-edit alignment, relative to genome A; they are not validated biological structural variants.',
  'The submitted strand and origin are retained. Alternative optimal alignments can place edits differently in repeats.',
  'Inversions, duplications and translocations are not inferred. Gene annotations provide overlap context only, not functional consequences.',
  'Ambiguous IUPAC symbols match literally during alignment. Indel alleles containing unresolved bases are not reported.',
];

function minimumGap(value: number | undefined): number {
  const result = value ?? DEFAULT_MIN_GAP_BP;
  if (!Number.isSafeInteger(result) || result < 1 || result > WAVEFRONT_LIMITS.length) {
    throw new Error(`Minimum indel size must be an integer from 1 to ${WAVEFRONT_LIMITS.length}.`);
  }
  return result;
}

/** Invalid/out-of-genome annotation intervals cannot contribute gene context. */
function annotationIndex(genes: GeneInfo[], genomeLength: number) {
  const sorted = genes.filter(gene => Number.isSafeInteger(gene.startPos) && Number.isSafeInteger(gene.endPos)
    && gene.startPos >= 0 && gene.endPos > gene.startPos && gene.endPos <= genomeLength)
    .slice().sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos || a.id - b.id);
  const maximumEnd: number[] = [];
  for (let i = 0; i < sorted.length; i++) maximumEnd.push(Math.max(maximumEnd[i - 1] ?? 0, sorted[i].endPos));
  return { sorted, maximumEnd };
}
function collectGenes(index: ReturnType<typeof annotationIndex>, start: number, end: number): string[] {
  // Only interior interbase sites overlap an annotation. A boundary adjacent to
  // a feature does not establish that the feature itself is affected.
  let lo = 0, hi = index.sorted.length;
  const upper = start === end ? start : end;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (index.sorted[middle].startPos < upper) lo = middle + 1; else hi = middle;
  }
  const labels = new Set<string>();
  for (let i = lo - 1; i >= 0 && index.maximumEnd[i] > start; i--) {
    const gene = index.sorted[i];
    if (gene.endPos <= start) continue;
    labels.add(gene.name || gene.product || gene.locusTag || `gene-${gene.id}`);
    if (labels.size === 8) break;
  }
  return [...labels].sort();
}

/**
 * Internal producer seam: consume the exact diff just computed for these bases
 * so browser highlights and indels share one alignment and one work budget.
 * Public callers needing an independent analysis use analyzeStructuralVariants.
 */
export function structuralVariantsFromDiff(
  sequenceA: string,
  sequenceB: string,
  diff: SequenceDiffResult,
  genesA: GeneInfo[] = [],
  genesB: GeneInfo[] = [],
  minGapBp = DEFAULT_MIN_GAP_BP,
): StructuralVariantReport {
  const base = { method: SEQUENCE_DIFF_METHOD, minGapBp: minimumGap(minGapBp), limitations: [...LIMITATIONS] };
  const unavailable = (reason: string): StructuralVariantReport => ({ ...base, status: 'unavailable', reason,
    calls: [], counts: null, alignment: null, belowThreshold: null, unresolved: null });
  if (typeof sequenceA !== 'string' || typeof sequenceB !== 'string' || !sequenceA.length || !sequenceB.length) {
    return unavailable('Both genomes require sequence input before aligned indels can be assessed.');
  }
  if (diff.status === 'unavailable') return unavailable(diff.reason);
  if (diff.stats.lengthA !== sequenceA.length || diff.stats.lengthB !== sequenceB.length) {
    throw new Error('Aligned indel evidence does not match the input sequence lengths.');
  }
  const a = sequenceA.toUpperCase(), b = sequenceB.toUpperCase();
  if (!/[ACGT]/.test(a) || !/[ACGT]/.test(b)) {
    return unavailable('Both genomes require resolved A/C/G/T bases; an all-ambiguous alignment cannot establish indel evidence.');
  }
  const indexA = annotationIndex(genesA, a.length), indexB = annotationIndex(genesB, b.length);
  const calls: StructuralVariantCall[] = [];
  const counts = { deletion: 0, insertion: 0 };
  let belowThreshold = 0, unresolved = 0;
  for (const run of diff.runs) {
    if (run.operation !== 'insertion' && run.operation !== 'deletion') continue;
    const sizeA = run.endA - run.startA, sizeB = run.endB - run.startB;
    if (Math.max(sizeA, sizeB) < base.minGapBp) { belowThreshold++; continue; }
    const referenceAllele = a.slice(run.startA, run.endA), alternateAllele = b.slice(run.startB, run.endB);
    if (/[^ACGT]/.test(referenceAllele + alternateAllele)) { unresolved++; continue; }
    if (calls.length === MAX_REPORTED_INDELS) {
      return unavailable(`Aligned indel reporting exceeded ${MAX_REPORTED_INDELS.toLocaleString('en-US')} events. Increase the size threshold or compare a smaller region; no partial report was produced.`);
    }
    counts[run.operation]++;
    calls.push({ id: `${run.operation}-${run.startA}-${run.endA}-${run.startB}-${run.endB}`,
      type: run.operation, startA: run.startA, endA: run.endA, startB: run.startB, endB: run.endB,
      sizeA, sizeB, referenceAllele, alternateAllele,
      evidence: [SEQUENCE_DIFF_METHOD, `${Math.max(sizeA, sizeB)} resolved bases in one ${run.operation} run relative to genome A`,
        'Zero-based half-open coordinates; equal endpoints are interbase sites'],
      affectedGenesA: collectGenes(indexA, run.startA, run.endA),
      affectedGenesB: collectGenes(indexB, run.startB, run.endB) });
  }
  return { ...base, status: 'complete', reason: null, calls, counts,
    alignment: { ...diff.stats }, belowThreshold, unresolved };
}

/** Exact sequence-derived indels, or an explicit unavailable result. No annotation fallback. */
export function analyzeStructuralVariants(
  sequenceA: string,
  sequenceB: string,
  genesA: GeneInfo[] = [],
  genesB: GeneInfo[] = [],
  options: StructuralVariantOptions = {},
): StructuralVariantReport {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['minGapBp', 'maxStates', 'maxComparisons'].includes(key))) {
    throw new Error('Unsupported aligned indel options.');
  }
  const { minGapBp, ...budgets } = options;
  const minimum = minimumGap(minGapBp);
  const diff = computeSequenceDiff(sequenceA, sequenceB, budgets);
  return structuralVariantsFromDiff(sequenceA, sequenceB, diff, genesA, genesB, minimum);
}
