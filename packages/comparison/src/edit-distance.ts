/**
 * Edit Distance Metrics Module
 *
 * Implements Levenshtein distance and variants for genome sequence comparison.
 * Uses dynamic programming with space-optimized algorithms.
 *
 * For very long sequences (>10kb), uses a windowed approximation approach.
 *
 * References:
 * - Levenshtein (1966) "Binary codes capable of correcting deletions, insertions, and reversals"
 * - Needleman & Wunsch (1970) "A general method applicable to the search for similarities"
 * - Myers (1999) "A fast bit-vector algorithm for approximate string matching"
 */

import type { EditDistanceMetrics } from './types';
import type { SequenceDiffStats } from './sequence-diff';

const SAMPLED_OPERATIONS_UNAVAILABLE = 'Sampled edit windows estimate total distance only; whole-sequence insertion, deletion and substitution counts require an exact alignment.';

// WASM function reference - loaded dynamically
let wasmLevenshtein: ((a: string, b: string) => number) | null = null;
let wasmAvailable = false;

// Attempt to load WASM module dynamically
async function initWasm(): Promise<void> {
  if (wasmAvailable) return;
  try {
    const wasm = await import('@phage/wasm-compute');
    // wasm-compute may require explicit async init (depending on build target).
    const maybeInit = (wasm as unknown as { default?: () => Promise<void> }).default;
    if (typeof maybeInit === 'function') {
      await maybeInit();
    }
    wasmLevenshtein = wasm.levenshtein_distance;
    // Test the WASM function with a trivial case
    wasmAvailable = typeof wasmLevenshtein === 'function' && wasmLevenshtein('a', 'b') === 1;
  } catch {
    wasmAvailable = false;
    wasmLevenshtein = null;
  }
}

// Initialize WASM on module load (non-blocking)
initWasm().catch(() => { /* WASM unavailable, using JS fallback */ });

/**
 * Compute Levenshtein distance using dynamic programming.
 * Uses the WASM implementation when available. Measured 1.6x at 1 kb and 1.8x
 * at 5 kb (`bun run bench:wasm`); the old "5-20x" here was never measured.
 * Only measured to 5 kb because the algorithm is O(n*m).
 * Space-optimized: O(min(m,n)) instead of O(m*n).
 *
 * For sequences > maxLength, returns approximate result.
 */
export function levenshteinDistance(
  a: string,
  b: string,
  maxLength: number = 10000
): { distance: number; isApproximate: boolean } {
  // Use WASM for exact computation when available
  if (wasmAvailable && wasmLevenshtein && a.length <= maxLength && b.length <= maxLength) {
    return { distance: wasmLevenshtein(a, b), isApproximate: false };
  }

  // Fall back to JS implementation for very long sequences or when WASM unavailable
  return levenshteinDistanceJS(a, b, maxLength);
}

function levenshteinDistanceJS(
  a: string,
  b: string,
  maxLength: number = 10000
): { distance: number; isApproximate: boolean } {
  // Check if we need approximate calculation
  if (a.length > maxLength || b.length > maxLength) {
    return approximateLevenshtein(a, b, 1000, 20);
  }

  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Special cases
  if (m === 0) return { distance: n, isApproximate: false };
  if (n === 0) return { distance: m, isApproximate: false };

  // Two-row DP array using typed arrays for speed and minimal GC overhead
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);

  // Initialize first row
  for (let i = 0; i <= m; i++) {
    prev[i] = i;
  }

  // Fill DP table
  for (let j = 1; j <= n; j++) {
    curr[0] = j;

    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,      // deletion
        curr[i - 1] + 1,  // insertion
        prev[i - 1] + cost // substitution
      );
    }

    // Swap rows
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return { distance: prev[m], isApproximate: false };
}

/**
 * Approximate Levenshtein distance for very long sequences.
 * Uses a windowed sampling approach.
 *
 * Divides sequences into windows and averages local distances.
 */
