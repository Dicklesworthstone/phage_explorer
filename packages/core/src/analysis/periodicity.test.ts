import { describe, expect, it } from 'bun:test';
import { analyzePeriodicity } from './periodicity';

describe('periodicity', () => {
  it('returns empty results for empty sequence', () => {
    const res = analyzePeriodicity('');
    expect(res.spectrum.rows).toBe(0);
    expect(res.spectrum.cols).toBe(0);
    expect(res.topPeriods).toEqual([]);
    expect(res.candidates).toEqual([]);
  });

  it('detects 3bp periodicity in a 3-mer repeat (GC encoding)', () => {
    const seq = 'GAT'.repeat(1500);
    const res = analyzePeriodicity(seq, {
      encoding: 'gc',
      windowSize: 1024,
      stepSize: 1024,
      minPeriod: 2,
      maxPeriod: 12,
      minValidPairs: 200,
      candidateThreshold: 0.95,
      maxTopPeriods: 5,
      maxCandidates: 5,
    });

    expect(res.topPeriods[0]?.period).toBe(3);
    expect(res.topPeriods[0]?.meanScore ?? 0).toBeGreaterThan(0.9);
    expect(res.candidates[0]?.period).toBe(3);
    expect(res.candidates[0]?.peakScore ?? 0).toBeGreaterThan(0.9);
  });

  it('detects 2bp periodicity in an AT repeat (purine encoding)', () => {
    const seq = 'AT'.repeat(3000);
    const res = analyzePeriodicity(seq, {
      encoding: 'purine',
      windowSize: 1024,
      stepSize: 1024,
      minPeriod: 1,
      maxPeriod: 10,
      minValidPairs: 200,
      candidateThreshold: 0.95,
      maxTopPeriods: 5,
      maxCandidates: 5,
    });

    expect(res.topPeriods[0]?.period).toBe(2);
    expect(res.topPeriods[0]?.meanScore ?? 0).toBeGreaterThan(0.9);
    expect(res.candidates[0]?.period).toBe(2);
    expect(res.candidates[0]?.peakScore ?? 0).toBeGreaterThan(0.9);
  });
});

