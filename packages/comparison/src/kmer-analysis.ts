/**
 * K-mer Analysis Module
 *
 * Alignment-free sequence comparison using k-mer frequency analysis.
 * Implements Jaccard index, cosine similarity, containment index,
 * and Bray-Curtis dissimilarity.
 *
 * Uses the WASM implementation when available. Measured 5.7x at 1 kb rising to
 * 13x at 300 kb (`bun run bench:wasm`).
 *
 * References:
 * - Zielezinski et al. (2019) "Benchmarking of alignment-free sequence comparison methods"
 * - CMash (Koslicki & Zabeti, 2019) for multi-resolution k-mer estimation
 */

import type { KmerAnalysis } from './types';

const VALID_DNA_BASES = new Set(['A', 'C', 'G', 'T']);

function hasInvalidDnaBase(kmer: string): boolean {
  for (const base of kmer) {
    if (!VALID_DNA_BASES.has(base)) return true;
  }
  return false;
}

// WASM types and function references - loaded dynamically
interface WasmKmerAnalysisResult {
  k: number;
  unique_kmers_a: number;
  unique_kmers_b: number;
  shared_kmers: number;
  jaccard_index: number;
  containment_a_in_b: number;
  containment_b_in_a: number;
  cosine_similarity: number;
  bray_curtis_dissimilarity: number;
  free(): void;
}

let wasmAnalyzeKmers: ((a: string, b: string, k: number) => WasmKmerAnalysisResult) | null = null;
let wasmMinHashJaccard: ((a: string, b: string, k: number, numHashes: number) => number) | null = null;
let wasmAvailable = false;

// Attempt to load WASM module dynamically
export async function initKmerAnalysisWasm(): Promise<void> {
  if (wasmAvailable) return;
  try {
    const wasm = await import('@phage/wasm-compute');
    // wasm-compute may require explicit async init (depending on build target).
    const maybeInit = (wasm as unknown as { default?: () => Promise<void> }).default;
    if (typeof maybeInit === 'function') {
      await maybeInit();
    }
    wasmAnalyzeKmers = wasm.analyze_kmers;
    wasmMinHashJaccard = wasm.min_hash_jaccard;
    // Test WASM function with trivial case
    const testResult = wasmAnalyzeKmers!('ATCG', 'ATCG', 2);
    wasmAvailable = testResult && typeof testResult.jaccard_index === 'number';
    // Free the test result
    if (testResult && typeof testResult.free === 'function') {
      testResult.free();
    }
  } catch {
    wasmAvailable = false;
    wasmAnalyzeKmers = null;
    wasmMinHashJaccard = null;
  }
}

// Initialize WASM on module load (non-blocking) - REMOVED
// initWasm().catch(() => { /* WASM unavailable, using JS fallback */ });

/**
 * Extract all k-mers from a sequence as a Set (for presence/absence).
 * Converts to uppercase and handles ambiguous bases (N) by skipping.
 */
export function extractKmerSet(sequence: string, k: number): Set<string> {
  const kmers = new Set<string>();
  if (k < 1 || sequence.length < k) {
    return kmers;
  }
  const seq = sequence.toUpperCase();

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    // Skip k-mers containing any ambiguous base (not A/C/G/T)
    if (!hasInvalidDnaBase(kmer)) {
      kmers.add(kmer);
    }
  }

  return kmers;
}

/**
 * Extract k-mer frequency map (for abundance-aware metrics).
 * Returns a Map of k-mer → count.
 */
export function extractKmerFrequencies(sequence: string, k: number): Map<string, number> {
  const freqs = new Map<string, number>();
  if (k < 1 || sequence.length < k) {
    return freqs;
  }
  const seq = sequence.toUpperCase();

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    if (!hasInvalidDnaBase(kmer)) {
      freqs.set(kmer, (freqs.get(kmer) ?? 0) + 1);
    }
  }

  return freqs;
}

/**
 * Compute Jaccard Index between two k-mer sets.
 *
 * J(A,B) = |A ∩ B| / |A ∪ B|
 *
 * Range: [0, 1] where 1 = identical k-mer content
 */
export function jaccardIndex(setA: Set<string>, setB: Set<string>): number {
  let intersectionSize = 0;

  // Count intersection
  for (const kmer of setA) {
    if (setB.has(kmer)) {
      intersectionSize++;
    }
  }

  // Union size = |A| + |B| - |A ∩ B|
  const unionSize = setA.size + setB.size - intersectionSize;

  return unionSize > 0 ? intersectionSize / unionSize : 1;
}

