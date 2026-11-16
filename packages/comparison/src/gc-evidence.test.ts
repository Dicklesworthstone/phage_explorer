import { describe, expect, it } from 'bun:test';
import { analyzeBiologicalMetrics, calculateGCContent } from './biological-metrics';
import { compareGenomes } from './comparison-engine';

describe('GC comparison evidence', () => {
  it('counts only resolved bases, independently of the k-mer evidence window', () => {
    const metrics = analyzeBiologicalMetrics('gNc', 'atNN');
    expect(metrics.gcResolvedBasesA).toBe(2);
    expect(metrics.gcResolvedBasesB).toBe(2);
    expect(metrics.gcContentA).toBe(100);
    expect(metrics.gcContentB).toBe(0);
    expect(metrics.gcDifference).toBe(100);
    expect(calculateGCContent('gNc')).toBe(100);
  });

  it('distinguishes unresolved records from an observed zero GC percentage', () => {
    const metrics = analyzeBiologicalMetrics('NRY', 'AATT');
    expect(metrics.gcResolvedBasesA).toBe(0);
    expect(metrics.gcResolvedBasesB).toBe(4);
    expect(metrics.gcContentB).toBe(0);
  });

  it('never infers GC similarity or difference when either record lacks resolved bases', async () => {
    const a = { id: 1, name: 'A', accession: 'A' };
    const b = { id: 2, name: 'B', accession: 'B' };
    for (const [sequenceA, sequenceB] of [
      ['N'.repeat(30), 'N'.repeat(30)],
      ['N'.repeat(30), 'G'.repeat(30)],
      ['G'.repeat(30), 'N'.repeat(30)],
    ]) {
      const result = await compareGenomes(a, b, sequenceA, sequenceB);
      expect(result.summary.insights.some(insight => insight.category === 'GC Content')).toBe(false);
    }
    const resolved = await compareGenomes(a, b, 'A'.repeat(30), 'T'.repeat(30));
    expect(resolved.summary.insights.some(insight => insight.category === 'GC Content'
      && insight.type === 'similarity')).toBe(true);
  });
});
