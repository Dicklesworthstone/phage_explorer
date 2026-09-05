import { describe, expect, it } from 'bun:test';
import type { PhageFull } from '../types';
import {
  AMG_KNOWLEDGE_BASE,
  createStandardHostMetabolicModel,
  detectAmgsFromPhage,
  FBASimplexSolver,
  runAMGFluxAnalysis,
  runDeltaFbaForAmg,
  solveFBA,
  type AMGDetection,
  type FBAStatus,
  parseHostMetabolicModel,
  createAMGFluxRecord,
  restoreAMGFluxRecord,
} from './amg-flux';
import { importLocalGenomes } from '../genome-import';
import { serializeAnalysisRecord } from '../analysis-result';

describe('reproducible AMG model experiment', () => {
  it('preserves real annotations, model, parameters and numerical fields across restoration', async () => {
    const { genomes } = await importLocalGenomes({ name: 'amg.gb', text: 'LOCUS       AMG 9 bp DNA linear\nFEATURES             Location/Qualifiers\n     CDS             1..9\n                     /gene="nrdA"\nORIGIN\n        1 atgaaatag\n//\n' });
    const phage = genomes[0].phage;
    const model = { id: 'exact-five', name: 'Five-unit optimum', description: 'Controlled source=sink model', metabolites: ['a'], objectiveReaction: 'sink', reactions: [
      { id: 'source', name: 'Source', subsystem: 'Exchange', stoichiometry: { a: 1 }, lowerBound: 2, upperBound: 5, reversible: false, koIds: [] },
      { id: 'sink', name: 'Sink', subsystem: 'Exchange', stoichiometry: { a: -1 }, lowerBound: 1, upperBound: 10, reversible: false, koIds: [] },
    ] };
    const record = await createAMGFluxRecord(phage, { hostModel: model, boostFactor: 3, modelSource: 'imported' });
    expect(record.fields.baselineObjective).toMatchObject({ kind: 'simulation', value: 5, units: 'model-flux' });
    expect(record.fields.baselineFluxes.value).toEqual({ source: 5, sink: 5 });
    expect(record.fields.annotationMatches).toMatchObject({ kind: 'sequence-score', coverage: { available: 1, total: 1 } });
    expect(record.inputs[0].source).toBe('local');
    const restored = await restoreAMGFluxRecord(serializeAnalysisRecord(record), phage);
    expect(restored.hostModel).toEqual(model);
    const repeated = await createAMGFluxRecord(phage, restored);
    expect(repeated).toEqual(record);
    await expect(restoreAMGFluxRecord(serializeAnalysisRecord(record), { ...phage, accession: 'DIFFERENT' })).rejects.toThrow('different gene annotations');
    const teaching = await createAMGFluxRecord(phage, { hostModel: createStandardHostMetabolicModel(), boostFactor: 5, modelSource: 'illustrative' });
    expect(teaching.fields.baselineObjective.kind).toBe('demo');
    expect(teaching.fields.baselineObjective.units).toBe('arbitrary-flux');
    model.reactions[0].lowerBound = 6;
    const failure = await createAMGFluxRecord(phage, { hostModel: model, boostFactor: 3, modelSource: 'imported' });
    for (const name of ['baselineObjective', 'baselineFluxes', 'objectiveChanges', 'percentChanges', 'sumIndependentChanges']) {
      expect(failure.fields[name]).toMatchObject({ kind: 'unavailable', value: null, units: null });
    }
    expect(failure.fields.baselineObjective.kind === 'unavailable' && failure.fields.baselineObjective.missingInputs.join()).toContain('infeasible');
  });
});

