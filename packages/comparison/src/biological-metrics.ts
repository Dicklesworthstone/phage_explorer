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

/** Ambiguous triplets are not extra cells in a 64-codon contingency table. */
function resolvedCodonCounts(input: Record<string, number>): { counts: Record<string, number>; total: number; excluded: number } {
  const counts: Record<string, number> = {};
  let total = 0, excluded = 0;
  for (const [codon, count] of Object.entries(input)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('Codon counts must be nonnegative safe integers.');
    if (Object.hasOwn(CODON_TABLE, codon)) { counts[codon] = count; total += count; }
    else excluded += count;
    if (!Number.isSafeInteger(total + excluded)) throw new RangeError('Total codon count exceeds the safe integer range.');
  }
  return { counts, total, excluded };
}

/**
 * Compare codon usage between two sequences.
 */
export function compareCodonUsage(
  codonCountsA: Record<string, number>,
  codonCountsB: Record<string, number>
): CodonUsageComparison {
  const a = resolvedCodonCounts(codonCountsA), b = resolvedCodonCounts(codonCountsB);
  const countsA = a.counts, countsB = b.counts;
  const rscuA = calculateRSCU(countsA);
  const rscuB = calculateRSCU(countsB);

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
  const totalA = a.total;
  const totalB = b.total;
  const totalSum = totalA + totalB;
  if (!Number.isSafeInteger(totalSum)) throw new RangeError('Combined codon count exceeds the safe integer range.');

  let chiSquare = 0;
  let categories = 0;
  let chiSquareExpectedBelowFive = 0;

  if (totalSum > 0) {
    for (const codon of codons) {
      const obsA = countsA[codon] ?? 0;
      const obsB = countsB[codon] ?? 0;
      const total = obsA + obsB;

      if (total > 0) {
        const expA = total * (totalA / totalSum);
        const expB = total * (totalB / totalSum);

        if (expA > 0) chiSquare += Math.pow(obsA - expA, 2) / expA;
        if (expB > 0) chiSquare += Math.pow(obsB - expB, 2) / expB;
        if (expA < 5) chiSquareExpectedBelowFive++;
        if (expB < 5) chiSquareExpectedBelowFive++;
        categories++;
      }
    }
  }
  const df = totalA > 0 && totalB > 0 ? Math.max(0, categories - 1) : 0;
  const chiSquareUnavailableReason = totalA === 0 || totalB === 0
    ? 'Both genomes need resolved codon observations.'
    : df === 0 ? 'At least two observed codon categories are required.' : null;

  // Asymptotic Pearson test of the full codon distribution, not synonymous bias alone.
  const chiSquarePValue = chiSquareUnavailableReason === null ? chiSquareSurvival(chiSquare, df) : null;

  // CAI (cross-adaptation): evaluate A with B preferences and vice versa
  const caiA = computeCAIFromCounts(countsA, countsB);
  const caiB = computeCAIFromCounts(countsB, countsA);
  const weightA = deriveCodonWeights(countsA);
  const weightB = deriveCodonWeights(countsB);
  const caiCorrelation = cosineSimilarity(
    codons.map(c => weightA[c]),
    codons.map(c => weightB[c])
  );

  // Find most different codons (guard against division by zero)
  const safeTotal = (t: number) => t > 0 ? t : 1;
  const differences: CodonDifference[] = codons.map(codon => ({
    codon,
    aminoAcid: CODON_TABLE[codon],
    frequencyA: (countsA[codon] ?? 0) / safeTotal(totalA) * 1000,
    frequencyB: (countsB[codon] ?? 0) / safeTotal(totalB) * 1000,
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
    chiSquareUnavailableReason,
    chiSquareExpectedBelowFive,
    resolvedCodonsA: totalA,
    resolvedCodonsB: totalB,
    excludedCodonsA: a.excluded,
    excludedCodonsB: b.excluded,
    caiA,
    caiB,
    caiCorrelation,
    topDifferentCodons: differences.slice(0, 10),
  };
}

/**
 * Chi-square survival Q(df/2, x/2). Use the lower-gamma series only where it
 * converges rapidly, and compute the upper tail directly elsewhere to avoid
 * both truncation and cancellation in 1 - CDF. Here df is an integer in 1..63.
 * NIST DLMF 8.7.1 (series), 8.9.2 (continued fraction): https://dlmf.nist.gov/8.9
 */
function chiSquareSurvival(x: number, df: number): number {
  if (x <= 0) return 1;
  const k = df / 2;
  const t = x / 2;
  // Integer/half-integer gamma normalization via Gamma(a+1) = a Gamma(a).
  let logGamma = df % 2 === 0 ? 0 : Math.log(Math.PI) / 2;
  for (let a = df % 2 === 0 ? 1 : 0.5; a < k; a++) logGamma += Math.log(a);
  const scale = Math.exp(-t + k * Math.log(t) - logGamma);
  const tolerance = 1e-14;
  if (t < k + 1) {
    let term = 1 / k, sum = term;
    for (let n = 1; n <= 1000; n++) {
      term *= t / (k + n);
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * tolerance) return Math.max(0, Math.min(1, 1 - scale * sum));
    }
  } else {
    // Modified Lentz evaluation of the contracted upper-gamma fraction.
    const tiny = 1e-300;
    let b = t + 1 - k, c = 1 / tiny, d = 1 / b, fraction = d;
    for (let n = 1; n <= 1000; n++) {
      const numerator = n * (k - n);
      b += 2;
      d = b + numerator * d;
      c = b + numerator / c;
      if (Math.abs(d) < tiny) d = d < 0 ? -tiny : tiny;
      if (Math.abs(c) < tiny) c = c < 0 ? -tiny : tiny;
      d = 1 / d;
      const delta = c * d;
      fraction *= delta;
      if (Math.abs(delta - 1) <= tolerance) return Math.max(0, Math.min(1, scale * fraction));
    }
  }
  throw new Error('Codon chi-square probability did not converge.');
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
