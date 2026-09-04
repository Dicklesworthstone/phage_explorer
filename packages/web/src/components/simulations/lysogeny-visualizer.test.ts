import { describe, expect, it } from 'bun:test';
import {
  makeLysogenySimulation,
  derivePhageSimDefaults,
  predictLysogenyFate,
  reconstructLysogenyCircuit,
  type LysogenyCircuitState,
  type PhageFull,
} from '@phage-explorer/core';

function mockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 10,
    slug: 'lambda',
    name: 'Enterobacteria phage lambda',
    accession: 'NC_001416',
    family: 'Siphoviridae',
    host: 'Escherichia coli',
    genomeLength: 48502,
    gcContent: 49.9,
    morphology: 'siphovirus',
    lifecycle: 'temperate',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [
      {
        id: 1,
        name: 'cI',
        locusTag: 'lambda_01',
        startPos: 37900,
        endPos: 38600,
        strand: '-',
        product: 'repressor CI',
        type: 'CDS',
      },
      {
        id: 2,
        name: 'cro',
        locusTag: 'lambda_02',
        startPos: 38800,
        endPos: 39000,
        strand: '+',
        product: 'transcriptional repressor Cro',
        type: 'CDS',
      },
      {
        id: 3,
        name: 'cII',
        locusTag: 'lambda_03',
        startPos: 39200,
        endPos: 39500,
        strand: '+',
        product: 'activator cII',
        type: 'CDS',
      },
      {
        id: 4,
        name: 'int',
        locusTag: 'lambda_04',
        startPos: 27000,
        endPos: 28000,
        strand: '-',
        product: 'site-specific recombinase integrase',
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('LysogenyVisualizer & Circuit Reconstructor (Roadmap #34)', () => {
  it('reconstructs the genetic decision circuit with Lambda architecture and operator sites', () => {
    const phage = mockPhage();
    const circuit = reconstructLysogenyCircuit(phage);

    expect(circuit.architecture).toBe('lambda-like');
    expect(circuit.isTemperate).toBe(true);
    expect(circuit.genes.ci?.name).toBe('cI');
    expect(circuit.genes.cro?.name).toBe('cro');
    expect(circuit.genes.cII?.name).toBe('cII');
    expect(circuit.genes.integrase?.name).toBe('int');

    // Promoters & operators populated
    expect(circuit.promoters.some((p) => p.name === 'PRM')).toBe(true);
    expect(circuit.promoters.some((p) => p.name === 'PR')).toBe(true);
    expect(circuit.operators.some((o) => o.name === 'OR1')).toBe(true);
    expect(circuit.operators.some((o) => o.name === 'OR2')).toBe(true);
    expect(circuit.operators.some((o) => o.name === 'OR3')).toBe(true);
  });

  it('initializes simulation state with phase portrait vector field, nullclines, and attractors', () => {
    const sim = makeLysogenySimulation();
    const phage = mockPhage();
    const state: LysogenyCircuitState = sim.init(phage);

    expect(state.type).toBe('lysogeny-circuit');
    expect(state.phase).toBe('undecided');
    expect(state.phasePortrait).toBeDefined();
    expect(state.phasePortrait!.length).toBeGreaterThan(50);

    // Nullclines and attractors
    expect(state.nullclines).toBeDefined();
    expect(state.nullclines!.ciNullcline.length).toBeGreaterThan(10);
    expect(state.nullclines!.croNullcline.length).toBeGreaterThan(10);
    expect(state.attractors?.length).toBe(3); // lysogenic, lytic, saddle

    // Shea-Ackers operator occupancy
    expect(state.occupancy).toBeDefined();
    expect(state.occupancy!.partitionZ).toBeGreaterThanOrEqual(1.0);
    expect(state.occupancy!.prmActivity).toBeGreaterThanOrEqual(0);
    expect(state.occupancy!.prActivity).toBeGreaterThanOrEqual(0);
  });

  it('updates state dynamically through step simulation with trajectory history', () => {
    const sim = makeLysogenySimulation();
    const phage = mockPhage();
    let state = sim.init(phage, { moi: 3.5, nutrients: 1.2 });

    // Step forward 10 times
    for (let i = 0; i < 10; i++) {
      state = sim.step(state, 0.1);
    }

    expect(state.time).toBeCloseTo(1.0, 4);
    expect(state.history.length).toBe(11);
    expect(state.history[10].ci).toBeDefined();
    expect(state.history[10].cro).toBeDefined();
    expect(state.history[10].phase).toBeDefined();
    expect(state.predictedProbability).toBeGreaterThan(0.6);
  });

  it('correctly predicts 0% lysogeny when presented with virulent obligate lytic phage T4', () => {
    const t4 = mockPhage({
      name: 'Enterobacteria phage T4',
      lifecycle: 'virulent',
      genes: [
        {
          id: 101,
          name: 'gp23',
          locusTag: 't4_23',
          startPos: 1000,
          endPos: 2000,
          strand: '+',
          product: 'major capsid protein',
          type: 'CDS',
        },
      ],
    });

    const circuit = reconstructLysogenyCircuit(t4);
    expect(circuit.architecture).toBe('obligately-lytic');
    expect(circuit.isTemperate).toBe(false);

    const prediction = predictLysogenyFate({}, circuit);
    expect(prediction.probability).toBe(0);
    expect(prediction.fate).toBe('lytic');
    expect(prediction.factors[0]).toContain('Obligately lytic');

    const defaults = derivePhageSimDefaults('lysogeny-circuit', t4);
    expect(defaults.ciProd).toBe(0.05); // Locked minimal repressor
    expect(defaults.croProd).toBe(1.2); // Strong lytic synthesis
  });
});
