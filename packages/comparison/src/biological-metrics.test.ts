/**
 * Tests for Biological Metrics Module
 *
 * Tests GC content, k-mer identity estimation, codon usage, amino acid composition,
 * gene content comparison, and dinucleotide bias analysis.
 */

import { describe, test, expect } from 'bun:test';
import {
  calculateGCContent,
  estimateKmerIdentity,
  analyzeBiologicalMetrics,
  calculateRSCU,
  compareCodonUsage,
  compareAminoAcidUsage,
  compareGeneContent,
  compareDinucleotideBias,
} from './biological-metrics';
import { CODON_TABLE, type GeneInfo } from '@phage-explorer/core';

describe('calculateGCContent', () => {
  test('calculates correct GC content for pure G/C sequence', () => {
    expect(calculateGCContent('GGCC')).toBeCloseTo(100, 1);
    expect(calculateGCContent('GCGC')).toBeCloseTo(100, 1);
  });

  test('calculates correct GC content for pure A/T sequence', () => {
    expect(calculateGCContent('AATT')).toBeCloseTo(0, 1);
    expect(calculateGCContent('TATA')).toBeCloseTo(0, 1);
  });

  test('calculates correct GC content for 50% sequence', () => {
    expect(calculateGCContent('ATGC')).toBeCloseTo(50, 1);
    expect(calculateGCContent('ACGT')).toBeCloseTo(50, 1);
  });

  test('handles lowercase sequences', () => {
    expect(calculateGCContent('atgc')).toBeCloseTo(50, 1);
    expect(calculateGCContent('ATgc')).toBeCloseTo(50, 1);
  });

  test('ignores non-ATGC characters', () => {
    expect(calculateGCContent('ATNCGN')).toBeCloseTo(50, 1); // Only counts ATCG
  });

  test('returns 0 for empty sequence', () => {
    expect(calculateGCContent('')).toBe(0);
  });

  test('returns 0 for all-N sequence', () => {
    expect(calculateGCContent('NNNN')).toBe(0);
  });
});