/**
 * Compute Containment Index (asymmetric).
 *
 * C(A,B) = |A ∩ B| / |A|
 *
 * Measures what fraction of A's k-mers are found in B.
 * Useful when comparing genomes of different sizes.
 */
export function containmentIndex(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0) return 0;

  let intersectionSize = 0;
  for (const kmer of setA) {
    if (setB.has(kmer)) {
      intersectionSize++;
    }
  }

  return intersectionSize / setA.size;
}

/**
 * Compute Cosine Similarity between k-mer frequency vectors.
 *
 * cos(A,B) = (A · B) / (||A|| × ||B||)
 *
 * Range: [0, 1] where 1 = identical frequency distribution
 * Takes into account both presence and abundance of k-mers.
 */
export function cosineSimilarity(
  freqsA: Map<string, number>,
  freqsB: Map<string, number>
): number {
  // Get union of all k-mers
  const allKmers = new Set([...freqsA.keys(), ...freqsB.keys()]);

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const kmer of allKmers) {
    const countA = freqsA.get(kmer) ?? 0;
    const countB = freqsB.get(kmer) ?? 0;

    dotProduct += countA * countB;
    normA += countA * countA;
    normB += countB * countB;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

/**
 * Compute Bray-Curtis Dissimilarity.
 *
 * BC = Σ|Ai - Bi| / Σ(Ai + Bi)
 *
 * Originally from ecology for species abundance comparison.
 * Range: [0, 1] where 0 = identical, 1 = completely different
 */
export function brayCurtisDissimilarity(
  freqsA: Map<string, number>,
  freqsB: Map<string, number>
): number {
  const allKmers = new Set([...freqsA.keys(), ...freqsB.keys()]);

  let sumDiff = 0;
  let sumTotal = 0;

  for (const kmer of allKmers) {
    const countA = freqsA.get(kmer) ?? 0;
    const countB = freqsB.get(kmer) ?? 0;

    sumDiff += Math.abs(countA - countB);
    sumTotal += countA + countB;
  }

  return sumTotal > 0 ? sumDiff / sumTotal : 0;
}

/**
 * Compute intersection size between two k-mer sets.
 */
export function kmerIntersectionSize(setA: Set<string>, setB: Set<string>): number {
  let count = 0;
  for (const kmer of setA) {
    if (setB.has(kmer)) {
      count++;
    }
  }
  return count;
}

/**
 * Perform complete k-mer analysis between two sequences.
 * Uses the WASM implementation when available; see bench:wasm for the ratios.
 */
export function analyzeKmers(
  sequenceA: string,
  sequenceB: string,
  k: number
): KmerAnalysis {
  if (k < 1) {
    return {
      k,
      uniqueKmersA: 0,
      uniqueKmersB: 0,
      sharedKmers: 0,
      jaccardIndex: 0,
      containmentAinB: 0,
      containmentBinA: 0,
      cosineSimilarity: 0,
      brayCurtisDissimilarity: 0,
    };
  }

  // Use the WASM implementation when available; see bench:wasm for the ratios.
  if (wasmAvailable && wasmAnalyzeKmers) {
    let result: WasmKmerAnalysisResult | null = null;
    try {
      result = wasmAnalyzeKmers(sequenceA, sequenceB, k);
      const analysis: KmerAnalysis = {
        k: result.k,
        uniqueKmersA: result.unique_kmers_a,
        uniqueKmersB: result.unique_kmers_b,
        sharedKmers: result.shared_kmers,
        jaccardIndex: result.jaccard_index,
        containmentAinB: result.containment_a_in_b,
        containmentBinA: result.containment_b_in_a,
        cosineSimilarity: result.cosine_similarity,
        brayCurtisDissimilarity: result.bray_curtis_dissimilarity,
      };
      return analysis;
    } finally {
      // Always free WASM memory
      if (result && typeof result.free === 'function') {
        result.free();
      }
    }
  }

  // Fallback to JS implementation
  return analyzeKmersJS(sequenceA, sequenceB, k);
}

/**
 * Pure JS implementation of k-mer analysis (fallback when WASM unavailable).
 */
function analyzeKmersJS(
  sequenceA: string,
  sequenceB: string,
  k: number
): KmerAnalysis {
  // Extract canonical k-mer sets (presence/absence)
  const setA = extractCanonicalKmerSet(sequenceA, k);
  const setB = extractCanonicalKmerSet(sequenceB, k);

  // Extract canonical k-mer frequencies (abundance)
  const freqsA = extractCanonicalKmerFrequencies(sequenceA, k);
  const freqsB = extractCanonicalKmerFrequencies(sequenceB, k);

  // Compute metrics
  const shared = kmerIntersectionSize(setA, setB);

  return {
    k,
    uniqueKmersA: setA.size,
    uniqueKmersB: setB.size,
    sharedKmers: shared,
    jaccardIndex: jaccardIndex(setA, setB),
    containmentAinB: containmentIndex(setA, setB),
    containmentBinA: containmentIndex(setB, setA),
    cosineSimilarity: cosineSimilarity(freqsA, freqsB),
    brayCurtisDissimilarity: brayCurtisDissimilarity(freqsA, freqsB),
  };
}

/**
 * Analyze multiple k values and return array of results.
 * This provides multi-resolution analysis as recommended in literature.
 *
 * - Small k (3-4): Captures composition, less specific
 * - Medium k (5-7): Good balance of specificity and coverage
 * - Large k (9-11): Highly specific, better for detecting conserved regions
 */
export function multiResolutionKmerAnalysis(
  sequenceA: string,
  sequenceB: string,
  kValues: number[] = [3, 5, 7, 11]
): KmerAnalysis[] {
  return kValues.map(k => analyzeKmers(sequenceA, sequenceB, k));
}

/**
 * Compute canonical k-mers (includes reverse complement).
 * This is useful for double-stranded DNA where both strands are equivalent.
 *
 * For each k-mer, we store the lexicographically smaller of the k-mer
 * and its reverse complement.
 */
export function extractCanonicalKmerSet(sequence: string, k: number): Set<string> {
  if (k < 1 || sequence.length < k) return new Set<string>();
  const kmers = new Set<string>();
  const seq = sequence.toUpperCase();

  const complement: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    if (hasInvalidDnaBase(kmer)) continue;

    // Compute reverse complement
    let revComp = '';
    for (let j = k - 1; j >= 0; j--) {
      revComp += complement[kmer[j]] ?? kmer[j];
    }

    // Use canonical (lexicographically smaller)
    const canonical = kmer < revComp ? kmer : revComp;
    kmers.add(canonical);
  }

  return kmers;
}

