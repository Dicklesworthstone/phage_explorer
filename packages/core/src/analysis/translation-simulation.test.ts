import { describe, expect, it } from 'bun:test';
import { ribosomeTrafficSimulation } from './translation-simulation';

describe('Ribosome traffic simulation', () => {
  it('init > builds a synthetic mRNA when no phage is provided', () => {
    const state = ribosomeTrafficSimulation.init(null, {}, () => 0);
    expect(state.type).toBe('ribosome-traffic');
    expect(state.mRnaId).toBe('Synthetic');
    expect(state.codonRates).toHaveLength(200);
    expect(new Set(state.codonRates)).toEqual(new Set([0.1]));
    expect(state.ribosomes).toEqual([]);
    expect(state.proteinsProduced).toBe(0);
    expect(state.stallEvents).toBe(0);
    expect(state.params.initiationRate).toBeGreaterThan(0);
    expect(state.params.terminationRate).toBeGreaterThan(0);
    expect(state.params.footprint).toBeGreaterThan(0);
  });

  it('step > deterministic stepping with rng=0 initiates one ribosome and advances it', () => {
    const rng = () => 0;
    const s0 = ribosomeTrafficSimulation.init(null, {}, rng);
    const s1 = ribosomeTrafficSimulation.step(s0, 1, rng);
    expect(s1.time).toBeCloseTo(1, 6);
    expect(s1.ribosomes).toEqual([0]);
    expect(s1.proteinsProduced).toBe(0);
    expect(s1.stallEvents).toBe(0);

    const s2 = ribosomeTrafficSimulation.step(s1, 1, rng);
    expect(s2.time).toBeCloseTo(2, 6);
    expect(s2.ribosomes).toEqual([1]);
  });

  it('step > termination removes ribosome at stop codon and increments proteinsProduced', () => {
    const rng = () => 0;
    const base = ribosomeTrafficSimulation.init(null, {}, rng);
    const endPos = base.codonRates.length - 1;
    const state = {
      ...base,
      ribosomes: [endPos],
      params: { ...base.params, initiationRate: 0 },
    };

    const next = ribosomeTrafficSimulation.step(state, 1, rng);
    expect(next.ribosomes).toEqual([]);
    expect(next.proteinsProduced).toBe(1);
  });

  it('step > fractional dt with rng can result in zero discrete steps', () => {
    const rng = () => 1;
    const s0 = ribosomeTrafficSimulation.init(null, {}, () => 0);
    const s1 = ribosomeTrafficSimulation.step(s0, 0.5, rng);
    expect(s1.time).toBeCloseTo(0.5, 6);
    expect(s1.ribosomes).toEqual([]);
  });
});