describe('estimateKmerIdentity', () => {
  test('reports equal canonical sets and repeat limitations for identical sequences', () => {
    const seq = 'ATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGCATGC';
    const result = estimateKmerIdentity(seq, seq);
    expect(result.status).toBe('estimated');
    expect(result.percent).toBe(100);
    expect(result.jaccard).toBe(1);
    expect(result.coverageA.validWindows).toBe(seq.length - 20);
    expect(result.warnings.some(warning => warning.includes('Repeated k-mers'))).toBe(true);
  });

  test('matches an independently enumerated canonical-set and Mash-formula oracle', () => {
    // A: AAA,AAC,ACC,CCC. B: AAA,AAG,AGG,CCC (GGG canonicalizes to CCC).
    // Two shared out of six union words gives J=1/3 and D=ln(2)/3.
    const result = estimateKmerIdentity('AAACCC', 'AAAGGG', 3);
    expect(result.coverageA).toEqual({ totalWindows: 4, validWindows: 4, distinctKmers: 4, validWindowFraction: 1 });
    expect(result.coverageB).toEqual(result.coverageA);
    expect(result.sharedKmers).toBe(2);
    expect(result.jaccard).toBeCloseTo(1 / 3, 14);
    expect(result.distance).toBeCloseTo(0.23104906018664842, 14);
    expect(result.percent).toBeCloseTo(76.89509398133516, 12);
  });

  test('is strand invariant, case insensitive and symmetric for high-complexity DNA', () => {
    const sequence = 'AACCTGATGCTAGTCAGGATCGTACCTGAGTACCGATTCAGGCTATCGACGTTAGCTGGATCAGTAC';
    const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
    const reverse = [...sequence].reverse().map(base => complement[base]).join('').toLowerCase();
    const result = estimateKmerIdentity(sequence, reverse);
    expect(result.percent).toBe(100);
    expect(result.jaccard).toBe(1);
    expect(result.coverageA.validWindowFraction).toBe(1);
    expect(estimateKmerIdentity(reverse, sequence)).toEqual(result);
    // Homopolymers A and T are also reverse complements, not unrelated words.
    expect(estimateKmerIdentity('A'.repeat(49), 'T'.repeat(49)).percent).toBe(100);
  });

  test('never infers identity from missing, short or entirely ambiguous evidence', () => {
    for (const [left, right] of [
      ['', ''], ['ACGT', 'TGCA'], ['N'.repeat(100), 'N'.repeat(100)],
      ['RYSWKMBDHV'.repeat(10), 'ACGT'.repeat(40)],
      ['A'.repeat(20) + 'N' + 'A'.repeat(20), 'A'.repeat(41)],
    ]) {
      const result = estimateKmerIdentity(left, right);
      expect(result.status).toBe('unavailable');
      expect(result.percent).toBeNull();
      expect(result.distance).toBeNull();
      expect(result.jaccard).toBeNull();
      expect(result.sharedKmers).toBe(0);
      expect(result.unavailableReason).toContain('insufficient k-mer evidence');
      for (const coverage of [result.coverageA, result.coverageB]) {
        expect(Number.isFinite(coverage.validWindowFraction)).toBe(true);
        expect(coverage.validWindowFraction).toBeGreaterThanOrEqual(0);
        expect(coverage.validWindowFraction).toBeLessThanOrEqual(1);
      }
    }
  });

  test('keeps zero overlap distinct from a measured zero-percent identity', () => {
    const result = estimateKmerIdentity('A'.repeat(100), 'C'.repeat(100));
    expect(result.status).toBe('unavailable');
    expect(result.jaccard).toBe(0);
    expect(result.percent).toBeNull();
    expect(result.distance).toBeNull();
    expect(result.coverageA.validWindowFraction).toBe(1);
    expect(result.unavailableReason).toContain('No shared canonical 21-mers');
  });

  test('reports exactly which windows contributed without bridging ambiguous bases', () => {
    // AAA and CCC contribute; AAN, ANN, NNN, NNC and NCC do not.
    const result = estimateKmerIdentity('AAANNNCCC', 'AAACCC', 3);
    expect(result.coverageA).toEqual({ totalWindows: 7, validWindows: 2, distinctKmers: 2, validWindowFraction: 2 / 7 });
    expect(result.coverageB.validWindows).toBe(4);
    expect(result.sharedKmers).toBe(2);
    expect(result.jaccard).toBe(0.5);
    expect(result.warnings.some(warning => warning.includes('Ambiguous symbols'))).toBe(true);
    expect(result.warnings.some(warning => warning.includes('Different input lengths'))).toBe(true);
    const swapped = estimateKmerIdentity('AAACCC', 'AAANNNCCC', 3);
    expect(swapped.percent).toBe(result.percent);
    expect(swapped.coverageB).toEqual(result.coverageA);
  });

  test('rejects invalid k instead of manufacturing a score', () => {
    for (const k of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => estimateKmerIdentity('ACGT', 'ACGT', k)).toThrow('positive integer');
    }
  });
});

describe('analyzeBiologicalMetrics', () => {
  test('returns all expected fields', () => {
    const seqA = 'ATGCATGCATGCATGC';
    const seqB = 'GCTAGCTAGCTAGCTA';
    const result = analyzeBiologicalMetrics(seqA, seqB);

    expect(result.kmerIdentity.status).toBe('unavailable');
    expect(result.kmerIdentity.percent).toBeNull();
    expect(result).toHaveProperty('gcContentA');
    expect(result).toHaveProperty('gcContentB');
    expect(result).toHaveProperty('gcDifference');
    expect(result).toHaveProperty('gcRatio');
    expect(result).toHaveProperty('lengthA');
    expect(result).toHaveProperty('lengthB');
    expect(result).toHaveProperty('lengthRatio');
    expect(result).toHaveProperty('lengthDifference');
  });

  test('calculates correct lengths', () => {
    const seqA = 'ATGCATGC'; // 8bp
    const seqB = 'ATGCATGCATGC'; // 12bp
    const result = analyzeBiologicalMetrics(seqA, seqB);

    expect(result.lengthA).toBe(8);
    expect(result.lengthB).toBe(12);
    expect(result.lengthDifference).toBe(4);
    expect(result.lengthRatio).toBeCloseTo(8 / 12, 5);
  });

  test('identifies the actual canonical-set approximation method', () => {
    const result = analyzeBiologicalMetrics('ATGC', 'GCTA');
    expect(result.kmerIdentity.method).toBe('canonical-kmer-mash');
  });
});

