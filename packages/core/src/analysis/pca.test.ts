import { describe, expect, it } from 'bun:test';
import type { KmerVector } from './kmer-frequencies';
import { computeScreePlotData, getTopLoadings, performPCA, projectToPCA } from './pca';

describe('PCA', () => {
  it('performPCA > empty input returns empty result', () => {
    const result = performPCA([]);
    expect(result.projections).toEqual([]);
    expect(result.eigenvalues).toEqual([]);
    expect(result.varianceExplained).toEqual([]);
    expect(result.cumulativeVariance).toEqual([]);
    expect(result.loadings).toEqual([]);
    expect(result.mean.length).toBe(256);
    expect(result.totalVariance).toBe(0);
  });

  it('performPCA > finds axis-aligned PCs for a simple rectangular dataset', () => {
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'p1', frequencies: new Float32Array([0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 2, name: 'p2', frequencies: new Float32Array([2, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 3, name: 'p3', frequencies: new Float32Array([0, 1]), gcContent: 0, genomeLength: 0 },
      { phageId: 4, name: 'p4', frequencies: new Float32Array([2, 1]), gcContent: 0, genomeLength: 0 },
    ];

    const originalRandom = Math.random;
    Math.random = () => 0.1234;
    try {
      const result = performPCA(vectors, { numComponents: 2, maxIterations: 200, tolerance: 1e-12 });

      expect(result.loadings).toHaveLength(2);
      expect(result.loadings[0]!.length).toBe(2);
      expect(result.loadings[1]!.length).toBe(2);

      // Covariance is diagonal with Var(x)=4/3 and Var(y)=1/3, so PC1 should align with x-axis.
      expect(Math.abs(result.loadings[0]![0]!)).toBeGreaterThan(0.9);
      expect(Math.abs(result.loadings[0]![1]!)).toBeLessThan(0.1);
      expect(Math.abs(result.loadings[1]![1]!)).toBeGreaterThan(0.9);
      expect(Math.abs(result.loadings[1]![0]!)).toBeLessThan(0.1);

      expect(result.eigenvalues).toHaveLength(2);
      expect(result.totalVariance).toBeGreaterThan(0);
      expect(result.eigenvalues[0]! + result.eigenvalues[1]!).toBeCloseTo(result.totalVariance, 5);

      expect(result.varianceExplained[0]!).toBeGreaterThan(result.varianceExplained[1]!);
      expect(result.cumulativeVariance.at(-1)).toBeCloseTo(1, 5);

      const projections = result.projections.map((p) => ({ pc1: p.pc1, pc2: p.pc2 }));
      // Centered x values are ±1; centered y values are ±0.5. Signs may flip; use abs.
      const pc1Abs = projections.map((p) => Math.abs(p.pc1)).sort((a, b) => a - b);
      const pc2Abs = projections.map((p) => Math.abs(p.pc2)).sort((a, b) => a - b);
      expect(pc1Abs).toEqual([1, 1, 1, 1]);
      expect(pc2Abs).toEqual([0.5, 0.5, 0.5, 0.5]);

      // projectToPCA matches the stored projection for a vector.
      const p1 = result.projections.find((p) => p.phageId === 1);
      expect(p1).toBeDefined();
      const projected = projectToPCA(vectors[0]!.frequencies, result.mean, result.loadings);
      expect(projected.pc1).toBeCloseTo(p1!.pc1, 6);
      expect(projected.pc2).toBeCloseTo(p1!.pc2, 6);
    } finally {
      Math.random = originalRandom;
    }
  });

  it('getTopLoadings > returns top indices by absolute loading', () => {
    const loadings = [new Float32Array([0, -3, 1, 2])];
    const top = getTopLoadings(loadings, 1, 2);
    expect(top).toHaveLength(1);
    expect(top[0]).toHaveLength(2);
    expect(top[0]![0]).toEqual({ kmer: 'C', loading: -3 });
    expect(top[0]![1]).toEqual({ kmer: 'T', loading: 2 });
  });

  it('computeScreePlotData > computes variance and cumulative series', () => {
    const data = computeScreePlotData([2, 1], 3);
    expect(data).toEqual([
      { component: 1, variance: 2 / 3, cumulative: 2 / 3 },
      { component: 2, variance: 1 / 3, cumulative: 1 },
    ]);
  });
});

