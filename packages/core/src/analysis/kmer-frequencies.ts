/**
 * K-mer Frequency Analysis
 *
 * Computes tetranucleotide (4-mer) frequency vectors for alignment-free
 * genomic signature comparison and phylogenetic profiling.
 */

import { reverseComplement } from '../codons';

export interface KmerVector {
  phageId: number;
  name: string;
  frequencies: Float32Array; // 256 elements for tetranucleotides
  gcContent: number;
  genomeLength: number;
}

export interface KmerFrequencyOptions {
  k?: number; // Default: 4 (tetranucleotides)
  normalize?: boolean; // Default: true (frequencies sum to 1)
  includeReverseComplement?: boolean; // Default: true
}

const NUCLEOTIDES = ['A', 'C', 'G', 'T'] as const;

// Optimized char code map
const CHAR_MAP = new Int8Array(256).fill(-1);
CHAR_MAP['A'.charCodeAt(0)] = 0; CHAR_MAP['a'.charCodeAt(0)] = 0;
CHAR_MAP['C'.charCodeAt(0)] = 1; CHAR_MAP['c'.charCodeAt(0)] = 1;
CHAR_MAP['G'.charCodeAt(0)] = 2; CHAR_MAP['g'.charCodeAt(0)] = 2;
CHAR_MAP['T'.charCodeAt(0)] = 3; CHAR_MAP['t'.charCodeAt(0)] = 3;

/**
 * Generate all k-mers of length k
 */
export function generateKmers(k: number): string[] {
  if (k <= 0) return [];
  if (k === 1) return [...NUCLEOTIDES];

  const result: string[] = [];
  const subKmers = generateKmers(k - 1);
  for (const nuc of NUCLEOTIDES) {
    for (const sub of subKmers) {
      result.push(nuc + sub);
    }
  }
  return result;
}

/**
 * Get the index of a k-mer in the frequency array (base-4 encoding)
 */
export function kmerToIndex(kmer: string): number {
  let index = 0;
  for (let i = 0; i < kmer.length; i++) {
    const code = CHAR_MAP[kmer.charCodeAt(i)];
    if (code === -1) return -1;
    index = (index << 2) | code;
  }
  return index;
}

/**
 * Get the k-mer string from its index
 */
export function indexToKmer(index: number, k: number): string {
  let result = '';
  let remaining = index;
  for (let i = 0; i < k; i++) {
    result = NUCLEOTIDES[remaining & 3] + result; // & 3 is equivalent to % 4
    remaining >>= 2; // equivalent to floor(remaining / 4)
  }
  return result;
}

/**
 * Compute k-mer frequency vector for a sequence
 * Optimized with bitwise rolling hash
 */
export function computeKmerFrequencies(
  sequence: string,
  options: KmerFrequencyOptions = {}
): Float32Array {
  const { k = 4, normalize = true, includeReverseComplement = true } = options;
  
  // Limit k to 12 to prevent excessive memory usage.
  // 4^12 * 4 bytes = 64MB. 4^13 would be 256MB, 4^15 would be 4GB.
  if (k > 12) throw new Error('k > 12 not supported by dense vector implementation (use sparse map for k > 12)');

  const vectorSize = 1 << (2 * k); // 4^k
  const counts = new Float32Array(vectorSize);
  const mask = vectorSize - 1; // All 1s for 2*k bits

  // Helper to count k-mers in a string
  const countInSeq = (seq: string) => {
    let hash = 0;
    let len = 0;
    
    for (let i = 0; i < seq.length; i++) {
      const code = CHAR_MAP[seq.charCodeAt(i)];
      
      if (code !== -1) {
        hash = ((hash << 2) & mask) | code;
        len++;
        if (len >= k) {
          counts[hash]++;
        }
      } else {
        // Reset on invalid char (N, etc.)
        hash = 0;
        len = 0;
      }
    }
  };

  countInSeq(sequence);

  if (includeReverseComplement) {
    countInSeq(reverseComplement(sequence));
  }

  // Normalize to frequencies
  if (normalize) {
    let total = 0;
    for (let i = 0; i < vectorSize; i++) {
      total += counts[i];
    }
    if (total > 0) {
      for (let i = 0; i < vectorSize; i++) {
        counts[i] /= total;
      }
    }
  }

  return counts;
}

/**
 * Compute GC content from sequence
 */
export function computeGcContent(sequence: string): number {
  let gc = 0;
  let total = 0;
  const seq = sequence.toUpperCase();

  for (let i = 0; i < seq.length; i++) {
    const c = seq[i];
    if (c === 'G' || c === 'C') {
      gc++;
      total++;
    } else if (c === 'A' || c === 'T') {
      total++;
    }
  }

  return total > 0 ? gc / total : 0;
}

/**
 * Compute Euclidean distance between two frequency vectors
 */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Compute Manhattan distance between two frequency vectors
 */
export function manhattanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum;
}

/**
 * Compute cosine similarity between two frequency vectors
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dotProduct / denominator : 0;
}

/**
 * Batch compute k-mer vectors for multiple sequences
 */
export function computeKmerVectorsBatch(
  phages: Array<{ id: number; name: string; sequence: string }>,
  options: KmerFrequencyOptions = {}
): KmerVector[] {
  return phages.map(phage => ({
    phageId: phage.id,
    name: phage.name,
    frequencies: computeKmerFrequencies(phage.sequence, options),
    gcContent: computeGcContent(phage.sequence),
    genomeLength: phage.sequence.length,
  }));
}

/**
 * Compute distance matrix between all pairs of k-mer vectors
 */
export function computeDistanceMatrix(
  vectors: KmerVector[],
  distanceFn: (a: Float32Array, b: Float32Array) => number = euclideanDistance
): Float32Array {
  const n = vectors.length;
  const matrix = new Float32Array(n * n);

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        matrix[i * n + j] = 0;
      } else {
        const dist = distanceFn(vectors[i].frequencies, vectors[j].frequencies);
        matrix[i * n + j] = dist;
        matrix[j * n + i] = dist; // Symmetric
      }
    }
  }

  return matrix;
}

/**
 * Get the most distinctive k-mers for a vector (highest deviation from mean)
 */
export function getDistinctiveKmers(
  vector: Float32Array,
  meanVector: Float32Array,
  k: number = 4,
  topN: number = 10
): Array<{ kmer: string; frequency: number; deviation: number }> {
  const deviations: Array<{ index: number; deviation: number }> = [];

  for (let i = 0; i < vector.length; i++) {
    deviations.push({
      index: i,
      deviation: vector[i] - meanVector[i],
    });
  }

  // Sort by absolute deviation (most distinctive first)
  deviations.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

  return deviations.slice(0, topN).map(d => ({
    kmer: indexToKmer(d.index, k),
    frequency: vector[d.index],
    deviation: d.deviation,
  }));
}

/**
 * Compute mean frequency vector across all samples
 */
export function computeMeanVector(vectors: KmerVector[]): Float32Array {
  if (vectors.length === 0) {
    return new Float32Array(256);
  }

  const n = vectors.length;
  const dim = vectors[0].frequencies.length;
  const mean = new Float32Array(dim);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      mean[i] += vec.frequencies[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    mean[i] /= n;
  }

  return mean;
}