describe('calculateRSCU', () => {
  test('returns RSCU values for all codons', () => {
    const codonCounts = {
      TTT: 10, // Phe
      TTC: 10, // Phe
    };
    const rscu = calculateRSCU(codonCounts);

    // Both Phe codons used equally, RSCU should be 1.0
    expect(rscu.TTT).toBeCloseTo(1.0, 5);
    expect(rscu.TTC).toBeCloseTo(1.0, 5);
  });

  test('handles biased codon usage', () => {
    const codonCounts = {
      TTT: 20, // Phe
      TTC: 0,  // Phe (not used)
    };
    const rscu = calculateRSCU(codonCounts);

    // TTT used exclusively: RSCU = observed/expected = 20/(20/2) = 2.0
    expect(rscu.TTT).toBeCloseTo(2.0, 5);
    expect(rscu.TTC).toBe(0);
  });

  test('handles empty codon counts', () => {
    const rscu = calculateRSCU({});
    expect(rscu.TTT).toBe(0);
    expect(rscu.ATG).toBe(0);
  });
});

describe('compareCodonUsage', () => {
  test('preserves small upper-tail probabilities for strong count differences', () => {
    // Independent chi-square survival values (SciPy 1.17.0 chi2.sf).
    // The two disjoint categories have statistic 2*n and one degree of freedom.
    for (const [count, expected] of [[2, 0.04550026389635857], [20, 2.5396285894708634e-10],
      [100, 2.0884875837625688e-45]] as const) {
      const result = compareCodonUsage({ AAA: count }, { CCC: count });
      expect(result.chiSquareStatistic).toBe(2 * count);
      expect(result.degreesOfFreedom).toBe(1);
      expect(Math.abs(result.chiSquarePValue! / expected - 1)).toBeLessThan(1e-10);
    }
    for (const count of [1000, 10000, 1000000]) {
      // These probabilities are below the representable double range, not 1.
      expect(compareCodonUsage({ AAA: count }, { CCC: count }).chiSquarePValue).toBe(0);
    }
  });

  test('matches the exact two-degree survival function and large category reference values', () => {
    const twoDegrees = compareCodonUsage({ AAA: 10, CCC: 5 }, { CCC: 5, GGG: 10 });
    expect(twoDegrees.chiSquareStatistic).toBe(20);
    expect(twoDegrees.degreesOfFreedom).toBe(2);
    expect(Math.abs(twoDegrees.chiSquarePValue! / Math.exp(-10) - 1)).toBeLessThan(1e-12);
    for (const [categories, count, expected] of [[32, 1, 0.41674402994554294],
      [64, 1, 0.44117997461167985], [64, 2, 2.4924609143901037e-6],
      [64, 10, 2.0351428718454365e-96]] as const) {
      const codons = Object.keys(CODON_TABLE).slice(0, categories);
      const a = Object.fromEntries(codons.slice(0, categories / 2).map(codon => [codon, count]));
      const b = Object.fromEntries(codons.slice(categories / 2).map(codon => [codon, count]));
      const result = compareCodonUsage(a, b);
      expect(result.chiSquareStatistic).toBe(categories * count);
      expect(result.degreesOfFreedom).toBe(categories - 1);
      expect(Math.abs(result.chiSquarePValue! / expected - 1)).toBeLessThan(1e-10);
      expect(compareCodonUsage(b, a).chiSquarePValue).toBe(result.chiSquarePValue);
    }
  });

  test('excludes unresolved triplets from both row totals and frequency metrics', () => {
    const resolved = compareCodonUsage({ AAA: 100, CCC: 20 }, { AAA: 20, CCC: 100 });
    const ambiguous = compareCodonUsage({ AAA: 100, CCC: 20, NNN: 10000, ARN: 7 }, { AAA: 20, CCC: 100, NNN: 3 });
    expect(ambiguous.resolvedCodonsA).toBe(120);
    expect(ambiguous.resolvedCodonsB).toBe(120);
    expect(ambiguous.excludedCodonsA).toBe(10007);
    expect(ambiguous.excludedCodonsB).toBe(3);
    expect(ambiguous.chiSquareStatistic).toBe(resolved.chiSquareStatistic);
    expect(ambiguous.chiSquarePValue).toBe(resolved.chiSquarePValue);
    expect(ambiguous.caiA).toBe(resolved.caiA);
    expect(ambiguous.caiB).toBe(resolved.caiB);
    expect(ambiguous.topDifferentCodons).toEqual(resolved.topDifferentCodons);
  });

  test('distinguishes missing or degenerate data from identical supported distributions', () => {
    const cases: Array<[Record<string, number>, Record<string, number>]> = [
      [{}, {}], [{ NNN: 100 }, { AAA: 100, CCC: 100 }],
      [{ AAA: 100, CCC: 100 }, {}], [{ AAA: 100 }, { AAA: 200 }],
    ];
    for (const [a, b] of cases) {
      const result = compareCodonUsage(a, b);
      expect(result.chiSquarePValue).toBeNull();
      expect(result.chiSquareUnavailableReason).toBeString();
      expect(result.degreesOfFreedom).toBe(0);
    }
    const identical = compareCodonUsage({ AAA: 100, CCC: 100 }, { AAA: 200, CCC: 200 });
    expect(identical.chiSquarePValue).toBe(1);
    expect(identical.chiSquareUnavailableReason).toBeNull();
    expect(identical.chiSquareExpectedBelowFive).toBe(0);
    expect(compareCodonUsage({ AAA: 1 }, { CCC: 1 }).chiSquareExpectedBelowFive).toBe(4);
  });

  test('rejects malformed counts rather than publishing nonfinite significance', () => {
    for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => compareCodonUsage({ AAA: count }, { CCC: 10 })).toThrow('safe integers');
      expect(() => compareCodonUsage({ AAA: 10 }, { NNN: count })).toThrow('safe integers');
    }
    expect(() => compareCodonUsage({ AAA: Number.MAX_SAFE_INTEGER, CCC: 1 }, { CCC: 1 })).toThrow('safe integer');
    expect(() => compareCodonUsage({ AAA: Number.MAX_SAFE_INTEGER }, { CCC: 1 })).toThrow('safe integer');
  });

  test('returns all expected fields', () => {
    const countsA = { ATG: 10, TTT: 5, TTC: 5 };
    const countsB = { ATG: 10, TTT: 5, TTC: 5 };
    const result = compareCodonUsage(countsA, countsB);

    expect(result).toHaveProperty('rscuDistanceEuclidean');
    expect(result).toHaveProperty('rscuDistanceManhattan');
    expect(result).toHaveProperty('rscuCosineSimilarity');
    expect(result).toHaveProperty('chiSquareStatistic');
    expect(result).toHaveProperty('chiSquarePValue');
    expect(result).toHaveProperty('degreesOfFreedom');
    expect(result).toHaveProperty('caiA');
    expect(result).toHaveProperty('caiB');
    expect(result).toHaveProperty('caiCorrelation');
    expect(result).toHaveProperty('topDifferentCodons');
  });

  test('identical usage has zero distance', () => {
    const counts = { ATG: 10, TTT: 5, TTC: 5, TAA: 1 };
    const result = compareCodonUsage(counts, counts);

    expect(result.rscuDistanceEuclidean).toBeCloseTo(0, 5);
    expect(result.rscuCosineSimilarity).toBeCloseTo(1, 5);
  });

  test('different usage has non-zero distance', () => {
    const countsA = { TTT: 20, TTC: 0 };  // Biased toward TTT
    const countsB = { TTT: 0, TTC: 20 };  // Biased toward TTC
    const result = compareCodonUsage(countsA, countsB);

    expect(result.rscuDistanceEuclidean).toBeGreaterThan(0);
  });

  test('topDifferentCodons is sorted by difference', () => {
    const countsA = { TTT: 100, TTC: 0, ATG: 50 };
    const countsB = { TTT: 0, TTC: 100, ATG: 50 };
    const result = compareCodonUsage(countsA, countsB);

    const diffs = result.topDifferentCodons.map(c => c.difference);
    for (let i = 1; i < diffs.length; i++) {
      expect(diffs[i]).toBeLessThanOrEqual(diffs[i - 1]);
    }
  });
});

