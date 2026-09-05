import { describe, expect, it } from 'bun:test';
import {
  CANONICAL_HOST_TARGETS,
  CURATED_DOMAIN_PRIORS,
  embeddingCosineSimilarity,
  calculateDomainCompatibility,
  computeDockingAffinity,
  fuseBayesianEvidence,
  simulateInSilicoEffectorMutations,
  analyzeHostInteractions,
  inferPhageProteinDomains,
  deriveProteinPseudoEmbedding,
} from './host-interactions';
import type { PhageFull, GeneInfo } from '../types';

function mockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 1,
    slug: 'enterobacteria-phage-t4',
    name: 'Enterobacteria phage T4',
    accession: 'NC_000866',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 168903,
    gcContent: 35.3,
    morphology: 'myovirus',
    lifecycle: 'lytic',
    description: null,
    baltimoreGroup: 'I',
    genomeType: 'dsDNA',
    pdbIds: ['1YFP', '2XGF'],
    genes: [],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Host interaction illustration and mathematical helpers', () => {
  it.each([undefined, { demonstration: false }, { embeddingOverrides: new Map([[1, [1, 0, 0]]]) }])('rejects ordinary physical interaction requests: %p', options => {
    expect(() => analyzeHostInteractions(mockPhage(), undefined, options)).toThrow('explicit demonstration');
  });
  describe('Canonical Host Database & Domain Priors', () => {
    it('contains comprehensive bacterial host targets across compartments', () => {
      expect(CANONICAL_HOST_TARGETS.length).toBeGreaterThanOrEqual(15);

      const ompC = CANONICAL_HOST_TARGETS.find((h) => h.id === 'OmpC');
      expect(ompC).toBeDefined();
      expect(ompC?.compartment).toBe('outer_membrane');
      expect(ompC?.functionalCategory).toBe('receptor-binding');
      expect(ompC?.embedding.length).toBe(320);
      expect(ompC?.surfaceCharge).toBeLessThan(0); // Anionic outer surface

      const cas9 = CANONICAL_HOST_TARGETS.find((h) => h.id === 'Cas9');
      expect(cas9).toBeDefined();
      expect(cas9?.isDefenseSystem).toBe(true);
      expect(cas9?.functionalCategory).toBe('anti-defense');
      expect(cas9?.surfaceCharge).toBeGreaterThan(0); // Cationic DNA-binding cleft

      const rpoD = CANONICAL_HOST_TARGETS.find((h) => h.id === 'RpoD_sigma70');
      expect(rpoD).toBeDefined();
      expect(rpoD?.functionalCategory).toBe('transcription-takeover');
    });

    it('contains curated domain-domain interaction priors from iPfam/3did', () => {
      expect(CURATED_DOMAIN_PRIORS.length).toBeGreaterThanOrEqual(12);

      const tailPorin = CURATED_DOMAIN_PRIORS.find(
        (p) => p.phageDomain === 'PF03906' && p.hostDomain === 'PF00595'
      );
      expect(tailPorin).toBeDefined();
      expect(tailPorin?.priorScore).toBeGreaterThanOrEqual(0.85);

      const acrCas = CURATED_DOMAIN_PRIORS.find(
        (p) => p.phageDomain === 'PF16811' && p.hostDomain === 'PF09707'
      );
      expect(acrCas).toBeDefined();
      expect(acrCas?.priorScore).toBeGreaterThanOrEqual(0.90);
    });
  });

  describe('Vector Similarity & Domain Compatibility', () => {
    it('computes normalized cosine similarity accurately', () => {
      const vecA = new Float32Array([1, 0, 0, 0]);
      const vecB = new Float32Array([1, 0, 0, 0]);
      const vecC = new Float32Array([0, 1, 0, 0]);
      const vecD = new Float32Array([-1, 0, 0, 0]);

      expect(embeddingCosineSimilarity(vecA, vecB)).toBeCloseTo(1.0, 4);
      expect(embeddingCosineSimilarity(vecA, vecC)).toBeCloseTo(0.5, 4); // orthogonal -> 0.5 in [0, 1]
      expect(embeddingCosineSimilarity(vecA, vecD)).toBeCloseTo(0.0, 4); // opposite -> 0.0 in [0, 1]
    });

    it('evaluates domain compatibility scores from Pfam annotations', () => {
      const phageDomains = [{ domainId: 'PF03906', domainName: 'Phage_tail_fiber' }];
      const hostPorinDomains = [{ domainId: 'PF00595', domainName: 'Porin' }];
      const hostCasDomains = [{ domainId: 'PF09707', domainName: 'Cas9_REC' }];

      const matched = calculateDomainCompatibility(phageDomains, hostPorinDomains);
      expect(matched.score).toBeGreaterThan(0.85);
      expect(matched.supportingPairs.length).toBeGreaterThan(0);

      const unmatched = calculateDomainCompatibility(phageDomains, hostCasDomains);
      expect(unmatched.score).toBeLessThan(0.1);
      expect(unmatched.supportingPairs.length).toBe(0);
    });

    it('derives protein domains and pseudo-embeddings from gene annotations', () => {
      const tailGene: GeneInfo = {
        id: 37,
        name: 'gp37',
        product: 'long tail fiber distal subunit',
        locusTag: 'T4_037',
        startPos: 1000,
        endPos: 2500,
        strand: '+',
        type: 'CDS',
      };

      const domains = inferPhageProteinDomains(tailGene);
      expect(domains.some((d) => d.domainId === 'PF03906')).toBe(true);

      const embedding = deriveProteinPseudoEmbedding(tailGene);
      expect(embedding.length).toBe(320);
    });
  });

  describe('Docking Footprint & Bayesian Evidence Fusion', () => {
    it('computes docking interface footprint, BSA, and binding free energy', () => {
      const tailGene: GeneInfo = {
        id: 37,
        name: 'gp37',
        product: 'long tail fiber distal subunit',
        locusTag: 'T4_037',
        startPos: 1000,
        endPos: 2500,
        strand: '+',
        type: 'CDS',
      };

      const ompC = CANONICAL_HOST_TARGETS.find((h) => h.id === 'OmpC')!;
      const docking = computeDockingAffinity(tailGene, ompC);

      expect(docking.buriedSurfaceAreaA2).toBeGreaterThanOrEqual(800);
      expect(docking.buriedSurfaceAreaA2).toBeLessThanOrEqual(2000);
      expect(docking.estimatedDeltaG_kcal_mol).toBeLessThan(-5.0); // Spontaneous binding
      expect(docking.estimatedKd_nM).toBeGreaterThan(0);
      expect(docking.phageResidueWindow).toContain('Distal Tip');
      expect(docking.hostResidueWindow).toContain('Loop');
    });

    it('fuses multi-evidence sources into calibrated confidence score', () => {
      // High evidence on all channels
      const highResult = fuseBayesianEvidence(0.85, 0.92, 0.88);
      expect(highResult.confidence).toBeGreaterThan(0.75);
      expect(highResult.evidenceLevel).toBe('high');

      // Moderate evidence
      const medResult = fuseBayesianEvidence(0.60, 0.40, 0.50);
      expect(medResult.confidence).toBeGreaterThan(0.35);
      expect(medResult.evidenceLevel).toBe('medium');

      // Low evidence
      const lowResult = fuseBayesianEvidence(0.20, 0.05, 0.20);
      expect(lowResult.confidence).toBeLessThan(0.40);
      expect(lowResult.evidenceLevel).toBe('low');
    });
  });

  describe('Full Pipeline Analysis (analyzeHostInteractions)', () => {
    it('analyzes phage effectors and builds bipartite interaction network', () => {
      const mockPhageObj = mockPhage({
        genes: [
          {
            id: 37,
            name: 'gp37',
            product: 'long tail fiber distal subunit receptor binding',
            locusTag: 'T4_037',
            startPos: 1000,
            endPos: 3500,
            strand: '+',
            type: 'CDS',
          },
          {
            id: 38,
            name: 'gp38',
            product: 'tail fiber adhesin receptor recognition protein',
            locusTag: 'T4_038',
            startPos: 3600,
            endPos: 4200,
            strand: '+',
            type: 'CDS',
          },
          {
            id: 50,
            name: 'AsiA',
            product: 'anti-sigma factor 70 transcription modifier',
            locusTag: 'T4_050',
            startPos: 15000,
            endPos: 15300,
            strand: '-',
            type: 'CDS',
          },
          {
            id: 60,
            name: 'MazG',
            product: 'pyrophosphohydrolase abortive infection evasion',
            locusTag: 'T4_060',
            startPos: 22000,
            endPos: 22800,
            strand: '+',
            type: 'CDS',
          },
        ],
      });

      const result = analyzeHostInteractions(mockPhageObj, undefined, { demonstration: true });
      expect(result.source).toBe('demonstration');
      expect(result.assumptions).toContain('invented model outputs');

      expect(result.totalInteractions).toBeGreaterThan(0);
      expect(result.bipartiteNodes.length).toBeGreaterThan(0);
      expect(result.bipartiteEdges.length).toBe(result.totalInteractions);

      // Verify receptor binding interactions
      const gp37OmpC = result.interactions.find(
        (i) => i.phageProteinName === 'gp37' && (i.hostProteinId === 'OmpC' || i.hostProteinId === 'OmpF')
      );
      expect(gp37OmpC).toBeDefined();
      expect(gp37OmpC?.functionalRole).toBe('receptor-binding');
      expect(gp37OmpC?.confidence).toBeGreaterThan(0.60);

      // Verify transcription takeover interaction
      const asiARpoD = result.interactions.find(
        (i) => i.phageProteinName === 'AsiA' && i.hostProteinId === 'RpoD_sigma70'
      );
      expect(asiARpoD).toBeDefined();
      expect(asiARpoD?.functionalRole).toBe('transcription-takeover');

      // Verify role tallies
      expect(result.interactionsByRole['receptor-binding']).toBeGreaterThan(0);
      expect(result.interactionsByRole['transcription-takeover']).toBeGreaterThan(0);

      // Hub proteins identified
      expect(result.hubPhageProteins.length).toBeGreaterThan(0);
      expect(result.hubHostProteins.length).toBeGreaterThan(0);

      // In-silico engineering candidates generated
      expect(result.inSilicoEngineeringCandidates.length).toBeGreaterThanOrEqual(2);
      for (const cand of result.inSilicoEngineeringCandidates) {
        expect(cand.deltaDeltaG).toBeLessThan(0); // Tighter binding engineered
        expect(cand.predictedFoldAffinityChange).toBeGreaterThan(1.0);
      }
    });

    it('simulates in-silico effector engineering modifications', () => {
      const mockInteractions = [
        {
          id: 'ppi-1-37-OmpC',
          phageGeneId: 37,
          phageProteinName: 'gp37',
          phageProduct: 'tail fiber',
          phageStartPos: 1000,
          phageEndPos: 2500,
          hostProteinId: 'OmpC',
          hostProteinName: 'Outer membrane porin C',
          hostOrganism: 'Escherichia coli K-12',
          hostCompartment: 'outer_membrane' as const,
          functionalRole: 'receptor-binding' as const,
          embeddingSimilarity: 0.82,
          domainCompatibility: 0.92,
          dockingAffinityScore: 0.88,
          confidence: 0.89,
          evidenceLevel: 'high' as const,
          supportingPfamPairs: ['PF03906 ↔ PF00595'],
          dockingFootprint: {
            phageResidueWindow: 'Distal Tip',
            hostResidueWindow: 'Loop L3',
            buriedSurfaceAreaA2: 1300,
            estimatedDeltaG_kcal_mol: -8.8,
            estimatedKd_nM: 32,
            electrostaticMatchScore: 0.88,
          },
          mechanisticRationale: 'Distal tip loop binds porin',
        },
      ];

      const mutations = simulateInSilicoEffectorMutations(mockInteractions);
      expect(mutations.length).toBeGreaterThanOrEqual(1);

      const tailMut = mutations[0];
      expect(tailMut.phageProtein).toBe('gp37');
      expect(tailMut.deltaDeltaG).toBeLessThan(0);
      expect(tailMut.engineeredDeltaG).toBeLessThan(tailMut.baselineDeltaG);
      expect(tailMut.structuralRationale).toBeDefined();
    });

    it('operates safely when phage has no genes', () => {
      const emptyPhage = mockPhage({ genes: [] });
      const result = analyzeHostInteractions(emptyPhage, undefined, { demonstration: true });

      expect(result.totalInteractions).toBe(0);
      expect(result.bipartiteNodes.length).toBe(0);
      expect(result.bipartiteEdges.length).toBe(0);
      expect(result.inSilicoEngineeringCandidates.length).toBe(0);
      expect(result.summary).toContain('Identified 0 candidate effector interactions');
    });
  });
});