describe('FBA numerical contract', () => {
  const cases: Array<{ name: string; S: number[][]; lb: number[]; ub: number[]; c: number[]; status: FBAStatus; objective: number | null }> = [
    { name: 'fixed source violates steady state', S: [[1]], lb: [1], ub: [1], c: [1], status: 'infeasible', objective: null },
    { name: 'nonzero lower-bound objective offset', S: [], lb: [2], ub: [5], c: [1], status: 'optimal', objective: 5 },
    { name: 'inconsistent bounds', S: [], lb: [5], ub: [2], c: [1], status: 'infeasible', objective: null },
    { name: 'reversible flux with negative optimum', S: [[1, -1]], lb: [-5, -3], ub: [-2, 4], c: [0, 1], status: 'optimal', objective: -2 },
    { name: 'phase-one feasible positive lower bounds', S: [[1, -1]], lb: [2, 1], ub: [5, 10], c: [0, 1], status: 'optimal', objective: 5 },
    { name: 'zero capacity', S: [[1, -1]], lb: [0, 0], ub: [0, 10], c: [0, 1], status: 'optimal', objective: 0 },
    { name: 'unbounded objective', S: [], lb: [0], ub: [Infinity], c: [1], status: 'unbounded', objective: null },
    { name: 'duplicate and zero equality rows', S: [[1, -1], [2, -2], [0, 0]], lb: [2, 1], ub: [5, 10], c: [0, 1], status: 'optimal', objective: 5 },
    { name: 'negative objective coefficient', S: [], lb: [-3], ub: [5], c: [-2], status: 'optimal', objective: 6 },
    { name: 'small equality coefficients', S: [[1e-12, -1e-12]], lb: [0, 0], ub: [5, 10], c: [0, 1e-12], status: 'optimal', objective: 5e-12 },
  ];
  for (const fixture of cases) {
    it(fixture.name, () => {
      const ids = fixture.lb.map((_, i) => `r${i}`);
      const result = new FBASimplexSolver(fixture.S, fixture.lb, fixture.ub, fixture.c, ids).solve();
      expect(result.status).toBe(fixture.status);
      expect(result.optimal).toBe(fixture.status === 'optimal');
      if (fixture.objective === null) {
        expect(result.objective).toBeNull();
        expect(result.fluxes).toEqual({});
      } else {
        expect(result.objective).toBeCloseTo(fixture.objective, 10);
        const flux = ids.map(id => result.fluxes[id]);
        fixture.S.forEach(row => expect(Math.abs(row.reduce((sum, a, j) => sum + a * flux[j], 0))).toBeLessThan(1e-8));
        flux.forEach((v, j) => {
          expect(v).toBeGreaterThanOrEqual(fixture.lb[j] - 1e-8);
          expect(v).toBeLessThanOrEqual(fixture.ub[j] + 1e-8);
        });
        expect(flux.reduce((sum, v, j) => sum + fixture.c[j] * v, 0)).toBeCloseTo(result.objective!, 10);
      }
    });
  }

  it('reports exhausted iterations and invalid input instead of a numerical optimum', () => {
    expect(new FBASimplexSolver([], [0], [5], [1], ['r']).solve(0).status).toBe('iteration_limit');
    expect(new FBASimplexSolver([[1, 2]], [0], [5], [1], ['r']).solve().status).toBe('invalid_input');
    expect(new FBASimplexSolver([], [NaN], [5], [1], ['r']).solve().status).toBe('invalid_input');
    expect(new FBASimplexSolver([], [0], [5], [Infinity], ['r']).solve().status).toBe('invalid_input');
    expect(new FBASimplexSolver([], [0, 0], [5, 5], [1, 1], ['r', 'r']).solve().status).toBe('invalid_input');
    expect(new FBASimplexSolver([], [-1e308], [1e308], [1], ['r']).solve().status).toBe('numerical_error');
  });

  it('rejects missing objective and undeclared metabolites', () => {
    const model = createStandardHostMetabolicModel();
    expect(solveFBA({ ...model, objectiveReaction: 'missing' }).status).toBe('invalid_input');
    expect(solveFBA({ ...model, metabolites: [] }).status).toBe('invalid_input');
  });

  it('imports explicit model JSON and rejects malformed or oversized models', () => {
    const model = createStandardHostMetabolicModel();
    expect(parseHostMetabolicModel(JSON.stringify(model))).toEqual(model);
    expect(parseHostMetabolicModel(JSON.stringify({ model, analysis: {} }))).toEqual(model);
    expect(() => parseHostMetabolicModel('{}')).toThrow('Invalid model');
    expect(() => parseHostMetabolicModel(JSON.stringify({ ...model, reactions: Array(101).fill(model.reactions[0]) }))).toThrow('Invalid model');
    expect(() => parseHostMetabolicModel(JSON.stringify({ ...model, reactions: [{ ...model.reactions[0], lowerBound: null }] }))).toThrow('Invalid model');
  });

  it('matches independent vertex enumeration on 48 bounded three-reaction systems', () => {
    // A bounded plane intersects a box at vertices with at least two active
    // bounds. Enumerating those intersections does not use simplex or its basis.
    for (let k = 0; k < 48; k++) {
      const row = [1 + k % 3, -(1 + k % 4), 1 + k % 2];
      const lb = [k % 4 - 2, -3, k % 3 - 2];
      const ub = [3 + k % 3, 2 + k % 4, 4];
      const c = [k % 5 - 2, 2 - k % 4, 1];
      let expected = -Infinity;
      for (let free = 0; free < 3; free++) {
        const fixed = [0, 1, 2].filter(j => j !== free);
        for (let corner = 0; corner < 4; corner++) {
          const v = [0, 0, 0];
          fixed.forEach((j, bit) => { v[j] = corner & (1 << bit) ? ub[j] : lb[j]; });
          v[free] = -fixed.reduce((sum, j) => sum + row[j] * v[j], 0) / row[free];
          if (v[free] >= lb[free] - 1e-10 && v[free] <= ub[free] + 1e-10) expected = Math.max(expected, v.reduce((sum, value, j) => sum + c[j] * value, 0));
        }
      }
      const result = new FBASimplexSolver([row], lb, ub, c, ['a', 'b', 'c']).solve();
      expect(result.status).toBe(expected === -Infinity ? 'infeasible' : 'optimal');
      if (expected !== -Infinity) expect(result.objective).toBeCloseTo(expected, 8);
    }
  });

  it('does not turn an infeasible model into an AMG gain', () => {
    const model = createStandardHostMetabolicModel();
    model.reactions[0].lowerBound = 20;
    const phage = { id: 1, name: 'example', genes: [{ id: 1, name: 'nrdA', startPos: 0, endPos: 300 }] } as PhageFull;
    const result = runAMGFluxAnalysis(phage, { hostModel: model });
    expect(result.baselineFba.status).toBe('infeasible');
    expect(result.baselineFba.objectiveValue).toBeNull();
    expect(result.amgResults).toEqual([]);
    expect(result.failedAmgs.map(r => r.status)).toEqual(['infeasible']);
    expect(result.summary).toContain('No objective gain');
  });

  it('treats imported subsystem names as data rather than object prototypes', () => {
    const model = createStandardHostMetabolicModel();
    model.reactions.forEach(r => { r.subsystem = '__proto__'; });
    const phage = { id: 1, name: 'example', genes: [{ id: 1, name: 'nrdA', startPos: 0, endPos: 300 }] } as PhageFull;
    const result = runAMGFluxAnalysis(phage, { hostModel: model });
    expect(result.amgResults[0].pathwayImpacts[0].pathwayName).toBe('__proto__');
    expect(Number.isFinite(result.amgResults[0].pathwayImpacts[0].totalDeltaFlux)).toBe(true);
    expect(Object.prototype).not.toHaveProperty('total');
  });

  it('marks relative gain undefined when the baseline objective is zero', () => {
    const model = createStandardHostMetabolicModel();
    model.reactions.forEach(r => { r.upperBound = 0; });
    const phage = { id: 1, name: 'example', genes: [{ id: 1, name: 'nrdA', startPos: 0, endPos: 300 }] } as PhageFull;
    const result = runAMGFluxAnalysis(phage, { hostModel: model });
    expect(result.amgResults[0].percentGain).toBeNull();
    expect(result.amgResults[0].deltaObjective).toBe(0);
    expect(result.amgResults[0]).not.toHaveProperty('fitnessScore');
  });
});

