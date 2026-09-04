import { describe, expect, it } from 'bun:test';
import {
  calculateOperatorOccupancy,
  calculateDerivatives,
  simulateSwitchStep,
  computeCircuitPhasePortrait,
  computeNullclines,
  computeAttractors,
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

  it('computes nullclines for CI and Cro', () => {
    const { ciNullcline, croNullcline } = computeNullclines({}, 15, 3.0, 3.0);
    expect(ciNullcline.length).toBe(16);
    expect(croNullcline.length).toBe(16);
    for (const pt of ciNullcline) {
      expect(pt.ci).toBeGreaterThanOrEqual(0);
    }
    for (const pt of croNullcline) {
      expect(pt.cro).toBeGreaterThanOrEqual(0);
    }
  });

  it('locates distinct lysogenic and lytic attractors', () => {
    const attractors = computeAttractors({});
    expect(attractors.length).toBe(3); // lysogenic, lytic, saddle
    const lyso = attractors.find(a => a.type === 'lysogenic');
    const lytic = attractors.find(a => a.type === 'lytic');
    expect(lyso).toBeDefined();
    expect(lytic).toBeDefined();
    expect(lyso!.ci).toBeGreaterThan(lyso!.cro);
    expect(lytic!.cro).toBeGreaterThan(lytic!.ci);
  });
});

describe('Lysogeny Decision Circuit - Fate Probability Prediction', () => {
  it('predicts high lysogeny probability under high MOI and starvation', () => {
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

  it('predicts 0% lysogeny for obligately lytic phages', () => {
    const circuit = reconstructLysogenyCircuit(mockPhage({ lifecycle: 'virulent', name: 'T4' }));
    const pred = predictLysogenyFate({}, circuit);
    expect(pred.probability).toBe(0.0);
    expect(pred.fate).toBe('lytic');
    expect(pred.factors[0]).toContain('Obligately lytic');
  });
});

describe('Lysogeny Decision Circuit - Sequence & Gene Reconstruction', () => {
  it('scans sequence for consensus sigma70 promoters and palindromic operators', () => {
    // Synthetic sequence with a -35 box, 17bp spacer, and -10 box: TTGACA ... TATAAT
    // and an operator TATCACCGCCAGTGGT
    const testDna =
      'AAAAATTGACAGGGGGAAAAAGGGGGGTATAATCCCCCCTATCACCGCAGGTGGTCCCCCCGCGCGCGCGCGCGCGCGCGCGTTTTTT';
    const found = findRegulatoryElements(testDna);
    expect(found.promoters.length).toBeGreaterThanOrEqual(1);
    expect(found.operators.length).toBeGreaterThanOrEqual(1);
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
    expect(circuit.promoters.length).toBeGreaterThanOrEqual(2);
    expect(circuit.operators.length).toBeGreaterThanOrEqual(3);
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
    let state = sim.init(phage);
    expect(state.occupancy).toBeDefined();
    expect(state.circuitInfo).toBeDefined();
    expect(state.phasePortrait?.length).toBeGreaterThan(10);

    state = sim.step(state, 0.1);
    expect(state.history.length).toBe(2);
    expect(state.time).toBeCloseTo(0.1, 5);
    expect(sim.getSummary?.(state)).toContain('CI=');
  });
});
