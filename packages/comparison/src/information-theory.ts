/**
 * Information Theory Metrics Module
 *
 * Implements Shannon entropy, mutual information, Kullback-Leibler divergence,
 * and Jensen-Shannon divergence for genome sequence comparison.
 *
 * References:
 * - Shannon (1948) "A Mathematical Theory of Communication"
 * - Cover & Thomas (2006) "Elements of Information Theory"
 * - Zielezinski et al. (2017) "Alignment-free sequence comparison"
 */

import type { InformationTheoryMetrics } from './types';

/**
 * Compute Shannon entropy of a discrete probability distribution.
 *
 * H(X) = -Σ p(x) log₂(p(x))
 *
 * For DNA: theoretical max is 2 bits/base (4 equally likely outcomes)
 * For proteins: theoretical max is ~4.32 bits/residue (20 amino acids)
 */
export function shannonEntropy(probabilities: number[]): number {
  let entropy = 0;

  for (const p of probabilities) {
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Get nucleotide frequencies from a DNA sequence.
 * Returns array [pA, pC, pG, pT] normalized to sum to 1.
 */
export function getNucleotideFrequencies(sequence: string): number[] {
  const counts = { A: 0, C: 0, G: 0, T: 0 };
  let total = 0;

  for (const char of sequence.toUpperCase()) {
    if (char in counts) {
      counts[char as keyof typeof counts]++;
      total++;
    }
  }

  if (total === 0) return [0.25, 0.25, 0.25, 0.25];

  return [
    counts.A / total,
    counts.C / total,
    counts.G / total,
    counts.T / total,
  ];
}

/**
 * Get dinucleotide frequencies from a DNA sequence.
 * Returns 16-element array for AA, AC, AG, AT, CA, CC, ... TT
 */
export function getDinucleotideFrequencies(sequence: string): number[] {
  const dinucs = ['AA', 'AC', 'AG', 'AT', 'CA', 'CC', 'CG', 'CT',
                  'GA', 'GC', 'GG', 'GT', 'TA', 'TC', 'TG', 'TT'];
  const counts = new Map<string, number>();
  let total = 0;

  const seq = sequence.toUpperCase();
  for (let i = 0; i < seq.length - 1; i++) {
    const dinuc = seq.substring(i, i + 2);
    if (dinucs.includes(dinuc)) {
      counts.set(dinuc, (counts.get(dinuc) ?? 0) + 1);
      total++;
    }
  }

  if (total === 0) return new Array(16).fill(1 / 16);

  return dinucs.map(d => (counts.get(d) ?? 0) / total);
}

/**
 * Compute sequence entropy in bits per base.
 * Uses k-mer frequencies to capture local dependencies.
 *
 * @param sequence DNA sequence
 * @param k K-mer size (1 = single nucleotide, 2 = dinucleotide, etc.)
 */
export function sequenceEntropy(sequence: string, k: number = 1): number {
  if (k === 1) {
    return shannonEntropy(getNucleotideFrequencies(sequence));
  }

  // General k-mer entropy
  const freqs = new Map<string, number>();
  let total = 0;
  const seq = sequence.toUpperCase();

  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.substring(i, i + k);
    if (!kmer.includes('N')) {
      freqs.set(kmer, (freqs.get(kmer) ?? 0) + 1);
      total++;
    }
  }

  if (total === 0) return 0;

  // Normalize to probabilities and compute entropy
  const probs = Array.from(freqs.values()).map(c => c / total);
  return shannonEntropy(probs) / k; // Normalize per base
}

/**
 * Compute Kullback-Leibler Divergence.
 *
 * KL(P||Q) = Σ P(x) log₂(P(x) / Q(x))
 *
 * Note: KL divergence is asymmetric. KL(P||Q) ≠ KL(Q||P)
 * Returns Infinity if Q(x) = 0 where P(x) > 0.
 *
 * For stability, we use a small epsilon when Q(x) = 0.
 */
export function kullbackLeiblerDivergence(
  p: number[],
  q: number[],
  epsilon: number = 1e-10
): number {
  if (p.length !== q.length) {
    throw new Error('Probability distributions must have same length');
  }

  let kl = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0) {
      // Add epsilon to prevent log(0)
      const qi = Math.max(q[i], epsilon);
      kl += p[i] * Math.log2(p[i] / qi);
    }
  }

  return kl;
}

