/**
 * Biological Metrics Module
 *
 * Implements biologically meaningful comparison metrics:
 * - Strand-independent k-mer identity estimates (not aligned ANI)
 * - GC content comparison
 * - Codon usage analysis (RSCU, CAI)
 * - Amino acid composition comparison
 * - Gene content comparison
 *
 * References:
 * - Ondov et al. (2016), Mash, https://doi.org/10.1186/s13059-016-0997-x
 * - Sharp & Li (1987) "The codon adaptation index"
 * - Carbone et al. (2003) "Codon usage bias"
 */

import type {
  BiologicalMetrics,
  KmerIdentityCoverage,
  KmerIdentityEstimate,
  CodonUsageComparison,
  CodonDifference,
  AminoAcidComparison,
  AminoAcidDifference,
  GeneContentComparison,
} from './types';
import type { GeneInfo } from '@phage-explorer/core';
import { CODON_TABLE, AMINO_ACIDS, countAminoAcidUsage, translateSequence } from '@phage-explorer/core';
import { extractCanonicalKmerFrequencies } from './kmer-analysis';

/**
 * Calculate GC content of a sequence.
 */
function calculateGCStatistics(sequence: string): { percent: number; resolvedBases: number } {
  let gc = 0;
  let total = 0;
  const len = sequence.length;

  for (let i = 0; i < len; i++) {
    const char = sequence.charCodeAt(i);
    // G=71, C=67, g=103, c=99
    // A=65, T=84, a=97, t=116
    if (char === 71 || char === 67 || char === 103 || char === 99) {
      gc++;
      total++;
    } else if (
      char === 65 || char === 84 || // A, T
      char === 97 || char === 116   // a, t
    ) {
      total++;
    }
  }

  return { percent: total > 0 ? (gc / total) * 100 : 0, resolvedBases: total };
}

/** Numeric convenience API; zero without resolved bases is not evidence of 0% GC. */
export function calculateGCContent(sequence: string): number {
  return calculateGCStatistics(sequence).percent;
}

/**
 * Transform exact canonical k-mer resemblance using the Mash mutation model:
 * D = -ln(2J / (1 + J)) / k; identity approximation = 100(1 - D).
 * See Ondov et al. (2016), equation 4, doi:10.1186/s13059-016-0997-x.
 *
 * Canonical words make the calculation independent of submitted DNA strand.
 * This uses full sets, not a MinHash sketch, so there is no sketch sampling error
 * estimate. The model still assumes unique words and independent mutations;
 * repeats, ambiguous bases and different genome content can violate it. This
 * does not align homologous fragments, measure aligned ANI or assign species.
 */
