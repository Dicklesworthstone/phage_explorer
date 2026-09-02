import { describe, expect, it } from 'bun:test';
import {
  derivePhageSimDefaults,
  makePackagingSimulation,
  makeEvolutionSimulation,
  packagingStateAt,
  debyeLengthNm,
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
          type: 'CDS',
        },
      ],
      codonUsage: {
        aaCounts: { K: 10, G: 90, F: 50 },
        codonCounts: { AAA: 10, GGG: 90, TTT: 50 },
      },
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

/**
 * DNA packaging physics.
 *
 * The overlay computed `force = 5 + 50*phi^3` and
 * `pressure = min(60, 5 + 55*phi)`. Nothing but genome length and cursor
 * position entered either. Meanwhile the README described "Physics-informed DNA
 * packaging" with "Intrinsic pressure from DNA bending: L/(R^2) energy model"
 * and "Ionic strength effects (Debye screening ~0.304/sqrt(I) nm)", none of
 * which existed anywhere in the code.
 *
 * The model now exists. These tests check it behaves like the physics it claims
 * to be, and check the specific acceptance criterion: output must differ across
 * morphologies at equal genome length.
 */
describe('packaging physics', () => {
  const LAMBDA_BP = 48502;

  it('differs across morphologies at equal genome length', () => {
    // The acceptance criterion, and the whole point: capsid radius enters the
    // model, so the same DNA in a bigger head is under less pressure. The old
    // closed form could not distinguish these at all.
    const podo = packagingStateAt(40000, 40000, 'podovirus');
    const sipho = packagingStateAt(40000, 40000, 'siphovirus');
    const myo = packagingStateAt(40000, 40000, 'myovirus');

    expect(podo.forcePn).not.toBeCloseTo(myo.forcePn, 1);
    expect(sipho.forcePn).not.toBeCloseTo(myo.forcePn, 1);
    // A myovirus head is much larger, so the same genome packs loosely.
    expect(myo.forcePn).toBeLessThan(podo.forcePn);
    expect(myo.capsidRadiusNm).toBeGreaterThan(podo.capsidRadiusNm);
  });

  it('lands in the measured force range at full packing', () => {
    // Optical tweezers give ~57 pN for phages of this class. One constant is
    // fitted to that, so this is partly a self-check -- but the model must not
    // be free to wander an order of magnitude away for other genomes, and this
    // is what notices if it does.
    const lambda = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus');
    expect(lambda.forcePn).toBeGreaterThan(30);
    expect(lambda.forcePn).toBeLessThan(90);

    const t4 = packagingStateAt(168903, 168903, 'myovirus');
    expect(t4.forcePn).toBeGreaterThan(10);
    expect(t4.forcePn).toBeLessThan(150);
  });

  it('rises steeply with fill rather than linearly', () => {
    // The measured force curve is flat early and climbs sharply past about half
    // packing. A linear ramp -- which is what the old `5 + 55*phi` was -- gets
    // the endpoints right and the physics wrong.
    const q = packagingStateAt(LAMBDA_BP * 0.25, LAMBDA_BP, 'siphovirus').forcePn;
    const h = packagingStateAt(LAMBDA_BP * 0.5, LAMBDA_BP, 'siphovirus').forcePn;
    const f = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus').forcePn;

    expect(h - q).toBeGreaterThan(0);
    expect(f - h).toBeGreaterThan((h - q) * 1.5);
  });

  it('reproduces the measured interaxial DNA spacing', () => {
    // An independent check: the spacing is computed on the way to the force and
    // is not fitted to anything. Tightly packed phage heads measure 2.5-2.8 nm.
    const lambda = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus');
    expect(lambda.spacingNm).toBeGreaterThan(2.3);
    expect(lambda.spacingNm).toBeLessThan(3.0);
  });

  it('gives a pressure consistent with the force and the portal geometry', () => {
    // ~57 pN through the portal channel is the standard route to the ~6 MPa
    // (~60 atm) figure quoted for phage heads.
    const lambda = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus');
    expect(lambda.pressureAtm).toBeGreaterThan(20);
    expect(lambda.pressureAtm).toBeLessThan(120);
  });

  it('responds to ionic strength through the Debye length', () => {
    // The README's headline claim. Lower salt means weaker screening, stronger
    // repulsion between neighbouring duplexes, and a harder push.
    const low = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus', 0.02);
    const high = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus', 0.4);

    expect(low.debyeNm).toBeGreaterThan(high.debyeNm);
    expect(low.forcePn).toBeGreaterThan(high.forcePn);
  });

  it('matches the quoted Debye formula', () => {
    // 0.304/sqrt(I) nm, exactly as the README states.
    expect(debyeLengthNm(0.1)).toBeCloseTo(0.304 / Math.sqrt(0.1), 6);
    expect(debyeLengthNm(1)).toBeCloseTo(0.304, 6);
  });

  it('starts at the bare bending cost and rises monotonically', () => {
    const points = [0, 0.2, 0.4, 0.6, 0.8, 1].map(
      f => packagingStateAt(LAMBDA_BP * f, LAMBDA_BP, 'siphovirus').forcePn
    );

    // At zero fill the first duplex is bent to the capsid wall and nothing else
    // is inside, so the force is the pure bending term xi_p*kT/(2R^2). For
    // R = 29 nm that is 50*4.11/(2*29^2) = 0.122 pN. This is an independent
    // check on the bending term: nothing was fitted to produce it.
    expect(points[0]).toBeCloseTo((50 * 4.11) / (2 * 29 * 29), 3);

    for (let i = 1; i < points.length; i++) {
      expect(points[i]).toBeGreaterThanOrEqual(points[i - 1]);
    }
  });

  it('handles a zero-length genome without producing NaN', () => {
    const s = packagingStateAt(0, 0, 'siphovirus');
    expect(Number.isFinite(s.forcePn)).toBe(true);
    expect(s.forcePn).toBe(0);
    expect(Number.isFinite(s.pressureAtm)).toBe(true);
  });
});
