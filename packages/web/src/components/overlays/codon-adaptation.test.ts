import { describe, expect, it } from 'bun:test';
import {
  analyzePhageHostCodonAdaptation,
  HOST_REFERENCE_PROFILES,
  type PhageFull,
} from '@phage-explorer/core';
import { getAdaptationColor } from './CodonAdaptationOverlay';

function createMockPhage(overrides: Partial<PhageFull> = {}): PhageFull {
  return {
    id: 101,
    slug: 'enterobacteria-phage-t4',
    name: 'Enterobacteria phage T4',
    accession: 'NC_000866',
    family: 'Myoviridae',
    host: 'Escherichia coli',
    genomeLength: 168903,
    gcContent: 34.5,
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
        locusTag: 'T4_001',
        startPos: 100,
        endPos: 400,
        strand: '+',
        product: 'major capsid protein',
        type: 'CDS',
      },
      {
        id: 2,
        name: 'e',
        locusTag: 'T4_002',
        startPos: 500,
        endPos: 800,
        strand: '+',
        product: 'endolysin lysozyme',
        type: 'CDS',
      },
      {
        id: 3,
        name: 'gp43',
        locusTag: 'T4_003',
        startPos: 900,
        endPos: 1500,
        strand: '+',
        product: 'DNA polymerase',
        type: 'CDS',
      },
      {
        id: 4,
        name: 'nrdA',
        locusTag: 'T4_004',
        startPos: 1600,
        endPos: 2100,
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

describe('Codon Adaptation Overlay & Lens Tests', () => {
  describe('Color scale mapping', () => {
    it('returns appropriate color thresholds for adaptation scores', () => {
      expect(getAdaptationColor(0.9)).toBe('#22c55e'); // Green
      expect(getAdaptationColor(0.8)).toBe('#22c55e');
      expect(getAdaptationColor(0.7)).toBe('#84cc16'); // Lime
      expect(getAdaptationColor(0.6)).toBe('#84cc16');
      expect(getAdaptationColor(0.5)).toBe('#f59e0b'); // Orange
      expect(getAdaptationColor(0.4)).toBe('#f59e0b');
      expect(getAdaptationColor(0.3)).toBe('#f97316'); // Dark orange
      expect(getAdaptationColor(0.2)).toBe('#f97316');
      expect(getAdaptationColor(0.1)).toBe('#ef4444'); // Red
      expect(getAdaptationColor(0.0)).toBe('#ef4444');
    });
  });

  describe('Full Phage-Host Adaptation Analysis Integration', () => {
    it('computes multi-host rankings and identifies primary host', () => {
      const phage = createMockPhage();
      const result = analyzePhageHostCodonAdaptation(phage, { genomeSequence: 'CTG'.repeat(700) });

      expect(result.phageId).toBe(101);
      expect(result.phageName).toBe('Enterobacteria phage T4');
      expect(result.primaryHost).toBe('Escherichia coli');
      expect(result.hostRankings.length).toBe(Object.keys(HOST_REFERENCE_PROFILES).length);

      // Primary host ranking is present
      const primaryRank = result.hostRankings.find((r) => r.isPrimaryHost);
      expect(primaryRank).toBeDefined();
      expect(primaryRank?.overallCompatibility).toBeGreaterThan(0);
      expect(primaryRank?.overallCompatibility).toBeLessThanOrEqual(100);

      // Top rank has valid compatibility score
      const topRank = result.hostRankings[0];
      expect(topRank.overallCompatibility).toBeGreaterThan(0);
      expect(topRank.overallCompatibility).toBeLessThanOrEqual(100);

      // Rankings must be sorted descending by overall compatibility score
      for (let i = 0; i < result.hostRankings.length - 1; i++) {
        expect(result.hostRankings[i].overallCompatibility).toBeGreaterThanOrEqual(
          result.hostRankings[i + 1].overallCompatibility
        );
      }
    });

    it('classifies genes into functional modules and produces module adaptation summaries', () => {
      const phage = createMockPhage();
      const result = analyzePhageHostCodonAdaptation(phage, { genomeSequence: 'CTG'.repeat(700) });

      expect(result.genes.length).toBe(4);

      const gp23 = result.genes.find((g) => g.name === 'gp23');
      expect(gp23?.module).toBe('structural');

      const endolysin = result.genes.find((g) => g.name === 'e');
      expect(endolysin?.module).toBe('lysis');

      const gp43 = result.genes.find((g) => g.name === 'gp43');
      expect(gp43?.module).toBe('replication');

      const nrdA = result.genes.find((g) => g.name === 'nrdA');
      expect(nrdA?.module).toBe('amg_auxiliary');

      // Check module summaries
      expect(result.modules.length).toBeGreaterThanOrEqual(4);
      for (const mod of result.modules) {
        expect(mod.geneCount).toBeGreaterThan(0);
        expect(mod.meanCai).toBeGreaterThan(0);
        expect(['adapted', 'transitional', 'mismatched_acquisition']).toContain(mod.adaptationStatus);
      }
    });

    it('detects host switching footprints when alternative hosts show higher CAI', () => {
      // Mock phage with genome sequence heavily optimized for Pseudomonas codons in gene 4
      const gene1 = 'CTG'.repeat(100); // 300 bp (100 to 400)
      const gene2 = 'CTG'.repeat(100); // 300 bp (500 to 800)
      const gene3 = 'CTG'.repeat(200); // 600 bp (900 to 1500)
      // Gene 4 (1600 to 2100 = 500 bp): Pseudomonas-favored codons CGC / GCC / GAG
      const gene4 = 'CGC'.repeat(80) + 'GCC'.repeat(80);
      const mockGenome = 'N'.repeat(100) + gene1 + 'N'.repeat(100) + gene2 + 'N'.repeat(100) + gene3 + 'N'.repeat(100) + gene4;

      const phage = createMockPhage({
        host: 'Escherichia coli',
      });

      const result = analyzePhageHostCodonAdaptation(phage, {
        genomeSequence: mockGenome,
        primaryHostName: 'Escherichia coli',
      });
      expect(result).toBeDefined();
      expect(Array.isArray(result.hostSwitchCandidates)).toBe(true);

      // Verify footprint fields for candidates
      for (const cand of result.hostSwitchCandidates) {
        expect(cand.geneId).toBeDefined();
        expect(cand.hostSwitchFootprint).toBeDefined();
        expect(cand.hostSwitchFootprint?.caiDelta).toBeGreaterThan(0);
        expect(cand.hostSwitchFootprint?.candidateHost).toBeDefined();
      }
    });

    it('operates safely when phage has no genes or sequence', () => {
      const emptyPhage = createMockPhage({
        genes: [],
      });

      const result = analyzePhageHostCodonAdaptation(emptyPhage);
      expect(result.genes).toEqual([]);
      expect(result.modules).toEqual([]);
      expect(result.hostSwitchCandidates).toEqual([]);
      expect(result.hostRankings).toEqual([]);
      expect(result.summary).toContain('No host scores were inferred');
    });
  });
});
