/**
 * Tests for Genome Comparison Engine Module
 *
 * Tests the main orchestration functions for comprehensive genome comparison,
 * quick comparison, and utility functions.
 */

import { describe, test, expect } from 'bun:test';
import {
  compareGenomes,
  quickCompare,
  formatSimilarity,
  getSimilarityColor,
  createSimilarityBar,
} from './comparison-engine';
import { DEFAULT_COMPARISON_CONFIG } from './types';
import type { GeneInfo } from '@phage-explorer/core';

// Test sequences - real-ish phage-like DNA
const SEQ_A = 'ATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGC';
const SEQ_B = 'ATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGC';
const SEQ_C = 'GCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTAGCTA';
const LONGER_SEQ_A = SEQ_A.repeat(50); // ~3200bp
const LONGER_SEQ_B = SEQ_B.repeat(50);
const LONGER_SEQ_C = SEQ_C.repeat(50);

let geneId = 0;
const makeGene = (name: string, product: string, start: number, end: number): GeneInfo => ({
  id: ++geneId,
  name,
  locusTag: `gene_${geneId}`,
  startPos: start,
  endPos: end,
  strand: '+',
  product,
  type: 'CDS',
});

describe('compareGenomes', () => {
  test('propagates coherent information metrics without reporting dependence as identity', async () => {
    const a = { id: 1, name: 'A', accession: 'A' }, b = { id: 2, name: 'B', accession: 'B' };
    const identical = await compareGenomes(a, b, 'ACGTACGT', 'ACGTACGT');
    expect(identical.informationTheory.normalizedMI).toBe(1);
    expect(identical.informationTheory.mutualInformation).toBe(0.4);
    const insight = identical.summary.insights.find(row => row.category === 'Information');
    expect(insight?.value).toBe(1);
    expect(insight?.type).toBe('notable');
    expect(insight?.message).toContain('100.0%');
    expect(insight?.message).toContain('4 resolved pairs');
    expect(insight?.message).toContain('not nucleotide identity');

    // Both genomes have observed 5-mer distributions, but not at shared positions.
    const disjoint = await compareGenomes(a, b, 'ACGTACGTNNNNNNNN', 'NNNNNNNNACGTACGT');
    expect(disjoint.informationTheory.coverage.resolvedWindowPairs).toBe(0);
    expect(disjoint.informationTheory.normalizedMI).toBeNull();
    expect(disjoint.informationTheory.jensenShannonDivergence).toBe(0);
    expect(disjoint.summary.insights.some(row => row.category === 'Information')).toBe(false);

    const constant = await compareGenomes(a, b, 'AAAAAAAA', 'TTTTTTTT');
    expect(constant.informationTheory.mutualInformation).toBe(0);
    expect(constant.informationTheory.normalizedMI).toBeNull();
    expect(constant.summary.insights.some(row => row.category === 'Information')).toBe(false);
  });

  test('returns complete result structure for identical sequences', async () => {
    const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
    const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

    const result = await compareGenomes(phageA, phageB, LONGER_SEQ_A, LONGER_SEQ_B);

    // Check required top-level fields
    expect(result).toHaveProperty('phageA');
    expect(result).toHaveProperty('phageB');
    expect(result).toHaveProperty('computedAt');
    expect(result).toHaveProperty('computeTimeMs');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('kmerAnalysis');
    expect(result).toHaveProperty('informationTheory');
    expect(result).toHaveProperty('rankCorrelation');
    expect(result).toHaveProperty('editDistance');
    expect(result).toHaveProperty('biological');
    expect(result).toHaveProperty('codonUsage');
    expect(result).toHaveProperty('aminoAcidUsage');
    expect(result).toHaveProperty('geneContent');
    expect(result).toHaveProperty('structuralVariants');

    // Verify phage info is preserved
    expect(result.phageA).toEqual(phageA);
    expect(result.phageB).toEqual(phageB);
  });

  test('computes high similarity for identical sequences', async () => {
    const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
    const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

    const result = await compareGenomes(phageA, phageB, LONGER_SEQ_A, LONGER_SEQ_B);

    // Overall similarity is weighted from multiple metrics, so threshold is lower
    expect(result.summary.overallSimilarity).toBeGreaterThan(80);
    expect(result.summary.sequenceSimilarity).toBeGreaterThan(90);
  });

  test('computes lower similarity for different sequences', async () => {
    const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
    const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

    const result = await compareGenomes(phageA, phageB, LONGER_SEQ_A, LONGER_SEQ_C);

    // Different sequences should have lower similarity
    expect(result.summary.overallSimilarity).toBeLessThan(90);
  });

  test('includes gene content comparison when genes provided', async () => {
    const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
    const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };
    const genesA = [
      makeGene('terminase', 'terminase large subunit', 0, 1000),
      makeGene('portal', 'portal protein', 1000, 2000),
    ];
    const genesB = [
      makeGene('terminase', 'terminase large subunit', 0, 1000),
      makeGene('capsid', 'major capsid protein', 1000, 2000),
    ];

    const result = await compareGenomes(
      phageA,
      phageB,
      LONGER_SEQ_A,
      LONGER_SEQ_B,
      genesA,
      genesB
    );

    expect(result.geneContent.genesA).toBe(2);
    expect(result.geneContent.genesB).toBe(2);
    expect(result.geneContent.sharedGeneNames).toBeGreaterThanOrEqual(0);
  });

  test('respects includeStructuralVariants config option', async () => {
    const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
    const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

    const resultWith = await compareGenomes(
      phageA,
      phageB,
      LONGER_SEQ_A,
      LONGER_SEQ_B,
      [],
      [],
      null,
      null,
      { ...DEFAULT_COMPARISON_CONFIG, includeStructuralVariants: true, kmerSizes: [7] }
    );

    const resultWithout = await compareGenomes(
      phageA,
      phageB,
      LONGER_SEQ_A,
      LONGER_SEQ_B,
      [],
      [],
      null,
      null,
      { ...DEFAULT_COMPARISON_CONFIG, includeStructuralVariants: false, kmerSizes: [7] }
    );

    expect(resultWith.structuralVariants).not.toBeNull();
    expect(resultWith.sequenceDiff?.status).toBe('complete');
    expect(resultWithout.structuralVariants).toBeNull();
    expect(resultWithout.sequenceDiff).toBeNull();
  });

  test('connects exact indel evidence to the same complete alignment used for the sequence diff', async () => {
    const reference = 'CCGG', inserted = 'A'.repeat(60), query = 'CC' + inserted + 'GG';
    const result = await compareGenomes({ id: 1, name: 'Reference', accession: 'A' },
      { id: 2, name: 'Query', accession: 'B' }, reference, query);
    expect(result.geneContent.genesA).toBe(0);
    expect(result.structuralVariants?.status).toBe('complete');
    expect(result.sequenceDiff?.status).toBe('complete');
    if (result.sequenceDiff?.status !== 'complete' || result.structuralVariants?.status !== 'complete') {
      throw new Error('Expected complete exact alignment and indel evidence.');
    }
    expect(result.structuralVariants.alignment).toEqual(result.sequenceDiff.stats);
    expect(result.editDistance).toMatchObject({ levenshteinDistance: 60,
      insertions: 60, deletions: 0, substitutions: 0, isApproximate: false,
      operationsUnavailableReason: null });
    expect(result.structuralVariants.calls).toHaveLength(1);
    expect(result.structuralVariants.calls[0]).toMatchObject({ type: 'insertion', startA: 2, endA: 2,
      startB: 2, endB: 62, referenceAllele: '', alternateAllele: inserted });
    expect(result.sequenceDiff.runs.find(run => run.operation === 'insertion'))
      .toEqual({ operation: 'insertion', startA: 2, endA: 2, startB: 2, endB: 62 });
  });

  test('reuses exact near-identical alignment at the 10kb threshold and preserves explicit sampling', async () => {
    const a = 'ACGT'.repeat(2250), b = a.slice(0, 4500) + 'A'.repeat(1000) + a.slice(4500);
    const phageA = { id: 1, name: 'Reference', accession: 'A' }, phageB = { id: 2, name: 'Query', accession: 'B' };
    const exact = await compareGenomes(phageA, phageB, a, b, [], [], null, null,
      { ...DEFAULT_COMPARISON_CONFIG, kmerSizes: [3], maxEditDistanceLength: 10000 });
    expect(exact.sequenceDiff?.status).toBe('complete');
    if (exact.sequenceDiff?.status !== 'complete') throw new Error('Expected exact near-identical alignment.');
    expect(exact.editDistance).toMatchObject({ levenshteinDistance: 1000, normalizedLevenshtein: 0.1,
      levenshteinSimilarity: 0.9, insertions: 1000, deletions: 0, substitutions: 0,
      isApproximate: false, operationsUnavailableReason: null });
    expect(exact.editDistance.insertions! - exact.editDistance.deletions!).toBe(b.length - a.length);
    expect(exact.sequenceDiff.stats).toMatchObject({ distance: 1000, insertions: 1000, deletions: 0, substitutions: 0 });

    const sampled = await compareGenomes(phageA, phageB, a, b, [], [], null, null,
      { ...DEFAULT_COMPARISON_CONFIG, kmerSizes: [3], maxEditDistanceLength: 0,
        editDistanceWindowSize: 100, editDistanceWindowCount: 2 });
    expect(sampled.editDistance).toMatchObject({ isApproximate: true, insertions: null, deletions: null, substitutions: null });
    expect(sampled.editDistance.levenshteinDistance).toBeGreaterThanOrEqual(1000);
    expect(sampled.sequenceDiff).toEqual(exact.sequenceDiff);
  });

  test('retains exact metrics with bounded memory when the WFA budget cannot complete the diff', async () => {
    const result = await compareGenomes({ id: 1, name: 'A', accession: 'A' }, { id: 2, name: 'B', accession: 'B' },
      'A'.repeat(3000), 'C'.repeat(3001), [], [], null, null,
      { ...DEFAULT_COMPARISON_CONFIG, kmerSizes: [3], maxEditDistanceLength: 4000 });
    expect(result.sequenceDiff?.status).toBe('unavailable');
    expect(result.editDistance).toMatchObject({ levenshteinDistance: 3001, insertions: 1, deletions: 0,
      substitutions: 3000, isApproximate: false, operationsUnavailableReason: null });
    expect(result.editDistance.insertions! + result.editDistance.deletions! + result.editDistance.substitutions!)
      .toBe(result.editDistance.levenshteinDistance);
  });

  test('records compute time', async () => {
    const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
    const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

    const result = await compareGenomes(phageA, phageB, SEQ_A, SEQ_B);

    expect(result.computeTimeMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.computedAt).toBe('number');
  });

  describe('summary computation', () => {
    test('never assigns relatedness from empty resolved k-mer sets', async () => {
      const phageA = { id: 1, name: 'Unknown A', accession: 'UNKNOWN_A' };
      const phageB = { id: 2, name: 'Unknown B', accession: 'UNKNOWN_B' };
      const result = await compareGenomes(phageA, phageB, 'N'.repeat(64), 'N'.repeat(64));
      expect(result.biological.kmerIdentity.percent).toBeNull();
      expect(result.summary.similarityCategory).toBe('insufficient_data');
      expect(result.summary.overallSimilarity).toBeNull();
      expect(result.summary.confidenceLevel).toBe('low');
      expect(result.summary.sequenceSimilarity).toBe(0);
      expect(result.summary.compositionSimilarity).toBe(0);
      expect(result.summary.insights.some(insight => insight.category === 'Sequence evidence')).toBe(true);
      expect(result.summary.insights.some(insight => /likely same species|distantly related/i.test(insight.message))).toBe(false);
    });

    test('keeps short resolved comparisons descriptive when k=21 identity is unavailable', async () => {
      const phageA = { id: 1, name: 'Short A', accession: 'SHORT_A' };
      const phageB = { id: 2, name: 'Short B', accession: 'SHORT_B' };
      const result = await compareGenomes(phageA, phageB, 'AACCTGATGCTA', 'AACCTGATGCTA');
      expect(result.biological.kmerIdentity.percent).toBeNull();
      expect(result.summary.similarityCategory).not.toBe('insufficient_data');
      expect(result.summary.sequenceSimilarity).toBe(100);
      expect(result.summary.insights.some(insight => /same species/i.test(insight.message))).toBe(false);
    });

    test('does not apply a species cutoff to equal canonical genome content', async () => {
      const phageA = { id: 1, name: 'Forward', accession: 'FORWARD' };
      const phageB = { id: 2, name: 'Reverse', accession: 'REVERSE' };
      const sequence = 'AACCTGATGCTAGTCAGGATCGTACCTGAGTACCGATTCAGGCTATCGACGTTAGCTGGATCAGTAC';
      const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
      const reverse = [...sequence].reverse().map(base => complement[base]).join('');
      const result = await compareGenomes(phageA, phageB, sequence, reverse);
      expect(result.biological.kmerIdentity.percent).toBe(100);
      const insight = result.summary.insights.find(item => item.category === 'K-mer identity estimate');
      expect(insight?.message).toContain('no alignment or species inference');
      expect(result.summary.insights.some(item => /likely same species|high ANI/i.test(item.message))).toBe(false);
    });

    test('categorizes similarity correctly', async () => {
      const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
      const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

      const identicalResult = await compareGenomes(
        phageA,
        phageB,
        LONGER_SEQ_A,
        LONGER_SEQ_A
      );

      // Identical sequences should have high category
      expect(
        ['identical', 'highly_similar', 'similar'].includes(
          identicalResult.summary.similarityCategory
        )
      ).toBe(true);
    });

    test('includes insights array', async () => {
      const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
      const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

      const result = await compareGenomes(phageA, phageB, LONGER_SEQ_A, LONGER_SEQ_B);

      expect(Array.isArray(result.summary.insights)).toBe(true);
      for (const insight of result.summary.insights) {
        expect(insight).toHaveProperty('type');
        expect(insight).toHaveProperty('category');
        expect(insight).toHaveProperty('message');
        expect(insight).toHaveProperty('value');
        expect(insight).toHaveProperty('significance');
      }
    });

    test('includes confidence level', async () => {
      const phageA = { id: 1, name: 'Phage A', accession: 'NC_001' };
      const phageB = { id: 2, name: 'Phage B', accession: 'NC_002' };

      const result = await compareGenomes(phageA, phageB, LONGER_SEQ_A, LONGER_SEQ_B);

      expect(['high', 'medium', 'low']).toContain(result.summary.confidenceLevel);
    });
  });
});

