import { describe, expect, it } from 'bun:test';
import {
  computeDistanceMatrix,
  computeGcContent,
  computeKmerFrequencies,
  computeKmerVectorsBatch,
  computeMeanVector,
  cosineSimilarity,
  euclideanDistance,
  generateKmers,
  getDistinctiveKmers,
  indexToKmer,
  kmerToIndex,
  manhattanDistance,
} from './kmer-frequencies';

describe('K-mer frequencies', () => {
  it('generateKmers > returns 4^k kmers (ordered)', () => {
    expect(generateKmers(0)).toEqual([]);
    expect(generateKmers(1)).toEqual(['A', 'C', 'G', 'T']);
    const kmers2 = generateKmers(2);
    expect(kmers2).toHaveLength(16);
    expect(kmers2.slice(0, 4)).toEqual(['AA', 'AC', 'AG', 'AT']);
    expect(kmers2.slice(-4)).toEqual(['TA', 'TC', 'TG', 'TT']);
  });

  it('kmerToIndex/indexToKmer > round-trips for valid kmers', () => {
    for (const kmer of ['AA', 'ac', 'Gg', 'tT', 'ACGT', 'TGCA']) {
      const idx = kmerToIndex(kmer);
      expect(idx).toBeGreaterThanOrEqual(0);
      const roundTrip = indexToKmer(idx, kmer.length);
      expect(roundTrip).toBe(kmer.toUpperCase());
    }
    expect(kmerToIndex('AN')).toBe(-1);
  });

  it('computeKmerFrequencies > throws for k > 12 (dense vector guard)', () => {
    expect(() => computeKmerFrequencies('ACGT', { k: 13 })).toThrow();
  });

  it('computeKmerFrequencies > normalize=false counts forward and reverse complement separately', () => {
    const k = 2;
    const seq = 'AAAAA';
    const vec = computeKmerFrequencies(seq, { k, normalize: false, includeReverseComplement: true });
    expect(vec.length).toBe(16);

    const aa = kmerToIndex('AA');
    const tt = kmerToIndex('TT');
    expect(vec[aa]).toBe(4);
    expect(vec[tt]).toBe(4);
  });

  it('computeKmerFrequencies > normalize=true sums to 1 when counts exist', () => {
    const vec = computeKmerFrequencies('AAAAA', { k: 2, normalize: true, includeReverseComplement: true });
    let sum = 0;
    for (const v of vec) sum += v;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('computeKmerFrequencies > does not count kmers across invalid characters (e.g. N)', () => {
    const vec = computeKmerFrequencies('AANAA', { k: 2, normalize: false, includeReverseComplement: false });
    const aa = kmerToIndex('AA');
    expect(vec[aa]).toBe(2);
  });

  it('computeGcContent > ignores ambiguous bases', () => {
    expect(computeGcContent('')).toBe(0);
    expect(computeGcContent('NNNN')).toBe(0);
    expect(computeGcContent('GCGC')).toBe(1);
    expect(computeGcContent('ATAT')).toBe(0);
    expect(computeGcContent('ACGTNN')).toBeCloseTo(0.5, 6);
  });

  it('distance metrics > agree on simple cases', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(euclideanDistance(a, a)).toBe(0);
    expect(manhattanDistance(a, a)).toBe(0);
    expect(cosineSimilarity(a, a)).toBe(1);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(euclideanDistance(a, b)).toBeCloseTo(Math.sqrt(2), 6);
    expect(manhattanDistance(a, b)).toBe(2);
  });

  it('computeKmerVectorsBatch/computeMeanVector > basic workflow', () => {
    const vectors = computeKmerVectorsBatch(
      [
        { id: 1, name: 'x', sequence: 'AAAAA' },
        { id: 2, name: 'y', sequence: 'AAAAT' },
      ],
      { k: 2, normalize: true, includeReverseComplement: false }
    );

    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.gcContent).toBe(0);
    expect(vectors[1]?.gcContent).toBeCloseTo(0, 6);

    const mean = computeMeanVector(vectors);
    const expectedDim = vectors[0]?.frequencies.length ?? 0;
    expect(mean.length).toBe(expectedDim);

    const aa = kmerToIndex('AA');
    const at = kmerToIndex('AT');
    expect(aa).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(mean[aa]).toBeCloseTo(0.875, 6);
    expect(mean[at]).toBeCloseTo(0.125, 6);
  });

  it('getDistinctiveKmers > returns top kmers by absolute deviation', () => {
    const mean = new Float32Array(16);
    const vector = new Float32Array(16);
    vector[kmerToIndex('AA')] = 0.7;
    vector[kmerToIndex('AC')] = 0.2;
    vector[kmerToIndex('TT')] = 0.05;

    const top = getDistinctiveKmers(vector, mean, 2, 2);
    expect(top).toHaveLength(2);
    expect(top[0]?.kmer).toBe('AA');
    expect(top[0]?.frequency).toBeCloseTo(0.7, 6);
    expect(top[1]?.kmer).toBe('AC');
    expect(top[1]?.frequency).toBeCloseTo(0.2, 6);
  });

  it('computeDistanceMatrix > symmetric with 0 diagonal', () => {
    const vectors = computeKmerVectorsBatch(
      [
        { id: 1, name: 'x', sequence: 'AAAAAA' },
        { id: 2, name: 'y', sequence: 'AAAATT' },
        { id: 3, name: 'z', sequence: 'TTTTTT' },
      ],
      { k: 2, normalize: true, includeReverseComplement: false }
    );

    const matrix = computeDistanceMatrix(vectors, manhattanDistance);
    const n = vectors.length;
    expect(matrix.length).toBe(n * n);

    for (let i = 0; i < n; i++) {
      expect(matrix[i * n + i]).toBe(0);
      for (let j = 0; j < n; j++) {
        expect(matrix[i * n + j]).toBeCloseTo(matrix[j * n + i] ?? 0, 6);
      }
    }
  });

  it('computeMeanVector > returns 256 dims when vectors empty', () => {
    expect(computeMeanVector([]).length).toBe(256);
  });

  it('computeKmerFrequencies > includeReverseComplement=false differs from true for non-palindromic input', () => {
    const seq = 'AAAAG';
    const forwardOnly = computeKmerFrequencies(seq, { k: 2, normalize: false, includeReverseComplement: false });
    const withRc = computeKmerFrequencies(seq, { k: 2, normalize: false, includeReverseComplement: true });
    expect(forwardOnly[kmerToIndex('AA')]).toBe(3);
    expect(forwardOnly[kmerToIndex('AG')]).toBe(1);
    expect(withRc[kmerToIndex('AA')]).toBe(3);
    expect(withRc[kmerToIndex('AG')]).toBe(1);
    expect(withRc[kmerToIndex('CT')]).toBe(1);
    expect(withRc[kmerToIndex('TT')]).toBe(3);
  });
});