export function estimateKmerIdentity(
  sequenceA: string,
  sequenceB: string,
  k: number = 21
): KmerIdentityEstimate {
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError('K-mer size must be a positive integer.');
  const wordsA = extractCanonicalKmerFrequencies(sequenceA, k);
  const wordsB = extractCanonicalKmerFrequencies(sequenceB, k);
  const coverage = (words: Map<string, number>, length: number): KmerIdentityCoverage => {
    const totalWindows = Math.max(0, length - k + 1);
    let validWindows = 0;
    for (const count of words.values()) validWindows += count;
    return { totalWindows, validWindows, distinctKmers: words.size,
      validWindowFraction: totalWindows > 0 ? validWindows / totalWindows : 0 };
  };
  const coverageA = coverage(wordsA, sequenceA.length), coverageB = coverage(wordsB, sequenceB.length);
  let sharedKmers = 0;
  const [smaller, larger] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  for (const word of smaller.keys()) if (larger.has(word)) sharedKmers++;
  // Empty sets are absence of evidence, not identical genomes. Zero overlap
  // cannot give a finite logarithmic distance and must not become 0% identity.
  const jaccard = wordsA.size > 0 && wordsB.size > 0
    ? sharedKmers / (wordsA.size + wordsB.size - sharedKmers) : null;
  const distance = sharedKmers > 0 && jaccard !== null
    ? jaccard === 1 ? 0 : -Math.log(2 * jaccard / (1 + jaccard)) / k : null;
  const unavailableReason = jaccard === null
    ? `Both sequences need at least one resolved ${k}-base window; short or ambiguous inputs have insufficient k-mer evidence.`
    : distance === null ? `No shared canonical ${k}-mers; identity cannot be estimated at this resolution.`
    : distance > 1 ? 'The Mash-style distance exceeds the identity approximation range.' : null;
  const warnings: string[] = [
    'Mash-style approximation from k-mer resemblance, not aligned nucleotide identity or a species assignment.',
  ];
  if (coverageA.validWindows < coverageA.totalWindows || coverageB.validWindows < coverageB.totalWindows) {
    warnings.push('Ambiguous symbols break k-mers; excluded windows may bias the estimate.');
  }
  if (wordsA.size < coverageA.validWindows || wordsB.size < coverageB.validWindows) {
    warnings.push('Repeated k-mers lose multiplicity; equal k-mer sets do not prove equal sequences.');
  }
  if (sequenceA.length !== sequenceB.length) {
    warnings.push('Different input lengths affect resemblance; this estimate does not measure identity only over aligned regions.');
  }
  return { method: 'canonical-kmer-mash', k, status: unavailableReason ? 'unavailable' : 'estimated',
    percent: unavailableReason === null && distance !== null ? 100 * (1 - distance) : null,
    distance, jaccard, sharedKmers, coverageA, coverageB, unavailableReason, warnings };
}

/**
 * Analyze biological metrics between two sequences.
 */
export function analyzeBiologicalMetrics(
  sequenceA: string,
  sequenceB: string
): BiologicalMetrics {
  const { percent: gcA, resolvedBases: gcResolvedBasesA } = calculateGCStatistics(sequenceA);
  const { percent: gcB, resolvedBases: gcResolvedBasesB } = calculateGCStatistics(sequenceB);
  const kmerIdentity = estimateKmerIdentity(sequenceA, sequenceB);

  const lengthA = sequenceA.length;
  const lengthB = sequenceB.length;

  const maxLength = Math.max(lengthA, lengthB);
  const maxGc = Math.max(gcA, gcB);

  return {
    kmerIdentity,
    gcContentA: gcA,
    gcContentB: gcB,
    gcResolvedBasesA,
    gcResolvedBasesB,
    gcDifference: Math.abs(gcA - gcB),
    gcRatio: maxGc > 0 ? Math.min(gcA, gcB) / maxGc : 1,
    lengthA,
    lengthB,
    lengthRatio: maxLength > 0 ? Math.min(lengthA, lengthB) / maxLength : 1,
    lengthDifference: Math.abs(lengthA - lengthB),
  };
}

/**
 * Calculate Relative Synonymous Codon Usage (RSCU) for a sequence.
 *
 * RSCU = (observed frequency) / (expected frequency)
 * where expected = 1 / (number of synonymous codons)
 *
 * RSCU > 1 means codon is used more than expected
 * RSCU < 1 means codon is used less than expected
 */
export function calculateRSCU(codonCounts: Record<string, number>): Record<string, number> {
  const rscu: Record<string, number> = {};

  // Group codons by amino acid
  const aaToCodeons: Record<string, string[]> = {};
  for (const [codon, aa] of Object.entries(CODON_TABLE)) {
    if (!aaToCodeons[aa]) {
      aaToCodeons[aa] = [];
    }
    aaToCodeons[aa].push(codon);
  }

  // Calculate RSCU for each codon
  for (const codons of Object.values(aaToCodeons)) {
    // Total count for this amino acid
    const totalAA = codons.reduce((sum, c) => sum + (codonCounts[c] ?? 0), 0);

    for (const codon of codons) {
      const observed = codonCounts[codon] ?? 0;
      // Expected if all synonymous codons were used equally
      const expected = totalAA / codons.length;

      rscu[codon] = expected > 0 ? observed / expected : 0;
    }
  }

  return rscu;
}

