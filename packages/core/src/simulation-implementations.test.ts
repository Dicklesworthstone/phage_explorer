import { describe, expect, it } from 'bun:test';
import {
  derivePhageSimDefaults,
  makePackagingSimulation,
  makeEvolutionSimulation,
  makeResistanceSimulation,
  packagingStateAt,
  packagingEnergyPnNm,
  debyeLengthNm,
  PACKAGING_TICK_SECONDS,
  PACKAGING_MAX_TICKS,
  PACKAGING_STALL_VELOCITY,
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
    expect(derivePhageSimDefaults('packaging-motor', MS2).genomeKb).toBe(3.569);
    expect(derivePhageSimDefaults('packaging-motor', PHIKZ).genomeKb).toBe(280.334);
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

  it('uses the cursor energy law at the actually packaged length', () => {
    for (const phage of [MS2, PHIKZ]) {
      const state = pressureAfter(phage, 60);
      const physics = packagingStateAt(state.bpPackaged, phage.genomeLength!, phage.morphology,
        Number(state.params.ionic) / 1000, Number(state.params.capsidRadius));
      expect(state.force).toBe(physics.forcePn);
      expect(state.pressure).toBe(physics.pressureAtm);
      expect(state.fillFraction).toBe(state.bpPackaged / phage.genomeLength!);
    }
  });

  it('lets an explicit caller parameter override the phage-derived value', () => {
    const state = sim.init(PHIKZ, { genomeKb: 42 }, () => 0.5);
    expect(state.params.genomeKb).toBe(42);
  });

  it('still initialises with no phage loaded', () => {
    const state = sim.init(undefined, undefined, () => 0.5);
    expect(state.type).toBe('packaging-motor');
    expect(state.pressure).toBe(0);
    expect(state.fillFraction).toBe(0);
    expect(state.force).toBeGreaterThan(0); // prospective bending load on the first duplex
    expect(state.params).toEqual({ genomeKb: 50, capsidRadius: 30, ionic: 50, mode: 'cos' });
  });
});