/**
 * Extract canonical k-mer frequencies (abundance-aware).
 */
export function extractCanonicalKmerFrequencies(sequence: string, k: number): Map<string, number> {
  if (k < 1 || sequence.length < k) return new Map<string, number>();
  const freqs = new Map<string, number>();
  const seq = sequence.toUpperCase();
  const complement: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    if (hasInvalidDnaBase(kmer)) continue;

    let revComp = '';
    for (let j = k - 1; j >= 0; j--) {
      revComp += complement[kmer[j]] ?? kmer[j];
    }

    const canonical = kmer < revComp ? kmer : revComp;
    freqs.set(canonical, (freqs.get(canonical) ?? 0) + 1);
  }

  return freqs;
}

/**
 * Estimate Jaccard similarity using MinHash for very large sequences.
 * This provides O(n) space and time complexity instead of O(n^2).
 * Uses the WASM implementation when available. Measured 3.9x at 1 kb rising to
 * 40x at 300 kb (`bun run bench:wasm`) -- the old "3-5x" understated it.
 *
 * Optimized to use a single base hash and permutations.
 */
export function minHashJaccard(
  sequenceA: string,
  sequenceB: string,
  k: number,
  numHashes: number = 128
): number {
  // Fast path for degenerate inputs: if both sequences have no valid k-mers,
  // treat them as identical (Jaccard(∅, ∅) = 1). If only one is empty, similarity is 0.
  //
  // This also normalizes behavior between the JS and WASM implementations.
  if (k < 1 || numHashes < 1) return 0;

  const hasValidKmer = (seq: string): boolean => {
    if (seq.length < k) return false;
    let run = 0;
    for (let i = 0; i < seq.length; i++) {
      const ch = seq.charCodeAt(i);
      // Only treat N/n as ambiguous, matching extractKmerSet/minhash JS behavior.
      if (ch === 78 || ch === 110) {
        run = 0;
      } else {
        run++;
        if (run >= k) return true;
      }
    }
    return false;
  };

  const hasA = hasValidKmer(sequenceA);
  const hasB = hasValidKmer(sequenceB);
  if (!hasA && !hasB) return 1;
  if (!hasA || !hasB) return 0;

  // Use the WASM implementation when available; measured 3.9x-40x by bench:wasm.
  if (wasmAvailable && wasmMinHashJaccard) {
    try {
      return wasmMinHashJaccard(sequenceA, sequenceB, k, numHashes);
    } catch {
      // Fall through to JS implementation on error
    }
  }

  // Fallback to JS implementation
  return minHashJaccardJS(sequenceA, sequenceB, k, numHashes);
}