/**
 * Compute Jensen-Shannon Divergence.
 *
 * JSD(P||Q) = (KL(P||M) + KL(Q||M)) / 2
 * where M = (P + Q) / 2
 *
 * JSD is symmetric and always finite (0 to 1 for log₂).
 * sqrt(JSD) is a proper metric (satisfies triangle inequality).
 */
export function jensenShannonDivergence(p: number[], q: number[]): number {
  if (p.length !== q.length) {
    throw new Error('Probability distributions must have same length');
  }

  // Compute M = (P + Q) / 2
  const m = p.map((pi, i) => (pi + q[i]) / 2);

  // JSD = (KL(P||M) + KL(Q||M)) / 2
  return (kullbackLeiblerDivergence(p, m) + kullbackLeiblerDivergence(q, m)) / 2;
}

/**
 * Compute Mutual Information between two sequences.
 *
 * I(X;Y) = H(X) + H(Y) - H(X,Y)
 *
 * We estimate this using k-mer co-occurrence frequencies.
 */
export function mutualInformation(
  sequenceA: string,
  sequenceB: string,
  k: number = 3
): { mi: number; hA: number; hB: number; hJoint: number } {
  const seqA = sequenceA.toUpperCase();
  const seqB = sequenceB.toUpperCase();

  // Use the shorter length for comparison
  const len = Math.min(seqA.length, seqB.length);

  // Extract k-mer frequencies from each sequence
  const freqsA = new Map<string, number>();
  const freqsB = new Map<string, number>();
  const jointFreqs = new Map<string, number>();
  let totalA = 0, totalB = 0, totalJoint = 0;

  for (let i = 0; i <= len - k; i++) {
    const kmerA = seqA.substring(i, i + k);
    const kmerB = seqB.substring(i, i + k);

    if (!kmerA.includes('N')) {
      freqsA.set(kmerA, (freqsA.get(kmerA) ?? 0) + 1);
      totalA++;
    }
    if (!kmerB.includes('N')) {
      freqsB.set(kmerB, (freqsB.get(kmerB) ?? 0) + 1);
      totalB++;
    }
    if (!kmerA.includes('N') && !kmerB.includes('N')) {
      const joint = `${kmerA}|${kmerB}`;
      jointFreqs.set(joint, (jointFreqs.get(joint) ?? 0) + 1);
      totalJoint++;
    }
  }

  // Compute entropies
  const probsA = Array.from(freqsA.values()).map(c => c / totalA);
  const probsB = Array.from(freqsB.values()).map(c => c / totalB);
  const probsJoint = Array.from(jointFreqs.values()).map(c => c / totalJoint);

  const hA = shannonEntropy(probsA);
  const hB = shannonEntropy(probsB);
  const hJoint = shannonEntropy(probsJoint);

  // I(X;Y) = H(X) + H(Y) - H(X,Y)
  const mi = Math.max(0, hA + hB - hJoint);

  return { mi, hA, hB, hJoint };
}

/**
 * Compute Normalized Mutual Information.
 *
 * NMI = 2 * I(X;Y) / (H(X) + H(Y))
 *
 * Range: [0, 1] where 1 = perfect mutual dependence
 */
export function normalizedMutualInformation(
  sequenceA: string,
  sequenceB: string,
  k: number = 3
): number {
  const { mi, hA, hB } = mutualInformation(sequenceA, sequenceB, k);

  const denom = hA + hB;
  return denom > 0 ? (2 * mi) / denom : 0;
}

/**
 * Compute relative entropy (average of both KL directions).
 *
 * This provides a symmetric measure of "distance" between distributions.
 */
export function relativeEntropy(p: number[], q: number[]): number {
  return (kullbackLeiblerDivergence(p, q) + kullbackLeiblerDivergence(q, p)) / 2;
}

/**
 * Perform complete information theory analysis.
 */
