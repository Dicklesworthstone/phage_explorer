/**
 * Genome Comparison Engine
 *
 * Main orchestration module that runs all comparison analyses
 * and produces a comprehensive comparison result.
 */

import type {
  GenomeComparisonResult,
  ComparisonSummary,
  ComparisonInsight,
  ComparisonConfig,
  SimilarityCategory,
} from './types';
import type { GeneInfo, CodonUsageData } from '@phage-explorer/core';

import { multiResolutionKmerAnalysis } from './kmer-analysis';
import { analyzeInformationTheory } from './information-theory';
import { compareFrequencyDistributions } from './rank-correlation';
import { analyzeEditDistance, quickSimilarityEstimate } from './edit-distance';
import {
  analyzeBiologicalMetrics,
  compareCodonUsage,
  compareAminoAcidUsage,
  compareGeneContent,
} from './biological-metrics';
import { countCodonUsage } from '@phage-explorer/core';
import { analyzeStructuralVariants } from './structural-variants';

/**
 * Perform comprehensive genome comparison.
 */
export async function compareGenomes(
  phageA: { id: number; name: string; accession: string },
  phageB: { id: number; name: string; accession: string },
  sequenceA: string,
  sequenceB: string,
  genesA: GeneInfo[] = [],
  genesB: GeneInfo[] = [],
  codonUsageA?: CodonUsageData | null,
  codonUsageB?: CodonUsageData | null,
  config: ComparisonConfig = {
    kmerSizes: [3, 5, 7, 11],
    maxEditDistanceLength: 10000,
    editDistanceWindowSize: 1000,
    editDistanceWindowCount: 20,
    includeGeneComparison: true,
    includeCodonUsage: true,
    includeStructuralVariants: true,
  }
): Promise<GenomeComparisonResult> {
  const startTime = Date.now();

  // Run k-mer analysis at multiple resolutions
  const kmerAnalysis = multiResolutionKmerAnalysis(
    sequenceA,
    sequenceB,
    config.kmerSizes
  );

  // Information theory metrics
  const informationTheory = analyzeInformationTheory(sequenceA, sequenceB, 5);

  // Edit distance (may use approximation for long sequences)
  const editDistance = analyzeEditDistance(sequenceA, sequenceB, {
    maxExactLength: config.maxEditDistanceLength,
    windowSize: config.editDistanceWindowSize,
    windowCount: config.editDistanceWindowCount,
  });

  // Biological metrics
  const biological = analyzeBiologicalMetrics(sequenceA, sequenceB);

  // Codon usage comparison
  const codonCountsA = codonUsageA?.codonCounts ?? countCodonUsage(sequenceA, 0);
  const codonCountsB = codonUsageB?.codonCounts ?? countCodonUsage(sequenceB, 0);
  const codonUsage = compareCodonUsage(codonCountsA, codonCountsB);

  // Amino acid usage comparison
  const aminoAcidUsage = compareAminoAcidUsage(sequenceA, sequenceB);

  // Rank correlation on codon frequencies
  const codonFreqsA = new Map(Object.entries(codonCountsA));
  const codonFreqsB = new Map(Object.entries(codonCountsB));
  const rankCorrelation = compareFrequencyDistributions(codonFreqsA, codonFreqsB);

  // Gene content comparison
  const geneContent = compareGeneContent(
    genesA,
    genesB,
    sequenceA.length,
    sequenceB.length
  );

  const structuralVariants =
    config.includeStructuralVariants !== false
      ? analyzeStructuralVariants(sequenceA, sequenceB, genesA, genesB)
      : null;

  // Compute summary
  const summary = computeSummary(
    kmerAnalysis,
    informationTheory,
    editDistance,
    biological,
    codonUsage,
    aminoAcidUsage,
    geneContent
  );

  const computeTimeMs = Date.now() - startTime;

  return {
    phageA,
    phageB,
    computedAt: Date.now(),
    computeTimeMs,
    summary,
    kmerAnalysis,
    informationTheory,
    rankCorrelation,
    editDistance,
    biological,
    codonUsage,
    aminoAcidUsage,
    geneContent,
    structuralVariants,
  };
}