// Derive codon preference weights for CAI (frequency / max per amino acid)
function deriveCodonWeights(codonCounts: Record<string, number>): Record<string, number> {
  const aaToCodons: Record<string, string[]> = {};
  for (const [codon, aa] of Object.entries(CODON_TABLE)) {
    if (!aaToCodons[aa]) aaToCodons[aa] = [];
    aaToCodons[aa].push(codon);
  }

  const weights: Record<string, number> = {};
  for (const codons of Object.values(aaToCodons)) {
    const maxCount = Math.max(...codons.map(c => codonCounts[c] ?? 0), 0);
    for (const codon of codons) {
      const count = codonCounts[codon] ?? 0;
      const weight = maxCount > 0 ? count / maxCount : 0;
      weights[codon] = Math.max(weight, 1e-6); // avoid zeros for log
    }
  }
  return weights;
}

// CAI computed from codon count distributions (geometric mean of weights)
function computeCAIFromCounts(
  targetCounts: Record<string, number>,
  referenceCounts: Record<string, number>
): number {
  const weights = deriveCodonWeights(referenceCounts);
  const totalCodons = Object.values(targetCounts).reduce((sum, c) => sum + c, 0);
  if (totalCodons === 0) return 0;

  let logSum = 0;
  for (const [codon, count] of Object.entries(targetCounts)) {
    if (count <= 0) continue;
    logSum += count * Math.log(weights[codon] ?? 1e-6);
  }

  return Math.exp(logSum / totalCodons);
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Compare codon usage between two sequences.
 */
export function compareCodonUsage(
  codonCountsA: Record<string, number>,
  codonCountsB: Record<string, number>
): CodonUsageComparison {
  const rscuA = calculateRSCU(codonCountsA);
  const rscuB = calculateRSCU(codonCountsB);

  // Get all codons
  const codons = Object.keys(CODON_TABLE);

  // Create vectors for distance calculations
  const vecA = codons.map(c => rscuA[c] ?? 0);
  const vecB = codons.map(c => rscuB[c] ?? 0);

  // Euclidean distance
  let euclidean = 0;
  let manhattan = 0;
  for (let i = 0; i < codons.length; i++) {
    const diff = vecA[i] - vecB[i];
    euclidean += diff * diff;
    manhattan += Math.abs(diff);
  }
  euclidean = Math.sqrt(euclidean);

  const cosSim = cosineSimilarity(vecA, vecB);

  // Chi-square test
  const totalA = Object.values(codonCountsA).reduce((a, b) => a + b, 0);
  const totalB = Object.values(codonCountsB).reduce((a, b) => a + b, 0);
  const totalSum = totalA + totalB;

  let chiSquare = 0;
  let df = 0;

  if (totalSum > 0) {
    for (const codon of codons) {
      const obsA = codonCountsA[codon] ?? 0;
      const obsB = codonCountsB[codon] ?? 0;
      const total = obsA + obsB;

      if (total > 0) {
        const expA = totalA * total / totalSum;
        const expB = totalB * total / totalSum;

        if (expA > 0) chiSquare += Math.pow(obsA - expA, 2) / expA;
        if (expB > 0) chiSquare += Math.pow(obsB - expB, 2) / expB;
        df++;
      }
    }
  }
  df = Math.max(1, df - 1); // Degrees of freedom

  // P-value from chi-square (rough approximation)
  const chiSquarePValue = chiSquareCdf(chiSquare, df);

  // CAI (cross-adaptation): evaluate A with B preferences and vice versa
  const caiA = computeCAIFromCounts(codonCountsA, codonCountsB);
  const caiB = computeCAIFromCounts(codonCountsB, codonCountsA);
  const weightA = deriveCodonWeights(codonCountsA);
  const weightB = deriveCodonWeights(codonCountsB);
  const caiCorrelation = cosineSimilarity(
    codons.map(c => weightA[c]),
    codons.map(c => weightB[c])
  );

  // Find most different codons (guard against division by zero)
  const safeTotal = (t: number) => t > 0 ? t : 1;
  const differences: CodonDifference[] = codons.map(codon => ({
    codon,
    aminoAcid: CODON_TABLE[codon],
    frequencyA: (codonCountsA[codon] ?? 0) / safeTotal(totalA) * 1000,
    frequencyB: (codonCountsB[codon] ?? 0) / safeTotal(totalB) * 1000,
    rscuA: rscuA[codon] ?? 0,
    rscuB: rscuB[codon] ?? 0,
    difference: Math.abs((rscuA[codon] ?? 0) - (rscuB[codon] ?? 0)),
  })).sort((a, b) => b.difference - a.difference);

  return {
    rscuDistanceEuclidean: euclidean,
    rscuDistanceManhattan: manhattan,
    rscuCosineSimilarity: cosSim,
    chiSquareStatistic: chiSquare,
    chiSquarePValue,
    degreesOfFreedom: df,
    caiA,
    caiB,
    caiCorrelation,
    topDifferentCodons: differences.slice(0, 10),
  };
}

/**
 * Chi-square CDF approximation (upper tail).
 */
function chiSquareCdf(x: number, df: number): number {
  // Use incomplete gamma function approximation
  if (x <= 0) return 1;

  const k = df / 2;
  const t = x / 2;

  // Simple approximation for large df
  if (df > 100) {
    const z = Math.pow(x / df, 1 / 3) - (1 - 2 / (9 * df));
    return 1 - normalCdf(z / Math.sqrt(2 / (9 * df)));
  }

  // Regularized gamma
  return 1 - gammaCdf(t, k);
}

function normalCdf(z: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

function gammaCdf(x: number, k: number): number {
  // Incomplete gamma function approximation
  if (x <= 0) return 0;

  let sum = 0;
  let term = 1 / k;
  sum = term;

  for (let n = 1; n < 100; n++) {
    term *= x / (k + n);
    sum += term;
    if (term < 1e-10) break;
  }

  return sum * Math.exp(-x + k * Math.log(x) - logGamma(k));
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953
  ];

  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);

  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    ser += c[j] / ++y;
  }

  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/**
 * Compare amino acid usage between two sequences.
 */