// Cache for deterministic MinHash seeds matching Rust wasm-compute:
// seeds[i] = (i as u32).wrapping_mul(0x9e3779b9)
const seedCache = new Map<number, Uint32Array>();

// Generate deterministic seeds for MinHash matching wasm-compute
function getDeterministicSeeds(count: number): Uint32Array {
  if (seedCache.has(count)) {
    return seedCache.get(count)!;
  }

  const seeds = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    seeds[i] = Math.imul(i, 0x9e3779b9) >>> 0;
  }

  seedCache.set(count, seeds);
  return seeds;
}

const M1 = 0x9e3779b97f4a7c15n;
const M2 = 0xbf58476d1ce4e5b9n;
const M3 = 0x94d049bb133111ebn;
const MASK64 = 0xffffffffffffffffn;

/**
 * Fast 64-bit to 32-bit splitmix hash mixing matching wasm-compute::mix_hash.
 */
export function mixHash(index: bigint | number, seed: number): number {
  let x = (BigInt(index) ^ BigInt(seed >>> 0)) & MASK64;
  x = (x * M1) & MASK64;
  x = ((x ^ (x >> 30n)) * M2) & MASK64;
  x = ((x ^ (x >> 27n)) * M3) & MASK64;
  x = (x ^ (x >> 31n)) & MASK64;
  return Number(x & 0xffffffffn) >>> 0;
}

/**
 * Pure JS MinHash signature computation matching WASM minhash_signature / minhash_signature_canonical.
 */
export function minHashSketchJS(
  sequence: string,
  k: number,
  numHashes: number = 128,
  canonical: boolean = false
): Uint32Array {
  const kClamped = Math.min(k, 32);
  const signature = new Uint32Array(numHashes).fill(0xffffffff);
  if (kClamped === 0 || numHashes === 0 || sequence.length < kClamped) {
    return signature;
  }

  const mask = kClamped >= 32 ? MASK64 : (1n << BigInt(2 * kClamped)) - 1n;
  const rcShift = BigInt(2 * (kClamped - 1));
  const seeds = getDeterministicSeeds(numHashes);

  let fwdIndex = 0n;
  let rcIndex = 0n;
  let validBases = 0;

  for (let i = 0; i < sequence.length; i++) {
    const ch = sequence.charCodeAt(i);
    let baseCode: bigint;
    let compCode: bigint;
    if (ch === 65 || ch === 97) {
      baseCode = 0n;
      compCode = 3n;
    } else if (ch === 67 || ch === 99) {
      baseCode = 1n;
      compCode = 2n;
    } else if (ch === 71 || ch === 103) {
      baseCode = 2n;
      compCode = 1n;
    } else if (ch === 84 || ch === 116 || ch === 85 || ch === 117) {
      baseCode = 3n;
      compCode = 0n;
    } else {
      fwdIndex = 0n;
      rcIndex = 0n;
      validBases = 0;
      continue;
    }

    fwdIndex = ((fwdIndex << 2n) | baseCode) & mask;
    if (canonical) {
      rcIndex = (rcIndex >> 2n) | (compCode << rcShift);
    }
    validBases++;

    if (validBases >= kClamped) {
      const idx = canonical ? (fwdIndex < rcIndex ? fwdIndex : rcIndex) : fwdIndex;
      for (let h = 0; h < numHashes; h++) {
        const val = mixHash(idx, seeds[h]);
        if (val < signature[h]) {
          signature[h] = val;
        }
      }
    }
  }

  return signature;
}

/**
 * Pure JS implementation of MinHash Jaccard (fallback when WASM unavailable).
 * Produces bit-identical results to wasm-compute min_hash_jaccard.
 */
function minHashJaccardJS(
  sequenceA: string,
  sequenceB: string,
  k: number,
  numHashes: number = 128
): number {
  // Guard against invalid numHashes
  if (numHashes < 1) {
    return 0;
  }

  const sketchA = minHashSketchJS(sequenceA, k, numHashes, false);
  const sketchB = minHashSketchJS(sequenceB, k, numHashes, false);

  let emptyA = true;
  let emptyB = true;
  for (let i = 0; i < numHashes; i++) {
    if (sketchA[i] !== 0xffffffff) emptyA = false;
    if (sketchB[i] !== 0xffffffff) emptyB = false;
  }
  if (emptyA || emptyB) {
    return 0;
  }

  let matches = 0;
  for (let i = 0; i < numHashes; i++) {
    if (sketchA[i] === sketchB[i]) {
      matches++;
    }
  }

  return matches / numHashes;
}
