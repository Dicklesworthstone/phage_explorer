import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { KmerVector } from './kmer-frequencies';
import { computeKmerVectorsBatch } from './kmer-frequencies';
import { parseAnalysisRecord, serializeAnalysisRecord } from '../analysis-result';
import { computeScreePlotData, computeSignatureNeighborhood, createSignatureNeighborhoodRecord,
  getTopLoadings, performPCA, projectToPCA, type PCAProjection, type SignatureSource } from './pca';

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
  });

  it('performPCA > deterministic loadings (canonical sign)', () => {
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'p1', frequencies: new Float32Array([0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 2, name: 'p2', frequencies: new Float32Array([2, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 3, name: 'p3', frequencies: new Float32Array([0, 1]), gcContent: 0, genomeLength: 0 },
      { phageId: 4, name: 'p4', frequencies: new Float32Array([2, 1]), gcContent: 0, genomeLength: 0 },
    ];

    const r1 = performPCA(vectors, { numComponents: 2, maxIterations: 200 });
    const r2 = performPCA(vectors, { numComponents: 2, maxIterations: 200 });

    expect(r1.loadings).toHaveLength(2);
    expect(r2.loadings).toHaveLength(2);

    for (let k = 0; k < 2; k++) {
      const v1 = r1.loadings[k]!;
      const v2 = r2.loadings[k]!;
      expect(v1.length).toBe(v2.length);

      // Canonical sign: largest-magnitude element is positive.
      let maxIdx = 0;
      let maxAbs = Math.abs(v1[0]!);
      for (let i = 1; i < v1.length; i++) {
        const abs = Math.abs(v1[i]!);
        if (abs > maxAbs) {
          maxAbs = abs;
          maxIdx = i;
        }
      }
      expect(v1[maxIdx]!).toBeGreaterThanOrEqual(0);

      for (let i = 0; i < v1.length; i++) {
        expect(v1[i]!).toBeCloseTo(v2[i]!, 6);
      }
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

  it('computeScreePlotData > handles zero total variance', () => {
    const data = computeScreePlotData([0, 0], 0);
    expect(data).toEqual([
      { component: 1, variance: 0, cumulative: 0 },
      { component: 2, variance: 0, cumulative: 0 },
    ]);
  });

  it('performPCA > handles single sample (n=1)', () => {
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'single', frequencies: new Float32Array([1, 2, 3]), gcContent: 0.5, genomeLength: 100 },
    ];

    const result = performPCA(vectors, { numComponents: 2 });

    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]!.phageId).toBe(1);
    // Single sample has zero variance - all projections should be 0
    expect(result.totalVariance).toBe(0);
  });

  it('performPCA > computes 3 components with pc3', () => {
    // Create a 3D dataset to exercise the pc3 path
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'p1', frequencies: new Float32Array([0, 0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 2, name: 'p2', frequencies: new Float32Array([3, 0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 3, name: 'p3', frequencies: new Float32Array([0, 2, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 4, name: 'p4', frequencies: new Float32Array([3, 2, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 5, name: 'p5', frequencies: new Float32Array([0, 0, 1]), gcContent: 0, genomeLength: 0 },
      { phageId: 6, name: 'p6', frequencies: new Float32Array([3, 2, 1]), gcContent: 0, genomeLength: 0 },
    ];

    const result = performPCA(vectors, { numComponents: 3, maxIterations: 200, tolerance: 1e-12 });

    expect(result.loadings).toHaveLength(3);
    expect(result.eigenvalues).toHaveLength(3);

    // All projections should have pc3 defined
    for (const proj of result.projections) {
      expect(proj.pc3).toBeDefined();
    }

    // Cumulative variance should sum to ~1 with 3 components covering the 3D data
    expect(result.cumulativeVariance[2]).toBeCloseTo(1, 3);
  });

  it('projectToPCA > projects with 3 components', () => {
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'p1', frequencies: new Float32Array([0, 0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 2, name: 'p2', frequencies: new Float32Array([3, 0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 3, name: 'p3', frequencies: new Float32Array([0, 2, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 4, name: 'p4', frequencies: new Float32Array([0, 0, 1]), gcContent: 0, genomeLength: 0 },
    ];

    const result = performPCA(vectors, { numComponents: 3 });

    // Project a new vector
    const newVec = new Float32Array([1, 1, 0.5]);
    const projected = projectToPCA(newVec, result.mean, result.loadings);

    expect(projected.pc1).toBeDefined();
    expect(projected.pc2).toBeDefined();
    expect(projected.pc3).toBeDefined();
    expect(Number.isFinite(projected.pc3!)).toBe(true);
  });

  it('projectToPCA > handles 1 component only', () => {
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'p1', frequencies: new Float32Array([0, 0]), gcContent: 0, genomeLength: 0 },
      { phageId: 2, name: 'p2', frequencies: new Float32Array([2, 0]), gcContent: 0, genomeLength: 0 },
    ];

    const result = performPCA(vectors, { numComponents: 1 });
    expect(result.loadings).toHaveLength(1);

    const projected = projectToPCA(new Float32Array([1, 0]), result.mean, result.loadings);
    expect(projected.pc1).toBeDefined();
    expect(projected.pc2).toBe(0); // Only 1 loading, so pc2 defaults to 0
    expect(projected.pc3).toBeUndefined();
  });

  it('performPCA > limits components to min(n, dim)', () => {
    // 2 samples with 3 dimensions - max components is 2
    const vectors: KmerVector[] = [
      { phageId: 1, name: 'p1', frequencies: new Float32Array([1, 2, 3]), gcContent: 0, genomeLength: 0 },
      { phageId: 2, name: 'p2', frequencies: new Float32Array([4, 5, 6]), gcContent: 0, genomeLength: 0 },
    ];

    const result = performPCA(vectors, { numComponents: 5 }); // Request 5, but limited to 2

    expect(result.loadings.length).toBeLessThanOrEqual(2);
    expect(result.eigenvalues.length).toBeLessThanOrEqual(2);
  });
});

describe('full-frequency signature neighborhoods', () => {
  const vector = (phageId: number, frequencies: number[], name = `genome-${phageId}`): KmerVector => ({
    phageId, name, frequencies: new Float32Array(frequencies), gcContent: 0.5, genomeLength: 100,
  });
  // PC1/PC2 can be the first two coordinate axes of a higher-dimensional
  // orthogonal projection. The hidden difference is lost from the display.
  const fixture = () => {
    const vectors = [
      vector(1, [0.25, 0.25, 0.25, 0.25]),
      vector(2, [0.25, 0.25, 0.5, 0]),
      vector(3, [0.3125, 0.1875, 0.25, 0.25]),
    ];
    const projections: PCAProjection[] = vectors.map(v => ({ phageId: v.phageId, name: v.name,
      pc1: v.frequencies[0], pc2: v.frequencies[1], gcContent: v.gcContent, genomeLength: v.genomeLength }));
    const sources: SignatureSource[] = vectors.map(v => ({ phageId: v.phageId, accession: `local-${v.phageId}`,
      source: 'local', sequenceSha256: createHash('sha256').update(`source-${v.phageId}`).digest('hex') }));
    return { vectors, projections, sources };
  };

  it('ranks in all dimensions when a 2D projection reverses nearest-neighbor order', () => {
    const { vectors, projections } = fixture();
    const result = computeSignatureNeighborhood(vectors, 1, projections);
    expect(result.neighbors.map(n => n.phageId)).toEqual([3, 2]);
    // Independent distances: sqrt(2*(1/16)^2) versus sqrt(2*(1/4)^2).
    expect(result.neighbors[0].featureDistance).toBeCloseTo(Math.SQRT2 / 16, 12);
    expect(result.neighbors[1].featureDistance).toBeCloseTo(Math.SQRT2 / 4, 12);
    expect(result.neighbors[0].projectedDistance).toBeCloseTo(Math.SQRT2 / 16, 12);
    expect(result.neighbors[1].projectedDistance).toBe(0);
    expect(result.dimensions).toBe(4);
    expect(result.unavailableReason).toBeNull();
  });

  it('retains the real nearest signature when actual PCA discards the separating axis', () => {
    // Symmetric pairs make the mean (1/4,1/4,1/4,1/4). The independent
    // covariance axes are (1,-1,0,0), (0,0,1,-1), (1,1,-1,-1), with
    // eigenvalues 0.0325, 0.03125 and 0.01 respectively. PC1/PC2 discard
    // the last contrast, making genome 2 coincide with genome 1 on screen.
    const vectors = [
      vector(1, [0.25, 0.25, 0.25, 0.25]),
      vector(2, [0.35, 0.35, 0.15, 0.15]),
      vector(3, [0.3, 0.2, 0.25, 0.25]),
      vector(4, [0.15, 0.15, 0.35, 0.35]),
      vector(5, [0.2, 0.3, 0.25, 0.25]),
      vector(6, [0.5, 0, 0.25, 0.25]),
      vector(7, [0, 0.5, 0.25, 0.25]),
      vector(8, [0.25, 0.25, 0.5, 0]),
      vector(9, [0.25, 0.25, 0, 0.5]),
    ];
    const pca = performPCA(vectors, { numComponents: 2, maxIterations: 500 });
    const result = computeSignatureNeighborhood(vectors, 1, pca.projections);
    expect(result.neighbors.slice(0, 2).map(n => n.phageId)).toEqual([3, 5]);
    const near = result.neighbors.find(n => n.phageId === 3)!;
    const hidden = result.neighbors.find(n => n.phageId === 2)!;
    expect(near.featureDistance).toBeCloseTo(Math.SQRT2 / 20, 6);
    expect(hidden.featureDistance).toBeCloseTo(0.2, 6);
    expect(hidden.projectedDistance!).toBeLessThan(near.projectedDistance! / 100);
    expect(pca.eigenvalues[0]).toBeCloseTo(0.0325, 6);
    expect(pca.eigenvalues[1]).toBeCloseTo(0.03125, 6);
  });

  it('preserves ranking under sample permutation, renaming and display-axis sign/rotation changes', () => {
    const { vectors, projections } = fixture();
    const original = computeSignatureNeighborhood(vectors, 1, projections);
    const reordered = computeSignatureNeighborhood([...vectors].reverse().map(v => ({ ...v, name: `renamed-${v.phageId}` })), 1,
      [...projections].reverse().map(p => ({ ...p, pc1: -p.pc2, pc2: p.pc1 })));
    expect(reordered.neighbors.map(({ name: _name, ...n }) => n))
      .toEqual(original.neighbors.map(({ name: _name, ...n }) => n));
    // Deliberately distort the display without changing the frequency vectors.
    const distorted = computeSignatureNeighborhood(vectors, 1, projections.map(p => ({ ...p, pc1: p.phageId * 10, pc2: 0 })));
    expect(distorted.neighbors.map(n => [n.phageId, n.featureDistance]))
      .toEqual(original.neighbors.map(n => [n.phageId, n.featureDistance]));
  });

  it('uses stable IDs for exact ties and keeps missing projections unavailable', () => {
    const tied = [vector(4, [1, 0, 0, 0]), vector(2, [1, 0, 0, 0]), vector(3, [1, 0, 0, 0])];
    const result = computeSignatureNeighborhood(tied, 4);
    expect(result.neighbors.map(n => [n.phageId, n.featureDistance, n.projectedDistance])).toEqual([[2, 0, null], [3, 0, null]]);
  });

  it('excludes no-kmer genomes and distinguishes their missing evidence from an identical signature', () => {
    const vectors = [vector(1, [0.25, 0.25, 0.25, 0.25]), vector(2, [0, 0, 0, 0]), vector(3, [0.25, 0.25, 0.25, 0.25])];
    expect(computeSignatureNeighborhood(vectors, 1).neighbors.map(n => [n.phageId, n.featureDistance])).toEqual([[3, 0]]);
    expect(computeSignatureNeighborhood(vectors, 1).excludedPhageIds).toEqual([2]);
    const unavailable = computeSignatureNeighborhood(vectors, 2);
    expect(unavailable.neighbors).toEqual([]);
    expect(unavailable.unavailableReason).toContain('selected genome has no counted k-mers');
    expect(computeSignatureNeighborhood(vectors.slice(0, 2), 1).unavailableReason).toContain('No other genome');
  });

  it('uses actual normalized sequence signatures and retains reverse-complement equivalence', () => {
    const rows = computeKmerVectorsBatch([
      { id: 1, name: 'original', sequence: 'AAAACCCGTT' },
      { id: 2, name: 'reverse', sequence: 'AACGGGTTTT' },
      { id: 3, name: 'unknown', sequence: 'NNNNNNNNNN' },
      { id: 4, name: 'different', sequence: 'ATATATATAT' },
    ], { k: 3, normalize: true, includeReverseComplement: true });
    const result = computeSignatureNeighborhood(rows, 1);
    expect(result.neighbors[0].phageId).toBe(2);
    expect(result.neighbors[0].featureDistance).toBe(0);
    expect(result.neighbors[1].featureDistance).toBeGreaterThan(0);
    expect(result.excludedPhageIds).toEqual([3]);
  });

  it('rejects malformed vectors and projections instead of ranking nonfinite or incompatible distances', () => {
    const { vectors, projections } = fixture();
    for (const bad of [[1, 1, 0, 0], [-0.25, 0.25, 0.5, 0.5], [NaN, 0, 0, 1], [Infinity, 0, 0, 0], [1, 0]]) {
      expect(() => computeSignatureNeighborhood([vectors[0], vector(4, bad)], 1)).toThrow();
    }
    expect(() => computeSignatureNeighborhood([vectors[0], vectors[0]], 1)).toThrow('unique');
    expect(() => computeSignatureNeighborhood(vectors, 99)).toThrow('absent');
    expect(() => computeSignatureNeighborhood(vectors, 1, [{ ...projections[0], phageId: 99 }])).toThrow('matrix rows');
    expect(() => computeSignatureNeighborhood(vectors, 1, [{ ...projections[0], pc1: NaN }])).toThrow('finite');
  });

  it('exports every ranked neighbor with exact accepted vectors, source identities and submitted settings', async () => {
    const { vectors, projections, sources } = fixture();
    const options = { k: 1, includeReverseComplement: true };
    const record = await createSignatureNeighborhoodRecord(vectors, 1, projections, options, sources);
    const saved = await parseAnalysisRecord(serializeAnalysisRecord(record));
    expect(saved.parameters).toEqual({ selectedPhageId: 1, k: 1, includeReverseComplement: true,
      normalize: true, rankingSpace: 'full-kmer-frequencies', metric: 'euclidean' });
    expect(saved.fields.neighbors.kind).toBe('sequence-score');
    expect(saved.fields.neighbors.value).toEqual(computeSignatureNeighborhood(vectors, 1, projections).neighbors);
    expect(saved.fields.neighbors.coverage).toEqual({ available: 2, total: 2, unit: 'records' });
    for (const input of saved.inputs) {
      const row = input.data as { phageId: number; frequencies: number[]; sequenceSha256: string };
      expect(row.sequenceSha256).toBe(sources.find(s => s.phageId === row.phageId)!.sequenceSha256);
      expect(row.frequencies).toEqual(Array.from(vectors.find(v => v.phageId === row.phageId)!.frequencies));
    }
    const reordered = await createSignatureNeighborhoodRecord([...vectors].reverse(), 1, [...projections].reverse(), options, [...sources].reverse());
    expect(reordered.resultId).toBe(record.resultId);
    const changedSource = sources.map(s => ({ ...s, sequenceSha256: 'f'.repeat(64) }));
    expect((await createSignatureNeighborhoodRecord(vectors, 1, projections, options, changedSource)).cacheKey).not.toBe(record.cacheKey);
    expect(saved.fields.neighbors.limitations.join(' ')).toContain('not independently validate vector extraction or PCA fitting');
  });

  it('snapshots export inputs before asynchronous hashing and records unavailable evidence explicitly', async () => {
    const { vectors, projections, sources } = fixture();
    const pending = createSignatureNeighborhoodRecord(vectors, 1, projections, { k: 1, includeReverseComplement: false }, sources);
    vectors[0].frequencies.fill(0);
    sources[0].sequenceSha256 = 'a'.repeat(64);
    projections[0].pc1 = 100;
    const original = fixture();
    expect((await pending).resultId).toBe((await createSignatureNeighborhoodRecord(original.vectors, 1, original.projections,
      { k: 1, includeReverseComplement: false }, original.sources)).resultId);
    const missing = await createSignatureNeighborhoodRecord(vectors, 1, projections, { k: 1, includeReverseComplement: false }, sources);
    expect(missing.fields.neighbors.kind).toBe('unavailable');
    expect(missing.fields.neighbors.value).toBeNull();
    expect(missing.fields.exclusions.value).toEqual([1]);
  });

  it('refuses incomplete source identities and settings that do not describe the accepted vectors', async () => {
    const { vectors, projections, sources } = fixture();
    await expect(createSignatureNeighborhoodRecord(vectors, 1, projections, { k: 2, includeReverseComplement: true }, sources)).rejects.toThrow('dimensions');
    await expect(createSignatureNeighborhoodRecord(vectors, 1, projections, { k: 1, includeReverseComplement: true }, sources.slice(1))).rejects.toThrow('incomplete');
    await expect(createSignatureNeighborhoodRecord(vectors, 1, projections, { k: 1, includeReverseComplement: true }, [sources[0], sources[0]])).rejects.toThrow('one source-sequence');
  });
});
