import { alignWavefront, WAVEFRONT_LIMITS, type WavefrontOptions } from '../../core/src/analysis/wavefront-alignment';

export const SEQUENCE_DIFF_METHOD = 'Exact global unit-edit alignment' as const;
export type SequenceDiffOperation = 'match' | 'substitution' | 'insertion' | 'deletion';
/** Zero-based, half-open coordinates in the original, ungapped input sequences. */
export interface SequenceDiffRun {
  operation: SequenceDiffOperation;
  startA: number;
  endA: number;
  startB: number;
  endB: number;
}
export interface SequenceDiffStats {
  insertions: number;
  deletions: number;
  substitutions: number;
  matches: number;
  lengthA: number;
  lengthB: number;
  /** Literal matching symbols / alignment columns, as a percentage. */
  identity: number;
  alignmentColumns: number;
  ambiguousColumns: number;
  distance: number;
}
export type SequenceDiffResult = {
  status: 'complete';
  method: typeof SEQUENCE_DIFF_METHOD;
  /** A-axis display mask: 0 match, 1 substitution, 2 insertion anchor, 3 deletion. */
  mask: Uint8Array;
  positions: number[];
  runs: SequenceDiffRun[];
  stats: SequenceDiffStats;
  states: number;
  comparisons: number;
} | {
  status: 'unavailable';
  method: typeof SEQUENCE_DIFF_METHOD;
  reason: string;
};

/**
 * An optimal unit-cost alignment, or an explicit unavailable result. Never
 * substitutes positional mismatches, sampled windows or a partial traceback.
 * Common prefix/suffix cancellation preserves Levenshtein distance; aligning
 * only the remaining interval also handles a long isolated insertion/deletion
 * without allocating a quadratic frontier for its known length difference.
 * IUPAC symbols match literally. This is not an ambiguity-resolving biological
 * identity estimate, rearrangement detector or strand/origin normalization.
 */
export function computeSequenceDiff(sequenceA: string, sequenceB: string, options: WavefrontOptions = {}): SequenceDiffResult {
  const unavailable = (reason: string): SequenceDiffResult => ({ status: 'unavailable', method: SEQUENCE_DIFF_METHOD, reason });
  if (typeof sequenceA !== 'string' || typeof sequenceB !== 'string' ||
      sequenceA.length > WAVEFRONT_LIMITS.length || sequenceB.length > WAVEFRONT_LIMITS.length) {
    return unavailable(`Exact diff supports at most ${WAVEFRONT_LIMITS.length.toLocaleString()} bases per sequence. Compare a smaller region or use an external alignment.`);
  }
  // Validate original ASCII symbols before case conversion: Unicode uppercasing
  // can expand a single character (for example ß -> SS), corrupting coordinates.
  if (/[^ACGTRYSWKMBDHVNacgtryswkmbdhvn]/.test(sequenceA + sequenceB)) {
    return unavailable('Exact diff requires ungapped IUPAC DNA. Unsupported symbols were not replaced or ignored.');
  }
  const a = sequenceA.toUpperCase(), b = sequenceB.toUpperCase();
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['maxStates', 'maxComparisons'].includes(key))) throw new Error('Unsupported sequence diff budgets.');
  const maxStates = options.maxStates ?? WAVEFRONT_LIMITS.states;
  const maxComparisons = options.maxComparisons ?? WAVEFRONT_LIMITS.comparisons;
  if (!Number.isSafeInteger(maxStates) || maxStates < 0 || maxStates > WAVEFRONT_LIMITS.states ||
      !Number.isSafeInteger(maxComparisons) || maxComparisons < 0 || maxComparisons > WAVEFRONT_LIMITS.comparisons) {
    throw new Error('Invalid sequence diff budget.');
  }
  let prefix = 0, suffix = 0, comparisons = 0;
  const equal = (i: number, j: number): boolean => {
    if (comparisons >= maxComparisons) throw new Error('Exact diff exceeded its comparison budget. Compare a smaller or more closely related region; no approximate result was produced.');
    comparisons++;
    return a[i] === b[j];
  };
  let alignment;
  try {
    while (prefix < Math.min(a.length, b.length) && equal(prefix, prefix)) prefix++;
    while (suffix < Math.min(a.length, b.length) - prefix && equal(a.length - suffix - 1, b.length - suffix - 1)) suffix++;
    alignment = alignWavefront(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix),
      { maxStates, maxComparisons: maxComparisons - comparisons });
  } catch (cause) {
    // Inputs and budgets were validated above. Exhaustion must leave no mask,
    // coordinates or numeric success that consumers could mistake for a result.
    return unavailable(cause instanceof Error ? cause.message : 'Exact alignment could not be completed.');
  }
  const alignedA = a.slice(0, prefix) + alignment.reference + a.slice(a.length - suffix);
  const alignedB = b.slice(0, prefix) + alignment.query + b.slice(b.length - suffix);
  const mask = new Uint8Array(a.length), runs: SequenceDiffRun[] = [];
  const stats: SequenceDiffStats = { insertions: 0, deletions: 0, substitutions: 0, matches: 0,
    lengthA: a.length, lengthB: b.length, identity: 0, alignmentColumns: alignedA.length,
    ambiguousColumns: 0, distance: alignment.distance };
  let atA = 0, atB = 0;
  for (let col = 0; col < alignedA.length; col++) {
    const left = alignedA[col], right = alignedB[col];
    const operation: SequenceDiffOperation = left === '-' ? 'insertion' : right === '-' ? 'deletion'
      : left === right ? 'match' : 'substitution';
    if ((left !== '-' && !'ACGT'.includes(left)) || (right !== '-' && !'ACGT'.includes(right))) stats.ambiguousColumns++;
    if (operation === 'insertion') stats.insertions++;
    else if (operation === 'deletion') { stats.deletions++; mask[atA] = 3; }
    else if (operation === 'substitution') { stats.substitutions++; mask[atA] = 1; }
    else stats.matches++;
    const startA = atA, startB = atB;
    if (left !== '-') atA++;
    if (right !== '-') atB++;
    const last = runs[runs.length - 1];
    if (last?.operation === operation) { last.endA = atA; last.endB = atB; }
    else runs.push({ operation, startA, endA: atA, startB, endB: atB });
  }
  // Insertions have no A bases. Anchor navigation to the following A base, or
  // the final A base at the end; the run retains the exact interbase coordinate.
  for (const run of runs) if (run.operation === 'insertion' && mask.length) {
    const anchor = Math.min(run.startA, mask.length - 1);
    if (mask[anchor] === 0) mask[anchor] = 2;
  }
  const positions: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) positions.push(i);
  stats.identity = stats.alignmentColumns ? 100 * stats.matches / stats.alignmentColumns : 100;
  return { status: 'complete', method: SEQUENCE_DIFF_METHOD, mask, positions, runs, stats,
    states: alignment.states, comparisons: comparisons + alignment.comparisons };
}