export function approximateLevenshtein(
  a: string,
  b: string,
  windowSize: number = 1000,
  numWindows: number = 20
): { distance: number; isApproximate: boolean; windowSize: number; windowCount: number } {
  // Guard against invalid windowSize
  if (windowSize < 1) {
    windowSize = 1000;
  }

  const lenA = a.length;
  const lenB = b.length;

  // Handle length differences
  const minLen = Math.min(lenA, lenB);
  const maxLen = Math.max(lenA, lenB);
  const lengthDiff = maxLen - minLen;

  // Calculate step size to cover the sequences
  if (!Number.isSafeInteger(numWindows) || numWindows < 1) throw new Error('Edit-distance window count must be a positive integer.');
  if (!Number.isSafeInteger(windowSize)) throw new Error('Edit-distance window size must be a positive integer.');
  if (!minLen) return { distance: maxLen, isApproximate: false, windowSize, windowCount: 0 };
  // A short query against a large genome must not bypass sampling and launch
  // a full O(minLen * maxLen) comparison. Only compare complete inputs when
  // BOTH fit in a single requested window.
  if (maxLen < windowSize) {
    return { ...levenshteinDistance(a, b, Infinity), windowSize, windowCount: 1 };
  }
  const sampledSize = Math.min(windowSize, minLen);
  const effectiveWindows = Math.min(numWindows, Math.max(1, Math.floor(minLen / sampledSize)));

  const step = Math.floor((minLen - sampledSize) / (effectiveWindows - 1 || 1));

  let totalDistance = 0;
  let windowCount = 0;

  for (let i = 0; i < effectiveWindows; i++) {
    const start = i * step;
    const windowA = a.substring(start, start + sampledSize);
    const windowB = b.substring(start, start + sampledSize);

    const result = levenshteinDistance(windowA, windowB, Infinity);
    totalDistance += result.distance;
    windowCount++;
  }

  // Average distance per window, scaled to full sequence
  const avgDistPerWindow = totalDistance / windowCount;
  const scaleFactor = minLen / sampledSize;
  const estimatedDistance = Math.round(avgDistPerWindow * scaleFactor + lengthDiff);

  return {
    distance: estimatedDistance,
    isApproximate: true,
    windowSize: sampledSize,
    windowCount,
  };
}

/**
 * Compute an exact optimal edit-operation breakdown using rolling DP rows.
 * Each cell carries the insertion count on its selected optimal path; the
 * deletion count follows from insertions - deletions = query length - reference
 * length. This preserves diagonal/insertion/deletion tie precedence without an
 * O(m*n) traceback matrix. Above maxLength, the total is sampled and the
 * whole-sequence operation breakdown is explicitly unavailable.
 */
export function levenshteinWithOperations(
  a: string,
  b: string,
  maxLength: number = 5000
): { distance: number; insertions: number | null; deletions: number | null; substitutions: number | null;
  isApproximate: boolean; operationsUnavailableReason: string | null } {
  // For very long sequences, use sampling
  if (a.length > maxLength || b.length > maxLength) {
    const approx = approximateLevenshtein(a, b, 1000, 20);
    return { distance: approx.distance, insertions: null, deletions: null, substitutions: null,
      isApproximate: true, operationsUnavailableReason: SAMPLED_OPERATIONS_UNAVAILABLE };
  }

  const m = a.length;
  const n = b.length;
  if (!m || !n) return { distance: m + n, insertions: n, deletions: m, substitutions: 0,
    isApproximate: false, operationsUnavailableReason: null };
  let previous = Uint32Array.from({ length: n + 1 }, (_, j) => j), next = new Uint32Array(n + 1);
  let previousInsertions = previous.slice(), nextInsertions = new Uint32Array(n + 1);

  // Fill matrix
  for (let i = 1; i <= m; i++) {
    next[0] = i;
    nextInsertions[0] = 0;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const diagonal = previous[j - 1] + cost;
      const insertion = next[j - 1] + 1, deletion = previous[j] + 1;
      const best = Math.min(diagonal, insertion, deletion);
      next[j] = best;
      nextInsertions[j] = best === diagonal ? previousInsertions[j - 1]
        : best === insertion ? nextInsertions[j - 1] + 1 : previousInsertions[j];
    }
    [previous, next] = [next, previous];
    [previousInsertions, nextInsertions] = [nextInsertions, previousInsertions];
  }
  const distance = previous[n], insertions = previousInsertions[n], deletions = insertions + m - n;
  return { distance, insertions, deletions, substitutions: distance - insertions - deletions,
    isApproximate: false, operationsUnavailableReason: null };
}

/** The exact diff already owns an optimal alignment; reuse its operation counts
 * rather than performing another quadratic DP or choosing a conflicting tie.
 */
export function editDistanceFromAlignment(stats: SequenceDiffStats): EditDistanceMetrics {
  const maximum = Math.max(stats.lengthA, stats.lengthB);
  const normalized = maximum ? stats.distance / maximum : 0;
  return { levenshteinDistance: stats.distance, normalizedLevenshtein: normalized,
    levenshteinSimilarity: 1 - normalized, insertions: stats.insertions,
    deletions: stats.deletions, substitutions: stats.substitutions,
    isApproximate: false, operationsUnavailableReason: null };
}

/**
 * Compute normalized Levenshtein distance.
 * Normalized to [0, 1] range where 0 = identical.
 *
 * NLD = distance / max(len(a), len(b))
 */
export function normalizedLevenshtein(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;

  const result = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);

  return result.distance / maxLen;
}

/**
 * Compute Levenshtein similarity (inverse of normalized distance).
 * Range: [0, 1] where 1 = identical.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  return 1 - normalizedLevenshtein(a, b);
}

/**
 * Hamming distance (for equal-length strings).
 * Counts positions where characters differ.
 *
 * Much faster than Levenshtein but only works for same-length sequences.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error('Hamming distance requires equal-length strings');
  }

  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      distance++;
    }
  }

  return distance;
}

/**
 * Compute percent identity (simple positional matching).
 * Fast for comparing aligned sequences.
 */
