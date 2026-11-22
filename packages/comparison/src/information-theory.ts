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

const KL_PROBABILITY_FLOOR = 1e-10;

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
}

// Inspect submitted positions without deleting ambiguity, gaps or whitespace.
// ASCII case folding also avoids changing coordinates for non-DNA Unicode text.
function isResolvedBase(sequence: string, position: number): boolean {
  const code = sequence.charCodeAt(position) | 32;
  return code === 97 || code === 99 || code === 103 || code === 116;
}

function resolvedKmerCounts(sequence: string, k: number): { counts: Map<string, number>; total: number } {
  positiveInteger(k, 'K-mer size');
  const counts = new Map<string, number>();
  let run = 0, total = 0;
  for (let position = 0; position < sequence.length; position++) {
    run = isResolvedBase(sequence, position) ? run + 1 : 0;
    if (run < k) continue;
    const word = sequence.slice(position - k + 1, position + 1).toUpperCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
    total++;
  }
  return { counts, total };
}

function countEntropy(counts: Map<string, number>, total: number): number {
  return shannonEntropy(Array.from(counts.values(), count => count / total));
}

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
 * Returns [pA, pC, pG, pT], or all zeros when no resolved bases exist.
 * The zero vector denotes no observations, not a probability distribution.
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

  if (total === 0) return [0, 0, 0, 0];

  return [
    counts.A / total,
    counts.C / total,
    counts.G / total,
    counts.T / total,
  ];
}

/**
 * Get dinucleotide frequencies from a DNA sequence.
 * Returns 16-element array for AA, AC, AG, AT, CA, CC, ... TT.
 * All zeros denotes no resolved windows, not a uniform distribution.
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

  if (total === 0) return new Array(16).fill(0);

  return dinucs.map(d => (counts.get(d) ?? 0) / total);
}

/**
 * Compute sequence entropy in bits per base.
 * Uses resolved A/C/G/T k-mer frequencies to capture local dependencies.
 * Returns 0 by convention without observations; use analyzeInformationTheory
 * for coverage and explicit unavailable values in user-facing results.
 *
 * @param sequence DNA sequence
 * @param k K-mer size (1 = single nucleotide, 2 = dinucleotide, etc.)
 */
export function sequenceEntropy(sequence: string, k: number = 1): number {
  const { counts, total } = resolvedKmerCounts(sequence, k);
  return total ? countEntropy(counts, total) / k : 0;
}

/**
 * Compute Kullback-Leibler Divergence.
 *
 * KL(P||Q) = Σ P(x) log₂(P(x) / Q(x))
 *
 * Note: KL divergence is asymmetric. KL(P||Q) ≠ KL(Q||P)
 * Exact KL is infinite if Q(x) = 0 where P(x) > 0. This implementation
 * deliberately floors denominator probabilities at epsilon, giving a finite
 * approximation when the floor applies; the analysis result declares it.
 */
