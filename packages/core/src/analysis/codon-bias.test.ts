import { describe, expect, it } from 'bun:test';
import {
  CODON_FAMILIES,
  analyzeCodonBias,
  computeEffectiveNumberOfCodons,
  computeGC3,
  computeRSCU,
} from './codon-bias';

describe('Codon bias', () => {
  it('computeGC3 > computes GC fraction at third codon position', () => {
    // AAA (A), GGG (G), CCC (C) => 2/3 are G/C at third base.
    expect(computeGC3('AAAGGGCCC')).toBeCloseTo(2 / 3, 6);
    expect(computeGC3('')).toBe(0);
  });

  it('computeRSCU > computes expected values for a simple 2-codon family (F: TTT/TTC)', () => {
    const rscu = computeRSCU({ TTT: 10, TTC: 0 });
    const ttt = rscu.find((r) => r.codon === 'TTT');
    const ttc = rscu.find((r) => r.codon === 'TTC');

    expect(ttt).toBeDefined();
    expect(ttc).toBeDefined();
    expect(ttt?.rscu).toBeCloseTo(2, 6);
    expect(ttt?.frequency).toBe(1);
    expect(ttt?.isPreferred).toBe(true);
    expect(ttc?.rscu).toBe(0);
    expect(ttc?.frequency).toBe(0);
    expect(ttc?.isPreferred).toBe(false);
  });

  it('computeEffectiveNumberOfCodons > decreases for more biased synonymous usage', () => {
    const uniformCounts: Record<string, number> = {};
    const biasedCounts: Record<string, number> = {};

    for (const codons of Object.values(CODON_FAMILIES)) {
      for (const codon of codons) {
        uniformCounts[codon] = 10;
      }
      const first = codons[0];
      if (first) biasedCounts[first] = 10;
    }

    const ncUniform = computeEffectiveNumberOfCodons(computeRSCU(uniformCounts));
    const ncBiased = computeEffectiveNumberOfCodons(computeRSCU(biasedCounts));
    expect(ncUniform).toBeGreaterThan(ncBiased);
    expect(ncUniform).toBeLessThanOrEqual(61);
    expect(ncBiased).toBeGreaterThanOrEqual(20);
  });

  it('analyzeCodonBias > flags preferred codons for strong single-codon usage', () => {
    const seq = 'TTT'.repeat(5);
    const bias = analyzeCodonBias(seq);

    expect(bias.totalCodons).toBe(5);
    expect(bias.gcContent).toBe(0);
    expect(bias.gc3Content).toBe(0);
    expect(bias.preferredCodons).toContain('TTT');
    expect(bias.avoidedCodons).toContain('TTC');
    expect(bias.biasScore).toBeGreaterThanOrEqual(0);
    expect(bias.biasScore).toBeLessThanOrEqual(1);
  });
});