export function percentIdentity(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  if (minLen === 0) return a.length === b.length ? 100 : 0;

  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i].toUpperCase() === b[i].toUpperCase()) {
      matches++;
    }
  }

  // Penalize length difference
  const maxLen = Math.max(a.length, b.length);
  return (matches / maxLen) * 100;
}

/**
 * Longest Common Subsequence (LCS) length.
 * More biologically relevant than edit distance in some contexts.
 */
export function longestCommonSubsequence(
  a: string,
  b: string,
  maxLength: number = 10000
): number {
  // For very long sequences, use sampling
  if (a.length > maxLength || b.length > maxLength) {
    return approximateLCS(a, b, 1000, 10);
  }

  const m = a.length;
  const n = b.length;

  // Two-row DP using typed Int32Array
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[n];
}

/**
 * Approximate LCS for very long sequences.
 */
function approximateLCS(
  a: string,
  b: string,
  windowSize: number,
  numWindows: number
): number {
  const minLen = Math.min(a.length, b.length);
  const step = Math.floor(minLen / numWindows);

  let totalLCS = 0;
  for (let i = 0; i < numWindows; i++) {
    const start = i * step;
    const windowA = a.substring(start, start + windowSize);
    const windowB = b.substring(start, start + windowSize);
    totalLCS += longestCommonSubsequence(windowA, windowB, Infinity);
  }

  // Scale to full length
  return Math.round((totalLCS / numWindows) * (minLen / windowSize));
}

/**
 * Compute LCS similarity ratio.
 * LCS / max(len(a), len(b))
 */
export function lcsSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const lcsLen = longestCommonSubsequence(a, b);
  return lcsLen / maxLen;
}

/**
 * Perform complete edit distance analysis.
 */
export function analyzeEditDistance(
  sequenceA: string,
  sequenceB: string,
  config: {
    maxExactLength?: number;
    windowSize?: number;
    windowCount?: number;
  } = {}
): EditDistanceMetrics {
  const {
    maxExactLength = 10000,
    windowSize = 1000,
    windowCount = 20,
  } = config;

  const isLong = sequenceA.length > maxExactLength || sequenceB.length > maxExactLength;

  let result: {
    distance: number;
    insertions: number | null;
    deletions: number | null;
    substitutions: number | null;
    operationsUnavailableReason: string | null;
    isApproximate: boolean;
    windowSize?: number;
    windowCount?: number;
  };

  if (isLong) {
    // Use approximate method
    const approx = approximateLevenshtein(sequenceA, sequenceB, windowSize, windowCount);
    result = {
      distance: approx.distance,
      insertions: null,
      deletions: null,
      substitutions: null,
      operationsUnavailableReason: SAMPLED_OPERATIONS_UNAVAILABLE,
      isApproximate: true,
      windowSize: approx.windowSize,
      windowCount: approx.windowCount,
    };
  } else {
    const ops = levenshteinWithOperations(sequenceA, sequenceB, maxExactLength);
    result = {
      ...ops,
      isApproximate: false,
    };
  }

  // Compute normalized metrics
  const maxLen = Math.max(sequenceA.length, sequenceB.length);
  const normalized = maxLen > 0 ? result.distance / maxLen : 0;

  return {
    levenshteinDistance: result.distance,
    normalizedLevenshtein: normalized,
    levenshteinSimilarity: 1 - normalized,
    insertions: result.insertions,
    deletions: result.deletions,
    substitutions: result.substitutions,
    operationsUnavailableReason: result.operationsUnavailableReason,
    isApproximate: result.isApproximate,
    windowSize: result.windowSize,
    windowCount: result.windowCount,
  };
}

/**
 * Fast identity check using sampling.
 * Quickly estimates if sequences are similar enough to warrant full comparison.
 * 
 * @deprecated This method relies on positional sampling and assumes sequences are globally aligned.
 * It will fail (return ~0) for unaligned or frameshifted sequences.
 * Use `minHashJaccard` (from kmer-analysis) or `quickCompare` (from comparison-engine) for robust alignment-free estimation.
 */
export function quickSimilarityEstimate(
  a: string,
  b: string,
  sampleSize: number = 1000,
  numSamples: number = 10
): number {
  // If lengths differ significantly, similarity is low
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  if (lenRatio < 0.5) return lenRatio * 0.5;

  const minLen = Math.min(a.length, b.length);
  if (minLen <= sampleSize) {
    return percentIdentity(a, b) / 100;
  }

  // Sample at random positions
  let matches = 0;
  let total = 0;

  for (let i = 0; i < numSamples; i++) {
    const start = Math.floor(Math.random() * (minLen - sampleSize));
    const sampleA = a.substring(start, start + sampleSize);
    const sampleB = b.substring(start, start + sampleSize);

    for (let j = 0; j < sampleSize; j++) {
      if (sampleA[j].toUpperCase() === sampleB[j].toUpperCase()) {
        matches++;
      }
      total++;
    }
  }

  return (matches / total) * lenRatio;
}