export function compareAminoAcidUsage(
  sequenceA: string,
  sequenceB: string
): AminoAcidComparison {
  // Translate sequences
  const aaSeqA = translateSequence(sequenceA, 0);
  const aaSeqB = translateSequence(sequenceB, 0);

  // Count amino acids
  const countsA = countAminoAcidUsage(aaSeqA);
  const countsB = countAminoAcidUsage(aaSeqB);

  const totalA = Object.values(countsA).reduce((a, b) => a + b, 0);
  const totalB = Object.values(countsB).reduce((a, b) => a + b, 0);

  // All amino acids
  const aas = Object.keys(AMINO_ACIDS).filter(aa => aa !== '*');

  // Guard against division by zero
  const safeTotalA = totalA > 0 ? totalA : 1;
  const safeTotalB = totalB > 0 ? totalB : 1;

  // Frequency vectors
  const freqA = aas.map(aa => (countsA[aa] ?? 0) / safeTotalA);
  const freqB = aas.map(aa => (countsB[aa] ?? 0) / safeTotalB);

  // Euclidean distance
  let euclidean = 0;
  for (let i = 0; i < aas.length; i++) {
    euclidean += Math.pow(freqA[i] - freqB[i], 2);
  }
  euclidean = Math.sqrt(euclidean);

  // Cosine similarity
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < aas.length; i++) {
    dotProduct += freqA[i] * freqB[i];
    normA += freqA[i] * freqA[i];
    normB += freqB[i] * freqB[i];
  }
  const cosSim = (Math.sqrt(normA) * Math.sqrt(normB)) > 0
    ? dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
    : 0;

  // Pearson correlation
  const meanA = freqA.reduce((a, b) => a + b, 0) / freqA.length;
  const meanB = freqB.reduce((a, b) => a + b, 0) / freqB.length;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < aas.length; i++) {
    const dA = freqA[i] - meanA;
    const dB = freqB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }
  const correlation = (Math.sqrt(varA) * Math.sqrt(varB)) > 0
    ? cov / (Math.sqrt(varA) * Math.sqrt(varB))
    : 0;

  // By property group
  const propertyGroups: Record<string, string[]> = {
    hydrophobic: ['A', 'V', 'I', 'L', 'M', 'F', 'W'],
    polar: ['S', 'T', 'N', 'Q', 'Y'],
    charged: ['D', 'E', 'K', 'R', 'H'],
  };

  const propertySimilarities: Record<string, number> = {};
  for (const [prop, aaList] of Object.entries(propertyGroups)) {
    const sumA = aaList.reduce((sum, aa) => sum + (countsA[aa] ?? 0), 0) / safeTotalA;
    const sumB = aaList.reduce((sum, aa) => sum + (countsB[aa] ?? 0), 0) / safeTotalB;
    propertySimilarities[prop] = 1 - Math.abs(sumA - sumB);
  }

  // Top different amino acids
  const differences: AminoAcidDifference[] = aas.map((aa, i) => ({
    aminoAcid: aa,
    name: AMINO_ACIDS[aa as keyof typeof AMINO_ACIDS]?.name ?? aa,
    property: AMINO_ACIDS[aa as keyof typeof AMINO_ACIDS]?.property ?? 'unknown',
    frequencyA: freqA[i] * 100,
    frequencyB: freqB[i] * 100,
    percentDifference: Math.abs(freqA[i] - freqB[i]) * 100,
  })).sort((a, b) => b.percentDifference - a.percentDifference);

  return {
    euclideanDistance: euclidean,
    cosineSimilarity: cosSim,
    correlationCoefficient: correlation,
    hydrophobicSimilarity: propertySimilarities.hydrophobic,
    polarSimilarity: propertySimilarities.polar,
    chargedSimilarity: propertySimilarities.charged,
    topDifferentAAs: differences.slice(0, 10),
  };
}