/**
 * Compute overall comparison summary with insights.
 */
function computeSummary(
  kmerAnalysis: GenomeComparisonResult['kmerAnalysis'],
  informationTheory: GenomeComparisonResult['informationTheory'],
  editDistance: GenomeComparisonResult['editDistance'],
  biological: GenomeComparisonResult['biological'],
  codonUsage: GenomeComparisonResult['codonUsage'],
  aminoAcidUsage: GenomeComparisonResult['aminoAcidUsage'],
  geneContent: GenomeComparisonResult['geneContent']
): ComparisonSummary {
  const insights: ComparisonInsight[] = [];

  // Sequence similarity (based on k-mer Jaccard, k=7)
  const kmer7 = kmerAnalysis.find(k => k.k === 7) ?? kmerAnalysis[0];
  // Guard against empty kmerAnalysis array
  const sequenceSimilarity = kmer7 ? kmer7.jaccardIndex * 100 : 0;

  // Composition similarity (based on cosine of k-mer frequencies)
  const compositionSimilarity = kmer7 ? kmer7.cosineSimilarity * 100 : 0;

  // Codon usage similarity
  const codonUsageSimilarity = codonUsage.rscuCosineSimilarity * 100;

  // Gene content similarity
  const geneContentSimilarity = geneContent.geneNameJaccard * 100;

  // Weighted overall score
  // Weights: sequence 40%, composition 25%, codon 20%, gene 15%
  const overallSimilarity =
    sequenceSimilarity * 0.40 +
    compositionSimilarity * 0.25 +
    codonUsageSimilarity * 0.20 +
    geneContentSimilarity * 0.15;

  // Categorize similarity
  const similarityCategory = categorizeSimilarity(overallSimilarity);

  // Determine confidence level based on data availability
  const hasGenes = geneContent.genesA > 0 && geneContent.genesB > 0;
  const hasLongSequences = biological.lengthA > 1000 && biological.lengthB > 1000;
  const confidenceLevel = hasGenes && hasLongSequences
    ? 'high'
    : hasLongSequences
    ? 'medium'
    : 'low';

  // Generate insights
  // ANI insight
  if (biological.aniScore >= 95) {
    insights.push({
      type: 'similarity',
      category: 'ANI',
      message: `Very high ANI (${biological.aniScore.toFixed(1)}%) - likely same species`,
      value: biological.aniScore,
      significance: 'high',
    });
  } else if (biological.aniScore < 70) {
    insights.push({
      type: 'difference',
      category: 'ANI',
      message: `Low ANI (${biological.aniScore.toFixed(1)}%) - distantly related`,
      value: biological.aniScore,
      significance: 'high',
    });
  }

  // GC content insight
  if (biological.gcDifference < 2) {
    insights.push({
      type: 'similarity',
      category: 'GC Content',
      message: `Similar GC content (difference: ${biological.gcDifference.toFixed(1)}%)`,
      value: biological.gcDifference,
      significance: 'medium',
    });
  } else if (biological.gcDifference > 10) {
    insights.push({
      type: 'difference',
      category: 'GC Content',
      message: `Different GC content (difference: ${biological.gcDifference.toFixed(1)}%)`,
      value: biological.gcDifference,
      significance: 'high',
    });
  }

  // Genome size insight
  if (biological.lengthRatio < 0.5) {
    insights.push({
      type: 'notable',
      category: 'Genome Size',
      message: `Very different genome sizes (ratio: ${(biological.lengthRatio * 100).toFixed(0)}%)`,
      value: biological.lengthRatio,
      significance: 'high',
    });
  }

  // K-mer containment insight
  const containmentMax = kmer7 ? Math.max(kmer7.containmentAinB, kmer7.containmentBinA) : 0;
  const containmentMin = kmer7 ? Math.min(kmer7.containmentAinB, kmer7.containmentBinA) : 0;
  if (containmentMax > 0.8 && containmentMin < 0.5) {
    insights.push({
      type: 'notable',
      category: 'Containment',
      message: 'Asymmetric containment - one genome may be a subset of the other',
      value: containmentMax,
      significance: 'high',
    });
  }

  // Mutual information insight
  if (informationTheory.normalizedMI > 0.5) {
    insights.push({
      type: 'similarity',
      category: 'Information',
      message: `High mutual information (NMI: ${(informationTheory.normalizedMI * 100).toFixed(1)}%)`,
      value: informationTheory.normalizedMI,
      significance: 'medium',
    });
  }

  // Codon bias insight
  if (codonUsage.topDifferentCodons.length > 0) {
    const topCodon = codonUsage.topDifferentCodons[0];
    if (topCodon.difference > 1.0) {
      insights.push({
        type: 'difference',
        category: 'Codon Usage',
        message: `Strong codon bias difference in ${topCodon.codon} (${topCodon.aminoAcid})`,
        value: topCodon.difference,
        significance: 'medium',
      });
    }
  }

  // Gene sharing insight
  if (geneContent.sharedGeneNames > 5) {
    insights.push({
      type: 'similarity',
      category: 'Genes',
      message: `Share ${geneContent.sharedGeneNames} named genes`,
      value: geneContent.sharedGeneNames,
      significance: 'medium',
    });
  }

  // Edit distance insight
  if (editDistance.levenshteinSimilarity > 0.9) {
    insights.push({
      type: 'similarity',
      category: 'Edit Distance',
      message: 'Very low edit distance - highly similar sequences',
      value: editDistance.levenshteinSimilarity,
      significance: 'high',
    });
  }

  return {
    overallSimilarity,
    similarityCategory,
    confidenceLevel,
    sequenceSimilarity,
    compositionSimilarity,
    codonUsageSimilarity,
    geneContentSimilarity,
    insights,
  };
}

