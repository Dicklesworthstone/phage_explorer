/**
 * Tests for information theory metrics
 *
 * Tests Shannon entropy, nucleotide frequencies, and related metrics.
 */

import { describe, expect, it } from 'bun:test';
import {
  shannonEntropy,
  getNucleotideFrequencies,
  getDinucleotideFrequencies,
  sequenceEntropy,
  kullbackLeiblerDivergence,
  jensenShannonDivergence,
  mutualInformation,
  normalizedMutualInformation,
  relativeEntropy,
  analyzeInformationTheory,
  entropyProfile,
  crossEntropy,
  normalizedCompressionDistance,
} from './information-theory';

describe('shannonEntropy', () => {
  it('returns 0 for certain outcome (single probability = 1)', () => {
    expect(shannonEntropy([1])).toBe(0);
    expect(shannonEntropy([1, 0, 0, 0])).toBe(0);
  });

  it('returns maximum entropy for uniform distribution', () => {
    // For 4 equally likely outcomes, H = log2(4) = 2 bits
    const uniform = [0.25, 0.25, 0.25, 0.25];
    expect(shannonEntropy(uniform)).toBeCloseTo(2, 5);
  });

  it('returns 1 bit for fair coin', () => {
    const fair = [0.5, 0.5];
    expect(shannonEntropy(fair)).toBeCloseTo(1, 5);
  });

  it('returns entropy between 0 and max for biased distribution', () => {
    const biased = [0.7, 0.1, 0.1, 0.1];
    const entropy = shannonEntropy(biased);
    expect(entropy).toBeGreaterThan(0);
    expect(entropy).toBeLessThan(2); // Less than max for 4 outcomes
  });

  it('handles zero probabilities correctly', () => {
    const withZeros = [0.5, 0, 0.5, 0];
    expect(shannonEntropy(withZeros)).toBeCloseTo(1, 5);
  });

  it('returns 0 for empty array', () => {
    expect(shannonEntropy([])).toBe(0);
  });
});

