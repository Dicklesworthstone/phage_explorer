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
} from './amg-flux';

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

      expect(deltaResult.baselineObjective).toBe(baseFba.objectiveValue);
      expect(deltaResult.augmentedObjective).toBeGreaterThanOrEqual(deltaResult.baselineObjective);
      expect(deltaResult.fitnessScore).toBeGreaterThanOrEqual(0);
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
