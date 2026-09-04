import { describe, expect, it } from 'bun:test';
import type { PhageFull } from '../types';
import {
  analyzePhageHostCodonAdaptation,
  calculateCAI,
  calculateGeneCPB,
  CANDIDATE_HOST_PROFILES,
  classifyFunctionalModule,
  matchHostProfile,
} from './codon-pair-adaptation';

function makeMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 101,
    slug: 'phage-t4',
    name: 'Bacteriophage T4',
    accession: 'NC_000866',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 168903,
    gcContent: 35.3,
    morphology: 'myovirus',
    lifecycle: 'virulent',
    description: null,
    baltimoreGroup: null,
    genomeType: 'dsDNA',
    pdbIds: [],
    genes: [
      {
        id: 1,
        name: 'gp23',
        locusTag: 'T4_023',
        startPos: 0,
        endPos: 30, // 10 codons
        strand: '+',
        product: 'major capsid protein',
        type: 'CDS',
      },
      {
        id: 2,
        name: 'gp43',
        locusTag: 'T4_043',
        startPos: 30,
        endPos: 60,
        strand: '+',
        product: 'DNA polymerase',
        type: 'CDS',
      },
      {
        id: 3,
        name: 'e',
        locusTag: 'T4_e',
        startPos: 60,
        endPos: 90,
        strand: '-',
        product: 'endolysin',
        type: 'CDS',
      },
      {
        id: 4,
        name: 'gp17',
        locusTag: 'T4_017',
        startPos: 90,
        endPos: 120,
        strand: '+',
        product: 'terminase large subunit',
        type: 'CDS',
      },
      {
        id: 5,
        name: 'nrdA',
        locusTag: 'T4_nrdA',
        startPos: 120,
        endPos: 150,
        strand: '+',
        product: 'ribonucleotide reductase alpha subunit',
        type: 'CDS',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Codon & Codon-Pair Adaptation Lens - Core', () => {
  describe('Candidate Host Reference Profiles', () => {
    it('defines reference profiles for major bacterial pathogen hosts', () => {
      expect(CANDIDATE_HOST_PROFILES.escherichia_coli).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.pseudomonas_aeruginosa).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.staphylococcus_aureus).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.mycobacterium_tuberculosis).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.salmonella_enterica).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.bacillus_subtilis).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.acinetobacter_baumannii).toBeDefined();
      expect(CANDIDATE_HOST_PROFILES.klebsiella_pneumoniae).toBeDefined();
    });

    it('each host profile has positive codon weights with optimal codons at 1.0', () => {
      for (const [key, host] of Object.entries(CANDIDATE_HOST_PROFILES)) {
        expect(host.key).toBe(key);
        expect(host.meanCpb).toBeGreaterThan(0);
        expect(host.stdCpb).toBeGreaterThan(0);

        // Standard sense codons
        const weights = Object.values(host.codonWeights);
        expect(weights.length).toBe(64);
        for (const w of weights) {
          expect(w).toBeGreaterThan(0);
          expect(w).toBeLessThanOrEqual(1.0);
        }
        // At least one optimal codon with weight 1.0
        expect(weights.some((w) => w === 1.0)).toBe(true);
      }
    });

    it('matches host string to closest reference profile', () => {
      expect(matchHostProfile('Escherichia coli O157:H7').key).toBe('escherichia_coli');
      expect(matchHostProfile('Pseudomonas aeruginosa PAO1').key).toBe('pseudomonas_aeruginosa');
      expect(matchHostProfile('Staphylococcus aureus USA300').key).toBe('staphylococcus_aureus');
      expect(matchHostProfile(null).key).toBe('escherichia_coli');
    });
  });

  describe('Functional Module Classifier', () => {
    it('correctly maps diverse gene names and products to canonical modules', () => {
      expect(classifyFunctionalModule('gp23', 'major capsid protein')).toBe('structural');
      expect(classifyFunctionalModule('gp12', 'short tail fiber')).toBe('structural');
      expect(classifyFunctionalModule('polA', 'DNA polymerase I')).toBe('replication');
      expect(classifyFunctionalModule('dnaB', 'replicative helicase')).toBe('replication');
      expect(classifyFunctionalModule('lys', 'endolysin enzyme')).toBe('lysis');
      expect(classifyFunctionalModule('hol', 'holin class II')).toBe('lysis');
      expect(classifyFunctionalModule('terL', 'terminase large subunit')).toBe('packaging_regulatory');
      expect(classifyFunctionalModule('cI', 'lysogenic repressor')).toBe('packaging_regulatory');
      expect(classifyFunctionalModule('psbA', 'photosystem II D1 protein')).toBe('amg_auxiliary');
      expect(classifyFunctionalModule('unknown', 'hypothetical protein')).toBe('unclassified');
    });
  });

  describe('CAI and Codon-Pair Bias (CPB) Calculations', () => {
    const eColi = CANDIDATE_HOST_PROFILES.escherichia_coli;

    it('calculates CAI close to 1.0 for highly optimized codons and lower for rare codons', () => {
      // High-weight codons in E. coli: CTG (Leu=1.0), GAA (Glu=1.0), AAA (Lys=1.0), GCG (Ala=1.0)
      const optimalSeq = 'CTG'.repeat(10) + 'GAA'.repeat(10) + 'AAA'.repeat(10);
      const optimalCai = calculateCAI(optimalSeq, eColi);
      expect(optimalCai).toBeGreaterThanOrEqual(0.95);

      // Rare codons in E. coli: CTA (Leu=0.036), ATA (Ile=0.003), CGA (Arg=0.005)
      const rareSeq = 'CTA'.repeat(10) + 'ATA'.repeat(10) + 'CGA'.repeat(10);
      const rareCai = calculateCAI(rareSeq, eColi);
      expect(rareCai).toBeLessThan(0.15);
      expect(rareCai).toBeGreaterThan(0);
    });

    it('calculates positive CPB for preferred codon pairs and negative CPB for deoptimized pairs', () => {
      // E. coli preferred pairs: CTG_CTG, GAA_GAA, AAA_AAA
      const preferredSeq = 'CTGCTGCTGCTG' + 'GAAGAAGAAGAA';
      const prefStats = calculateGeneCPB(preferredSeq, eColi);
      expect(prefStats.cpb).toBeGreaterThan(0.2);
      expect(prefStats.zScore).toBeGreaterThan(0);
      expect(prefStats.preferredPairs).toBeGreaterThan(0);

      // E. coli deoptimized pairs: CGA_CGA, AGG_AGG, ATA_ATA
      const deoptimizedSeq = 'CGACGA' + 'AGGAGG' + 'ATAATA';
      const deoptStats = calculateGeneCPB(deoptimizedSeq, eColi);
      expect(deoptStats.cpb).toBeLessThan(0);
      expect(deoptStats.zScore).toBeLessThan(0);
      expect(deoptStats.deoptimizedPairs).toBeGreaterThan(0);
    });

    it('handles short or empty sequences without error', () => {
      const emptyStats = calculateGeneCPB('', eColi);
      expect(emptyStats.cpb).toBe(0);
      expect(emptyStats.pairCount).toBe(0);

      const oneCodonStats = calculateGeneCPB('ATG', eColi);
      expect(oneCodonStats.cpb).toBe(0);
      expect(oneCodonStats.pairCount).toBe(0);
    });
  });

  describe('Full Phage-Host Codon Adaptation Analysis', () => {
    it('analyzes mock phage genome, module summaries, and host rankings', () => {
      // Construct a mock genome sequence matching the 5 mock genes (each 30 bp = 10 codons)
      // Gene 1 (gp23): optimal E. coli sequence
      const gene1 = 'CTG'.repeat(5) + 'AAA'.repeat(5);
      // Gene 2 (gp43): optimal E. coli sequence
      const gene2 = 'GAA'.repeat(5) + 'GCG'.repeat(5);
      // Gene 3 (endolysin): moderate sequence
      const gene3 = 'GTT'.repeat(5) + 'ACC'.repeat(5);
      // Gene 4 (terminase):
      const gene4 = 'TTC'.repeat(5) + 'ATC'.repeat(5);
      // Gene 5 (nrdA): optimal Pseudomonas sequence (CGC, GCC, GAG)
      const gene5 = 'CGC'.repeat(5) + 'GCC'.repeat(5);

      const mockGenome = gene1 + gene2 + gene3 + gene4 + gene5;
      const phage = makeMockPhage();

      const result = analyzePhageHostCodonAdaptation(phage, {
        genomeSequence: mockGenome,
        primaryHostName: 'Escherichia coli',
      });

      expect(result.phageId).toBe(101);
      expect(result.primaryHost).toBe('Escherichia coli');
      expect(result.genes.length).toBe(5);

      // Verify module aggregation
      expect(result.modules.length).toBeGreaterThanOrEqual(4);
      const structMod = result.modules.find((m) => m.module === 'structural');
      expect(structMod).toBeDefined();
      expect(structMod?.geneCount).toBe(1);
      expect(structMod?.meanCai).toBeGreaterThan(0.8);

      const lysisMod = result.modules.find((m) => m.module === 'lysis');
      expect(lysisMod).toBeDefined();

      const amgMod = result.modules.find((m) => m.module === 'amg_auxiliary');
      expect(amgMod).toBeDefined();

      // Host rankings
      expect(result.hostRankings.length).toBe(Object.keys(CANDIDATE_HOST_PROFILES).length);
      const topRank = result.hostRankings[0];
      expect(topRank.overallCompatibility).toBeGreaterThan(0);
      expect(topRank.overallCompatibility).toBeLessThanOrEqual(100);

      // Gene 5 was engineered with Pseudomonas-preferred codons (CGC/GCC)
      // Check if it has an alternative best host or footprint
      const nrdAGene = result.genes.find((g) => g.name === 'nrdA');
      expect(nrdAGene).toBeDefined();
      expect(nrdAGene?.cai.pseudomonas_aeruginosa).toBeGreaterThan(0.7);

      expect(result.summary).toContain('Evaluated 5 genes against 8 candidate bacterial hosts');
    });

    it('gracefully handles phages without loaded sequence using gene codon approximations', () => {
      const phage = makeMockPhage();
      const result = analyzePhageHostCodonAdaptation(phage, {
        genomeSequence: null,
      });

      expect(result.genes.length).toBe(5);
      for (const g of result.genes) {
        expect(g.primaryHostCai).toBeGreaterThan(0);
        expect(g.cai.escherichia_coli).toBeGreaterThan(0);
      }
      expect(result.hostRankings.length).toBe(8);
    });
  });
});