describe('compareAminoAcidUsage', () => {
  test('returns all expected fields', () => {
    const seqA = 'ATGATGATGATG'; // Met-Met-Met-Met
    const seqB = 'ATGATGATGATG';
    const result = compareAminoAcidUsage(seqA, seqB);

    expect(result).toHaveProperty('euclideanDistance');
    expect(result).toHaveProperty('cosineSimilarity');
    expect(result).toHaveProperty('correlationCoefficient');
    expect(result).toHaveProperty('hydrophobicSimilarity');
    expect(result).toHaveProperty('polarSimilarity');
    expect(result).toHaveProperty('chargedSimilarity');
    expect(result).toHaveProperty('topDifferentAAs');
  });

  test('identical sequences have perfect similarity', () => {
    const seq = 'ATGATGATGATGATGATGATGATGATGATG';
    const result = compareAminoAcidUsage(seq, seq);

    expect(result.euclideanDistance).toBeCloseTo(0, 5);
    expect(result.cosineSimilarity).toBeCloseTo(1, 5);
  });

  test('topDifferentAAs contains amino acid info', () => {
    const seqA = 'ATGATGATGATG';
    const seqB = 'TTTTTTTTTTTTTTT';
    const result = compareAminoAcidUsage(seqA, seqB);

    expect(result.topDifferentAAs.length).toBeGreaterThan(0);
    expect(result.topDifferentAAs[0]).toHaveProperty('aminoAcid');
    expect(result.topDifferentAAs[0]).toHaveProperty('name');
    expect(result.topDifferentAAs[0]).toHaveProperty('property');
  });
});

