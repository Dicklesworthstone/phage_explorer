/**
 * Dense K-mer Counter Utilities
 *
 * TypeScript wrapper for the WASM dense k-mer counter with:
 * - Safe caps to prevent OOM (k ≤ 10 for web)
 * - Efficient top-K extraction (min-heap, no full string generation)
 * - Worker-friendly (no DOM globals)
 *
 * @see phage_explorer-vk7b.1.2
 * @see docs/WASM_ABI_SPEC.md
 */

import { indexToKmer, kmerToIndex } from './kmer-frequencies';

// Re-export for convenience
export { indexToKmer, kmerToIndex };

// ============================================================================
// Constants & Types
// ============================================================================

/**
 * Maximum k value for dense counting in web browsers.
 * 4^10 = 1,048,576 counters × 4 bytes = ~4MB (safe for browsers).
 * Matches WASM `DENSE_KMER_MAX_K` constant.
 */
export const DENSE_KMER_MAX_K = 10;

/**
 * Memory cost in bytes for a dense k-mer count array.
 * Returns 4^k × 4 bytes (Uint32Array).
 */
export function denseKmerMemoryCost(k: number): number {
  // Use Math.pow for k > 15 to avoid 32-bit integer overflow with bit shift
  // (1 << 32 = 1 in JS due to 32-bit masking, but 4^16 = 4294967296)
  if (k > 15) {
    return Math.pow(4, k) * 4;
  }
  return (1 << (2 * k)) * 4; // 4^k * sizeof(u32)
}

/**
 * Human-readable memory cost string.
 */
export function denseKmerMemoryCostHuman(k: number): string {
  const bytes = denseKmerMemoryCost(k);
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Top-K k-mer result.
 */
export interface TopKmer {
  /** K-mer string (e.g., "ACGT") */
  kmer: string;
  /** Count of occurrences */
  count: number;
  /** Index in dense array */
  index: number;
}

/**
 * Dense k-mer counting result from JS fallback.
 *
 * Note: The WASM `DenseKmerResult` class has a different interface:
 * - WASM uses snake_case: `.total_valid`, `.unique_count`
 * - WASM `.total_valid` returns `bigint` (Rust u64), use `Number()` to convert
 * - JS fallback uses camelCase and `number` types
 *
 * When using WASM, access the result directly via the class getters.
 * When using the JS fallback (`countKmersDenseJS`), use this interface.
 */
export interface DenseKmerCountResult {
  /** Dense count array of length 4^k */
  counts: Uint32Array;
  /** Total valid k-mers counted (number in JS, bigint in WASM) */
  totalValid: number;
  /** K value used */
  k: number;
  /** Number of unique k-mers (non-zero counts) */
  uniqueCount?: number;
}

// ============================================================================
// Safety & Feature Checks
// ============================================================================

/**
 * Check if dense k-mer counting is safe for the given k.
 *
 * Returns true if:
 * - k >= 1
 * - k <= DENSE_KMER_MAX_K (10)
 * - Memory cost is acceptable (~4MB max)
 *
 * @param k - K-mer size
 * @returns true if safe to use dense counting
 */
export function canUseDenseKmerCounts(k: number): boolean {
  return k >= 1 && k <= DENSE_KMER_MAX_K;
}

/**
 * Get recommendation for k-mer counting strategy.
 *
 * @param k - Desired k-mer size
 * @returns Strategy recommendation
 */
export function getKmerCountingStrategy(k: number): {
  method: 'dense' | 'sparse' | 'minhash';
  reason: string;
  memoryMB: number;
} {
  const memoryBytes = denseKmerMemoryCost(k);
  const memoryMB = memoryBytes / (1024 * 1024);

  if (k <= 0) {
    return { method: 'dense', reason: 'Invalid k (must be >= 1)', memoryMB: 0 };
  }

  if (k <= DENSE_KMER_MAX_K) {
    return {
      method: 'dense',
      reason: `Dense array is efficient for k=${k} (${denseKmerMemoryCostHuman(k)})`,
      memoryMB,
    };
  }

  if (k <= 15) {
    return {
      method: 'sparse',
      reason: `k=${k} requires ${memoryMB.toFixed(0)}MB; use sparse Map<string, number>`,
      memoryMB,
    };
  }

  return {
    method: 'minhash',
    reason: `k=${k} is too large for exact counting; use MinHash sketches`,
    memoryMB,
  };
}

// ============================================================================
// Top-K Extraction (Efficient Min-Heap)
// ============================================================================

/**
 * Extract top-N k-mers by count without generating all k-mer strings.
 *
 * Uses a min-heap of size N to efficiently find the top-N counts,
 * then converts only those indices to k-mer strings.
 *
 * Time: O(n log N) where n = 4^k
 * Space: O(N) for the heap
 *
 * @param counts - Dense count array from WASM (Uint32Array)
 * @param k - K-mer size (for index-to-kmer conversion)
 * @param topN - Number of top k-mers to extract (default: 20)
 * @returns Array of top k-mers sorted by count (descending)
 */
export function topKFromDenseCounts(
  counts: Uint32Array,
  k: number,
  topN: number = 20
): TopKmer[] {
  if (topN <= 0 || counts.length === 0) {
    return [];
  }

  // Min-heap of (count, index) pairs
  // Heap property: parent <= children (so root is smallest)
  const heap: Array<{ count: number; index: number }> = [];

  // Heap operations
  const swap = (i: number, j: number) => {
    const tmp = heap[i];
    heap[i] = heap[j];
    heap[j] = tmp;
  };

  const bubbleUp = (i: number) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].count <= heap[i].count) break;
      swap(parent, i);
      i = parent;
    }
  };

  const bubbleDown = (i: number) => {
    const n = heap.length;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;

      if (left < n && heap[left].count < heap[smallest].count) {
        smallest = left;
      }
      if (right < n && heap[right].count < heap[smallest].count) {
        smallest = right;
      }

      if (smallest === i) break;
      swap(i, smallest);
      i = smallest;
    }
  };

  // Process all counts
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];

    // Skip zero counts
    if (count === 0) continue;

    if (heap.length < topN) {
      // Heap not full yet - add directly
      heap.push({ count, index });
      bubbleUp(heap.length - 1);
    } else if (count > heap[0].count) {
      // New count is larger than heap minimum - replace root
      heap[0] = { count, index };
      bubbleDown(0);
    }
  }

  // Extract results sorted by count (descending)
  const result: TopKmer[] = [];
  while (heap.length > 0) {
    // Pop from heap (swap root with last, remove last, bubble down)
    const item = heap[0];
    heap[0] = heap[heap.length - 1];
    heap.pop();
    if (heap.length > 0) {
      bubbleDown(0);
    }
    result.push({
      kmer: indexToKmer(item.index, k),
      count: item.count,
      index: item.index,
    });
  }

  // Reverse to get descending order (we extracted smallest-first)
  return result.reverse();
}

