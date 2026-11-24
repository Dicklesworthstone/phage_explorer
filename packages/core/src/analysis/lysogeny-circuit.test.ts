import { describe, expect, it } from 'bun:test';
import {
  calculateOperatorOccupancy,
  calculateDerivatives,
  simulateSwitchStep,
  computeCircuitPhasePortrait,
  computeNullclines,
  computeAttractors,
  calculateQuasiSteadyState,
  LYSOGENY_PHASE_LIMITS,
  predictLysogenyFate,
  findRegulatoryElements,
  reconstructLysogenyCircuit,
  deriveLysogenyCircuitParams,
} from './lysogeny-circuit';
import { derivePhageSimDefaults, makeLysogenySimulation } from '../simulation-implementations';
import type { PhageFull, GeneInfo } from '../types';

function mockGene(overrides: Partial<GeneInfo>): GeneInfo {
  return {
    id: 1,
    name: 'gene',
    locusTag: 'LT_001',
    startPos: 100,
    endPos: 500,
    strand: '+',
    product: 'hypothetical protein',
    type: 'CDS',
    ...overrides,
  };
}

function mockPhage(overrides: Partial<PhageFull>): PhageFull {
  return {
    id: 1,
    slug: 'test-phage',
    name: 'Test Phage',
    accession: 'NC_000001',
    family: 'Siphoviridae',
    host: 'Escherichia coli',
    genomeLength: 48502,
    gcContent: 50.0,
    morphology: 'siphovirus',
    lifecycle: 'temperate',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Lysogeny Decision Circuit - Shea-Ackers Operator Occupancy', () => {
  it('computes free operators and high PR activity when CI and Cro are near zero', () => {
    const occ = calculateOperatorOccupancy(0.01, 0.01);
    expect(occ.partitionZ).toBeGreaterThanOrEqual(1.0);
    expect(occ.or1Ci).toBeLessThan(0.05);
    expect(occ.or2Ci).toBeLessThan(0.05);
    expect(occ.or3Ci).toBeLessThan(0.05);
    // PR (lytic operon) is active when OR1 and OR2 are free
    expect(occ.prActivity).toBeGreaterThan(0.9);
    // PRM (lysogenic repressor maintenance) requires CI at OR2, so basal only
    expect(occ.prmActivity).toBeLessThan(0.1);
  });

  it('activates PRM and represses PR when CI is elevated (lysogenic state)', () => {
    const occ = calculateOperatorOccupancy(1.5, 0.1);
    // OR1 and OR2 should be occupied due to high affinity and cooperativity
    expect(occ.or1Ci).toBeGreaterThan(0.7);
    expect(occ.or2Ci).toBeGreaterThan(0.6);
    // PRM transcription is stimulated
    expect(occ.prmActivity).toBeGreaterThan(0.5);
    // PR transcription is strongly repressed
    expect(occ.prActivity).toBeLessThan(0.15);
  });

  it('represses PRM when Cro is elevated', () => {
    const occ = calculateOperatorOccupancy(0.2, 2.0);
    expect(occ.orCro).toBeGreaterThan(0.5);
    expect(occ.prmActivity).toBeLessThan(0.05);
  });
});

