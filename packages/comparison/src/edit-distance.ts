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
import initWasm, { levenshtein_distance as wasmLevenshtein } from '@phage/wasm-compute';
import { file } from 'bun';

let wasmReady = false;

// Initialize WASM asynchronously
(async () => {
  try {
    // Resolve path to WASM binary using Bun's resolution
    const wasmUrl = await import.meta.resolve('@phage/wasm-compute/wasm_compute_bg.wasm');
    const wasmBuffer = await file(new URL(wasmUrl)).arrayBuffer();
    await initWasm(wasmBuffer);
    wasmReady = true;
  } catch (e) {
    console.warn('Failed to initialize WASM for edit-distance, falling back to JS:', e);
  }
})();

/**
 * Compute Levenshtein distance using dynamic programming.
 * Space-optimized: O(min(m,n)) instead of O(m*n).
 *
 * For sequences > maxLength, returns approximate result.
 */
export function levenshteinDistance(
  a: string,
  b: string,
  maxLength: number = 10000
): { distance: number; isApproximate: boolean } {
  // Try using Rust implementation first
  try {
    if (!wasmReady) {
      // Best-effort lazy init if sync failed and async not yet resolved
      initWasm().then(() => { wasmReady = true; });
    }
    // Rust is significantly faster, so we can increase the exact calculation threshold.
    // 100kb x 100kb is feasible in Wasm/Rust whereas it would choke JS.
    if (a.length <= 100000 && b.length <= 100000) {
      return { distance: wasmLevenshtein(a, b), isApproximate: false };
    }
  } catch {
    // Fallback silently to JS implementation
  }

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

  // Two-row DP array
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);

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
    [prev, curr] = [curr, prev];
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
  const lenA = a.length;
  const lenB = b.length;

  // Handle length differences
  const minLen = Math.min(lenA, lenB);
  const maxLen = Math.max(lenA, lenB);
  const lengthDiff = maxLen - minLen;

  // Calculate step size to cover the sequences
  const effectiveWindows = Math.min(numWindows, Math.floor(minLen / windowSize));
  if (effectiveWindows < 1) {
    // Fallback to exact computation for short sequences
    return { ...levenshteinDistance(a, b, Infinity), windowSize, windowCount: 1 };
  }

  const step = Math.floor((minLen - windowSize) / (effectiveWindows - 1 || 1));

  let totalDistance = 0;
  let windowCount = 0;

  for (let i = 0; i < effectiveWindows; i++) {
    const start = i * step;
    const windowA = a.substring(start, start + windowSize);
    const windowB = b.substring(start, start + windowSize);

    const result = levenshteinDistance(windowA, windowB, Infinity);
    totalDistance += result.distance;
    windowCount++;
  }

  // Average distance per window, scaled to full sequence
  const avgDistPerWindow = totalDistance / windowCount;
  const scaleFactor = minLen / windowSize;
  const estimatedDistance = Math.round(avgDistPerWindow * scaleFactor + lengthDiff);

  return {
    distance: estimatedDistance,
    isApproximate: true,
    windowSize,
    windowCount,
  };
}

/**
 * Compute Levenshtein distance with traceback to get edit operations.
 * Returns the specific insertions, deletions, and substitutions.
 */
export function levenshteinWithOperations(
  a: string,
  b: string,
  maxLength: number = 5000
): { distance: number; insertions: number; deletions: number; substitutions: number } {
  // For very long sequences, use sampling
  if (a.length > maxLength || b.length > maxLength) {
    const approx = approximateLevenshtein(a, b, 1000, 20);
    // Estimate operation breakdown (rough approximation)
    const d = approx.distance;
    const lenDiff = Math.abs(a.length - b.length);
    const substitutions = Math.round((d - lenDiff) / 2);
    const insertions = a.length < b.length ? Math.round(lenDiff / 2) : 0;
    const deletions = a.length > b.length ? Math.round(lenDiff / 2) : 0;

    return {
      distance: d,
      insertions: Math.max(0, insertions + Math.round(substitutions / 3)),
      deletions: Math.max(0, deletions + Math.round(substitutions / 3)),
      substitutions: Math.max(0, Math.round(substitutions / 3)),
    };
  }

  const m = a.length;
  const n = b.length;

  // Full DP matrix for traceback
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );

  // Initialize
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,     // deletion
        dp[i][j - 1] + 1,     // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  // Traceback to count operations
  let insertions = 0;
  let deletions = 0;
  let substitutions = 0;

  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      // Match - no operation
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      // Substitution
      substitutions++;
      i--;
      j--;
    } else if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      // Insertion
      insertions++;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      // Deletion
      deletions++;
      i--;
    } else {
      // Match (shouldn't reach here but safety)
      i = Math.max(0, i - 1);
      j = Math.max(0, j - 1);
    }
  }

  return {
    distance: dp[m][n],
    insertions,
    deletions,
    substitutions,
  };
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

  // Two-row DP
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
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
    insertions: number;
    deletions: number;
    substitutions: number;
    isApproximate: boolean;
    windowSize?: number;
    windowCount?: number;
  };

  if (isLong) {
    // Use approximate method
    const approx = approximateLevenshtein(sequenceA, sequenceB, windowSize, windowCount);
    const lenDiff = Math.abs(sequenceA.length - sequenceB.length);

    // Estimate operations
    const estSubs = Math.max(0, Math.round((approx.distance - lenDiff) * 0.6));
    const estIndels = approx.distance - estSubs;

    result = {
      distance: approx.distance,
      insertions: sequenceA.length < sequenceB.length ? Math.round(estIndels * 0.6) : Math.round(estIndels * 0.4),
      deletions: sequenceA.length > sequenceB.length ? Math.round(estIndels * 0.6) : Math.round(estIndels * 0.4),
      substitutions: estSubs,
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
    isApproximate: result.isApproximate,
    windowSize: result.windowSize,
    windowCount: result.windowCount,
  };
}

/**
 * Fast identity check using sampling.
 * Quickly estimates if sequences are similar enough to warrant full comparison.
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
