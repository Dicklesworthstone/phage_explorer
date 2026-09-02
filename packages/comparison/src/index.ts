/**
 * @phage-explorer/comparison
 *
 * Comprehensive genome comparison module for phage sequences.
 * Implements multiple statistical and bioinformatics approaches:
 *
 * - K-mer Analysis: Jaccard, cosine similarity, containment, Bray-Curtis
 * - Information Theory: Entropy, mutual information, KL/JS divergence
 * - Rank Correlation: Spearman's rho, Kendall's tau, Hoeffding's D
 * - Edit Distance: Levenshtein with windowed approximation for long sequences
 * - Biological Metrics: ANI, GC content, codon usage (RSCU), amino acid composition
 * - Gene Content: Shared/unique genes, gene density comparison
 */

// Types
export * from './types';

// K-mer analysis
export {
  extractKmerSet,
  extractKmerFrequencies,
  jaccardIndex,
  containmentIndex,
  cosineSimilarity,
  brayCurtisDissimilarity,
  analyzeKmers,
  multiResolutionKmerAnalysis,
  extractCanonicalKmerSet,
  minHashJaccard,
} from './kmer-analysis';

// Information theory
export {
  shannonEntropy,
  getNucleotideFrequencies,
  getDinucleotideFrequencies,
  sequenceEntropy,
  kullbackLeiblerDivergence,
  jensenShannonDivergence,
  mutualInformation,
  normalizedMutualInformation,
  relativeEntropy,
  analyzeInformationTheory,
  entropyProfile,
  crossEntropy,
  normalizedCompressionDistance,
} from './information-theory';

// Rank correlation
export {
  computeRanks,
  spearmanRho,
  pearsonCorrelation,
  kendallTau,
  hoeffdingD,
  spearmanPValue,
  kendallPValue,
  interpretCorrelation,
  analyzeRankCorrelation,
  compareFrequencyDistributions,
} from './rank-correlation';

// Edit distance
export {
  levenshteinDistance,
  approximateLevenshtein,
  levenshteinWithOperations,
  normalizedLevenshtein,
  levenshteinSimilarity,
  hammingDistance,
  percentIdentity,
  longestCommonSubsequence,
  lcsSimilarity,
  analyzeEditDistance,
  quickSimilarityEstimate,
} from './edit-distance';

export * from './biological-metrics';
export * from './synteny';
export { analyzeStructuralVariants } from './structural-variants';

// Main comparison engine
export {
  compareGenomes,
  quickCompare,
  formatSimilarity,
  getSimilarityColor,
  createSimilarityBar,
} from './comparison-engine';

// HGT provenance tracer
export {
  analyzeHGTProvenance,
  initMinHashWasm,
  isMinHashWasmAvailable,
  computeSignature,
  MINHASH_DEFAULT_K,
  MINHASH_DEFAULT_HASHES,
  type HGTOptions,
} from './hgt-tracer';
export {
  SketchCache,
  buildSketch,
  kmerSet,
  kmerCodes,
  exactJaccard,
  exactContainment,
  estimateJaccard,
  estimateContainment,
  estimateCardinality,
  containmentOf,
  containmentUncertainty,
  type GenomeSketch,
  type ContainmentResult,
  type ContainmentMethod,
} from './sketch-cache';
export {
  buildReferencePanel,
  referenceLabel,
  DEFAULT_MAX_BASES_PER_REFERENCE,
  DEFAULT_MAX_REFERENCES,
  type ReferencePanelSource,
  type ReferencePanelPhage,
  type ReferencePanelOptions,
} from './reference-panel';

// MinHash signature cache
export {
  MinHashCache,
  getMinHashCache,
  initMinHashCache,
  clearMinHashCache,
  makeCacheKeyFromId,
  type CacheConfig,
  type CacheStats,
} from './minhash-cache';

// Tail fiber tropism / receptor atlas
export {
  analyzeTailFiberTropism,
  type TropismAnalysis,
  type ReceptorCandidate,
  type TailFiberHit,
  type TropismPredictionInput,
} from './tropism';
