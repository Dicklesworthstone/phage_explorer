/**
 * Genome Comparison Types
 *
 * Comprehensive type definitions for sophisticated phage genome comparison
 * using multiple statistical and bioinformatics metrics.
 */

import type { GeneInfo } from '@phage-explorer/core';

// K-mer analysis results
export interface KmerAnalysis {
  k: number;                          // K-mer length used
  uniqueKmersA: number;               // Unique k-mers in sequence A
  uniqueKmersB: number;               // Unique k-mers in sequence B
  sharedKmers: number;                // K-mers present in both
  jaccardIndex: number;               // |A ∩ B| / |A ∪ B|
  containmentAinB: number;            // |A ∩ B| / |A| (how much of A is in B)
  containmentBinA: number;            // |A ∩ B| / |B| (how much of B is in A)
  cosineSimilarity: number;           // Cosine of angle between frequency vectors
  brayCurtisDissimilarity: number;    // Ecological distance metric
}

// Information theory metrics
export interface InformationTheoryMetrics {
  entropyA: number;                   // Shannon entropy of sequence A (bits/base)
  entropyB: number;                   // Shannon entropy of sequence B (bits/base)
  jointEntropy: number;               // H(A,B) - joint entropy
  mutualInformation: number;          // I(A;B) = H(A) + H(B) - H(A,B)
  normalizedMI: number;               // NMI = 2*I(A;B) / (H(A) + H(B))
  jensenShannonDivergence: number;    // JSD - symmetric KLD, sqrt gives metric
  kullbackLeiblerAtoB: number;        // KL(A||B) - divergence from A to B
  kullbackLeiblerBtoA: number;        // KL(B||A) - divergence from B to A
  relativeEntropy: number;            // Average of KL divergences
}

// Rank correlation metrics (for frequency distributions)
export interface RankCorrelationMetrics {
  spearmanRho: number;                // Spearman's ρ - rank correlation
  spearmanPValue: number;             // P-value for Spearman's test
  kendallTau: number;                 // Kendall's τ - concordance measure
  kendallPValue: number;              // P-value for Kendall's test
  hoeffdingD: number;                 // Hoeffding's D - detects nonlinear dependence
  // Interpretation helpers
  spearmanStrength: CorrelationStrength;
  kendallStrength: CorrelationStrength;
}

export type CorrelationStrength =
  | 'perfect'      // |r| = 1
  | 'very_strong'  // 0.9 ≤ |r| < 1
  | 'strong'       // 0.7 ≤ |r| < 0.9
  | 'moderate'     // 0.5 ≤ |r| < 0.7
  | 'weak'         // 0.3 ≤ |r| < 0.5
  | 'negligible';  // |r| < 0.3

// Edit distance metrics
export interface EditDistanceMetrics {
  levenshteinDistance: number;        // Raw edit distance
  normalizedLevenshtein: number;      // Normalized to [0,1] where 0 = identical
  levenshteinSimilarity: number;      // 1 - normalized (1 = identical)
  insertions: number;                 // Number of insertions needed
  deletions: number;                  // Number of deletions needed
  substitutions: number;              // Number of substitutions needed
  // Approximate for very long sequences
  isApproximate: boolean;             // True if computed on sampled windows
  windowSize?: number;                // Window size if approximate
  windowCount?: number;               // Number of windows sampled
}

// Biological sequence metrics
export interface BiologicalMetrics {
  // Average Nucleotide Identity (ANI)
  aniScore: number;                   // ANI percentage (0-100)
  aniMethod: 'kmer' | 'blast' | 'mummer';

  // GC content comparison
  gcContentA: number;                 // GC% of sequence A
  gcContentB: number;                 // GC% of sequence B
  gcDifference: number;               // Absolute difference
  gcRatio: number;                    // Ratio (smaller/larger)

  // Genome size comparison
  lengthA: number;
  lengthB: number;
  lengthRatio: number;                // Ratio of lengths
  lengthDifference: number;           // Absolute difference
}

// Codon usage comparison
export interface CodonUsageComparison {
  // RSCU - Relative Synonymous Codon Usage
  rscuDistanceEuclidean: number;      // Euclidean distance of RSCU vectors
  rscuDistanceManhattan: number;      // Manhattan distance
  rscuCosineSimilarity: number;       // Cosine similarity

  // Chi-square test
  chiSquareStatistic: number;         // χ² statistic
  chiSquarePValue: number;            // P-value
  degreesOfFreedom: number;

  // CAI - Codon Adaptation Index (cross-adaptation)
  caiA: number;                       // CAI of sequence A using B's codon preference weights
  caiB: number;                       // CAI of sequence B using A's codon preference weights
  caiCorrelation: number;             // Cosine similarity of codon preference weights

  // Most different codons
  topDifferentCodons: CodonDifference[];
}

export interface CodonDifference {
  codon: string;
  aminoAcid: string;
  frequencyA: number;
  frequencyB: number;
  rscuA: number;
  rscuB: number;
  difference: number;                 // Absolute difference in RSCU
}

// Amino acid usage comparison
export interface AminoAcidComparison {
  euclideanDistance: number;          // Euclidean distance of AA frequency vectors
  cosineSimilarity: number;           // Cosine similarity
  correlationCoefficient: number;     // Pearson correlation

  // By property group
  hydrophobicSimilarity: number;
  polarSimilarity: number;
  chargedSimilarity: number;

  // Most different amino acids
  topDifferentAAs: AminoAcidDifference[];
}

