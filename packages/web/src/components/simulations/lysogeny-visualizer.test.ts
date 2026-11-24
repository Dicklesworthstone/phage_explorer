import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LysogenyVisualizer } from './LysogenyVisualizer';
import {
  makeLysogenySimulation,
  derivePhageSimDefaults,
  predictLysogenyFate,
  reconstructLysogenyCircuit,
  calculateDerivatives,
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
  it('renders observed coordinates and DNA separately from the uncalibrated model score', () => {
    const genomeSequence = 'NNNNTACCTCTGGCGGTGATA'; // Reverse-strand lambda OR1 reference.
    const phage = mockPhage({ genomeLength: genomeSequence.length, genes: [], lifecycle: null });
    const state = makeLysogenySimulation().init(phage, {}, undefined, { genomeSequence });
    const markup = renderToStaticMarkup(createElement(LysogenyVisualizer, { state }));
    expect(markup).toContain('Genome regulatory evidence');
    expect(markup).toContain('21 bases scanned');
    expect(markup).toContain('Observed regulatory motif candidates');
    expect(markup).toContain('5–21');
    expect(markup).toContain('<td>-</td>');
    expect(markup).toContain('TATCACCGCCAGAGGTA');
    expect(markup).toContain('lambda_OR1_sequence_match_4_-');
    expect(markup).toContain('Teaching score:');
    expect(markup).toContain('not a measured probability');
    expect(markup).toContain('Illustrative Operator Model');
    expect(markup).not.toContain('P(lysogeny)');
    const unavailable = renderToStaticMarkup(createElement(LysogenyVisualizer, {
      state: { ...state, predictedProbability: undefined },
    }));
    expect(unavailable).toContain('Unavailable');
  });

  it('makes a negative scan explicit and bounds only the visible table, not the exported evidence', () => {
    const sim = makeLysogenySimulation();
    const genomeSequence = Array(51).fill('TATCACCGCCAGAGGTA').join('N');
    const phage = mockPhage({ genomeLength: genomeSequence.length, genes: [], lifecycle: null });
    const state = sim.init(phage, {}, undefined, { genomeSequence });
    const markup = renderToStaticMarkup(createElement(LysogenyVisualizer, { state }));
    expect(state.circuitInfo?.operators).toHaveLength(51);
    expect(markup.match(/<tr>/g)).toHaveLength(51); // Header plus the first 50 candidates.
    expect(markup).toContain('The table shows the first 50');
    const empty = sim.init(phage, {}, undefined, { genomeSequence: 'A'.repeat(genomeSequence.length) });
    expect(renderToStaticMarkup(createElement(LysogenyVisualizer, { state: empty })))
      .toContain('this does not establish an absence of regulation');
  });

  it('retains a Lambda annotation hypothesis without inventing genomic operator sites', () => {
    const phage = mockPhage();
    const circuit = reconstructLysogenyCircuit(phage);

    expect(circuit.architecture).toBe('lambda-like');
    expect(circuit.isTemperate).toBe(true);
    expect(circuit.genes.ci?.name).toBe('cI');
    expect(circuit.genes.cro?.name).toBe('cro');
    expect(circuit.genes.cII?.name).toBe('cII');
    expect(circuit.genes.integrase?.name).toBe('int');

    expect(circuit.promoters).toEqual([]);
    expect(circuit.operators).toEqual([]);
    expect(circuit.sequenceStatus).toBe('not-supplied');
    expect(circuit.confidence).toBeNull();
  });

  it('initializes simulation state with phase portrait vector field, nullclines, and attractors', () => {
    const sim = makeLysogenySimulation();
    const phage = mockPhage();
    const state: LysogenyCircuitState = sim.init(phage, {}, undefined, { genomeSequence: 'A'.repeat(phage.genomeLength!) });

    expect(state.type).toBe('lysogeny-circuit');
    expect(state.phase).toBe('undecided');
    expect(state.phasePortrait).toBeDefined();
    expect(state.phasePortrait!.length).toBeGreaterThan(50);

    // Nullclines and attractors
    expect(state.nullclines).toBeDefined();
    expect(state.nullclines!.ciNullcline.length).toBeGreaterThan(10);
    expect(state.nullclines!.croNullcline.length).toBeGreaterThan(10);
    expect(state.attractors!.length).toBeGreaterThan(0);
    for (const equilibrium of state.attractors!) {
      const derivative = calculateDerivatives(equilibrium, state.params);
      for (const rate of [derivative.dCi, derivative.dCro, derivative.dCII, derivative.dRecAStar]) {
        expect(Math.abs(rate)).toBeLessThanOrEqual(1e-8);
      }
      expect(Math.max(...state.phasePortrait!.map(point => point.ci))).toBeGreaterThan(equilibrium.ci);
      expect(Math.max(...state.phasePortrait!.map(point => point.cro))).toBeGreaterThan(equilibrium.cro);
    }

    // Shea-Ackers operator occupancy
    expect(state.occupancy).toBeDefined();
    expect(state.occupancy!.partitionZ).toBeGreaterThanOrEqual(1.0);
    expect(state.occupancy!.prmActivity).toBeGreaterThanOrEqual(0);
    expect(state.occupancy!.prActivity).toBeGreaterThanOrEqual(0);
  });

  it('keeps the zero-decay simulation usable without invented equilibria or Cro nullclines', () => {
    const sim = makeLysogenySimulation();
    const state = sim.init(mockPhage(), { decay: 0 }, undefined, { genomeSequence: 'A'.repeat(48502) });
    expect(state.attractors).toEqual([]);
    expect(state.nullclines!.croNullcline).toEqual([]);
    const next = sim.step(state, 1);
    expect(next.cro).toBeGreaterThan(state.cro);
    expect(next.attractors).toEqual([]);
  });

  it('updates state dynamically through step simulation with trajectory history', () => {
    const sim = makeLysogenySimulation();
    const phage = mockPhage();
    let state = sim.init(phage, { moi: 3.5, nutrients: 1.2 }, undefined, { genomeSequence: 'A'.repeat(phage.genomeLength!) });

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

  it('selects the declared virulent teaching preset without inferring it from a phage name', () => {
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