/**
 * Compare gene content between two phages.
 */
export function compareGeneContent(
  genesA: GeneInfo[],
  genesB: GeneInfo[],
  genomeLengthA: number,
  genomeLengthB: number
): GeneContentComparison {
  // Extract gene names (use locus tag if name not available)
  const namesA = new Set(
    genesA.map(g => (g.name || g.locusTag || '').toLowerCase()).filter(n => n)
  );
  const namesB = new Set(
    genesB.map(g => (g.name || g.locusTag || '').toLowerCase()).filter(n => n)
  );

  // Find shared genes (by name matching)
  const sharedNames = new Set<string>();
  for (const name of namesA) {
    if (namesB.has(name)) {
      sharedNames.add(name);
    }
  }

  // Unique genes
  const uniqueA = [...namesA].filter(n => !namesB.has(n));
  const uniqueB = [...namesB].filter(n => !namesA.has(n));

  // Gene densities (genes per kb) - guard against division by zero
  const densityA = genomeLengthA > 0 ? genesA.length / (genomeLengthA / 1000) : 0;
  const densityB = genomeLengthB > 0 ? genesB.length / (genomeLengthB / 1000) : 0;

  // Average gene lengths
  const avgLengthA = genesA.length > 0
    ? genesA.reduce((sum, g) => sum + (g.endPos - g.startPos), 0) / genesA.length
    : 0;
  const avgLengthB = genesB.length > 0
    ? genesB.reduce((sum, g) => sum + (g.endPos - g.startPos), 0) / genesB.length
    : 0;

  // Jaccard on gene names
  const unionSize = namesA.size + namesB.size - sharedNames.size;
  const geneJaccard = unionSize > 0 ? sharedNames.size / unionSize : 0;

  return {
    genesA: genesA.length,
    genesB: genesB.length,
    sharedGeneNames: sharedNames.size,
    uniqueToA: uniqueA.length,
    uniqueToB: uniqueB.length,
    geneDensityA: densityA,
    geneDensityB: densityB,
    geneNameJaccard: geneJaccard,
    avgGeneLengthA: avgLengthA,
    avgGeneLengthB: avgLengthB,
    topSharedGenes: [...sharedNames].slice(0, 10),
    uniqueAGenes: uniqueA.slice(0, 10),
    uniqueBGenes: uniqueB.slice(0, 10),
  };
}