/**
 * Categorize similarity score.
 */
function categorizeSimilarity(score: number): SimilarityCategory {
  if (score >= 99) return 'identical';
  if (score >= 90) return 'highly_similar';
  if (score >= 70) return 'similar';
  if (score >= 50) return 'moderately_similar';
  if (score >= 30) return 'distantly_related';
  return 'unrelated';
}

/**
 * Quick comparison for filtering/sorting.
 * Returns a simple similarity score without full analysis.
 */
export function quickCompare(
  sequenceA: string,
  sequenceB: string
): { similarity: number; estimateType: 'quick' } {
  const similarity = quickSimilarityEstimate(sequenceA, sequenceB);
  return { similarity, estimateType: 'quick' };
}

/**
 * Format similarity score as descriptive text.
 */
export function formatSimilarity(score: number): string {
  if (score >= 99) return 'Nearly Identical';
  if (score >= 95) return 'Extremely Similar';
  if (score >= 90) return 'Highly Similar';
  if (score >= 80) return 'Very Similar';
  if (score >= 70) return 'Similar';
  if (score >= 60) return 'Moderately Similar';
  if (score >= 50) return 'Somewhat Similar';
  if (score >= 40) return 'Distantly Related';
  if (score >= 30) return 'Weakly Related';
  if (score >= 20) return 'Very Distant';
  return 'Unrelated';
}

/**
 * Get similarity color code for TUI display.
 */
export function getSimilarityColor(score: number): string {
  if (score >= 90) return '#22c55e'; // Green
  if (score >= 70) return '#84cc16'; // Lime
  if (score >= 50) return '#eab308'; // Yellow
  if (score >= 30) return '#f97316'; // Orange
  return '#ef4444'; // Red
}

/**
 * Create a visual similarity bar for TUI.
 */
export function createSimilarityBar(
  score: number,
  width: number = 20,
  fillChar: string = '█',
  emptyChar: string = '░'
): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  return fillChar.repeat(filled) + emptyChar.repeat(empty);
}
