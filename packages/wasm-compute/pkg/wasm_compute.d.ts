/* tslint:disable */
/* eslint-disable */

export class CodonUsageResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the codon counts as a JSON string.
   */
  readonly json: string;
}

export class GridResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly json: string;
}

export class HoeffdingResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Hoeffding's D statistic. Range: approximately [-0.5, 1]
   * Values near 0 indicate independence, larger values indicate dependence.
   * Unlike correlation, captures non-linear relationships.
   */
  d: number;
  /**
   * Number of observations used
   */
  n: number;
}

export class KmerAnalysisResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  k: number;
  unique_kmers_a: number;
  unique_kmers_b: number;
  shared_kmers: number;
  jaccard_index: number;
  containment_a_in_b: number;
  containment_b_in_a: number;
  cosine_similarity: number;
  bray_curtis_dissimilarity: number;
}

export class Model3D {
  free(): void;
  [Symbol.dispose](): void;
  constructor(vertices: Float64Array, edges: Uint32Array);
}

export class PCAResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Number of features
   */
  readonly n_features: number;
  /**
   * Get eigenvalues
   */
  readonly eigenvalues: Float64Array;
  /**
   * Get eigenvectors as flat array (row-major: [pc1_feat1, pc1_feat2, ..., pc2_feat1, ...])
   */
  readonly eigenvectors: Float64Array;
  /**
   * Number of components
   */
  readonly n_components: number;
}

export class RepeatResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly json: string;
}

export class Vector3 {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  x: number;
  y: number;
  z: number;
}

export function analyze_kmers(sequence_a: string, sequence_b: string, k: number): KmerAnalysisResult;

/**
 * Build a grid of sequence data for viewport rendering.
 *
 * This is the HOT PATH called on every scroll. Optimized for minimal
 * allocations and fast character processing.
 *
 * # Arguments
 * * `seq` - Full sequence string
 * * `start_index` - Starting position in sequence (0-based)
 * * `cols` - Number of columns in grid
 * * `rows` - Number of rows in grid
 * * `mode` - Display mode: "dna", "aa", or "dual"
 * * `frame` - Reading frame for AA translation (0, 1, or 2)
 *
 * # Returns
 * GridResult with JSON-encoded rows, each containing:
 * - cells: array of {char, phase, is_stop, is_start} for DNA mode
 * - cells: array of {char, codon, is_stop, is_start} for AA mode
 */
export function build_grid(seq: string, start_index: number, cols: number, rows: number, mode: string, frame: number): GridResult;

/**
 * Calculate GC content percentage.
 *
 * Only counts unambiguous A, T, G, C bases. N and other ambiguity codes
 * are excluded from both numerator and denominator.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 *
 * # Returns
 * GC content as percentage (0-100). Returns 0 if no valid bases.
 */
export function calculate_gc_content(seq: string): number;

/**
 * Compute cumulative GC skew (useful for visualizing replication origin).
 *
 * The cumulative skew will have a minimum at the origin of replication
 * and maximum at the terminus.
 */
export function compute_cumulative_gc_skew(seq: string): Float64Array;

/**
 * Compute GC skew using a sliding window.
 *
 * GC skew = (G - C) / (G + C)
 *
 * GC skew is used to identify the origin and terminus of replication in
 * bacterial genomes. Positive skew indicates leading strand, negative
 * indicates lagging strand.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `window_size` - Size of sliding window
 * * `step_size` - Step between windows (1 for maximum resolution)
 *
 * # Returns
 * Array of GC skew values for each window position.
 */
export function compute_gc_skew(seq: string, window_size: number, step_size: number): Float64Array;

/**
 * Compute linguistic complexity of a sequence.
 *
 * Linguistic complexity = (number of distinct substrings) / (maximum possible substrings)
 *
 * This measures how "random" or information-rich a sequence is.
 * Low complexity indicates repetitive regions.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `max_k` - Maximum substring length to consider
 *
 * # Returns
 * Complexity score in range [0, 1] where 1 = maximum complexity.
 */
