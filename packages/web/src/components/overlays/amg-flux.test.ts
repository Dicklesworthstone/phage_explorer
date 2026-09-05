import { describe, expect, it } from 'bun:test';
import {
  createStandardHostMetabolicModel,
  runAMGFluxAnalysis,
  runDeltaFbaForAmg,
  AMG_KNOWLEDGE_BASE,
  type PhageFull,
} from '@phage-explorer/core';
import { AMG_MARKER_GENES } from './AMGPathwayOverlay';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 42,
    slug: 'cyanophage-syn9',
    name: 'Prochlorococcus phage Syn9',
    accession: 'NC_008296',
    family: 'Myoviridae',
    host: 'Prochlorococcus marinus',
    genomeLength: 177300,
    gcContent: 37.6,
    morphology: 'myovirus',
    lifecycle: 'virulent',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [
      {
        id: 1,
        name: 'psbA',
        locusTag: 'Syn9_001',
        startPos: 1200,
        endPos: 2200,
        strand: '+',
        product: 'photosystem II P680 reaction center D1 protein',
        domains: ['PF00124'],
        type: 'CDS',
      },
      {
        id: 2,
        name: 'nrdA',
        locusTag: 'Syn9_002',
        startPos: 3500,
        endPos: 5800,
        strand: '+',
        product: 'ribonucleotide reductase alpha subunit',
        domains: ['PF00317'],
        type: 'CDS',
      },
      {
        id: 3,
        name: 'phoH',
        locusTag: 'Syn9_003',
        startPos: 7000,
        endPos: 8100,
        strand: '-',
        product: 'phosphate starvation inducible protein',
        domains: ['PF04997'],
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('AMG Flux Potential Analyzer (Web & Integration)', () => {
  it('preserves the 8 canonical AMG marker genes', () => {
    expect(AMG_MARKER_GENES).toEqual([
      'psbA',
      'psbD',
      'phoH',
      'mazG',
      'nrdA',
      'nrdB',
      'thyA',
      'dut',
    ]);
  });

  it('runs Delta-FBA analysis on mock cyanophage and detects multiple AMGs', () => {
    const phage = createMockPhage();
    const result = runAMGFluxAnalysis(phage, { boostFactor: 5.0 });

    expect(result.phageId).toBe(42);
    expect(result.phageName).toBe('Prochlorococcus phage Syn9');
    expect(result.detectedAmgs.length).toBe(3);
    expect(result.amgResults.length).toBe(3);

    // Verify detected AMGs
    const names = result.detectedAmgs.map((a) => a.geneName);
    expect(names).toContain('psbA');
    expect(names).toContain('nrdA');
    expect(names).toContain('phoH');

    // Verify positive objective flux
    expect(result.baselineFba.objectiveValue).toBeGreaterThan(0);
    expect(result.totalDeltaFlux).toBeGreaterThanOrEqual(0);
    expect(result.summary).toContain('Detected 3 AMG(s)');
  });

  it('computes reaction-level deltas and pathway impacts for boosted reactions', () => {
    const phage = createMockPhage();
    const result = runAMGFluxAnalysis(phage, { boostFactor: 4.0 });

    const nrdAResult = result.amgResults.find((r) => r.amg.geneName === 'nrdA');
    expect(nrdAResult).toBeDefined();
    expect(nrdAResult?.augmentedObjective).toBeGreaterThanOrEqual(nrdAResult!.baselineObjective);
    expect(nrdAResult?.percentGain).toBeGreaterThanOrEqual(0);
    expect(nrdAResult?.topReactionDeltas.length).toBeGreaterThan(0);

    const rnrReaction = nrdAResult?.topReactionDeltas.find((r) => r.reactionId === 'RNR_REDUCTASE');
    expect(rnrReaction).toBeDefined();
    expect(rnrReaction?.deltaFlux).toBeGreaterThanOrEqual(0);
  });

  it('evaluates what-if simulated candidate gains when no AMGs are present', () => {
    const lambdaPhage = createMockPhage({
      name: 'Enterobacteria phage lambda',
      genes: [
        {
          id: 10,
          name: 'cI',
          locusTag: 'lam_01',
          startPos: 100,
          endPos: 700,
          strand: '+',
          product: 'repressor',
          type: 'CDS',
        },
      ],
    });

    const analysis = runAMGFluxAnalysis(lambdaPhage);
    expect(analysis.detectedAmgs.length).toBe(0);

    // Simulate what-if gains across AMG_KNOWLEDGE_BASE
    const hostModel = createStandardHostMetabolicModel();
    const whatIfResults = AMG_KNOWLEDGE_BASE.map((kb) => {
      const dummyAmg = {
        geneId: 999,
        geneName: kb.ko.name.split(' ')[0],
        locusTag: kb.ko.ko,
        start: 0,
        end: 1000,
        strand: '+',
        amgClass: kb.amgClass,
        koMapping: kb.ko,
        evidence: 'gene_name' as const,
        boostedReactions: [...kb.reactions],
      };
      return runDeltaFbaForAmg(hostModel, dummyAmg, analysis.baselineFba, 5.0);
    });

    expect(whatIfResults.length).toBe(AMG_KNOWLEDGE_BASE.length);
    for (const r of whatIfResults) {
      expect(r.status).toBe('optimal');
      if (r.status !== 'optimal') throw new Error(r.status);
      expect(r.augmentedObjective).toBeGreaterThanOrEqual(r.baselineObjective);
      expect(r.percentGain).toBeGreaterThanOrEqual(0);
    }
  });
});
