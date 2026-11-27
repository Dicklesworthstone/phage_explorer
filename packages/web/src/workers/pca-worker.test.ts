import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as Comlink from 'comlink';
import { computePhasePortrait, performPCA } from '@phage-explorer/core';
import type { SharedAnalysisWorkerAPI } from './types';

let worker: Worker, api: Comlink.Remote<SharedAnalysisWorkerAPI>;
beforeAll(() => {
  worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
  api = Comlink.wrap<SharedAnalysisWorkerAPI>(worker);
});
afterAll(() => { api?.[Comlink.releaseProxy](); worker?.terminate(); });

describe('PCA analysis worker numerical contract', () => {
  it('keeps a rank-one genomic signature on one axis after transport and backend initialization', async () => {
    // Replicated frequency rows exceed the optional-native matrix threshold.
    // Four nonzero entries are padded to 256 features; the only contrast has
    // squared norm 3/2. With 40 of each row its sample eigenvalue is 30/79.
    const rows = Array.from({ length: 80 }, (_, i) => {
      const frequencies = new Float32Array(256);
      frequencies.set(i % 2 ? [0, 1, 0, 0] : [0.5, 0, 0.5, 0]);
      return { phageId: i, name: String(i), gcContent: 0.5, genomeLength: 100, frequencies };
    });
    const frequencies = new Float32Array(rows.length * 256);
    rows.forEach((row, i) => frequencies.set(row.frequencies, i * 256));
    const request = { vectors: rows.map(({ frequencies: _frequencies, ...meta }) => meta), frequencies, dim: 256 };
    for (let call = 0; call < 2; call++) {
      const result = (await api.computeGenomicSignaturePca(request))!;
      expect(result.eigenvalues[0]).toBeCloseTo(30 / 79, 10);
      expect(result.eigenvalues.slice(1)).toEqual([0, 0]);
      expect(result.projections.every(point => point.pc2 === 0 && point.pc3 === 0)).toBe(true);
      expect(result.projections).toEqual(performPCA(rows).projections);
      expect(result.loadings[1].every(value => value === 0)).toBe(true);
    }
  });

  it('returns the same rank-correct protein portrait as the terminal/core path', async () => {
    const result = await api.computePhasePortrait({ protein: 'MD', windowSize: 1, stepSize: 1 });
    expect(result).toEqual(computePhasePortrait('MD', 1, 1));
    expect(result!.points.map(point => point.coord.y)).toEqual([0.5, 0.5]);
    expect(result!.explained[0]).toBeCloseTo(1, 12);
    expect(result!.explained[1]).toBe(0);
  });

  it('keeps bias-window positions while removing the spurious second axis', async () => {
    const bytes = new TextEncoder().encode('AAAACCCCAAAACCCC');
    const result = (await api.computeBiasDecomposition({
      sequenceRef: { buffer: bytes.buffer, byteOffset: 0, byteLength: bytes.length, length: bytes.length, encoding: 'ascii', isShared: false },
      windowSize: 4, stepSize: 4,
    }))!;
    // Each window consists entirely of AA or CC dinucleotides. The matrix has
    // exactly two distinct points; centering leaves a single independent axis.
    expect(result.positions).toEqual([0, 4, 8, 12]);
    expect(result.gcContents).toEqual([0, 1, 0, 1]);
    expect(result.decomposition.components[0].explained).toBeCloseTo(1, 12);
    expect(result.decomposition.components[1].explained).toBe(0);
    expect(result.decomposition.projections.map(point => point.coords[1])).toEqual([0, 0, 0, 0]);
  });

  it('rejects nonfinite worker matrix entries instead of publishing NaN coordinates', async () => {
    let failure: unknown;
    try {
      await api.computeGenomicSignaturePca({
        vectors: [0, 1, 2].map(phageId => ({ phageId, name: String(phageId), gcContent: 0.5, genomeLength: 10 })),
        frequencies: new Float32Array([0, 1, 1, 0, NaN, 1]), dim: 2,
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('finite');
  });
});