describe('packaging motor elapsed time, controls and terminal states', () => {
  const sim = makePackagingSimulation();

  it('preserves zero time, retains partial ticks and applies caller speed only once', () => {
    const initial = sim.init();
    expect(sim.step(initial, 0)).toBe(initial);
    const partial = sim.step(initial, 0.01);
    expect(partial.bpPackaged).toBe(0);
    expect(partial.pendingSteps).toBeCloseTo(0.2, 12);
    expect(partial.time).toBe(0.01);
    const ordinary = sim.step(initial, 4);
    const fast = sim.step({ ...initial, speed: 4 }, 4);
    expect({ ...fast, speed: 1 }).toEqual(ordinary);
  });

  it('reaches identical checkpoints and history across elapsed-time partitions without mutating inputs', () => {
    const initial = sim.init();
    const whole = sim.step(initial, 8);
    let partitioned = initial;
    for (const dt of [0.25, 0.5, 1, 2, 4, 0.25]) partitioned = sim.step(partitioned, dt);
    expect(partitioned).toEqual(whole);
    let decimal = initial;
    for (let i = 0; i < 800; i++) decimal = sim.step(decimal, 0.01);
    expect(decimal).toEqual(whole);
    expect(whole.history.length).toBe(9);
    expect(whole.history.at(-1)?.time).toBe(8);
    expect(initial.bpPackaged).toBe(0);
    expect(initial.history).toHaveLength(1);
  });

  it('uses molar salt units and changes actual motor progress with salt and geometry', () => {
    const low = sim.step(sim.init(undefined, { ionic: 50 }), 30);
    const high = sim.step(sim.init(undefined, { ionic: 200 }), 30);
    expect(high.bpPackaged).toBeGreaterThan(low.bpPackaged);
    expect(high.force).toBeLessThan(low.force);
    expect(high.pressure).toBeLessThan(low.pressure);
    const compact = sim.step(sim.init(undefined, { capsidRadius: 20 }), 30);
    const roomy = sim.step(sim.init(undefined, { capsidRadius: 50 }), 30);
    expect(roomy.bpPackaged).toBeGreaterThan(compact.bpPackaged);
  });

  it('changes motor kinetics and nominal ATP accounting without changing the energy law', () => {
    const cos = sim.init(undefined, { mode: 'cos' });
    const phi29 = sim.init(undefined, { mode: 'phi29' });
    expect(cos.force).toBe(phi29.force);
    expect(cos.pressure).toBe(phi29.pressure);
    expect(cos.velocityBpPerSec).toBeGreaterThan(phi29.velocityBpPerSec);
    const a = sim.step(cos, 10), b = sim.step(phi29, 10);
    expect(a.bpPackaged).toBeGreaterThan(b.bpPackaged);
    expect(a.atpCount).toBe(a.bpPackaged * 0.5);
    expect(b.atpCount).toBe(b.bpPackaged * 0.25);
  });

  it('agrees with an independently integrated continuous motor law within the tick resolution', () => {
    // Fourth-order reference integration at 50x finer time resolution; the
    // product uses midpoint updates. Energy derivatives are checked separately.
    const initial = sim.init(undefined, { genomeKb: 50, capsidRadius: 20, ionic: 50 });
    const rate = (bp: number) => 600 * Math.max(0, 1 - packagingStateAt(bp, 50000, null, 0.05, 20).forcePn / 52);
    let referenceBp = 0;
    const h = 0.001;
    for (let i = 0; i < 5000; i++) {
      const a = rate(referenceBp), b = rate(referenceBp + h * a / 2), c = rate(referenceBp + h * b / 2), d = rate(referenceBp + h * c);
      referenceBp += h * (a + 2 * b + 2 * c + d) / 6;
    }
    expect(Math.abs(sim.step(initial, 5).bpPackaged - referenceBp)).toBeLessThan(0.01);
  });

  it('completes a small genome exactly, stops time and preserves the terminal checkpoint', () => {
    const initial = sim.init(undefined, { genomeKb: 3, capsidRadius: 60, ionic: 200 });
    const final = sim.step(initial, 1000);
    expect(sim.isComplete!(initial)).toBe(false);
    expect(sim.isComplete!(final)).toBe(true);
    expect(final.status).toBe('complete');
    expect(final.running).toBe(false);
    expect(final.bpPackaged).toBe(3000);
    expect(final.fillFraction).toBe(1);
    expect(final.time).toBeGreaterThan(5);
    expect(final.time).toBeLessThan(6);
    expect(final.velocityBpPerSec).toBe(0);
    expect(final.history.at(-1)?.fillFraction).toBe(1);
    expect(sim.step(final, 8)).toBe(final);
  });

  it('reports operational stall without inventing a probability or forcing completion', () => {
    const final = sim.step(sim.init(undefined, { genomeKb: 50, capsidRadius: 20, ionic: 1 }), 1800);
    expect(final.status).toBe('stalled');
    expect(final.running).toBe(false);
    expect(final.fillFraction).toBeLessThan(1);
    expect(final.velocityBpPerSec).toBe(0);
    expect(600 * Math.max(0, 1 - final.force / 52)).toBeLessThan(PACKAGING_STALL_VELOCITY);
    expect('stallProbability' in final).toBe(false);
  });

  it('stops before duplex overlap and preserves exact physical time at the finite horizon', () => {
    const packed = sim.step(sim.init(undefined, { genomeKb: 300, capsidRadius: 10, ionic: 200, mode: 'headful' }), 1800);
    expect(packed.status).toBe('packing-limit');
    expect(packed.running).toBe(false);
    const volume = 4 * Math.PI * 10 ** 3 / 3;
    expect(Math.sqrt(2 * volume / (Math.sqrt(3) * packed.bpPackaged * 0.34))).toBeCloseTo(2, 12);
    const limited = sim.step(sim.init(undefined, { genomeKb: 5000, capsidRadius: 60, ionic: 200, mode: 'phi29' }), 10000);
    expect(limited.status).toBe('time-limit');
    expect(limited.completedSteps).toBe(PACKAGING_MAX_TICKS);
    expect(limited.time).toBe(PACKAGING_MAX_TICKS * PACKAGING_TICK_SECONDS);
    expect(limited.pendingSteps).toBe(0);
    expect(limited.history).toHaveLength(300);
    expect(limited.history.at(-1)?.time).toBe(1800);
    expect(sim.step(limited, 1)).toBe(limited);
  });

  it('rejects unsupported controls and stale or nonfinite checkpoints', () => {
    for (const parameters of [{ ionic: 0 }, { ionic: NaN }, { capsidRadius: Infinity }, { genomeKb: -1 },
      { genomeKb: '50' }, { mode: 'unknown' }, { stall: 0.02 }]) expect(() => sim.init(undefined, parameters)).toThrow();
    const initial = sim.init();
    for (const dt of [-1, NaN, Infinity, 10001]) expect(() => sim.step(initial, dt)).toThrow(/delta/);
    expect(() => sim.step({ ...initial, modelVersion: 1 } as unknown as PackagingMotorState, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, params: { ...initial.params, capsidRadius: 40 } }, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, bpPackaged: NaN }, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, velocityBpPerSec: NaN }, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, speed: Infinity }, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, status: 'complete', running: false }, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, history: [{ ...initial.history[0], pressure: NaN }] }, 1)).toThrow(/checkpoint/);
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
  it('names and sizes the mRNA from the exact annotated coding sequence', () => {
    const genomeSequence = 'N'.repeat(100) + 'ATG'.repeat(299) + 'TAA';
    const phage = makePhage({
      genomeLength: genomeSequence.length,
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

    const state = ribosomeTrafficSimulation.init(phage, {}, () => 0.5, { genomeSequence });
    expect(state.mRnaId).toBe('repressor protein cI');
    expect(state.transcript?.cds).toBe(genomeSequence.slice(100));
    expect(state.source).toBe('annotated-cds');
    expect(state.codonRates).toHaveLength(300);
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

  it('retains the illustrative force scale without claiming biological calibration', () => {
    // Regression range for the retained phenomenological amplitude. Independent
    // derivative checks below establish numerical correctness, not biology.
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

  it('derives interaxial spacing from hexagonal volume conservation', () => {
    const lambda = packagingStateAt(LAMBDA_BP, LAMBDA_BP, 'siphovirus');
    const reconstructedVolume = Math.sqrt(3) / 2 * lambda.spacingNm! ** 2 * LAMBDA_BP * 0.34;
    expect(reconstructedVolume).toBeCloseTo(4 * Math.PI * 29 ** 3 / 3, 8);
  });

  it('matches separate fixed-volume force and fixed-length pressure derivatives', () => {
    // Perturb contour length and capsid volume separately. A force/portal-area
    // estimate of internal pressure cannot pass these independent derivatives.
    for (const fill of [0.01, 0.25, 0.8]) {
      const bp = LAMBDA_BP * fill, radius = 29, ionic = 0.1;
      const state = packagingStateAt(bp, LAMBDA_BP, null, ionic, radius);
      const hNm = 0.01;
      const derivativeL = (packagingEnergyPnNm(bp + hNm / 0.34, LAMBDA_BP, radius, ionic)
        - packagingEnergyPnNm(bp - hNm / 0.34, LAMBDA_BP, radius, ionic)) / (2 * hNm);
      expect(state.forcePn).toBeCloseTo(derivativeL, 6);
      const volume = 4 * Math.PI * radius ** 3 / 3, hVolume = volume * 1e-5;
      const radiusForVolume = (v: number) => Math.cbrt(3 * v / (4 * Math.PI));
      const derivativeV = -(packagingEnergyPnNm(bp, LAMBDA_BP, radiusForVolume(volume + hVolume), ionic)
        - packagingEnergyPnNm(bp, LAMBDA_BP, radiusForVolume(volume - hVolume), ionic)) / (2 * hVolume);
      expect(state.pressureAtm).toBeCloseTo(derivativeV * 1e6 / 101325, 6);
      expect(state.pressureAtm).not.toBeCloseTo(state.forcePn / (Math.PI * 1.8 ** 2) * 1e6 / 101325, 4);
    }
  });

  it('has the thin-shell limit and the independently evaluated full-shell derivative', () => {
    const radius = 29, length = LAMBDA_BP * 0.34, volume = 4 * Math.PI * radius ** 3 / 3;
    const bareBend = 50 * 4.11 / (2 * radius ** 2);
    expect(packagingStateAt(LAMBDA_BP * 1e-14, LAMBDA_BP, null, 0.1, radius).forcePn).toBeCloseTo(bareBend, 12);
    const empty = packagingStateAt(0, LAMBDA_BP, null, 0.1, radius);
    expect(empty.forcePn).toBe(bareBend);
    expect(empty.pressureAtm).toBe(0);
    expect(empty.spacingNm).toBeNull();
    // At phi=1, r_eff=3R/4 and dr_eff/dphi=-3R/4, hence F_b=3 E_b/L.
    const bendPerNm = 50 * 4.11 / (2 * (0.75 * radius) ** 2);
    const spacing = Math.sqrt(2 * volume / (Math.sqrt(3) * length));
    const lambda = 0.304 / Math.sqrt(0.1), interaction = 380.84 * Math.exp(-spacing / lambda);
    const full = packagingStateAt(LAMBDA_BP, LAMBDA_BP, null, 0.1, radius);
    expect(full.forcePn).toBeCloseTo(3 * bendPerNm + interaction * (1 + spacing / (2 * lambda)), 10);
    expect(full.pressureAtm).toBeCloseTo(length / volume * (2 * bendPerNm / 3 + interaction * spacing / (2 * lambda)) * 1e6 / 101325, 10);
  });

  it('rejects nonfinite or unsupported energy domains without manufacturing finite results', () => {
    for (const ionic of [0, -1, NaN, Infinity]) expect(() => debyeLengthNm(ionic)).toThrow();
    expect(() => packagingEnergyPnNm(-1, 100, 30, 0.1)).toThrow();
    expect(() => packagingEnergyPnNm(101, 100, 30, 0.1)).toThrow();
    expect(() => packagingStateAt(NaN, 100)).toThrow();
    expect(() => packagingStateAt(10, 100, null, 0.1, Infinity)).toThrow();
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

describe('resistance transition conservation and elapsed time', () => {
  const sim = makeResistanceSimulation();
  const parameters = {
    cocktailSize: 1, initialBacteria: 1000, initialPhage: 1e6, carryingCap: 1e9,
    growthRate: 0, infectionRate: 1e-7, burstSize: 10, latentPeriod: 1,
    mutationRate: 0, multiResRate: 0, phageDecay: 0,
  };
  const seeded = (seed: number) => {
    let cursor = seed;
    return () => {
      cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
      return cursor / 2 ** 32;
    };
  };

  it('moves one cell and one virion into an infected pool without an immediate burst', () => {
    // lambda=k*S*P*tau=1; with draws 1/2, Knuth returns floor(1/ln(2))=1.
    const initial = sim.init(null, parameters);
    const snapshot = JSON.parse(JSON.stringify(initial));
    const result = sim.step(initial, 1, () => 0.5);
    expect(result.sensitiveBacteria).toBe(999);
    expect(result.infectedByPhage).toEqual([1]);
    expect(result.phageCounts).toEqual([999999]);
    expect(result.sensitiveBacteria + result.infectedByPhage[0]).toBe(1000);
    expect(result.phageCounts[0] + result.infectedByPhage[0]).toBe(1e6);
    expect(initial).toEqual(snapshot);
  });

  it('protects R_i against i while retaining susceptibility to other members', () => {
    const initial = sim.init(null, { ...parameters, cocktailSize: 2, initialBacteria: 0, initialPhage: 0 });
    initial.partialResistant = [1000, 0];
    const protectedResult = sim.step({ ...initial, phageCounts: [1e6, 0] }, 1, () => 0.5);
    const exposedResult = sim.step({ ...initial, phageCounts: [0, 1e6] }, 1, () => 0.5);
    expect(protectedResult.partialResistant).toEqual([1000, 0]);
    expect(protectedResult.infectedByPhage).toEqual([0, 0]);
    expect(exposedResult.partialResistant).toEqual([999, 0]);
    expect(exposedResult.infectedByPhage).toEqual([0, 1]);
    expect(exposedResult.phageCounts).toEqual([0, 999999]);
  });

  it('keeps fully resistant cells outside every adsorption channel', () => {
    const initial = sim.init(null, { ...parameters, cocktailSize: 3, initialBacteria: 0 });
    initial.fullyResistant = 1000;
    const result = sim.step(initial, 1, () => 0.5);
    expect(result.fullyResistant).toBe(1000);
    expect(result.infectedByPhage).toEqual([0, 0, 0]);
    expect(result.phageCounts).toEqual(initial.phageCounts);
    expect(sim.getSummary(result)).not.toContain('CLEARED');
  });

  it('continues lysis after free phage reaches zero and releases burst-size progeny per lysed cell', () => {
    const initial = sim.init(null, { ...parameters, initialBacteria: 0, initialPhage: 0 });
    initial.infectedByPhage = [1000];
    expect(sim.isComplete!(initial)).toBe(false);
    const result = sim.step(initial, 1, () => 0.5);
    // lambda=1000*0.01/1=10; floor(10/ln(2))=14 lysis events.
    expect(result.infectedByPhage).toEqual([986]);
    expect(result.phageCounts).toEqual([140]);
    expect(result.phageCounts[0]).toBe((1000 - result.infectedByPhage[0]) * parameters.burstSize);
  });

  it('counts infected cells in carrying capacity and does not let them divide', () => {
    const initial = sim.init(null, { ...parameters, initialBacteria: 1e6, initialPhage: 1,
      carryingCap: 2e6, growthRate: 0.5, infectionRate: 0 });
    initial.infectedByPhage = [1e6];
    const result = sim.step(initial, 1, () => 0);
    expect(result.sensitiveBacteria).toBe(1e6);
    expect(result.infectedByPhage[0]).toBe(990000);
    expect(result.phageCounts[0]).toBe(100001);
  });

  it('makes mono-phage resistance full resistance after a single mutation', () => {
    const initial = sim.init(null, { ...parameters, initialBacteria: 1e8, initialPhage: 1,
      infectionRate: 0, mutationRate: 1e-5 });
    const result = sim.step(initial, 1, () => 0.5);
    expect(result.partialResistant).toEqual([0]);
    expect(result.fullyResistant).toBe(14);
    expect(result.sensitiveBacteria + result.fullyResistant).toBe(initial.sensitiveBacteria);
  });

  it('retains the first resistance-threshold event after the resistant population decreases', () => {
    const initial = sim.init(null, parameters);
    initial.resistanceEmerged = true;
    initial.resistanceTime = 0;
    const result = sim.step(initial, 1, () => 0.5);
    expect(result.resistanceEmerged).toBe(true);
    expect(result.resistanceTime).toBe(0);
  });

  it('does not consume randomness or run reactions for incomplete discrete ticks', () => {
    const initial = sim.init(null, parameters);
    let draws = 0;
    const rng = () => { draws++; return 0.5; };
    expect(sim.step(initial, 0, rng)).toBe(initial);
    const partial = sim.step(initial, 0.25, rng);
    expect(draws).toBe(0);
    expect(partial.pendingSteps).toBe(0.25);
    expect(partial.simTime).toBe(0);
    expect(partial.phageCounts).toEqual(initial.phageCounts);
  });

  it('reproduces identical full states for GUI and decimal step partitions', () => {
    const initial = sim.init(null);
    const whole = sim.step(initial, 8, seeded(42));
    let gui = initial;
    const guiRng = seeded(42);
    for (const delta of [0.25, 0.5, 1, 2, 4, 0.25]) gui = sim.step(gui, delta, guiRng);
    expect(gui).toEqual(whole);
    let decimal = initial;
    const decimalRng = seeded(42);
    for (let index = 0; index < 80; index++) decimal = sim.step(decimal, 0.1, decimalRng);
    expect(decimal).toEqual(whole);
  });

  it('applies caller speed through dt exactly once', () => {
    const initial = sim.init(null);
    const ordinary = sim.step(initial, 4, seeded(9));
    const fast = sim.step({ ...initial, speed: 4 }, 4, seeded(9));
    expect({ ...fast, speed: 1 }).toEqual(ordinary);
    expect(fast.simTime).toBe(0.04);
  });

  it('terminates exactly at 48 hours even if a caller keeps stepping', () => {
    const initial = sim.init(null, { ...parameters, infectionRate: 0 });
    const last = { ...initial, completedSteps: 4799, time: 4799, simTime: 4799 * 0.01 };
    const result = sim.step(last, 8, () => 0.5);
    expect(result.completedSteps).toBe(4800);
    expect(result.simTime).toBe(48);
    expect(result.time).toBe(4800);
    expect(result.running).toBe(false);
    expect(result.history.at(-1)?.t).toBe(48);
    expect(sim.step(result, 8, () => { throw new Error('Terminal run drew RNG'); })).toEqual(result);
  });

  it('handles zero-valued random draws and supported high competing hazards without invalid populations', () => {
    const initial = sim.init(null, { cocktailSize: 5, initialBacteria: 1e9, initialPhage: 1e10,
      carryingCap: 1e10, growthRate: 2, infectionRate: 1e-7, burstSize: 500, latentPeriod: 0.1 });
    const result = sim.step(initial, 1, () => 0);
    for (const count of [result.sensitiveBacteria, result.fullyResistant, ...result.partialResistant,
      ...result.infectedByPhage, ...result.phageCounts]) {
      expect(Number.isSafeInteger(count)).toBe(true);
      expect(count).toBeGreaterThanOrEqual(0);
    }
    expect(result.simTime).toBe(0.01);
  });

  it('preserves particle accounting in the no-growth, no-infection lysis limit', () => {
    const initial = sim.init(null, { ...parameters, initialBacteria: 0, initialPhage: 0, infectionRate: 0, burstSize: 1 });
    initial.infectedByPhage = [1e6];
    let state = initial;
    for (let index = 0; index < 100; index++) state = sim.step(state, 1, () => 0);
    expect(state.infectedByPhage[0] + state.phageCounts[0]).toBe(1e6);
    // Zero Box-Muller draws select rounded means. Per-step rounding is <=0.5,
    // while the independent Euler limit is I0*(1-tau/mean)^100.
    expect(Math.abs(state.infectedByPhage[0] - 1e6 * 0.99 ** 100)).toBeLessThan(50);
    expect(Math.abs(state.infectedByPhage[0] - 1e6 * Math.exp(-1))).toBeLessThan(2000);
  });

  it('rejects fractional particles, stale array shapes, invalid deltas and invalid RNG output', () => {
    for (const params of [{ initialBacteria: 1000.5 }, { initialPhage: 1000.5 }, { burstSize: 10.5 }]) {
      expect(() => sim.init(null, { ...parameters, ...params })).toThrow(/integer/);
    }
    const initial = sim.init(null, parameters);
    expect(() => sim.step({ ...initial, infectedByPhage: [] }, 1)).toThrow(/checkpoint/);
    expect(() => sim.step({ ...initial, params: { ...initial.params, cocktailSize: 2 } }, 1)).toThrow(/checkpoint/);
    for (const delta of [-1, NaN, Infinity, 10001]) expect(() => sim.step(initial, delta)).toThrow(/delta/);
    for (const draw of [-1, 1, NaN]) expect(() => sim.step(initial, 1, () => draw)).toThrow(/RNG/);
  });
});
