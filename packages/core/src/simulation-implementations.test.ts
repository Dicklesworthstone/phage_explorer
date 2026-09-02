import { describe, expect, it } from 'bun:test';
import {
  derivePhageSimDefaults,
  makePackagingSimulation,
  makeEvolutionSimulation,
} from './simulation-implementations';
import { ribosomeTrafficSimulation } from './analysis/translation-simulation';
import type { PhageFull } from './types';
import type { EvolutionReplayState, PackagingMotorState } from './simulation';

/**
 * These tests pin down that a simulation's output actually depends on the
 * phage the user selected. Before the phage was threaded through the web
 * worker, every one of them would have failed: packaging pressure was
 * identical for a 3.5 kb and a 280 kb genome, evolution replay drew mutation
 * positions from a hardcoded 50 kb and emitted nothing but A->G, and ribosome
 * traffic always built a 200-codon synthetic mRNA.
 */

function makePhage(overrides: Partial<PhageFull>): PhageFull {
  return {
    id: 1,
    slug: 'test',
    name: 'Test phage',
    accession: 'NC_000000',
    family: null,
    host: null,
    genomeLength: 48502,
    gcContent: 49.9,
    morphology: 'siphovirus',
    lifecycle: 'lysogenic',
    description: null,
    baltimoreGroup: null,
    genomeType: null,
    pdbIds: [],
    genes: [],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

// Real catalogue extremes: the smallest and largest genomes Phage Explorer ships.
const MS2 = makePhage({
  id: 5,
  slug: 'ms2',
  name: 'Enterobacteria phage MS2',
  genomeLength: 3569,
  gcContent: 51.7,
  morphology: 'levivirus',
});

const PHIKZ = makePhage({
  id: 20,
  slug: 'phikz',
  name: 'Pseudomonas phage phiKZ',
  genomeLength: 280334,
  gcContent: 36.8,
  morphology: 'myovirus',
});

describe('derivePhageSimDefaults', () => {
  it('returns nothing when no phage is loaded, so generic defaults survive', () => {
    expect(derivePhageSimDefaults('packaging-motor', null)).toEqual({});
    expect(derivePhageSimDefaults('packaging-motor', undefined)).toEqual({});
  });

  it('derives genome size in kb from the real genome length', () => {
    expect(derivePhageSimDefaults('packaging-motor', MS2).genomeKb).toBeCloseTo(3.6, 5);
    expect(derivePhageSimDefaults('packaging-motor', PHIKZ).genomeKb).toBeCloseTo(280.3, 5);
  });

  it('derives capsid radius from morphology, not a single constant', () => {
    const small = derivePhageSimDefaults('packaging-motor', MS2).capsidRadius;
    const large = derivePhageSimDefaults('packaging-motor', PHIKZ).capsidRadius;
    expect(small).toBe(13);
    expect(large).toBe(45);
    expect(small).not.toBe(large);
  });

  it('falls back to a generic capsid radius for a morphology with no published value', () => {
    const filamentous = makePhage({ morphology: 'filamentous', genomeLength: 6407 });
    expect(derivePhageSimDefaults('packaging-motor', filamentous).capsidRadius).toBe(30);
  });

  it('contributes nothing for simulations that take no phage-derived geometry', () => {
    expect(derivePhageSimDefaults('plaque-automata', PHIKZ)).toEqual({});
    expect(derivePhageSimDefaults('lysogeny-circuit', PHIKZ)).toEqual({});
  });
});

describe('packaging-motor uses the selected phage', () => {
  const sim = makePackagingSimulation();

  function pressureAfter(phage: PhageFull | null, steps: number): PackagingMotorState {
    let state = sim.init(phage ?? undefined, undefined, () => 0.5);
    for (let i = 0; i < steps; i++) state = sim.step(state, 1, () => 0.5);
    return state;
  }

  it('produces different physics for the smallest and largest genomes', () => {
    const small = pressureAfter(MS2, 60);
    const large = pressureAfter(PHIKZ, 60);
    expect(large.pressure).not.toBeCloseTo(small.pressure, 3);
    expect(large.force).not.toBeCloseTo(small.force, 3);
  });

  it('packs a jumbo genome to a higher pressure than a tiny one at equal fill', () => {
    const small = pressureAfter(MS2, 60);
    const large = pressureAfter(PHIKZ, 60);
    expect(large.fillFraction).toBeCloseTo(small.fillFraction, 6);
    expect(large.pressure).toBeGreaterThan(small.pressure);
  });

  it('lets an explicit caller parameter override the phage-derived value', () => {
    const state = sim.init(PHIKZ, { genomeKb: 42 }, () => 0.5);
    expect(state.params.genomeKb).toBe(42);
  });

  it('still initialises with no phage loaded', () => {
    const state = sim.init(undefined, undefined, () => 0.5);
    expect(state.type).toBe('packaging-motor');
    expect(state.pressure).toBeGreaterThan(0);
  });
});

describe('evolution-replay uses the selected phage', () => {
  const sim = makeEvolutionSimulation();

  function run(phage: PhageFull | null, steps: number): EvolutionReplayState {
    // A cycling rng exercises every branch of the substitution draw.
    let i = 0;
    const rng = () => {
      i += 1;
      return (i % 97) / 97;
    };
    let state = sim.init(phage ?? undefined, { mutRate: 1 }, rng);
    for (let s = 0; s < steps; s++) state = sim.step(state, 1, rng);
    return state;
  }

  it('records the real genome length and GC content on the state', () => {
    const state = sim.init(MS2, undefined, () => 0.5);
    expect(state.genomeLength).toBe(3569);
    // GC is stored as a percentage in the catalogue and normalised to a fraction.
    expect(state.gcContent).toBeCloseTo(0.517, 6);
  });

  it('never places a mutation outside a small real genome', () => {
    const state = run(MS2, 40);
    expect(state.mutations.length).toBeGreaterThan(0);
    for (const m of state.mutations) {
      expect(m.position).toBeGreaterThanOrEqual(1);
      expect(m.position).toBeLessThanOrEqual(3569);
    }
  });

  it('spreads mutations across a jumbo genome rather than a fixed 50 kb window', () => {
    const state = run(PHIKZ, 60);
    const maxPos = Math.max(...state.mutations.map(m => m.position));
    expect(maxPos).toBeGreaterThan(50000);
    expect(maxPos).toBeLessThanOrEqual(280334);
  });

  it('emits a spectrum of substitutions, not a single hardcoded pair', () => {
    const state = run(PHIKZ, 60);
    const kinds = new Set(state.mutations.map(m => `${m.from}>${m.to}`));
    expect(kinds.size).toBeGreaterThan(1);
    for (const m of state.mutations) {
      expect(['A', 'C', 'G', 'T']).toContain(m.from);
      expect(['A', 'C', 'G', 'T']).toContain(m.to);
      expect(m.from).not.toBe(m.to);
    }
  });

  it('falls back to a 50 kb genome when nothing is loaded', () => {
    const state = sim.init(undefined, undefined, () => 0.5);
    expect(state.genomeLength).toBe(50000);
    expect(state.gcContent).toBe(0.5);
  });

  it('the in-bounds assertion is discriminating, not vacuously true', () => {
    // Guards the guard: with no phage the simulation draws across the generic
    // 50 kb fallback, which is exactly what the pre-fix code did for every
    // phage. If positions here did NOT exceed MS2's 3,569 bp, the MS2
    // in-bounds test above would prove nothing.
    const state = run(null, 40);
    const maxPos = Math.max(...state.mutations.map(m => m.position));
    expect(maxPos).toBeGreaterThan(3569);
  });
});

describe('ribosome-traffic uses the selected phage', () => {
  it('names the mRNA after a real gene and sizes it from that gene', () => {
    const phage = makePhage({
      genes: [
        {
          id: 1,
          name: 'cI',
          locusTag: 'lambdap88',
          startPos: 100,
          endPos: 1000,
          strand: '+',
          product: 'repressor protein cI',
          geneType: 'CDS',
          qualifiers: null,
        },
      ] as PhageFull['genes'],
      codonUsage: {
        phageId: 1,
        aminoAcidCounts: {},
        codonCounts: { AAA: 10, GGG: 90, TTT: 50 },
      } as PhageFull['codonUsage'],
    });

    const state = ribosomeTrafficSimulation.init(phage, {}, () => 0.5);
    expect(state.mRnaId).toBe('repressor protein cI');
    expect(state.codonRates.length).toBeGreaterThan(0);
    expect(state.codonRates.length).not.toBe(200);
  });

  it('still builds a synthetic mRNA when no phage is supplied', () => {
    const state = ribosomeTrafficSimulation.init(null, {}, () => 0.5);
    expect(state.mRnaId).toBe('Synthetic');
    expect(state.codonRates).toHaveLength(200);
  });
});