describe('compareGeneContent', () => {
  let geneId = 0;
  const makeGene = (name: string, start: number, end: number): GeneInfo => ({
    id: ++geneId,
    name,
    locusTag: name,
    startPos: start,
    endPos: end,
    strand: '+',
    product: 'test product',
    type: 'CDS',
  });

  test('returns all expected fields', () => {
    const genesA = [makeGene('gene1', 0, 100), makeGene('gene2', 200, 300)];
    const genesB = [makeGene('gene1', 0, 100), makeGene('gene3', 200, 300)];
    const result = compareGeneContent(genesA, genesB, 1000, 1000);

    expect(result).toHaveProperty('genesA');
    expect(result).toHaveProperty('genesB');
    expect(result).toHaveProperty('sharedGeneNames');
    expect(result).toHaveProperty('uniqueToA');
    expect(result).toHaveProperty('uniqueToB');
    expect(result).toHaveProperty('geneDensityA');
    expect(result).toHaveProperty('geneDensityB');
    expect(result).toHaveProperty('geneNameJaccard');
    expect(result).toHaveProperty('avgGeneLengthA');
    expect(result).toHaveProperty('avgGeneLengthB');
  });

  test('correctly counts shared and unique genes', () => {
    const genesA = [makeGene('shared', 0, 100), makeGene('uniqueA', 200, 300)];
    const genesB = [makeGene('shared', 0, 100), makeGene('uniqueB', 200, 300)];
    const result = compareGeneContent(genesA, genesB, 1000, 1000);

    expect(result.sharedGeneNames).toBe(1);
    expect(result.uniqueToA).toBe(1);
    expect(result.uniqueToB).toBe(1);
  });

  test('calculates correct gene densities', () => {
    const genesA = [makeGene('g1', 0, 100)];
    const result = compareGeneContent(genesA, [], 1000, 1000);

    // 1 gene per 1kb = 1.0 genes/kb
    expect(result.geneDensityA).toBeCloseTo(1.0, 5);
    expect(result.geneDensityB).toBe(0);
  });

  test('calculates correct average gene lengths', () => {
    const genesA = [
      makeGene('g1', 0, 100),   // length 100
      makeGene('g2', 200, 400), // length 200
    ];
    const result = compareGeneContent(genesA, [], 1000, 1000);

    // Average: (100 + 200) / 2 = 150
    expect(result.avgGeneLengthA).toBeCloseTo(150, 5);
  });

  test('handles empty gene lists', () => {
    const result = compareGeneContent([], [], 1000, 1000);

    expect(result.genesA).toBe(0);
    expect(result.genesB).toBe(0);
    expect(result.sharedGeneNames).toBe(0);
    expect(result.geneNameJaccard).toBe(0);
  });

  test('calculates correct Jaccard index', () => {
    const genesA = [makeGene('a', 0, 100), makeGene('b', 0, 100)];
    const genesB = [makeGene('b', 0, 100), makeGene('c', 0, 100)];
    const result = compareGeneContent(genesA, genesB, 1000, 1000);

    // Shared: {b}, Union: {a, b, c} = 3, Jaccard = 1/3
    expect(result.geneNameJaccard).toBeCloseTo(1 / 3, 5);
  });
});