export interface AminoAcidDifference {
  aminoAcid: string;
  name: string;
  property: string;
  frequencyA: number;
  frequencyB: number;
  percentDifference: number;
}

// Gene content comparison
export interface GeneContentComparison {
  genesA: number;                     // Total genes in A
  genesB: number;                     // Total genes in B
  sharedGeneNames: number;            // Genes with matching names
  uniqueToA: number;                  // Genes only in A
  uniqueToB: number;                  // Genes only in B
  geneDensityA: number;               // Genes per kb
  geneDensityB: number;

  // Jaccard on gene names (if available)
  geneNameJaccard: number;

  // Average gene length comparison
  avgGeneLengthA: number;
  avgGeneLengthB: number;

  // Shared gene names (limited list)
  topSharedGenes: string[];
  uniqueAGenes: string[];
  uniqueBGenes: string[];
}

// Overall comparison summary
export interface ComparisonSummary {
  overallSimilarity: number;          // Weighted aggregate score (0-100)
  similarityCategory: SimilarityCategory;
  confidenceLevel: ConfidenceLevel;

  // Component scores (0-100)
  sequenceSimilarity: number;         // Based on k-mer/edit distance
  compositionSimilarity: number;      // Based on nucleotide/GC content
  codonUsageSimilarity: number;       // Based on codon preferences
  geneContentSimilarity: number;      // Based on gene annotations

  // Key insights
  insights: ComparisonInsight[];
}

export type SimilarityCategory =
  | 'identical'           // >99%
  | 'highly_similar'      // 90-99%
  | 'similar'             // 70-90%
  | 'moderately_similar'  // 50-70%
  | 'distantly_related'   // 30-50%
  | 'unrelated';          // <30%

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ComparisonInsight {
  type: 'similarity' | 'difference' | 'notable' | 'warning';
  category: string;
  message: string;
  value?: number;
  significance: 'high' | 'medium' | 'low';
}

// Complete comparison result
export interface GenomeComparisonResult {
  // Metadata
  phageA: {
    id: number;
    name: string;
    accession: string;
  };
  phageB: {
    id: number;
    name: string;
    accession: string;
  };
  computedAt: number;                 // Unix timestamp
  computeTimeMs: number;              // Time to compute

  // All metrics
  summary: ComparisonSummary;
  kmerAnalysis: KmerAnalysis[];       // Multiple k values (3, 5, 7, 11)
  informationTheory: InformationTheoryMetrics;
  rankCorrelation: RankCorrelationMetrics;
  editDistance: EditDistanceMetrics;
  biological: BiologicalMetrics;
  codonUsage: CodonUsageComparison;
  aminoAcidUsage: AminoAcidComparison;
  geneContent: GeneContentComparison;
  structuralVariants?: StructuralVariantReport | null;
}

// HGT provenance analysis
export interface GenomicIsland {
  start: number;
  end: number;
  gc: number;
  zScore: number;
  genes: GeneInfo[];
  hallmarks: string[];
  donors: DonorCandidate[];
  amelioration: 'recent' | 'intermediate' | 'ancient' | 'unknown';
}

export interface DonorCandidate {
  taxon: string;
  similarity: number;
  confidence: 'low' | 'medium' | 'high';
  /** Evidence type: 'kmer' = exact Jaccard, 'minhash' = approximate MinHash Jaccard */
  evidence: 'kmer' | 'minhash';
}

export interface PassportStamp {
  island: GenomicIsland;
  donor: DonorCandidate | null;
  donorDistribution: DonorCandidate[];
  amelioration: GenomicIsland['amelioration'];
  transferMechanism: 'lysogeny' | 'transduction' | 'conjugation' | 'unknown';
  gcDelta: number;
  hallmarks: string[];
}

export interface HGTAnalysis {
  genomeGC: number;
  islands: GenomicIsland[];
  stamps: PassportStamp[];
}

// Structural variant detection
export type StructuralVariantType =
  | 'deletion'
  | 'insertion'
  | 'inversion'
  | 'duplication'
  | 'translocation';

export interface StructuralVariantCall {
  id: string;
  type: StructuralVariantType;
  startA: number;
  endA: number;
  startB: number;
  endB: number;
  sizeA: number;
  sizeB: number;
  confidence: number; // 0..1
  anchorA: { startIdx: number; endIdx: number };
  anchorB: { startIdx: number; endIdx: number };
  evidence: string[];
  affectedGenesA: string[];
  affectedGenesB: string[];
}

export interface StructuralVariantReport {
  calls: StructuralVariantCall[];
  counts: Record<StructuralVariantType, number>;
  anchorsUsed: number;
}

// Configuration for comparison
export interface ComparisonConfig {
  kmerSizes: number[];                // K values for k-mer analysis (default: [3, 5, 7, 11])
  maxEditDistanceLength: number;      // Max length for exact edit distance (default: 10000)
  editDistanceWindowSize: number;     // Window size for approximate (default: 1000)
  editDistanceWindowCount: number;    // Number of windows (default: 20)
  includeGeneComparison: boolean;     // Include gene-level comparison
  includeCodonUsage: boolean;         // Include codon usage analysis
  includeStructuralVariants?: boolean; // Include structural variant calls (default: true)
}

export const DEFAULT_COMPARISON_CONFIG: ComparisonConfig = {
  kmerSizes: [3, 5, 7, 11],
  maxEditDistanceLength: 10000,
  editDistanceWindowSize: 1000,
  editDistanceWindowCount: 20,
  includeGeneComparison: true,
  includeCodonUsage: true,
  includeStructuralVariants: true,
};