export function analyzeInformationTheory(
  sequenceA: string,
  sequenceB: string,
  k: number = 3
): InformationTheoryMetrics {
  // Compute individual entropies
  const entropyA = sequenceEntropy(sequenceA, k);
  const entropyB = sequenceEntropy(sequenceB, k);

  // Compute mutual information
  const { mi, hJoint } = mutualInformation(sequenceA, sequenceB, k);
  const normalizedMI = (entropyA + entropyB) > 0
    ? (2 * mi) / (entropyA + entropyB)
    : 0;

  // Get k-mer frequency distributions for divergence calculations
  const freqsA = new Map<string, number>();
  const freqsB = new Map<string, number>();
  let totalA = 0, totalB = 0;

  const seqA = sequenceA.toUpperCase();
  const seqB = sequenceB.toUpperCase();

  for (let i = 0; i <= seqA.length - k; i++) {
    const kmer = seqA.substring(i, i + k);
    if (!kmer.includes('N')) {
      freqsA.set(kmer, (freqsA.get(kmer) ?? 0) + 1);
      totalA++;
    }
  }
  for (let i = 0; i <= seqB.length - k; i++) {
    const kmer = seqB.substring(i, i + k);
    if (!kmer.includes('N')) {
      freqsB.set(kmer, (freqsB.get(kmer) ?? 0) + 1);
      totalB++;
    }
  }

  // Create aligned probability arrays over union of k-mers
  const allKmers = new Set([...freqsA.keys(), ...freqsB.keys()]);
  const kmerArray = Array.from(allKmers);
  const pA = kmerArray.map(k => (freqsA.get(k) ?? 0) / totalA);
  const pB = kmerArray.map(k => (freqsB.get(k) ?? 0) / totalB);

  // Compute divergences
  const jsd = jensenShannonDivergence(pA, pB);
  const klAtoB = kullbackLeiblerDivergence(pA, pB);
  const klBtoA = kullbackLeiblerDivergence(pB, pA);

  return {
    entropyA,
    entropyB,
    jointEntropy: hJoint,
    mutualInformation: mi,
    normalizedMI: normalizedMI,
    jensenShannonDivergence: jsd,
    kullbackLeiblerAtoB: klAtoB,
    kullbackLeiblerBtoA: klBtoA,
    relativeEntropy: (klAtoB + klBtoA) / 2,
  };
}

/**
 * Compute positional entropy profile along a sequence.
 * Useful for identifying conserved vs. variable regions.
 *
 * Returns an array of entropy values for each window.
 */
export function entropyProfile(
  sequence: string,
  windowSize: number = 100,
  step: number = 50
): number[] {
  const profile: number[] = [];
  const seq = sequence.toUpperCase();

  for (let i = 0; i <= seq.length - windowSize; i += step) {
    const window = seq.substring(i, i + windowSize);
    profile.push(sequenceEntropy(window, 1));
  }

  return profile;
}

/**
 * Compute cross-entropy between two sequences.
 *
 * H(P,Q) = -Σ P(x) log₂(Q(x))
 *
 * Measures the average number of bits needed to encode
 * samples from P using a code optimized for Q.
 */
export function crossEntropy(p: number[], q: number[]): number {
  if (p.length !== q.length) {
    throw new Error('Distributions must have same length');
  }

  let ce = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0 && q[i] > 0) {
      ce -= p[i] * Math.log2(q[i]);
    } else if (p[i] > 0 && q[i] <= 0) {
      // Undefined: log(0) for non-zero probability
      return Infinity;
    }
  }

  return ce;
}

/**
 * Compute compression-based similarity using the Normalized Compression Distance (NCD).
 *
 * NCD(x,y) = (C(xy) - min(C(x), C(y))) / max(C(x), C(y))
 *
 * We approximate compression using entropy-based estimation.
 * Range: [0, 1+epsilon] where 0 = identical
 */
export function normalizedCompressionDistance(
  sequenceA: string,
  sequenceB: string,
  k: number = 3
): number {
  // Estimate "compressed size" using k-mer entropy
  const hA = sequenceEntropy(sequenceA, k) * sequenceA.length;
  const hB = sequenceEntropy(sequenceB, k) * sequenceB.length;

  // Concatenate and compute joint "compressed size"
  const combined = sequenceA + sequenceB;
  const hAB = sequenceEntropy(combined, k) * combined.length;

  const minH = Math.min(hA, hB);
  const maxH = Math.max(hA, hB);

  return maxH > 0 ? (hAB - minH) / maxH : 0;
}