/**
 * Compute dinucleotide bias comparison.
 * CpG, GpC, and other dinucleotide frequencies can reveal evolutionary relationships.
 */
export function compareDinucleotideBias(
  sequenceA: string,
  sequenceB: string
): {
  dinucleotideCorrelation: number;
  cpgRatioA: number;
  cpgRatioB: number;
  mostDifferentDinucs: Array<{ dinuc: string; freqA: number; freqB: number; diff: number }>;
} {
  const dinucs = ['AA', 'AC', 'AG', 'AT', 'CA', 'CC', 'CG', 'CT',
                  'GA', 'GC', 'GG', 'GT', 'TA', 'TC', 'TG', 'TT'];

  const countDinucs = (seq: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    const s = seq.toUpperCase();
    for (let i = 0; i < s.length - 1; i++) {
      const d = s.substring(i, i + 2);
      if (dinucs.includes(d)) {
        counts[d] = (counts[d] ?? 0) + 1;
      }
    }
    return counts;
  };

  const countsA = countDinucs(sequenceA);
  const countsB = countDinucs(sequenceB);

  const totalA = Object.values(countsA).reduce((a, b) => a + b, 0);
  const totalB = Object.values(countsB).reduce((a, b) => a + b, 0);

  // Guard against division by zero
  const safeTotalA = totalA > 0 ? totalA : 1;
  const safeTotalB = totalB > 0 ? totalB : 1;

  // Frequency vectors
  const freqA = dinucs.map(d => (countsA[d] ?? 0) / safeTotalA);
  const freqB = dinucs.map(d => (countsB[d] ?? 0) / safeTotalB);

  // Pearson correlation
  const meanA = freqA.reduce((a, b) => a + b, 0) / freqA.length;
  const meanB = freqB.reduce((a, b) => a + b, 0) / freqB.length;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < dinucs.length; i++) {
    const dA = freqA[i] - meanA;
    const dB = freqB[i] - meanB;
    cov += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }
  const correlation = (Math.sqrt(varA) * Math.sqrt(varB)) > 0
    ? cov / (Math.sqrt(varA) * Math.sqrt(varB))
    : 0;

  // CpG ratio (observed/expected)
  const gcA = calculateGCContent(sequenceA) / 100;
  const gcB = calculateGCContent(sequenceB) / 100;

  // Expected CpG = P(C) * P(G) * N ≈ (GC/2) * (GC/2) * N
  const expectedCpGA = (gcA / 2) * (gcA / 2) * totalA;
  const expectedCpGB = (gcB / 2) * (gcB / 2) * totalB;

  const cpgRatioA = expectedCpGA > 0 ? (countsA['CG'] ?? 0) / expectedCpGA : 0;
  const cpgRatioB = expectedCpGB > 0 ? (countsB['CG'] ?? 0) / expectedCpGB : 0;

  // Most different dinucleotides
  const differences = dinucs.map((d, i) => ({
    dinuc: d,
    freqA: freqA[i] * 100,
    freqB: freqB[i] * 100,
    diff: Math.abs(freqA[i] - freqB[i]) * 100,
  })).sort((a, b) => b.diff - a.diff);

  return {
    dinucleotideCorrelation: correlation,
    cpgRatioA,
    cpgRatioB,
    mostDifferentDinucs: differences.slice(0, 5),
  };
}