/**
 * Get the k-mer with the highest count.
 *
 * More efficient than topKFromDenseCounts(counts, k, 1)[0] for single lookup.
 *
 * @param counts - Dense count array
 * @param k - K-mer size
 * @returns Top k-mer or null if all counts are zero
 */
export function getMaxKmer(counts: Uint32Array, k: number): TopKmer | null {
  let maxCount = 0;
  let maxIndex = -1;

  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > maxCount) {
      maxCount = counts[i];
      maxIndex = i;
    }
  }

  if (maxIndex === -1) {
    return null;
  }

  return {
    kmer: indexToKmer(maxIndex, k),
    count: maxCount,
    index: maxIndex,
  };
}

// ============================================================================
// Normalization Helpers
// ============================================================================

/**
 * Convert counts to frequencies (Float32Array).
 *
 * Allocates a single Float32Array and divides each count by total.
 *
 * @param counts - Dense count array (Uint32Array)
 * @param totalValid - Total valid k-mers (denominator)
 * @returns Frequency vector (sums to 1.0 if totalValid > 0)
 */
export function countsToFrequencies(
  counts: Uint32Array,
  totalValid: number
): Float32Array {
  const frequencies = new Float32Array(counts.length);

  if (totalValid <= 0) {
    return frequencies; // All zeros
  }

  const invTotal = 1.0 / totalValid;
  for (let i = 0; i < counts.length; i++) {
    frequencies[i] = counts[i] * invTotal;
  }

  return frequencies;
}

/**
 * Normalize counts in-place to relative frequencies.
 *
 * Modifies the input Float32Array directly (avoids allocation).
 *
 * @param frequencies - Array to normalize (modified in place)
 * @returns Same array (for chaining)
 */