describe('quickCompare', () => {
  test('returns high similarity for identical sequences', () => {
    const result = quickCompare(LONGER_SEQ_A, LONGER_SEQ_A);

    expect(result.similarity).toBeGreaterThan(90);
    expect(result.estimateType).toBe('quick');
  });

  test('returns lower similarity for different sequences', () => {
    const result = quickCompare(LONGER_SEQ_A, LONGER_SEQ_C);

    expect(result.similarity).toBeLessThan(90);
    expect(result.estimateType).toBe('quick');
  });

  test('returns similar values for similar sequences', () => {
    const result = quickCompare(LONGER_SEQ_A, LONGER_SEQ_B);

    expect(result.similarity).toBeGreaterThan(90);
  });

  test('similarity is between 0 and 100', () => {
    const result1 = quickCompare(SEQ_A, SEQ_A);
    const result2 = quickCompare(SEQ_A, SEQ_C);

    expect(result1.similarity).toBeGreaterThanOrEqual(0);
    expect(result1.similarity).toBeLessThanOrEqual(100);
    expect(result2.similarity).toBeGreaterThanOrEqual(0);
    expect(result2.similarity).toBeLessThanOrEqual(100);
  });
});

describe('formatSimilarity', () => {
  test('formats high scores correctly', () => {
    expect(formatSimilarity(100)).toBe('Nearly Identical');
    expect(formatSimilarity(99)).toBe('Nearly Identical');
    expect(formatSimilarity(98)).toBe('Extremely Similar');
    expect(formatSimilarity(95)).toBe('Extremely Similar');
  });

  test('formats medium scores correctly', () => {
    expect(formatSimilarity(90)).toBe('Highly Similar');
    expect(formatSimilarity(80)).toBe('Very Similar');
    expect(formatSimilarity(70)).toBe('Similar');
    expect(formatSimilarity(60)).toBe('Moderately Similar');
    expect(formatSimilarity(50)).toBe('Somewhat Similar');
  });

  test('formats low scores correctly', () => {
    expect(formatSimilarity(40)).toBe('Distantly Related');
    expect(formatSimilarity(30)).toBe('Weakly Related');
    expect(formatSimilarity(20)).toBe('Very Distant');
    expect(formatSimilarity(10)).toBe('Unrelated');
    expect(formatSimilarity(0)).toBe('Unrelated');
  });

  test('handles boundary values', () => {
    expect(formatSimilarity(99.5)).toBe('Nearly Identical');
    expect(formatSimilarity(89.9)).toBe('Very Similar');
  });
});