describe('Lysogeny Decision Circuit - ODE Derivatives & Simulation Steps', () => {
  it('preserves all concentrations at zero elapsed time without artificial ceilings', () => {
    const initial = { ci: 6, cro: 8, cII: 4, recAStar: 9 };
    const next = simulateSwitchStep(initial, 0);
    for (const key of ['ci', 'cro', 'cII', 'recAStar'] as const) expect(next[key]).toBe(initial[key]);
  });

  it('integrates the complete requested interval against the independent RecA solution', () => {
    // R(t) = 50 UV + (R(0) - 50 UV) exp(-0.2t), independent of the other proteins.
    const initial = { ci: 0.3, cro: 0.2, cII: 0.1, recAStar: 7 };
    for (const dt of [0.001, 0.1, 2, 20]) {
      const next = simulateSwitchStep(initial, dt, { uv: 0.8 });
      expect(next.recAStar).toBeCloseTo(40 + (7 - 40) * Math.exp(-0.2 * dt), 5);
      expect(next.occupancy).toEqual(calculateOperatorOccupancy(next.ci, next.cro, { uv: 0.8 }));
    }
  });

  it('converges to the same coupled trajectory when elapsed time is partitioned', () => {
    const initial = { ci: 1.8, cro: 0.2, cII: 0.3, recAStar: 0 };
    const params = { uv: 0.7, moi: 3.5 };
    const whole = simulateSwitchStep(initial, 4, params);
    let partitioned = initial;
    for (let i = 0; i < 400; i++) partitioned = simulateSwitchStep(partitioned, 0.01, params);
    for (const key of ['ci', 'cro', 'cII', 'recAStar'] as const) {
      expect(whole[key]).toBeCloseTo(partitioned[key], 5);
      expect(whole[key]).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects invalid time, concentration and kinetic parameters instead of clipping them', () => {
    const initial = { ci: 1, cro: 1 };
    for (const dt of [-1, NaN, Infinity, 10001]) expect(() => simulateSwitchStep(initial, dt)).toThrow();
    for (const ci of [-1, NaN, Infinity]) expect(() => simulateSwitchStep({ ci, cro: 1 }, 0.1)).toThrow();
    for (const params of [{ kdCiOr1: 0 }, { kdCroOr: -1 }, { decay: -1 }, { moi: NaN }, { hill: 0 }]) {
      expect(() => simulateSwitchStep(initial, 0.1, params)).toThrow();
      expect(() => calculateDerivatives(initial, params)).toThrow();
    }
  });

  it('exhibits bistable convergence to lysogenic attractor when initialized with high CI', () => {
    let state: ReturnType<typeof simulateSwitchStep> | { ci: number; cro: number; cII: number; recAStar: number; phase?: string } = { ci: 1.8, cro: 0.2, cII: 0.3, recAStar: 0 };
    for (let i = 0; i < 50; i++) {
      state = simulateSwitchStep(state, 0.2);
    }
    expect(state.phase).toBe('lysogenic');
    expect(state.ci).toBeGreaterThan(state.cro + 0.5);
  });

  it('exhibits convergence to lytic fate when initialized with elevated Cro', () => {
    let state: ReturnType<typeof simulateSwitchStep> | { ci: number; cro: number; cII: number; recAStar: number; phase?: string } = { ci: 0.1, cro: 1.5, cII: 0.0, recAStar: 0 };
    for (let i = 0; i < 50; i++) {
      state = simulateSwitchStep(state, 0.2);
    }
    expect(state.phase).toBe('lytic');
    expect(state.cro).toBeGreaterThan(state.ci + 0.5);
  });

  it('UV irradiation activates RecA* and drives prophage induction from lysogeny', () => {
    // Start in stable lysogeny
    let state: ReturnType<typeof simulateSwitchStep> | { ci: number; cro: number; cII: number; recAStar: number; phase?: string } = { ci: 2.0, cro: 0.1, cII: 0.1, recAStar: 0 };
    // Apply severe UV damage
    for (let i = 0; i < 60; i++) {
      state = simulateSwitchStep(state, 0.2, { uv: 0.9 });
    }
    // CI should be degraded by RecA* cleavage, flipping the switch to lytic
    expect(state.recAStar).toBeGreaterThan(1.0);
    expect(state.ci).toBeLessThan(0.6);
    expect(state.phase).toBe('lytic');
  });

  it('high MOI promotes CII accumulation and boosts lysogeny', () => {
    const lowMoi = calculateDerivatives({ ci: 0.4, cro: 0.4, cII: 0.1 }, { moi: 0.5 });
    const highMoi = calculateDerivatives({ ci: 0.4, cro: 0.4, cII: 0.1 }, { moi: 4.0 });
    expect(highMoi.dCII).toBeGreaterThan(lowMoi.dCII);
    expect(highMoi.dCi).toBeGreaterThan(lowMoi.dCi);
  });
});

describe('Lysogeny Decision Circuit - Phase Portrait & Attractors', () => {
  it('computes 2D vector grid with non-NaN magnitudes and valid trajectories', () => {
    const grid = computeCircuitPhasePortrait({}, 10, 3.0, 3.0);
    expect(grid.length).toBe(121); // (10 + 1) * (10 + 1)
    for (const pt of grid) {
      expect(Number.isFinite(pt.dCi)).toBe(true);
      expect(Number.isFinite(pt.dCro)).toBe(true);
      expect(Number.isFinite(pt.magnitude)).toBe(true);
      expect(['lysogenic', 'lytic', 'undecided']).toContain(pt.fate);
    }
  });

  it('uses the same analytic CII/RecA steady reduction for every field arrow', () => {
    const params = { uv: 0.3, moi: 2.5, nutrients: 0.7 };
    const grid = computeCircuitPhasePortrait(params, 4, 6, 15);
    for (const point of grid) {
      const occupancy = calculateOperatorOccupancy(point.ci, point.cro, params);
      const cII = 2 * occupancy.prActivity * (1 - occupancy.orCro) * Math.sqrt(params.moi) * params.nutrients;
      const derivative = calculateDerivatives({ ci: point.ci, cro: point.cro, cII, recAStar: 15 }, params);
      expect(point.dCi).toBeCloseTo(derivative.dCi, 12);
      expect(point.dCro).toBeCloseTo(derivative.dCro, 12);
      expect(Math.abs(derivative.dCII)).toBeLessThan(1e-12);
      expect(Math.abs(derivative.dRecAStar)).toBeLessThan(1e-12);
      expect(point.fate).toBe('undecided'); // no basin is inferred from an arrow
    }
  });

  it('retains only actual nullcline zeros and does not fabricate roots at plot boundaries', () => {
    for (const params of [{}, { uv: 0.25 }, { moi: 4, nutrients: 0.2 }]) {
      const { ciNullcline, croNullcline } = computeNullclines(params, 20, 8, 16);
      expect(ciNullcline.length).toBeGreaterThan(0);
      expect(croNullcline.length).toBeGreaterThan(0);
      for (const [points, component] of [[ciNullcline, 'dCi'], [croNullcline, 'dCro']] as const) {
        for (const point of points) {
          expect(point.ci).toBeGreaterThanOrEqual(0); expect(point.ci).toBeLessThanOrEqual(8);
          expect(point.cro).toBeGreaterThanOrEqual(0); expect(point.cro).toBeLessThanOrEqual(16);
          const derivative = calculateDerivatives(calculateQuasiSteadyState(point.ci, point.cro, params), params);
          expect(Math.abs(derivative[component])).toBeLessThanOrEqual(LYSOGENY_PHASE_LIMITS.residualTolerance);
        }
      }
    }
    // Cro synthesis >= 0.05 and decay=0.05 imply Cro >= 1 at every zero.
    expect(computeNullclines({}, 12, 6, 0.5).croNullcline).toEqual([]);
  });

  it('finds an independently solvable equilibrium and its four analytic eigenvalues', () => {
    // With CI synthesis and CII input zero, PR=1 at equilibrium and the
    // eigenvalues are the four independent loss rates. Cro=(0.6+0.05)/0.05=13.
    const params = { moi: 0, nutrients: 0, ciProd: 0, croProd: 0.6, decay: 0.05, uv: 0.3 };
    const roots = computeAttractors(params);
    expect(roots.length).toBe(1);
    const root = roots[0];
    expect(root.ci).toBeCloseTo(0, 7);
    expect(root.cro).toBeCloseTo(13, 7);
    expect(root.cII).toBe(0);
    expect(root.recAStar).toBe(15);
    expect(root.stability).toBe('stable');
    expect(root.type).toBe('lytic');
    const eigenvalues = root.eigenvalues.map(value => value.real).sort((a, b) => a - b);
    const expected = [-0.05 - 0.25 * 15 - 0.2 * 0.3, -0.05, -0.25, -0.2].sort((a, b) => a - b);
    eigenvalues.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 5));
    for (const value of root.eigenvalues) expect(Math.abs(value.imaginary)).toBeLessThan(1e-6);
  });

  it('does not claim resolved stability across a singular fractional-Hill boundary', () => {
    const roots = computeAttractors({ hill: 0.5, ciProd: 3e-5, nutrients: 0 });
    const nearBoundary = roots.find(root => root.ci > 0 && root.ci < 1e-5);
    expect(nearBoundary).toBeDefined();
    expect(nearBoundary!.residual).toBeLessThanOrEqual(LYSOGENY_PHASE_LIMITS.residualTolerance);
    expect(nearBoundary!.stability).toBe('unresolved');
    expect(nearBoundary!.eigenvalues).toEqual([]);
  });

  it('verifies full-ODE equilibria and stability at defaults and after environmental changes', () => {
    for (const params of [{}, { uv: 0.4 }, { moi: 4, nutrients: 0.2 }, { ciProd: 0.05, croProd: 1.2 }]) {
      const roots = computeAttractors(params);
      expect(roots.length).toBeGreaterThan(0);
      for (const root of roots) {
        const derivative = calculateDerivatives(root, params);
        for (const rate of [derivative.dCi, derivative.dCro, derivative.dCII, derivative.dRecAStar]) {
          expect(Math.abs(rate)).toBeLessThanOrEqual(LYSOGENY_PHASE_LIMITS.residualTolerance);
        }
        expect(root.residual).toBeLessThanOrEqual(LYSOGENY_PHASE_LIMITS.residualTolerance);
        expect(root.eigenvalues.length).toBe(4);
        if (root.stability === 'stable') expect(root.eigenvalues.every(value => value.real < 0)).toBe(true);
        if (root.stability === 'saddle') {
          expect(root.eigenvalues.some(value => value.real > 0)).toBe(true);
          expect(root.eigenvalues.some(value => value.real < 0)).toBe(true);
        }
      }
    }
    const roots = computeAttractors();
    const lysogenic = roots.find(root => root.type === 'lysogenic')!;
    const lytic = roots.find(root => root.type === 'lytic')!;
    const saddle = roots.find(root => root.type === 'saddle')!;
    expect(lysogenic).toBeDefined(); expect(lytic).toBeDefined(); expect(saddle).toBeDefined();
    expect(lytic.cro).toBeGreaterThan(3); // the old plotting window hid this equilibrium
    // A geometric midpoint is not a saddle: the root must solve the equations itself.
    expect(Math.abs(saddle.ci - (lysogenic.ci + lytic.ci) / 2)).toBeGreaterThan(0.05);
    for (const root of [lysogenic, lytic]) {
      const perturbed = { ...root, ci: root.ci + 0.01, cro: root.cro + 0.01, cII: root.cII + 0.01 };
      const relaxed = simulateSwitchStep(perturbed, 200);
      expect(Math.abs(relaxed.ci - root.ci)).toBeLessThan(0.001);
      expect(Math.abs(relaxed.cro - root.cro)).toBeLessThan(0.001);
      expect(Math.abs(relaxed.cII - root.cII)).toBeLessThan(0.001);
    }
  });

  it('reports no finite equilibrium when basal Cro cannot decay', () => {
    for (const params of [{ decay: 0 }, { decay: 0, uv: 1 }, { decay: 0, croProd: 0, ciProd: 0 }]) {
      expect(computeAttractors(params)).toEqual([]);
      expect(computeNullclines(params, 12, 8, 16).croNullcline).toEqual([]);
      for (const point of computeCircuitPhasePortrait(params, 4, 8, 16)) expect(point.dCro).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('bounds phase-portrait work and rejects invalid grids and parameters', () => {
    for (const resolution of [0, -1, 0.5, NaN, Infinity, 129]) {
      expect(() => computeCircuitPhasePortrait({}, resolution)).toThrow();
      expect(() => computeNullclines({}, resolution)).toThrow();
    }
    for (const maximum of [0, -1, NaN, Infinity]) expect(() => computeNullclines({}, 4, maximum, 3)).toThrow();
    expect(() => computeAttractors({ decay: -1 })).toThrow();
  });
});

describe('Lysogeny Decision Circuit - Teaching Fate Score', () => {
  it('assigns a high lysogeny teaching score under high MOI and starvation', () => {
    const pred = predictLysogenyFate({ moi: 5.0, nutrients: 0.2, uv: 0.0 });
    expect(pred.probability).toBeGreaterThan(0.7);
    expect(pred.fate).toBe('lysogenic');
    expect(pred.factors.some(f => f.includes('High MOI'))).toBe(true);
  });

  it('predicts lytic fate under UV damage', () => {
    const pred = predictLysogenyFate({ moi: 1.0, uv: 0.8 });
    expect(pred.probability).toBeLessThan(0.3);
    expect(pred.fate).toBe('lytic');
    expect(pred.factors.some(f => f.includes('UV/SOS'))).toBe(true);
  });

  it('uses a zero teaching score for explicitly supplied virulent lifecycle metadata', () => {
    const circuit = reconstructLysogenyCircuit(mockPhage({ lifecycle: 'virulent', name: 'T4' }));
    const pred = predictLysogenyFate({}, circuit);
    expect(pred.probability).toBe(0.0);
    expect(pred.fate).toBe('lytic');
    expect(pred.factors[0]).toContain('Obligately lytic');
  });
});

describe('Lysogeny Decision Circuit - Sequence & Gene Reconstruction', () => {
  it('returns observed promoter and exact reference operator sequences', () => {
    const promoter = 'TTGACA' + 'A'.repeat(17) + 'TATAAT';
    const operator = 'TATCACCGCCAGAGGTA'; // Published lambda OR1; PMID 2949139.
    const found = findRegulatoryElements('NN' + promoter + 'NN' + operator);
    expect(found.promoters).toHaveLength(1);
    expect(found.promoters[0]).toMatchObject({ position: 2, direction: '+', sequence: promoter, strength: null });
    expect(found.operators).toHaveLength(1);
    expect(found.operators[0]).toMatchObject({ position: 33, direction: '+', sequence: operator,
      bindingAffinityCi: null, bindingAffinityCro: null });
  });

  it('reconstructs Lambda-like circuit when CI and Cro are present', () => {
    const phage = mockPhage({
      name: 'Enterobacteria phage lambda',
      lifecycle: 'temperate',
      genes: [
        mockGene({ name: 'cI', product: 'repressor CI', startPos: 37900, endPos: 38600 }),
        mockGene({ name: 'cro', product: 'transcriptional repressor Cro', startPos: 38800, endPos: 39000 }),
        mockGene({ name: 'cII', product: 'transcriptional activator cII', startPos: 39200, endPos: 39500 }),
        mockGene({ name: 'int', product: 'site-specific recombinase integrase', startPos: 27000, endPos: 28000 }),
      ],
    });

    const circuit = reconstructLysogenyCircuit(phage);
    expect(circuit.architecture).toBe('lambda-like');
    expect(circuit.isTemperate).toBe(true);
    expect(circuit.genes.ci?.name).toBe('cI');
    expect(circuit.genes.cro?.name).toBe('cro');
    expect(circuit.genes.cII?.name).toBe('cII');
    expect(circuit.genes.integrase?.name).toBe('int');
    expect(circuit.sequenceStatus).toBe('not-supplied');
    expect(circuit.promoters).toEqual([]);
    expect(circuit.operators).toEqual([]);
    expect(circuit.confidence).toBeNull();
    expect(circuit.summary).toContain('hypothesis');
  });

  it('identifies virulent phages without repressor as obligately lytic', () => {
    const phage = mockPhage({
      name: 'Enterobacteria phage T4',
      lifecycle: 'virulent',
      genes: [
        mockGene({ name: 'gp23', product: 'major capsid protein' }),
        mockGene({ name: 'gp18', product: 'tail sheath protein' }),
        mockGene({ name: 'gp43', product: 'DNA polymerase' }),
      ],
    });

    const circuit = reconstructLysogenyCircuit(phage);
    expect(circuit.architecture).toBe('obligately-lytic');
    expect(circuit.isTemperate).toBe(false);
  });
});

describe('Lysogeny Decision Circuit - Simulation Integration', () => {
  it('derives simulation parameters from a temperate genome', () => {
    const phage = mockPhage({
      genes: [
        mockGene({ name: 'cI', product: 'repressor CI' }),
        mockGene({ name: 'cro', product: 'Cro repressor' }),
      ],
    });
    const direct = deriveLysogenyCircuitParams(phage);
    expect(direct.ciProd).toBeDefined();
    const defaults = derivePhageSimDefaults('lysogeny-circuit', phage);
    expect(defaults.ciProd).toBeDefined();
    expect(defaults.croProd).toBeDefined();
    expect(defaults.hill).toBeGreaterThanOrEqual(2);
  });

  it('runs makeLysogenySimulation step and tracks history and occupancy', () => {
    const sim = makeLysogenySimulation();
    const phage = mockPhage({
      genes: [
        mockGene({ name: 'cI', product: 'repressor CI' }),
        mockGene({ name: 'cro', product: 'Cro repressor' }),
      ],
    });
    let state = sim.init(phage, {}, undefined, { genomeSequence: 'A'.repeat(phage.genomeLength!) });
    expect(state.modelVersion).toBe(3);
    expect(state.circuitInfo?.sequenceStatus).toBe('scanned');
    expect(state.circuitInfo?.operators).toEqual([]);
    expect(state.occupancy).toBeDefined();
    expect(state.circuitInfo).toBeDefined();
    expect(state.phasePortrait?.length).toBeGreaterThan(10);

    state = sim.step(state, 0.1);
    expect(state.history.length).toBe(2);
    expect(state.time).toBeCloseTo(0.1, 5);
    expect(sim.getSummary?.(state)).toContain('CI=');
  });

  it('keeps model time, concentrations and history synchronized at accelerated speed', () => {
    const sim = makeLysogenySimulation();
    const initial = sim.init(null, { uv: 1 });
    const next = sim.step(initial, 3);
    expect(next.time).toBe(3);
    expect(next.history.at(-1)?.time).toBe(3);
    expect(next.recAStar).toBeCloseTo(50 * (1 - Math.exp(-0.6)), 5);
    expect(sim.step(next, 0)).toBe(next);
  });
});