describe('AMG Flux Potential Analyzer - Core', () => {
  describe('Standard Host Metabolic Model', () => {
    it('creates standard model with valid metabolites and reactions', () => {
      const model = createStandardHostMetabolicModel();
      expect(model.id).toBe('host_core_metabolism');
      expect(model.metabolites.length).toBeGreaterThanOrEqual(15);
      expect(model.reactions.length).toBeGreaterThanOrEqual(10);
      expect(model.objectiveReaction).toBe('BIOMASS_VIRAL_DNTPS');

      const objRxn = model.reactions.find((r) => r.id === model.objectiveReaction);
      expect(objRxn).toBeDefined();
      expect(objRxn?.upperBound).toBeGreaterThan(0);
    });

    it('all reactions specify valid lower and upper bounds with non-empty stoichiometry', () => {
      const model = createStandardHostMetabolicModel();
      for (const rxn of model.reactions) {
        expect(rxn.lowerBound).toBeLessThanOrEqual(rxn.upperBound);
        expect(Object.keys(rxn.stoichiometry).length).toBeGreaterThan(0);
        // Every metabolite in stoichiometry should be defined in model.metabolites
        for (const met of Object.keys(rxn.stoichiometry)) {
          expect(model.metabolites).toContain(met);
        }
      }
    });
  });

  describe('FBASimplexSolver & solveFBA', () => {
    it('computes feasible steady-state flux for baseline host model', () => {
      const model = createStandardHostMetabolicModel();
      const result = solveFBA(model);

      expect(result.status).toBe('optimal');
      if (result.status !== 'optimal') throw new Error(result.status);
      expect(result.objectiveValue).toBeGreaterThan(0);
      expect(result.fluxes[model.objectiveReaction]).toBeCloseTo(result.objectiveValue, 2);

      // Verify bounds
      for (const rxn of model.reactions) {
        const f = result.fluxes[rxn.id] ?? 0;
        expect(f).toBeGreaterThanOrEqual(rxn.lowerBound - 1e-4);
        expect(f).toBeLessThanOrEqual(rxn.upperBound + 1e-4);
      }
    });

    it('preserves internal metabolite mass balance S * v = 0', () => {
      const model = createStandardHostMetabolicModel();
      const result = solveFBA(model);

      // Verify mass balance for internal metabolites (excluding exchange sinks/sources if any are open)
      // All metabolites in model are balanced
      const metMap = new Map(model.metabolites.map((m, idx) => [m, idx]));
      const netProduction = new Array(model.metabolites.length).fill(0);

      for (const rxn of model.reactions) {
        const flux = result.fluxes[rxn.id] ?? 0;
        for (const [met, coeff] of Object.entries(rxn.stoichiometry)) {
          const idx = metMap.get(met);
          if (idx !== undefined) {
            netProduction[idx] += coeff * flux;
          }
        }
      }

      for (let i = 0; i < model.metabolites.length; i++) {
        expect(Math.abs(netProduction[i])).toBeLessThan(0.01);
      }
    });

    it('correctly solves a simple 2-reaction LP system', () => {
      // Maximize v2 subject to:
      // v1 - v2 = 0
      // 0 <= v1 <= 5
      // 0 <= v2 <= 10
      const S = [[1, -1]];
      const lb = [0, 0];
      const ub = [5, 10];
      const c = [0, 1];
      const ids = ['r1', 'r2'];

      const solver = new FBASimplexSolver(S, lb, ub, c, ids);
      const res = solver.solve();

      expect(res.optimal).toBe(true);
      expect(res.objective).toBeCloseTo(5, 2);
      expect(res.fluxes.r1).toBeCloseTo(5, 2);
      expect(res.fluxes.r2).toBeCloseTo(5, 2);
    });
  });

  describe('AMG Detection from Phage Metadata', () => {
    it('returns empty array when phage or genes are undefined/empty', () => {
      expect(detectAmgsFromPhage(null)).toEqual([]);
      expect(detectAmgsFromPhage(undefined)).toEqual([]);
      expect(detectAmgsFromPhage({ id: 1, name: 'Empty', genes: [] } as unknown as PhageFull)).toEqual([]);
    });

    it('detects AMGs by Pfam domain', () => {
      const mockPhage = {
        id: 101,
        name: 'Cyanophage Syn9',
        genes: [
          {
            id: 1,
            name: 'psbA_like',
            product: 'photosystem protein',
            domains: ['PF00124'],
            startPos: 100,
            endPos: 800,
            strand: '+',
          },
          {
            id: 2,
            name: 'gp02',
            product: 'hypothetical protein',
            domains: ['PF99999'],
            startPos: 900,
            endPos: 1200,
            strand: '+',
          },
        ],
      } as unknown as PhageFull;

      const amgs = detectAmgsFromPhage(mockPhage);
      expect(amgs.length).toBe(1);
      expect(amgs[0].geneId).toBe(1);
      expect(amgs[0].amgClass).toBe('photosynthesis');
      expect(amgs[0].evidence).toBe('pfam');
      expect(amgs[0].koMapping.ko).toBe('K02703');
      expect(amgs[0].boostedReactions).toContain('PSII_ELECTRON_TRANSPORT');
    });

    it('detects AMGs by gene name pattern (case-insensitive)', () => {
      const mockPhage = {
        id: 102,
        name: 'Bacteriophage T4',
        genes: [
          {
            id: 11,
            name: 'nrdA',
            product: 'large subunit',
            domains: [],
            startPos: 100,
            endPos: 1500,
            strand: '+',
          },
          {
            id: 12,
            name: 'NRDB',
            product: 'small subunit',
            domains: [],
            startPos: 1600,
            endPos: 2500,
            strand: '+',
          },
          {
            id: 13,
            name: 'thyA',
            product: 'TS',
            domains: [],
            startPos: 2600,
            endPos: 3200,
            strand: '-',
          },
        ],
      } as unknown as PhageFull;

      const amgs = detectAmgsFromPhage(mockPhage);
      expect(amgs.length).toBe(3);
      expect(amgs.map((a) => a.geneName)).toEqual(['nrdA', 'NRDB', 'thyA']);
      expect(amgs.every((a) => a.amgClass === 'nucleotide')).toBe(true);
    });

    it('detects AMGs by product description and avoids duplicate gene IDs', () => {
      const mockPhage = {
        id: 103,
        name: 'Marine Phage P-SSP7',
        genes: [
          {
            id: 21,
            name: 'gp_pho',
            product: 'phosphate starvation-inducible protein PhoH',
            domains: [],
            startPos: 500,
            endPos: 1200,
            strand: '+',
          },
          {
            id: 22,
            name: 'gp_maz',
            product: 'nucleoside triphosphate pyrophosphohydrolase MazG',
            domains: [],
            startPos: 1300,
            endPos: 1800,
            strand: '+',
          },
          {
            id: 23,
            name: 'gp_dut',
            product: 'dUTPase enzyme',
            domains: [],
            startPos: 1900,
            endPos: 2400,
            strand: '+',
          },
        ],
      } as unknown as PhageFull;

      const amgs = detectAmgsFromPhage(mockPhage);
      expect(amgs.length).toBe(3);
      const classes = amgs.map((a) => a.amgClass);
      expect(classes).toContain('phosphate');
      expect(classes).toContain('nucleotide');
    });
  });

  describe('Delta-FBA & Whole Genome Analysis', () => {
    it('boosts reaction flux and increases viral objective value', () => {
      const model = createStandardHostMetabolicModel();
      const baseFba = solveFBA(model);
      if (baseFba.status !== 'optimal') throw new Error(baseFba.status);

      const mockNrdA: AMGDetection = {
        geneId: 1,
        geneName: 'nrdA',
        locusTag: 'T4_001',
        start: 100,
        end: 1500,
        strand: '+',
        amgClass: 'nucleotide',
        koMapping: AMG_KNOWLEDGE_BASE.find((k) => k.namePattern.test('nrda'))!.ko,
        evidence: 'gene_name',
        boostedReactions: ['RNR_REDUCTASE'],
      };

      const deltaResult = runDeltaFbaForAmg(model, mockNrdA, baseFba, 4.0);

      expect(deltaResult.status).toBe('optimal');
      if (deltaResult.status !== 'optimal') throw new Error(deltaResult.status);
      expect(deltaResult.baselineObjective).toBe(baseFba.objectiveValue);
      expect(deltaResult.augmentedObjective).toBeGreaterThanOrEqual(deltaResult.baselineObjective);
      expect(deltaResult.percentGain).toBeGreaterThanOrEqual(0);
      expect(deltaResult.topReactionDeltas.length).toBeGreaterThan(0);

      // The boosted reaction should have a delta
      const rnrDelta = deltaResult.topReactionDeltas.find((r) => r.reactionId === 'RNR_REDUCTASE');
      expect(rnrDelta).toBeDefined();
      expect(rnrDelta?.deltaFlux).toBeGreaterThanOrEqual(0);
    });

    it('runs comprehensive AMG flux analysis on phage with multiple AMGs', () => {
      const mockPhage = {
        id: 200,
        name: 'Prochlorococcus Phage P-HM2',
        genes: [
          {
            id: 1,
            name: 'psbA',
            product: 'photosystem II D1',
            domains: ['PF00124'],
            startPos: 100,
            endPos: 800,
            strand: '+',
          },
          {
            id: 2,
            name: 'nrdA',
            product: 'ribonucleotide reductase alpha',
            domains: ['PF00317'],
            startPos: 1000,
            endPos: 2200,
            strand: '+',
          },
          {
            id: 3,
            name: 'phoH',
            product: 'phosphate starvation protein',
            domains: ['PF04997'],
            startPos: 2300,
            endPos: 2900,
            strand: '+',
          },
        ],
      } as unknown as PhageFull;

      const analysis = runAMGFluxAnalysis(mockPhage, { boostFactor: 3.0 });

      expect(analysis.phageId).toBe(200);
      expect(analysis.phageName).toBe('Prochlorococcus Phage P-HM2');
      expect(analysis.detectedAmgs.length).toBe(3);
      expect(analysis.amgResults.length).toBe(3);
      expect(analysis.summary).toContain('Detected 3 AMG(s)');
      expect(analysis.topOverallImpactedSubsystem).not.toBe('None');
    });

    it('handles phage with zero AMGs cleanly', () => {
      const mockPhage = {
        id: 300,
        name: 'Phage Lambda',
        genes: [
          {
            id: 1,
            name: 'cI',
            product: 'repressor',
            domains: [],
            startPos: 100,
            endPos: 500,
            strand: '+',
          },
          {
            id: 2,
            name: 'cro',
            product: 'antirepressor',
            domains: [],
            startPos: 600,
            endPos: 800,
            strand: '-',
          },
        ],
      } as unknown as PhageFull;

      const analysis = runAMGFluxAnalysis(mockPhage);

      expect(analysis.detectedAmgs.length).toBe(0);
      expect(analysis.amgResults.length).toBe(0);
      expect(analysis.totalDeltaFlux).toBe(0);
      expect(analysis.topOverallImpactedSubsystem).toBe('None');
      expect(analysis.summary).toBe('No Auxiliary Metabolic Genes detected in this phage genome.');
    });
  });
});
