/**
 * Tests for k-mer analysis functions
 *
 * Tests alignment-free sequence comparison using k-mer frequency analysis.
 */

import { describe, expect, it } from 'bun:test';
import {
  extractKmerSet,
  extractKmerFrequencies,
  jaccardIndex,
  containmentIndex,
  cosineSimilarity,
  brayCurtisDissimilarity,
  kmerIntersectionSize,
} from './kmer-analysis';

describe('extractKmerSet', () => {
  it('extracts all k-mers from a simple sequence', () => {
    const kmers = extractKmerSet('ATCG', 2);
    expect(kmers.size).toBe(3);
    expect(kmers.has('AT')).toBe(true);
    expect(kmers.has('TC')).toBe(true);
    expect(kmers.has('CG')).toBe(true);
  });

  it('handles case-insensitive input', () => {
    const upper = extractKmerSet('ATCG', 2);
    const lower = extractKmerSet('atcg', 2);
    const mixed = extractKmerSet('AtCg', 2);

    expect(upper).toEqual(lower);
    expect(upper).toEqual(mixed);
  });

  it('skips k-mers containing N (ambiguous base)', () => {
    const kmers = extractKmerSet('ATNCG', 2);
    expect(kmers.has('TN')).toBe(false);
    expect(kmers.has('NC')).toBe(false);
    expect(kmers.has('AT')).toBe(true);
    expect(kmers.has('CG')).toBe(true);
  });

  it('returns empty set for sequence shorter than k', () => {
    const kmers = extractKmerSet('AT', 5);
    expect(kmers.size).toBe(0);
  });

  it('returns empty set for k < 1', () => {
    const kmers = extractKmerSet('ATCG', 0);
    expect(kmers.size).toBe(0);
  });

  it('handles k equal to sequence length', () => {
    const kmers = extractKmerSet('ATCG', 4);
    expect(kmers.size).toBe(1);
    expect(kmers.has('ATCG')).toBe(true);
  });

  it('handles repeated k-mers (set deduplication)', () => {
    const kmers = extractKmerSet('ATATAT', 2);
    expect(kmers.size).toBe(2); // AT and TA
  });
});

describe('extractKmerFrequencies', () => {
  it('counts k-mer frequencies correctly', () => {
    const freqs = extractKmerFrequencies('ATATAT', 2);
    expect(freqs.get('AT')).toBe(3);
    expect(freqs.get('TA')).toBe(2);
  });

  it('handles case-insensitive input', () => {
    const freqs = extractKmerFrequencies('AtAtAt', 2);
    expect(freqs.get('AT')).toBe(3);
  });

  it('skips k-mers containing N', () => {
    const freqs = extractKmerFrequencies('ATNTAT', 2);
    expect(freqs.has('TN')).toBe(false);
    expect(freqs.has('NT')).toBe(false);
    expect(freqs.get('AT')).toBe(2);
  });

  it('returns empty map for invalid inputs', () => {
    expect(extractKmerFrequencies('AT', 5).size).toBe(0);
    expect(extractKmerFrequencies('ATCG', 0).size).toBe(0);
  });
});

describe('jaccardIndex', () => {
  it('returns 1 for identical sets', () => {
    const set = new Set(['AT', 'TC', 'CG']);
    expect(jaccardIndex(set, set)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const setA = new Set(['AT', 'TC']);
    const setB = new Set(['GG', 'CC']);
    expect(jaccardIndex(setA, setB)).toBe(0);
  });

  it('returns correct value for partial overlap', () => {
    const setA = new Set(['AT', 'TC', 'CG']);
    const setB = new Set(['AT', 'TC', 'GG']);
    // Intersection: {AT, TC} = 2
    // Union: {AT, TC, CG, GG} = 4
    // Jaccard = 2/4 = 0.5
    expect(jaccardIndex(setA, setB)).toBe(0.5);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccardIndex(new Set(), new Set())).toBe(1);
  });

  it('returns 0 when one set is empty', () => {
    const set = new Set(['AT', 'TC']);
    expect(jaccardIndex(set, new Set())).toBe(0);
    expect(jaccardIndex(new Set(), set)).toBe(0);
  });
});