export function compute_linguistic_complexity(seq: string, max_k: number): number;

/**
 * Compute local complexity in sliding windows.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `window_size` - Size of sliding window
 * * `step_size` - Step between windows
 * * `k` - K-mer size for complexity calculation
 *
 * # Returns
 * Array of complexity values for each window.
 */
export function compute_windowed_complexity(seq: string, window_size: number, step_size: number, k: number): Float64Array;

/**
 * Count codon usage in a DNA sequence.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `frame` - Reading frame (0, 1, or 2)
 *
 * # Returns
 * CodonUsageResult with JSON-encoded codon counts.
 */
export function count_codon_usage(seq: string, frame: number): CodonUsageResult;

/**
 * Detect palindromic (inverted repeat) sequences in DNA.
 *
 * A palindrome in DNA is a sequence that reads the same on the complementary
 * strand in reverse (e.g., GAATTC and its complement CTTAAG reversed).
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `min_len` - Minimum palindrome arm length (typically 4-6)
 * * `max_gap` - Maximum gap/spacer between palindrome arms (0 for perfect palindromes)
 *
 * # Returns
 * RepeatResult with JSON array of {start, end, arm_length, gap, sequence}
 */
export function detect_palindromes(seq: string, min_len: number, max_gap: number): RepeatResult;

/**
 * Detect tandem repeats (consecutive copies of a pattern).
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `min_unit` - Minimum repeat unit length
 * * `max_unit` - Maximum repeat unit length
 * * `min_copies` - Minimum number of consecutive copies
 *
 * # Returns
 * RepeatResult with JSON array of {start, end, unit, copies, sequence}
 */
export function detect_tandem_repeats(seq: string, min_unit: number, max_unit: number, min_copies: number): RepeatResult;

/**
 * Compute Hoeffding's D statistic for measuring statistical dependence.
 *
 * Hoeffding's D is a non-parametric measure of association that can detect
 * any type of dependence (linear or non-linear) between two variables.
 * Unlike Pearson correlation (linear only) or Spearman/Kendall (monotonic),
 * Hoeffding's D can detect complex non-monotonic relationships.
 *
 * # Arguments
 * * `x` - First vector of observations (as a JS Float64Array)
 * * `y` - Second vector of observations (must have same length as x)
 *
 * # Returns
 * HoeffdingResult containing the D statistic and sample size.
 * D ranges approximately from -0.5 to 1, where:
 * - D ≈ 0: variables are independent
 * - D > 0: variables are dependent
 * - D = 1: perfect dependence
 *
 * # Performance
 * O(n²) time complexity. For very large vectors (n > 10000), consider
 * sampling or using approximate methods.
 *
 * # Example Use Cases for Genome Analysis
 * - Compare k-mer frequency vectors between genomes
 * - Detect non-linear relationships in GC content distributions
 * - Measure codon usage similarity accounting for complex dependencies
 */
export function hoeffdings_d(x: Float64Array, y: Float64Array): HoeffdingResult;

export function init_panic_hook(): void;

/**
 * Compute Jensen-Shannon Divergence between two probability distributions.
 *
 * JSD(P || Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M)
 * where M = 0.5 * (P + Q)
 *
 * This is a symmetric and bounded (0 to 1 when using log2) divergence measure.
 *
 * # Arguments
 * * `p` - First probability distribution
 * * `q` - Second probability distribution (must have same length as p)
 *
 * # Returns
 * JSD value in range [0, 1]. Returns 0 if inputs are identical, 1 if completely different.
 */
export function jensen_shannon_divergence(p: Float64Array, q: Float64Array): number;

/**
 * Compute JSD between two count arrays.
 * Normalizes to probabilities internally.
 */
export function jensen_shannon_divergence_from_counts(counts_a: Float64Array, counts_b: Float64Array): number;