export function normalizeInPlace(frequencies: Float32Array): Float32Array {
  let total = 0;
  for (let i = 0; i < frequencies.length; i++) {
    total += frequencies[i];
  }

  if (total > 0) {
    const invTotal = 1.0 / total;
    for (let i = 0; i < frequencies.length; i++) {
      frequencies[i] *= invTotal;
    }
  }

  return frequencies;
}

// ============================================================================
// JS Fallback Implementation
// ============================================================================

/**
 * Pure JS dense k-mer counter (fallback when WASM unavailable).
 *
 * Matches WASM behavior exactly for testing and fallback.
 *
 * @param sequence - DNA sequence (string or Uint8Array)
 * @param k - K-mer size (1-10)
 * @returns Dense k-mer count result
 */
export function countKmersDenseJS(
  sequence: string | Uint8Array,
  k: number
): DenseKmerCountResult {
  if (k < 1 || k > DENSE_KMER_MAX_K) {
    return {
      counts: new Uint32Array(0),
      totalValid: 0,
      k,
      uniqueCount: 0,
    };
  }

  const arraySize = 1 << (2 * k);
  const counts = new Uint32Array(arraySize);
  const mask = arraySize - 1;

  let rollingIndex = 0;
  let validBases = 0;
  let totalValid = 0;

  // Convert string to bytes if needed
  const bytes =
    typeof sequence === 'string'
      ? new TextEncoder().encode(sequence)
      : sequence;

  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];

    // Encode base (A=0, C=1, G=2, T=3)
    let baseCode: number;
    switch (byte) {
      case 65: case 97:  // A, a
        baseCode = 0;
        break;
      case 67: case 99:  // C, c
        baseCode = 1;
        break;
      case 71: case 103: // G, g
        baseCode = 2;
        break;
      case 84: case 116: // T, t
      case 85: case 117: // U, u
        baseCode = 3;
        break;
      default:
        // Ambiguous base - reset
        rollingIndex = 0;
        validBases = 0;
        continue;
    }

    rollingIndex = ((rollingIndex << 2) | baseCode) & mask;
    validBases++;

    if (validBases >= k) {
      counts[rollingIndex]++;
      totalValid++;
    }
  }

  // Count unique k-mers
  let uniqueCount = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > 0) uniqueCount++;
  }

  return {
    counts,
    totalValid,
    k,
    uniqueCount,
  };
}

// ============================================================================
// Memory Cost Reference Table
// ============================================================================

/**
 * Memory costs for dense k-mer arrays (for documentation).
 *
 * | k  | Array Size | Memory (Uint32) |
 * |----|------------|-----------------|
 * | 1  | 4          | 16 B            |
 * | 2  | 16         | 64 B            |
 * | 3  | 64         | 256 B           |
 * | 4  | 256        | 1 KB            |
 * | 5  | 1,024      | 4 KB            |
 * | 6  | 4,096      | 16 KB           |
 * | 7  | 16,384     | 64 KB           |
 * | 8  | 65,536     | 256 KB          |
 * | 9  | 262,144    | 1 MB            |
 * | 10 | 1,048,576  | 4 MB            |  ← DENSE_KMER_MAX_K
 * | 11 | 4,194,304  | 16 MB           |  ⚠️ browser warning
 * | 12 | 16,777,216 | 64 MB           |  ⚠️ often fails
 * | 13 | 67,108,864 | 256 MB          |  ❌ exceeds limits
 */
export const KMER_MEMORY_TABLE: ReadonlyArray<{
  k: number;
  arraySize: number;
  memoryBytes: number;
  safe: boolean;
}> = [
  { k: 1, arraySize: 4, memoryBytes: 16, safe: true },
  { k: 2, arraySize: 16, memoryBytes: 64, safe: true },
  { k: 3, arraySize: 64, memoryBytes: 256, safe: true },
  { k: 4, arraySize: 256, memoryBytes: 1024, safe: true },
  { k: 5, arraySize: 1024, memoryBytes: 4096, safe: true },
  { k: 6, arraySize: 4096, memoryBytes: 16384, safe: true },
  { k: 7, arraySize: 16384, memoryBytes: 65536, safe: true },
  { k: 8, arraySize: 65536, memoryBytes: 262144, safe: true },
  { k: 9, arraySize: 262144, memoryBytes: 1048576, safe: true },
  { k: 10, arraySize: 1048576, memoryBytes: 4194304, safe: true },
  { k: 11, arraySize: 4194304, memoryBytes: 16777216, safe: false },
  { k: 12, arraySize: 16777216, memoryBytes: 67108864, safe: false },
];