describe('containmentIndex', () => {
  it('returns 1 when A is subset of B', () => {
    const setA = new Set(['AT', 'TC']);
    const setB = new Set(['AT', 'TC', 'CG', 'GG']);
    expect(containmentIndex(setA, setB)).toBe(1);
  });

  it('returns 0 when A and B are disjoint', () => {
    const setA = new Set(['AT', 'TC']);
    const setB = new Set(['GG', 'CC']);
    expect(containmentIndex(setA, setB)).toBe(0);
  });

  it('returns fraction when partial overlap', () => {
    const setA = new Set(['AT', 'TC', 'CG']);
    const setB = new Set(['AT', 'GG']);
    // A has 3 elements, 1 is in B
    expect(containmentIndex(setA, setB)).toBeCloseTo(1/3);
  });

  it('returns 0 for empty A', () => {
    const setB = new Set(['AT', 'TC']);
    expect(containmentIndex(new Set(), setB)).toBe(0);
  });

  it('is asymmetric (order matters)', () => {
    const setA = new Set(['AT', 'TC']);
    const setB = new Set(['AT', 'TC', 'CG', 'GG']);
    // C(A,B) = 2/2 = 1 (all of A in B)
    // C(B,A) = 2/4 = 0.5 (half of B in A)
    expect(containmentIndex(setA, setB)).toBe(1);
    expect(containmentIndex(setB, setA)).toBe(0.5);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical frequency maps', () => {
    const freqs = new Map([['AT', 5], ['TC', 3]]);
    expect(cosineSimilarity(freqs, freqs)).toBe(1);
  });

  it('returns 0 for orthogonal vectors (no overlap)', () => {
    const freqsA = new Map([['AT', 5], ['TC', 3]]);
    const freqsB = new Map([['GG', 2], ['CC', 4]]);
    expect(cosineSimilarity(freqsA, freqsB)).toBe(0);
  });

  it('returns 1 for proportional frequencies', () => {
    const freqsA = new Map([['AT', 2], ['TC', 4]]);
    const freqsB = new Map([['AT', 4], ['TC', 8]]);
    // Cosine is scale-invariant
    expect(cosineSimilarity(freqsA, freqsB)).toBeCloseTo(1);
  });

  it('returns 0 for empty maps', () => {
    expect(cosineSimilarity(new Map(), new Map())).toBe(0);
  });
});

describe('brayCurtisDissimilarity', () => {
  it('returns 0 for identical frequency maps', () => {
    const freqs = new Map([['AT', 5], ['TC', 3]]);
    expect(brayCurtisDissimilarity(freqs, freqs)).toBe(0);
  });

  it('returns 1 for completely different frequencies', () => {
    const freqsA = new Map([['AT', 5]]);
    const freqsB = new Map([['GG', 3]]);
    expect(brayCurtisDissimilarity(freqsA, freqsB)).toBe(1);
  });

  it('returns value between 0 and 1 for partial overlap', () => {
    const freqsA = new Map([['AT', 5], ['TC', 3]]);
    const freqsB = new Map([['AT', 3], ['GG', 2]]);
    const bc = brayCurtisDissimilarity(freqsA, freqsB);
    expect(bc).toBeGreaterThan(0);
    expect(bc).toBeLessThan(1);
  });

  it('returns 0 for empty maps', () => {
    expect(brayCurtisDissimilarity(new Map(), new Map())).toBe(0);
  });
});

describe('kmerIntersectionSize', () => {
  it('returns correct count for overlapping sets', () => {
    const setA = new Set(['AT', 'TC', 'CG']);
    const setB = new Set(['AT', 'TC', 'GG']);
    expect(kmerIntersectionSize(setA, setB)).toBe(2);
  });

  it('returns 0 for disjoint sets', () => {
    const setA = new Set(['AT', 'TC']);
    const setB = new Set(['GG', 'CC']);
    expect(kmerIntersectionSize(setA, setB)).toBe(0);
  });

  it('returns full size for identical sets', () => {
    const set = new Set(['AT', 'TC', 'CG']);
    expect(kmerIntersectionSize(set, set)).toBe(3);
  });
});

describe('integration: k-mer analysis workflow', () => {
  it('produces sensible results for similar sequences', () => {
    const seqA = 'ATCGATCGATCG';
    const seqB = 'ATCGATCGATCG'; // Identical

    const kmerSetA = extractKmerSet(seqA, 3);
    const kmerSetB = extractKmerSet(seqB, 3);

    expect(jaccardIndex(kmerSetA, kmerSetB)).toBe(1);
    expect(containmentIndex(kmerSetA, kmerSetB)).toBe(1);
  });

  it('shows lower similarity for different sequences', () => {
    const seqA = 'ATCGATCGATCG';
    const seqB = 'GGCCGGCCGGCC'; // Completely different

    const kmerSetA = extractKmerSet(seqA, 3);
    const kmerSetB = extractKmerSet(seqB, 3);

    expect(jaccardIndex(kmerSetA, kmerSetB)).toBe(0);
  });

  it('shows intermediate similarity for related sequences', () => {
    const seqA = 'ATCGATCGATCG';
    const seqB = 'ATCGGGCCATCG'; // Some overlap

    const kmerSetA = extractKmerSet(seqA, 3);
    const kmerSetB = extractKmerSet(seqB, 3);

    const jaccard = jaccardIndex(kmerSetA, kmerSetB);
    expect(jaccard).toBeGreaterThan(0);
    expect(jaccard).toBeLessThan(1);
  });
});