/**
 * Compute Hoeffding's D between two k-mer frequency vectors derived from sequences.
 *
 * This is a convenience function that:
 * 1. Extracts k-mer frequencies from both sequences
 * 2. Creates aligned frequency vectors for all unique k-mers
 * 3. Computes Hoeffding's D on the frequency vectors
 *
 * # Arguments
 * * `sequence_a` - First DNA sequence
 * * `sequence_b` - Second DNA sequence
 * * `k` - K-mer size (typically 3-7 for genome comparison)
 *
 * # Returns
 * Hoeffding's D statistic measuring dependence between k-mer frequency profiles.
 * Higher values indicate more similar frequency patterns (non-linear similarity).
 */
export function kmer_hoeffdings_d(sequence_a: string, sequence_b: string, k: number): HoeffdingResult;

export function levenshtein_distance(s1: string, s2: string): number;

export function min_hash_jaccard(sequence_a: string, sequence_b: string, k: number, num_hashes: number): number;

/**
 * Compute PCA using power iteration method.
 *
 * # Arguments
 * * `data` - Flattened row-major matrix (n_samples * n_features)
 * * `n_samples` - Number of samples (rows)
 * * `n_features` - Number of features (columns)
 * * `n_components` - Number of principal components to extract
 * * `max_iterations` - Maximum iterations for power iteration (default: 100)
 * * `tolerance` - Convergence tolerance (default: 1e-8)
 *
 * # Returns
 * PCAResult containing eigenvectors and eigenvalues.
 *
 * # Algorithm
 * Uses power iteration to find top eigenvectors of X^T * X without forming
 * the full covariance matrix. This is memory-efficient for high-dimensional
 * data (e.g., k-mer frequencies with 4^k features).
 */
export function pca_power_iteration(data: Float64Array, n_samples: number, n_features: number, n_components: number, max_iterations: number, tolerance: number): PCAResult;

/**
 * Renders a 3D model to an ASCII string.
 *
 * # Arguments
 * * `model` - The 3D model to render (vertices and edges).
 * * `rx` - Rotation around X axis (radians).
 * * `ry` - Rotation around Y axis (radians).
 * * `rz` - Rotation around Z axis (radians).
 * * `width` - Target width of the ASCII canvas in characters.
 * * `height` - Target height of the ASCII canvas in characters.
 * * `quality` - Rendering quality/style ("low", "medium", "high", "ultra", "blocks").
 */
export function render_ascii_model(model: Model3D, rx: number, ry: number, rz: number, width: number, height: number, quality: string): string;

/**
 * Compute reverse complement of DNA sequence.
 *
 * Handles all IUPAC ambiguity codes correctly:
 * - Standard: A<->T, G<->C
 * - Ambiguity: R<->Y, K<->M, S<->S, W<->W, B<->V, D<->H, N<->N
 *
 * # Arguments
 * * `seq` - DNA sequence string
 *
 * # Returns
 * Reverse complement sequence (preserving case).
 */
export function reverse_complement(seq: string): string;

/**
 * Compute Shannon entropy from a probability distribution.
 *
 * H(X) = -Σ p(x) * log2(p(x))
 *
 * # Arguments
 * * `probs` - Probability distribution (must sum to ~1.0)
 *
 * # Returns
 * Shannon entropy in bits. Returns 0 for empty or invalid input.
 */
export function shannon_entropy(probs: Float64Array): number;

/**
 * Compute Shannon entropy from a frequency count array.
 * Converts counts to probabilities internally.
 *
 * # Arguments
 * * `counts` - Array of frequency counts
 *
 * # Returns
 * Shannon entropy in bits.
 */
export function shannon_entropy_from_counts(counts: Float64Array): number;

/**
 * Translate DNA sequence to amino acid sequence.
 *
 * # Arguments
 * * `seq` - DNA sequence string
 * * `frame` - Reading frame (0, 1, or 2)
 *
 * # Returns
 * Amino acid sequence as a string. Unknown codons (containing N) become 'X'.
 */
export function translate_sequence(seq: string, frame: number): string;
