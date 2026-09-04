import { describe, expect, it } from 'bun:test';
import {
  constructPangenomeGraph,
  CANONICAL_PANGENOME_TEMPLATES,
  type PangenomeGraphResult,
} from './pangenome-graph';
import type { PhageFull } from '../types';

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
    genes: [
      {
        id: 1,
        name: 'gp23',
        product: 'Major capsid protein',
        startPos: 10000,
        endPos: 11500,
        strand: '+',
        type: 'CDS',
        locusTag: 'T4_023',
      },
      {
        id: 2,
        name: 'gp37',
        product: 'Tail fiber distal subunit',
        startPos: 135000,
        endPos: 138500,
        strand: '+',
        type: 'CDS',
        locusTag: 'T4_037',
      },
    ],
    codonUsage: null,
    hasModel: false,
    ...overrides,
  };
}

describe('Pan-Phage Graph Pangenome & Variant Cards (Roadmap Top-10 #3)', () => {
  describe('Canonical Pangenome Templates', () => {
    it('defines rich comparative companion genomes for myoviruses and siphoviruses', () => {
      expect(CANONICAL_PANGENOME_TEMPLATES.myovirus).toBeDefined();
      expect(CANONICAL_PANGENOME_TEMPLATES.siphovirus).toBeDefined();

      const myo = CANONICAL_PANGENOME_TEMPLATES.myovirus;
      expect(myo.companionGenomes.length).toBeGreaterThanOrEqual(3);
      expect(myo.companionGenomes.some((g) => g.id === 'phage-t2')).toBe(true);
      expect(myo.companionGenomes.some((g) => g.id === 'phage-rb69')).toBe(true);

      const sipho = CANONICAL_PANGENOME_TEMPLATES.siphovirus;
      expect(sipho.companionGenomes.length).toBeGreaterThanOrEqual(2);
      expect(sipho.companionGenomes.some((g) => g.id === 'phage-434')).toBe(true);
      expect(sipho.companionGenomes.some((g) => g.id === 'phage-hk97')).toBe(true);
    });
  });

  describe('Graph Construction & Bubble Decomposition', () => {
    it('constructs sequence graph with core backbones and variant branches for T4', () => {
      const phage = mockPhage();
      const result: PangenomeGraphResult = constructPangenomeGraph(phage);

      expect(result.referencePhageName).toBe(phage.name);
      expect(result.includedGenomesCount).toBeGreaterThanOrEqual(4); // T4 + T2, T6, RB69
      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.links.length).toBeGreaterThan(0);
      expect(result.paths.length).toBe(result.includedGenomesCount);

      // Core segments should have frequency 1.0 and isCore true
      const coreSegments = result.segments.filter((s) => s.isCore);
      expect(coreSegments.length).toBeGreaterThan(0);
      for (const core of coreSegments) {
        expect(core.frequency).toBe(1.0);
        expect(core.isCore).toBe(true);
      }

      // Branch segments should have frequency < 1.0 and isCore false
      const branchSegments = result.segments.filter((s) => !s.isCore);
      expect(branchSegments.length).toBeGreaterThan(0);
      for (const branch of branchSegments) {
        expect(branch.isCore).toBe(false);
        expect(branch.frequency).toBeLessThan(1.0);
      }
    });

    it('creates valid topology links connecting core backbones through bubble branches', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);

      const segmentIds = new Set(result.segments.map((s) => s.id));
      for (const link of result.links) {
        expect(segmentIds.has(link.fromSegment)).toBe(true);
        expect(segmentIds.has(link.toSegment)).toBe(true);
        expect(['+', '-']).toContain(link.fromOrientation);
        expect(['+', '-']).toContain(link.toOrientation);
      }
    });

    it('constructs walks for each genome path through the variation graph', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);

      const refPath = result.paths.find((p) => p.genomeName === phage.name);
      expect(refPath).toBeDefined();
      if (!refPath) return;
      expect(refPath.segmentWalk.length).toBeGreaterThan(0);

      // Every segment in the walk should exist in segments
      const segmentIds = new Set(result.segments.map((s) => s.id));
      for (const step of refPath.segmentWalk) {
        expect(segmentIds.has(step.segmentId)).toBe(true);
      }
    });
  });

  describe('Variant Cards Generation & Annotation', () => {
    it('extracts structured variant cards with locus, span, and GC shift', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);

      expect(result.variantCards.length).toBeGreaterThan(0);

      for (const card of result.variantCards) {
        expect(card.id).toMatch(/^var-bubble-\d+$/);
        expect(card.bubbleIndex).toBeGreaterThan(0);
        expect(card.locusStartBp).toBeGreaterThanOrEqual(0);
        expect(card.locusEndBp).toBeGreaterThan(card.locusStartBp);
        expect(card.spanBp).toBe(card.locusEndBp - card.locusStartBp);
        expect(card.referenceLengthBp).toBeGreaterThan(0);
        expect(card.variantLengthBp).toBeGreaterThan(0);
        expect(card.functionalSignificance.length).toBeGreaterThan(10);
        expect(card.recombinationBreakpoints).toBeDefined();
        expect(card.recombinationBreakpoints.leftBreakpointBp).toBe(card.locusStartBp);
      }
    });

    it('identifies HGT candidates based on significant GC content shifts (>= 4.0%)', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);

      const hgtCandidates = result.variantCards.filter((c) => c.isHgtCandidate);
      expect(hgtCandidates.length).toBeGreaterThan(0);

      for (const hgt of hgtCandidates) {
        expect(Math.abs(hgt.gcShift)).toBeGreaterThanOrEqual(4.0);
        expect(hgt.donorLineageHints.length).toBeGreaterThan(0);
        expect(hgt.donorLineageHints[0].possibleLineage).toBeDefined();
      }
    });

    it('detects inverted repeats for inversion variants', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);

      const inversionCard = result.variantCards.find((c) => c.type === 'inversion');
      expect(inversionCard).toBeDefined();
      expect(inversionCard?.recombinationBreakpoints.invertedRepeatDetected).toBe(true);
    });

    it('associates overlapping genes and their impact types', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);

      const cardsWithGenes = result.variantCards.filter((c) => c.overlappedGenes.length > 0);
      expect(cardsWithGenes.length).toBeGreaterThan(0);

      for (const card of cardsWithGenes) {
        for (const gene of card.overlappedGenes) {
          expect(['disrupted', 'modified', 'novel_insertion', 'deleted']).toContain(gene.impact);
          expect(gene.name).toBeDefined();
          expect(gene.product).toBeDefined();
        }
      }
    });
  });

  describe('Pangenome Metrics & Recombination Hotspots', () => {
    it('calculates core fraction and Heaps law openness alpha', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);
      const { metrics } = result;

      expect(metrics.panGenomeLengthBp).toBeGreaterThan(metrics.coreGenomeLengthBp);
      expect(metrics.coreFraction).toBeGreaterThan(0);
      expect(metrics.coreFraction).toBeLessThan(1);
      // Heaps' law alpha > 0 implies an open phage pangenome
      expect(metrics.opennessAlpha).toBeGreaterThan(0);
      expect(metrics.totalBubbles).toBe(result.variantCards.length);
      expect(metrics.totalSegments).toBe(result.segments.length);
      expect(metrics.totalLinks).toBe(result.links.length);
    });

    it('identifies recombination hotspots with diversity scores', () => {
      const phage = mockPhage();
      const result = constructPangenomeGraph(phage);
      const { recombinationHotspots } = result.metrics;

      expect(recombinationHotspots.length).toBeGreaterThan(0);
      for (const hotspot of recombinationHotspots) {
        expect(hotspot.id).toBeDefined();
        expect(hotspot.locusStartBp).toBeLessThan(hotspot.locusEndBp);
        expect(hotspot.diversityScore).toBeGreaterThanOrEqual(50);
        expect(hotspot.associatedFunctionalModule.length).toBeGreaterThan(10);
      }
    });
  });

  describe('Template Selection & Comparative Cohort Injection', () => {
    it('uses Siphoviridae template for lambda-like phages', () => {
      const lambdaPhage = mockPhage({
        id: 2,
        name: 'Enterobacteria phage lambda',
        morphology: 'siphovirus',
        genomeLength: 48502,
        gcContent: 49.9,
      });

      const result = constructPangenomeGraph(lambdaPhage);
      expect(result.includedGenomesCount).toBeGreaterThanOrEqual(3);
      expect(result.genomes.some((g) => g.name.includes('434'))).toBe(true);
      expect(result.genomes.some((g) => g.name.includes('HK97'))).toBe(true);
    });

    it('integrates custom comparative genomes when provided', () => {
      const ref = mockPhage();
      const companion1 = mockPhage({
        id: 99,
        name: 'Custom Phage Alpha',
        genomeLength: 170000,
        gcContent: 36.0,
      });

      const result = constructPangenomeGraph(ref, [companion1]);
      expect(result.genomes.some((g) => g.name === 'Custom Phage Alpha')).toBe(true);
      expect(result.includedGenomesCount).toBeGreaterThanOrEqual(5);
    });
  });
});