describe('getSimilarityColor', () => {
  test('returns green for high similarity', () => {
    expect(getSimilarityColor(95)).toBe('#22c55e');
    expect(getSimilarityColor(90)).toBe('#22c55e');
  });

  test('returns lime for good similarity', () => {
    expect(getSimilarityColor(80)).toBe('#84cc16');
    expect(getSimilarityColor(70)).toBe('#84cc16');
  });

  test('returns yellow for moderate similarity', () => {
    expect(getSimilarityColor(60)).toBe('#eab308');
    expect(getSimilarityColor(50)).toBe('#eab308');
  });

  test('returns orange for low similarity', () => {
    expect(getSimilarityColor(40)).toBe('#f97316');
    expect(getSimilarityColor(30)).toBe('#f97316');
  });

  test('returns red for very low similarity', () => {
    expect(getSimilarityColor(20)).toBe('#ef4444');
    expect(getSimilarityColor(10)).toBe('#ef4444');
    expect(getSimilarityColor(0)).toBe('#ef4444');
  });
});

describe('createSimilarityBar', () => {
  test('creates correct bar for 100%', () => {
    const bar = createSimilarityBar(100, 10);
    expect(bar).toBe('██████████');
  });

  test('creates correct bar for 0%', () => {
    const bar = createSimilarityBar(0, 10);
    expect(bar).toBe('░░░░░░░░░░');
  });

  test('creates correct bar for 50%', () => {
    const bar = createSimilarityBar(50, 10);
    expect(bar).toBe('█████░░░░░');
  });

  test('uses custom width', () => {
    const bar = createSimilarityBar(50, 20);
    expect(bar.length).toBe(20);
  });

  test('uses custom fill and empty characters', () => {
    const bar = createSimilarityBar(50, 10, '#', '-');
    expect(bar).toBe('#####-----');
  });

  test('handles default width', () => {
    const bar = createSimilarityBar(50);
    expect(bar.length).toBe(20); // default width
  });
});