describe('getNucleotideFrequencies', () => {
  it('returns equal frequencies for balanced sequence', () => {
    const freqs = getNucleotideFrequencies('ACGT');
    expect(freqs).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('handles case-insensitive input', () => {
    const upper = getNucleotideFrequencies('ACGT');
    const lower = getNucleotideFrequencies('acgt');
    expect(upper).toEqual(lower);
  });

  it('returns correct frequencies for biased sequence', () => {
    const freqs = getNucleotideFrequencies('AAAA'); // 100% A
    expect(freqs[0]).toBe(1); // A
    expect(freqs[1]).toBe(0); // C
    expect(freqs[2]).toBe(0); // G
    expect(freqs[3]).toBe(0); // T
  });

  it('ignores N and other ambiguous characters', () => {
    const freqs = getNucleotideFrequencies('ACNGT');
    // Only ACGT counted, so 4 bases
    expect(freqs[0]).toBeCloseTo(0.25); // A
    expect(freqs[1]).toBeCloseTo(0.25); // C
    expect(freqs[2]).toBeCloseTo(0.25); // G
    expect(freqs[3]).toBeCloseTo(0.25); // T
  });

  it('returns no observed frequencies for empty or unresolved sequence', () => {
    const freqs = getNucleotideFrequencies('');
    expect(freqs).toEqual([0, 0, 0, 0]);
    expect(getNucleotideFrequencies('NRY')).toEqual([0, 0, 0, 0]);
  });

  it('frequencies sum to 1', () => {
    const freqs = getNucleotideFrequencies('AACCCGGGGT');
    const sum = freqs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe('getDinucleotideFrequencies', () => {
  it('returns 16-element array', () => {
    const freqs = getDinucleotideFrequencies('ACGT');
    expect(freqs.length).toBe(16);
  });

  it('frequencies sum to 1 for valid sequence', () => {
    const freqs = getDinucleotideFrequencies('ACGTACGTACGT');
    const sum = freqs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('handles short sequences', () => {
    const freqs = getDinucleotideFrequencies('AC'); // Only one dinucleotide
    const sum = freqs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('does not invent dinucleotide observations for empty sequence', () => {
    const freqs = getDinucleotideFrequencies('');
    expect(freqs.length).toBe(16);
    expect(freqs.every(frequency => frequency === 0)).toBe(true);
  });
});

describe('sequenceEntropy', () => {
  it('returns ~2 bits for random-like sequence', () => {
    // ACGT repeated should be close to max entropy (2 bits)
    const entropy = sequenceEntropy('ACGTACGTACGTACGT', 1);
    expect(entropy).toBeCloseTo(2, 1);
  });

  it('returns 0 for homopolymer', () => {
    const entropy = sequenceEntropy('AAAAAAAAAA', 1);
    expect(entropy).toBe(0);
  });

  it('returns lower entropy for biased sequence', () => {
    const random = sequenceEntropy('ACGTACGTACGT', 1);
    const biased = sequenceEntropy('AAAAACGTAAAA', 1);
    expect(biased).toBeLessThan(random);
  });

  it('handles k > 1 for dinucleotide entropy', () => {
    const entropy = sequenceEntropy('ACGTACGTACGT', 2);
    expect(entropy).toBeGreaterThan(0);
    expect(entropy).toBeLessThanOrEqual(2);
  });

  it('returns 0 for empty sequence', () => {
    const entropy = sequenceEntropy('', 1);
    // Numeric convenience convention only; the analysis result exposes null.
    expect(entropy).toBe(0);
  });
});

describe('kullbackLeiblerDivergence', () => {
  it('returns 0 for identical distributions', () => {
    const p = [0.25, 0.25, 0.25, 0.25];
    expect(kullbackLeiblerDivergence(p, p)).toBeCloseTo(0, 5);
  });

  it('is asymmetric (KL(P||Q) != KL(Q||P))', () => {
    const p = [0.9, 0.1];
    const q = [0.5, 0.5];
    const klPQ = kullbackLeiblerDivergence(p, q);
    const klQP = kullbackLeiblerDivergence(q, p);
    expect(klPQ).not.toBeCloseTo(klQP, 3);
  });

  it('returns positive value for different distributions', () => {
    const p = [0.9, 0.1];
    const q = [0.5, 0.5];
    expect(kullbackLeiblerDivergence(p, q)).toBeGreaterThan(0);
  });

  it('handles distributions with zeros', () => {
    const p = [0.5, 0.5, 0, 0];
    const q = [0.25, 0.25, 0.25, 0.25];
    // Should not throw
    expect(() => kullbackLeiblerDivergence(p, q)).not.toThrow();
  });
});

describe('jensenShannonDivergence', () => {
  it('returns 0 for identical distributions', () => {
    const p = [0.25, 0.25, 0.25, 0.25];
    expect(jensenShannonDivergence(p, p)).toBeCloseTo(0, 5);
  });

  it('is symmetric (JSD(P,Q) == JSD(Q,P))', () => {
    const p = [0.9, 0.1];
    const q = [0.5, 0.5];
    const jsdPQ = jensenShannonDivergence(p, q);
    const jsdQP = jensenShannonDivergence(q, p);
    expect(jsdPQ).toBeCloseTo(jsdQP, 5);
  });

  it('returns value between 0 and 1 for DNA distributions', () => {
    const p = [0.4, 0.1, 0.4, 0.1];
    const q = [0.25, 0.25, 0.25, 0.25];
    const jsd = jensenShannonDivergence(p, q);
    expect(jsd).toBeGreaterThanOrEqual(0);
    expect(jsd).toBeLessThanOrEqual(1);
  });

  it('returns 1 for maximally different distributions', () => {
    const p = [1, 0];
    const q = [0, 1];
    // JSD is bounded by ln(2) for binary distributions, normalized to [0,1]
    const jsd = jensenShannonDivergence(p, q);
    expect(jsd).toBeCloseTo(1, 1);
  });
});

describe('kullbackLeiblerDivergence - edge cases', () => {
  it('throws error for mismatched lengths', () => {
    const p = [0.5, 0.5];
    const q = [0.25, 0.25, 0.25, 0.25];
    expect(() => kullbackLeiblerDivergence(p, q)).toThrow('Probability distributions must have same length');
  });
});

describe('jensenShannonDivergence - edge cases', () => {
  it('throws error for mismatched lengths', () => {
    const p = [0.5, 0.5];
    const q = [0.25, 0.25, 0.25, 0.25];
    expect(() => jensenShannonDivergence(p, q)).toThrow('Probability distributions must have same length');
  });
});

describe('mutualInformation', () => {
  it('returns positive MI for related sequences', () => {
    const seqA = 'ACGTACGTACGTACGT';
    const seqB = 'ACGTACGTACGTACGT';
    const result = mutualInformation(seqA, seqB, 2);

    expect(result.mi).toBeGreaterThanOrEqual(0);
    expect(result.hA).toBeGreaterThanOrEqual(0);
    expect(result.hB).toBeGreaterThanOrEqual(0);
    expect(result.hJoint).toBeGreaterThanOrEqual(0);
  });

  it('returns object with all required properties', () => {
    const result = mutualInformation('ACGT', 'ACGT', 2);

    expect(result).toHaveProperty('mi');
    expect(result).toHaveProperty('hA');
    expect(result).toHaveProperty('hB');
    expect(result).toHaveProperty('hJoint');
  });

  it('handles sequences of different lengths', () => {
    const seqA = 'ACGTACGT';
    const seqB = 'ACGTACGTACGTACGT';
    const result = mutualInformation(seqA, seqB, 2);

    // Should use the shorter length
    expect(result.mi).toBeGreaterThanOrEqual(0);
  });

  it('handles sequences with N characters', () => {
    const seqA = 'ACNGTACGT';
    const seqB = 'ACGTACNGT';
    const result = mutualInformation(seqA, seqB, 2);

    expect(result.mi).toBeGreaterThanOrEqual(0);
  });
});

describe('normalizedMutualInformation', () => {
  it('returns value between 0 and 1', () => {
    const seqA = 'ACGTACGTACGTACGT';
    const seqB = 'ACGTACGTACGTACGT';
    const nmi = normalizedMutualInformation(seqA, seqB, 2);

    expect(nmi).toBeGreaterThanOrEqual(0);
    expect(nmi).toBeLessThanOrEqual(1);
  });

  it('detects deterministic recoding, not just nucleotide identity', () => {
    const seqA = 'ACGTACGTACGTACGT';
    const seqB = 'ACGTACGTACGTACGT';
    const seqC = 'TGCATGCATGCATGCA';

    const nmiSame = normalizedMutualInformation(seqA, seqB, 2);
    const nmiDiff = normalizedMutualInformation(seqA, seqC, 2);

    expect(nmiSame).toBeCloseTo(1, 12);
    expect(nmiDiff).toBeCloseTo(1, 12);
  });

  it('reports an undefined normalizer when both observed entropies are zero', () => {
    // Homopolymer sequences have 0 entropy
    const seqA = 'AAAAAAAAAA';
    const seqB = 'AAAAAAAAAA';
    const nmi = normalizedMutualInformation(seqA, seqB, 1);

    expect(nmi).toBeNull();
  });
});

describe('relativeEntropy', () => {
  it('returns 0 for identical distributions', () => {
    const p = [0.25, 0.25, 0.25, 0.25];
    expect(relativeEntropy(p, p)).toBeCloseTo(0, 5);
  });

  it('is symmetric', () => {
    const p = [0.7, 0.3];
    const q = [0.3, 0.7];
    expect(relativeEntropy(p, q)).toBeCloseTo(relativeEntropy(q, p), 5);
  });

  it('returns positive value for different distributions', () => {
    const p = [0.9, 0.1];
    const q = [0.5, 0.5];
    expect(relativeEntropy(p, q)).toBeGreaterThan(0);
  });
});

describe('analyzeInformationTheory', () => {
  it('returns complete metrics structure', () => {
    const seqA = 'ACGTACGTACGTACGT';
    const seqB = 'ACGTACGTACGTACGT';
    const result = analyzeInformationTheory(seqA, seqB, 2);

    expect(result).toHaveProperty('entropyA');
    expect(result).toHaveProperty('entropyB');
    expect(result).toHaveProperty('jointEntropy');
    expect(result).toHaveProperty('mutualInformation');
    expect(result).toHaveProperty('normalizedMI');
    expect(result).toHaveProperty('jensenShannonDivergence');
    expect(result).toHaveProperty('kullbackLeiblerAtoB');
    expect(result).toHaveProperty('kullbackLeiblerBtoA');
    expect(result).toHaveProperty('relativeEntropy');
  });

  it('withholds divergence when one input has no observations', () => {
    const result = analyzeInformationTheory('', 'ACGT', 2);

    expect(result.entropyA).toBeNull();
    expect(result.entropyB).toBeCloseTo(Math.log2(3) / 2, 12);
    expect(result.jensenShannonDivergence).toBeNull();
    expect(result.kullbackLeiblerAtoB).toBeNull();
    expect(result.kullbackLeiblerBtoA).toBeNull();
  });

  it('computes higher JSD for different sequences', () => {
    const similar = analyzeInformationTheory('ACGTACGTACGT', 'ACGTACGTACGT', 2);
    const different = analyzeInformationTheory('AAAAAAAAAAA', 'TTTTTTTTTTT', 2);

    expect(similar.jensenShannonDivergence).toBe(0);
    expect(different.jensenShannonDivergence).toBe(1);
  });
});

describe('information theory observation and unit oracles', () => {
  it('reports 100% NMI and coherent per-base units for identical 5-mer observations', () => {
    // ACGTA, CGTAC, GTACG and TACGT each occur once: every entropy is
    // log2(4) = 2 bits/window, or 2/5 bits/base; I(X;X) = H(X).
    const result = analyzeInformationTheory('ACGTACGT', 'acgtacgt', 5);
    expect(result.entropyA).toBeCloseTo(0.4, 12);
    expect(result.entropyB).toBeCloseTo(0.4, 12);
    expect(result.pairedEntropyA).toBeCloseTo(0.4, 12);
    expect(result.pairedEntropyB).toBeCloseTo(0.4, 12);
    expect(result.jointEntropy).toBeCloseTo(0.4, 12);
    expect(result.mutualInformation).toBeCloseTo(0.4, 12);
    expect(result.normalizedMI).toBeCloseTo(1, 12);
    expect(result.normalizedMIUnavailableReason).toBeNull();
    expect(result.coverage).toEqual({ totalWindowsA: 4, totalWindowsB: 4,
      resolvedWindowsA: 4, resolvedWindowsB: 4, pairedWindowSlots: 4, resolvedWindowPairs: 4 });
  });

  it('finds zero MI from a balanced independent two-by-two joint table', () => {
    // (A,A), (A,C), (C,A), (C,C) have probability 1/4 each.
    const result = analyzeInformationTheory('AACC', 'ACAC', 1);
    expect(result.pairedEntropyA).toBe(1);
    expect(result.pairedEntropyB).toBe(1);
    expect(result.jointEntropy).toBe(2);
    expect(result.mutualInformation).toBe(0);
    expect(result.normalizedMI).toBe(0);
  });

  it('derives both MI marginals from the jointly observed windows only', () => {
    // Joint positions 0 and 3 are (A,A), (C,G), each with probability 1/2.
    // Unpaired C observations must not enter either paired marginal.
    const result = analyzeInformationTheory('ANCC', 'ACNG', 1);
    expect(result.coverage).toEqual({ totalWindowsA: 4, totalWindowsB: 4,
      resolvedWindowsA: 3, resolvedWindowsB: 3, pairedWindowSlots: 4, resolvedWindowPairs: 2 });
    expect(result.pairedEntropyA).toBe(1);
    expect(result.pairedEntropyB).toBe(1);
    expect(result.jointEntropy).toBe(1);
    expect(result.mutualInformation).toBe(1);
    expect(result.normalizedMI).toBe(1);
    expect(result.entropyA).toBeCloseTo(0.9182958340544896, 12);
    expect(result.entropyB).toBeCloseTo(Math.log2(3), 12);
  });

  it('retains full-input divergence but withholds MI when resolved masks do not intersect', () => {
    for (const [a, b] of [['AN', 'NA'], ['ACNNNNNN', 'NNACGTAC']]) {
      const result = analyzeInformationTheory(a, b, 1);
      expect(result.coverage.resolvedWindowPairs).toBe(0);
      expect(result.pairedEntropyA).toBeNull();
      expect(result.pairedEntropyB).toBeNull();
      expect(result.jointEntropy).toBeNull();
      expect(result.mutualInformation).toBeNull();
      expect(result.normalizedMI).toBeNull();
      expect(normalizedMutualInformation(a, b, 1)).toBeNull();
      expect(result.jensenShannonDivergence).not.toBeNull();
      expect(result.normalizedMIUnavailableReason).toContain('No jointly resolved');
    }
    expect(analyzeInformationTheory('AN', 'NA', 1).jensenShannonDivergence).toBe(0);
  });

  it('excludes every unresolved symbol without joining bases across it or changing positions', () => {
    for (const symbol of ['N', 'R', 'Y', 'S', 'W', 'K', 'M', 'B', 'D', 'H', 'V', 'U', '-', '?', '.', ' ', '\n', 'ß']) {
      // Only AC and CA survive, each once. Symbols remain a gap in sampling.
      const input = `AC${symbol}CA`;
      const result = analyzeInformationTheory(input, input, 2);
      expect(result.coverage.resolvedWindowsA).toBe(2);
      expect(result.coverage.resolvedWindowPairs).toBe(2);
      expect(result.coverage.totalWindowsA).toBe(4);
      expect(result.entropyA).toBe(0.5);
      expect(result.mutualInformation).toBe(0.5);
      expect(result.normalizedMI).toBe(1);
    }
    const missing = analyzeInformationTheory('NRYU-.?', 'NRYU-.?', 1);
    expect(missing.entropyA).toBeNull();
    expect(missing.mutualInformation).toBeNull();
    expect(missing.normalizedMI).toBeNull();
    expect(missing.jensenShannonDivergence).toBeNull();
  });

  it('separates common-prefix pairing from full-input distributions for unequal lengths', () => {
    const result = analyzeInformationTheory('AC', 'ACGT', 1);
    expect(result.entropyA).toBe(1);
    expect(result.entropyB).toBe(2);
    expect(result.pairedEntropyA).toBe(1);
    expect(result.pairedEntropyB).toBe(1);
    expect(result.jointEntropy).toBe(1);
    expect(result.mutualInformation).toBe(1);
    expect(result.normalizedMI).toBe(1);
    // P=(1/2,1/2,0,0), Q=(1/4,1/4,1/4,1/4).
    expect(result.jensenShannonDivergence).toBeCloseTo(0.31127812445913283, 12);
    expect(result.coverage.resolvedWindowsB).toBe(4);
    expect(result.coverage.pairedWindowSlots).toBe(2);
  });

  it('distinguishes observed constant distributions from absent data', () => {
    const result = analyzeInformationTheory('AAAA', 'TTTT', 1);
    expect(result.entropyA).toBe(0);
    expect(result.entropyB).toBe(0);
    expect(result.jointEntropy).toBe(0);
    expect(result.mutualInformation).toBe(0);
    expect(result.normalizedMI).toBeNull();
    expect(result.normalizedMIUnavailableReason).toContain('constant');
    expect(result.coverage.resolvedWindowPairs).toBe(4);
    expect(result.jensenShannonDivergence).toBe(1);
    expect(result.klProbabilityFloor).toBe(1e-10);
  });

  it('rejects invalid k-mer sizes before sampling and validates profile progress', () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => analyzeInformationTheory('ACGT', 'ACGT', invalid)).toThrow(RangeError);
      expect(() => mutualInformation('ACGT', 'ACGT', invalid)).toThrow(RangeError);
      expect(() => sequenceEntropy('ACGT', invalid)).toThrow(RangeError);
      expect(() => entropyProfile('ACGT', 2, invalid)).toThrow(RangeError);
    }
  });
});

describe('entropyProfile', () => {
  it('returns array of entropy values', () => {
    const seq = 'ACGTACGTACGT'.repeat(10);
    const profile = entropyProfile(seq, 20, 10);

    expect(Array.isArray(profile)).toBe(true);
    expect(profile.length).toBeGreaterThan(0);
  });

  it('each value is a valid entropy', () => {
    const seq = 'ACGTACGTACGT'.repeat(10);
    const profile = entropyProfile(seq, 20, 10);

    for (const entropy of profile) {
      expect(entropy).toBeGreaterThanOrEqual(0);
      expect(entropy).toBeLessThanOrEqual(2); // Max for nucleotides
    }
  });

  it('returns fewer values with larger step', () => {
    const seq = 'ACGTACGTACGT'.repeat(20);
    const smallStep = entropyProfile(seq, 20, 10);
    const largeStep = entropyProfile(seq, 20, 50);

    expect(largeStep.length).toBeLessThan(smallStep.length);
  });

  it('returns empty array for sequence shorter than window', () => {
    const profile = entropyProfile('ACGT', 100, 50);
    expect(profile).toEqual([]);
  });

  it('detects low entropy in homopolymer regions', () => {
    // Sequence with a homopolymer region in the middle
    const varied = 'ACGT'.repeat(10);
    const homopolymer = 'A'.repeat(40);
    const seq = varied + homopolymer + varied;

    const profile = entropyProfile(seq, 20, 10);

    // Find the minimum entropy (should be in homopolymer region)
    const minEntropy = Math.min(...profile);
    expect(minEntropy).toBeLessThan(1);
  });
});

describe('crossEntropy', () => {
  it('throws error for mismatched lengths', () => {
    const p = [0.5, 0.5];
    const q = [0.25, 0.25, 0.25, 0.25];
    expect(() => crossEntropy(p, q)).toThrow('Distributions must have same length');
  });

  it('returns Infinity when q has zero where p is non-zero', () => {
    const p = [0.5, 0.5];
    const q = [1, 0]; // q[1] = 0 but p[1] = 0.5
    expect(crossEntropy(p, q)).toBe(Infinity);
  });

  it('returns entropy when p equals q', () => {
    const p = [0.25, 0.25, 0.25, 0.25];
    const ce = crossEntropy(p, p);
    const h = shannonEntropy(p);
    expect(ce).toBeCloseTo(h, 5);
  });

  it('cross-entropy >= entropy (always)', () => {
    const p = [0.7, 0.3];
    const q = [0.5, 0.5];
    const ce = crossEntropy(p, q);
    const h = shannonEntropy(p);
    expect(ce).toBeGreaterThanOrEqual(h - 0.0001); // Small tolerance
  });

  it('handles distributions with zeros in both', () => {
    const p = [0.5, 0.5, 0, 0];
    const q = [0.25, 0.25, 0.25, 0.25];
    // p[2] and p[3] are 0, so those terms are skipped
    expect(() => crossEntropy(p, q)).not.toThrow();
  });
});

describe('normalizedCompressionDistance', () => {
  it('returns ~1 for identical sequences (entropy-based approximation)', () => {
    // Note: This uses entropy * length as "compressed size" approximation.
    // For identical sequences: hAB ≈ 2*hA, so NCD ≈ (2*hA - hA)/hA = 1
    const seq = 'ACGTACGTACGT';
    const ncd = normalizedCompressionDistance(seq, seq, 2);
    expect(ncd).toBeCloseTo(1, 0.5);
  });

  it('returns non-negative value for different sequences', () => {
    const seqA = 'ACGTACGTACGT';
    const seqB = 'TGCATGCATGCA';
    const ncd = normalizedCompressionDistance(seqA, seqB, 2);

    expect(ncd).toBeGreaterThanOrEqual(0);
  });

  it('returns consistent values for sequence pairs', () => {
    const seqA = 'ACGTACGTACGT';
    const similar = 'ACGTACGTACGA'; // One base different
    const different = 'TTTTTTTTTTTTT';

    const ncdSimilar = normalizedCompressionDistance(seqA, similar, 2);
    const ncdDifferent = normalizedCompressionDistance(seqA, different, 2);

    // Both should be valid numbers
    expect(Number.isFinite(ncdSimilar)).toBe(true);
    expect(Number.isFinite(ncdDifferent)).toBe(true);
  });

  it('returns 0 when sequences are empty', () => {
    const ncd = normalizedCompressionDistance('', '', 2);
    expect(ncd).toBe(0);
  });

  it('returns 0 for homopolymer sequences (zero entropy)', () => {
    // Homopolymers have 0 entropy, so hA = hB = 0, maxH = 0, returns 0
    const seqA = 'AAAAAAAAAA';
    const seqB = 'TTTTTTTTTT';
    const ncd = normalizedCompressionDistance(seqA, seqB, 2);

    expect(ncd).toBe(0);
  });

  it('is symmetric', () => {
    const seqA = 'ACGTACGTACGT';
    const seqB = 'TGCATGCATGCA';
    const ncdAB = normalizedCompressionDistance(seqA, seqB, 2);
    const ncdBA = normalizedCompressionDistance(seqB, seqA, 2);

    expect(ncdAB).toBeCloseTo(ncdBA, 5);
  });
});

describe('integration: information theory workflow', () => {
  it('identifies similar sequences by low JSD', () => {
    const seqA = 'ACGTACGTACGT';
    const seqB = 'ACGTACGTACGT';
    const freqsA = getNucleotideFrequencies(seqA);
    const freqsB = getNucleotideFrequencies(seqB);
    expect(jensenShannonDivergence(freqsA, freqsB)).toBe(0);
  });

  it('identifies different sequences by higher JSD', () => {
    const seqA = 'AAAAAAAAAAAA'; // All A
    const seqB = 'TTTTTTTTTTTT'; // All T
    const freqsA = getNucleotideFrequencies(seqA);
    const freqsB = getNucleotideFrequencies(seqB);
    expect(jensenShannonDivergence(freqsA, freqsB)).toBeGreaterThan(0.5);
  });

  it('entropy reflects sequence complexity', () => {
    const simple = sequenceEntropy('AAAAAAAAAA', 1);
    const medium = sequenceEntropy('ATATATATAT', 1);
    const complex = sequenceEntropy('ACGTACGTAC', 1);
    expect(simple).toBeLessThan(medium);
    expect(medium).toBeLessThan(complex);
  });
});