describe('compareDinucleotideBias', () => {
  test('returns all expected fields', () => {
    const seqA = 'ATGCATGCATGCATGC';
    const seqB = 'GCTAGCTAGCTAGCTA';
    const result = compareDinucleotideBias(seqA, seqB);

    expect(result).toHaveProperty('dinucleotideCorrelation');
    expect(result).toHaveProperty('cpgRatioA');
    expect(result).toHaveProperty('cpgRatioB');
    expect(result).toHaveProperty('mostDifferentDinucs');
  });

  test('identical sequences have perfect correlation', () => {
    const seq = 'ATGCATGCATGCATGCATGCATGCATGCATGC';
    const result = compareDinucleotideBias(seq, seq);

    expect(result.dinucleotideCorrelation).toBeCloseTo(1.0, 5);
  });

  test('mostDifferentDinucs is sorted by difference', () => {
    const seqA = 'ATATATAT'; // AT-heavy
    const seqB = 'GCGCGCGC'; // GC-heavy
    const result = compareDinucleotideBias(seqA, seqB);

    const diffs = result.mostDifferentDinucs.map(d => d.diff);
    for (let i = 1; i < diffs.length; i++) {
      expect(diffs[i]).toBeLessThanOrEqual(diffs[i - 1]);
    }
  });

  test('calculates CpG ratio', () => {
    // CG-rich sequence
    const seq = 'CGCGCGCGCGCGCGCGCGCG';
    const result = compareDinucleotideBias(seq, seq);

    // Should have high CpG ratio
    expect(result.cpgRatioA).toBeGreaterThan(0);
    expect(typeof result.cpgRatioB).toBe('number');
  });

  test('handles empty sequences', () => {
    const result = compareDinucleotideBias('', '');

    expect(result.dinucleotideCorrelation).toBe(0);
    expect(result.cpgRatioA).toBe(0);
    expect(result.cpgRatioB).toBe(0);
  });
});