export function kullbackLeiblerDivergence(
  p: number[],
  q: number[],
  epsilon: number = KL_PROBABILITY_FLOOR
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
 * Empirical k-mer co-occurrence at the same submitted start position in the
 * common prefix. All three distributions use only jointly resolved windows;
 * positions valid on just one side cannot contribute to either marginal.
 * This is position pairing, not an inferred homologous alignment or identity.
 * Entropies here are bits/k-mer; zero without pairs is only a numeric sentinel.
 */
export function mutualInformation(
  sequenceA: string,
  sequenceB: string,
  k: number = 3
): { mi: number; hA: number; hB: number; hJoint: number; pairedWindows: number } {
  positiveInteger(k, 'K-mer size');
  const len = Math.min(sequenceA.length, sequenceB.length);

  // Extract k-mer frequencies from each sequence
  const freqsA = new Map<string, number>();
  const freqsB = new Map<string, number>();
  const jointFreqs = new Map<string, number>();
  let pairedWindows = 0, run = 0;

  for (let i = 0; i < len; i++) {
    run = isResolvedBase(sequenceA, i) && isResolvedBase(sequenceB, i) ? run + 1 : 0;
    if (run < k) continue;
    const kmerA = sequenceA.slice(i - k + 1, i + 1).toUpperCase();
    const kmerB = sequenceB.slice(i - k + 1, i + 1).toUpperCase();
    freqsA.set(kmerA, (freqsA.get(kmerA) ?? 0) + 1);
    freqsB.set(kmerB, (freqsB.get(kmerB) ?? 0) + 1);
    const joint = `${kmerA}|${kmerB}`;
    jointFreqs.set(joint, (jointFreqs.get(joint) ?? 0) + 1);
    pairedWindows++;
  }

  if (!pairedWindows) return { mi: 0, hA: 0, hB: 0, hJoint: 0, pairedWindows: 0 };
  const hA = countEntropy(freqsA, pairedWindows);
  const hB = countEntropy(freqsB, pairedWindows);
  const hJoint = countEntropy(jointFreqs, pairedWindows);

  // I(X;Y) = H(X) + H(Y) - H(X,Y)
  const mi = Math.max(0, hA + hB - hJoint);

  return { mi, hA, hB, hJoint, pairedWindows };
}

function normalizedMIFor(paired: ReturnType<typeof mutualInformation>): number | null {
  const denominator = paired.hA + paired.hB;
  // Both constant inputs have observed zero MI but an undefined 0/0 normalizer.
  if (!paired.pairedWindows || denominator === 0) return null;
  // All entropies came from the same joint table; clamp only floating-point
  // roundoff at the mathematical [0, 1] bound, never incompatible marginals.
  return Math.min(1, (2 * paired.mi) / denominator);
}

/**
 * Compute Normalized Mutual Information.
 *
 * NMI = 2 * I(X;Y) / (H(X) + H(Y))
 *
 * Range: [0, 1] where 1 = perfect empirical dependence, not sequence identity.
 * Null means no jointly resolved windows or zero entropy in both marginals.
 */
export function normalizedMutualInformation(
  sequenceA: string,
  sequenceB: string,
  k: number = 3
): number | null {
  return normalizedMIFor(mutualInformation(sequenceA, sequenceB, k));
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
  const a = resolvedKmerCounts(sequenceA, k), b = resolvedKmerCounts(sequenceB, k);
  const paired = mutualInformation(sequenceA, sequenceB, k);
  const normalizedMI = normalizedMIFor(paired);
  const normalizedMIUnavailableReason = !paired.pairedWindows
    ? 'No jointly resolved k-mer windows at the same input positions.'
    : normalizedMI === null ? 'Both paired distributions are constant; normalized MI is undefined (0/0), while observed MI is zero.' : null;
  const summary = {
    k,
    coverage: {
      totalWindowsA: Math.max(0, sequenceA.length - k + 1),
      totalWindowsB: Math.max(0, sequenceB.length - k + 1),
      resolvedWindowsA: a.total,
      resolvedWindowsB: b.total,
      pairedWindowSlots: Math.max(0, Math.min(sequenceA.length, sequenceB.length) - k + 1),
      resolvedWindowPairs: paired.pairedWindows,
    },
    // Full-input distributions and position-paired distributions are distinct
    // samples when lengths or masks differ. Expose both, with coherent units.
    entropyA: a.total ? countEntropy(a.counts, a.total) / k : null,
    entropyB: b.total ? countEntropy(b.counts, b.total) / k : null,
    pairedEntropyA: paired.pairedWindows ? paired.hA / k : null,
    pairedEntropyB: paired.pairedWindows ? paired.hB / k : null,
    jointEntropy: paired.pairedWindows ? paired.hJoint / k : null,
    mutualInformation: paired.pairedWindows ? paired.mi / k : null,
    normalizedMI,
    normalizedMIUnavailableReason,
    klProbabilityFloor: KL_PROBABILITY_FLOOR,
  };

  // Create aligned probability arrays over union of k-mers
  const allKmers = new Set([...a.counts.keys(), ...b.counts.keys()]);
  const kmerArray = Array.from(allKmers);

  // Missing data is not evidence that two distributions have zero divergence.
  if (a.total === 0 || b.total === 0) {
    return {
      ...summary,
      jensenShannonDivergence: null,
      kullbackLeiblerAtoB: null,
      kullbackLeiblerBtoA: null,
      relativeEntropy: null,
    };
  }

  const pA = kmerArray.map(kmer => (a.counts.get(kmer) ?? 0) / a.total);
  const pB = kmerArray.map(kmer => (b.counts.get(kmer) ?? 0) / b.total);

  // Compute divergences
  const jsd = jensenShannonDivergence(pA, pB);
  const klAtoB = kullbackLeiblerDivergence(pA, pB);
  const klBtoA = kullbackLeiblerDivergence(pB, pA);

  return {
    ...summary,
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
  positiveInteger(windowSize, 'Window size');
  positiveInteger(step, 'Step size');
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
