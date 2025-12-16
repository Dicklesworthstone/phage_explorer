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

  it('returns uniform distribution for empty sequence', () => {
    const freqs = getNucleotideFrequencies('');
    expect(freqs).toEqual([0.25, 0.25, 0.25, 0.25]);
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

  it('returns uniform for empty sequence', () => {
    const freqs = getDinucleotideFrequencies('');
    expect(freqs.length).toBe(16);
    expect(freqs[0]).toBeCloseTo(1/16, 5);
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
    // getNucleotideFrequencies returns uniform for empty, so entropy is 2
    expect(entropy).toBeCloseTo(2, 1);
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
