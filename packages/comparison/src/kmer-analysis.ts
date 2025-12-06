/**
 * K-mer Analysis Module
 *
 * Alignment-free sequence comparison using k-mer frequency analysis.
 * Implements Jaccard index, cosine similarity, containment index,
 * and Bray-Curtis dissimilarity.
 *
 * References:
 * - Zielezinski et al. (2019) "Benchmarking of alignment-free sequence comparison methods"
 * - CMash (Koslicki & Zabeti, 2019) for multi-resolution k-mer estimation
 */

import type { KmerAnalysis } from './types';

/**
 * Extract all k-mers from a sequence as a Set (for presence/absence).
 * Converts to uppercase and handles ambiguous bases (N) by skipping.
 */
export function extractKmerSet(sequence: string, k: number): Set<string> {
  const kmers = new Set<string>();
  const seq = sequence.toUpperCase();

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    // Skip k-mers containing N (ambiguous base)
    if (!kmer.includes('N')) {
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
  const seq = sequence.toUpperCase();

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    if (!kmer.includes('N')) {
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
 */
export function analyzeKmers(
  sequenceA: string,
  sequenceB: string,
  k: number
): KmerAnalysis {
  // Extract k-mer sets (presence/absence)
  const setA = extractKmerSet(sequenceA, k);
  const setB = extractKmerSet(sequenceB, k);

  // Extract k-mer frequencies (abundance)
  const freqsA = extractKmerFrequencies(sequenceA, k);
  const freqsB = extractKmerFrequencies(sequenceB, k);

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
  const kmers = new Set<string>();
  const seq = sequence.toUpperCase();

  const complement: Record<string, string> = { A: 'T', T: 'A', G: 'C', C: 'G' };

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    if (kmer.includes('N')) continue;

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
 * Estimate Jaccard similarity using MinHash for very large sequences.
 * This provides O(n) space and time complexity instead of O(n^2).
 *
 * Uses a simple hash function and keeps minimum hash values.
 */
export function minHashJaccard(
  sequenceA: string,
  sequenceB: string,
  k: number,
  numHashes: number = 128
): number {
  // Simple hash function (FNV-1a inspired)
  const hash = (s: string, seed: number): number => {
    let h = seed;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0; // Ensure unsigned
  };

  // Generate min-hash signature for a sequence
  const getSignature = (seq: string): number[] => {
    const signature: number[] = new Array(numHashes).fill(Infinity);
    const s = seq.toUpperCase();

    for (let i = 0; i <= s.length - k; i++) {
      const kmer = s.substring(i, i + k);
      if (kmer.includes('N')) continue;

      for (let h = 0; h < numHashes; h++) {
        const hashVal = hash(kmer, h * 0x9e3779b9);
        if (hashVal < signature[h]) {
          signature[h] = hashVal;
        }
      }
    }

    return signature;
  };

  const sigA = getSignature(sequenceA);
  const sigB = getSignature(sequenceB);

  // Count matching signatures
  let matches = 0;
  for (let i = 0; i < numHashes; i++) {
    if (sigA[i] === sigB[i]) {
      matches++;
    }
  }

  return matches / numHashes;
}
