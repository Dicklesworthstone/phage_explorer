/* tslint:disable */
/* eslint-disable */

export class BondDetectionResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the number of bonds
   */
  readonly bond_count: number;
  /**
   * Get bonds as flat array [a0, b0, a1, b1, ...]
   */
  readonly bonds: Uint32Array;
}

export class CodonUsageResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Get the codon counts as a JSON string.
   */
  readonly json: string;
}

/**
 * Error codes for dense k-mer counting.
 */
export enum DenseKmerError {
  /**
   * K value exceeds safe maximum (currently 10)
   */
  KTooLarge = 1,
  /**
   * K value is zero
   */
  KZero = 2,
  /**
   * Sequence is shorter than k
   */
  SequenceTooShort = 3,
}

export class DenseKmerResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  /**
   * Total number of valid k-mers counted (windows without N/ambiguous bases).
   */
  readonly total_valid: bigint;
  /**
   * Get the number of unique k-mers (non-zero counts).
   */
  readonly unique_count: number;
  /**
   * K value used for counting.
   */
  readonly k: number;
  /**
   * Get the k-mer counts as a Uint32Array.
   * Length is 4^k where each index represents a k-mer in base-4 encoding:
   * - A=0, C=1, G=2, T=3
   * - Index = sum(base[i] * 4^(k-1-i)) for i in 0..k
   *
   * Example for k=2: index 0=AA, 1=AC, 2=AG, 3=AT, 4=CA, ... 15=TT
   */
  readonly counts: Uint32Array;
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
 * Compute diff mask between two sequences.
 *
 * **STATUS: NOT WIRED IN** - Diff computation happens in JS.
 * Kept for future optimization if diff mode becomes a performance concern.
 * Diff is computed once per sequence change, not per frame, so JS is adequate.
 *
 * Compares a query sequence against a reference sequence and produces
 * a diff mask indicating the type of difference at each position:
 * - 0: Match
 * - 1: Mismatch (substitution)
 * - 2: Insertion (in query relative to ref - not computed here, placeholder)
 * - 3: Deletion (in query relative to ref - not computed here, placeholder)
 *
 * For simple pairwise comparison without alignment, only 0 and 1 are used.
 *
 * # Arguments
 * * `query` - Query sequence (the one being displayed)
 * * `reference` - Reference sequence to compare against
 *
 * # Returns
 * Uint8Array with diff codes (0 = match, 1 = mismatch)
 */
export function compute_diff_mask(query: string, reference: string): Uint8Array;

/**
 * Compute diff mask from pre-encoded sequences (faster than string version).
 *
 * **STATUS: NOT WIRED IN** - See `compute_diff_mask` above.
 * This is the faster variant that operates on pre-encoded sequences.
 *
 * # Arguments
 * * `query_encoded` - Pre-encoded query sequence (values 0-4)
 * * `ref_encoded` - Pre-encoded reference sequence (values 0-4)
 *
 * # Returns
 * Uint8Array with diff codes (0 = match, 1 = mismatch)
 */
export function compute_diff_mask_encoded(query_encoded: Uint8Array, ref_encoded: Uint8Array): Uint8Array;

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
 * Compute color runs for micro batch rendering.
 *
 * **STATUS: NOT WIRED IN** - JS `renderMicroBatch()` is used instead.
 * Kept for future optimization if profiling shows rendering is a bottleneck.
 * The JS version already uses the same single-pass algorithm and achieves 60fps.
 *
 * This performs single-pass run-length encoding on an encoded sequence,
 * producing runs grouped by color. The output is a flat Float32Array where
 * every 4 values represent: [color_code, row_y, x, width].
 *
 * Runs are sorted by color so the JS renderer only needs 5 fillStyle changes.
 *
 * # Arguments
 * * `encoded` - Pre-encoded sequence (values 0-4)
 * * `start_row` - First visible row index
 * * `end_row` - Last visible row index (exclusive)
 * * `cols` - Number of columns per row
 * * `cell_width` - Width of each cell in pixels
 * * `cell_height` - Height of each cell in pixels
 * * `offset_y` - Y offset for first visible row (sub-pixel scrolling)
 * * `start_row_offset` - startRow value from visible range (for row Y calculation)
 *
 * # Returns
 * Float32Array with runs: [color, y, x, width, color, y, x, width, ...]
 * First value is the total number of runs.
 */
export function compute_micro_runs(encoded: Uint8Array, start_row: number, end_row: number, cols: number, cell_width: number, cell_height: number, offset_y: number, start_row_offset: number): Float32Array;

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
 * Dense k-mer counting with typed array output.
 *
 * Uses a rolling 2-bit index algorithm with no per-position heap allocations.
 * Ambiguous bases (N and non-ACGT) reset the rolling state.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII). Accepts both upper and lower case.
 * * `k` - K-mer size. Must be 1 <= k <= 10 (4^10 = ~4MB max array).
 *
 * # Returns
 * `DenseKmerResult` with:
 * - `counts`: Uint32Array of length 4^k (dense count vector)
 * - `total_valid`: Total valid k-mers counted
 * - `k`: K value used
 * - `unique_count`: Number of unique k-mers observed
 *
 * Returns an empty result with all-zero counts if k is invalid.
 *
 * # Ownership
 * Caller must call `.free()` when done to release WASM memory.
 *
 * # Ambiguous Bases
 * Windows containing non-ACGT bases are skipped. The rolling state resets
 * on any ambiguous base, so no k-mer spans an N.
 *
 * # Example (from JS)
 * ```js
 * const result = wasm.count_kmers_dense(sequenceBytes, 6);
 * try {
 *   const counts = result.counts; // Uint32Array[4096]
 *   const total = result.total_valid;
 *   // Use counts...
 * } finally {
 *   result.free(); // Required!
 * }
 * ```
 *
 * # Determinism
 * Output is fully deterministic. No random number generation.
 *
 * @see phage_explorer-vk7b.1.1
 * @see docs/WASM_ABI_SPEC.md
 */
export function count_kmers_dense(seq: Uint8Array, k: number): DenseKmerResult;

/**
 * Dense k-mer counting with reverse complement combined.
 *
 * Counts both forward and reverse complement k-mers into the same array.
 * Uses canonical k-mers (min of forward and RC) for strand-independent analysis.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII)
 * * `k` - K-mer size (1 <= k <= 10)
 *
 * # Returns
 * `DenseKmerResult` with combined forward + RC counts.
 *
 * # Note
 * For odd k values, forward and RC k-mers are always different.
 * For even k values, some palindromic k-mers are their own RC.
 */
export function count_kmers_dense_canonical(seq: Uint8Array, k: number): DenseKmerResult;

/**
 * Detect bonds using spatial hashing for O(N) complexity.
 *
 * This is the CRITICAL optimization replacing the O(N²) algorithm.
 * For a 50,000 atom structure:
 * - Old: 1.25 billion comparisons → 30-60+ seconds
 * - New: ~1 million comparisons → <1 second
 *
 * # Arguments
 * * `positions` - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
 * * `elements` - String of element symbols (one char per atom: "CCCCNNO...")
 *
 * # Returns
 * BondDetectionResult with pairs of bonded atom indices.
 *
 * # Algorithm
 * 1. Build spatial hash with cell size = max bond distance (~2.7Å)
 * 2. For each atom, only check atoms in neighboring 27 cells
 * 3. Reduces O(N²) to O(N * k) where k ≈ 20 atoms per neighborhood
 */
export function detect_bonds_spatial(positions: Float32Array, elements: string): BondDetectionResult;

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
 * Fast sequence encoding for canvas rendering.
 *
 * **STATUS: NOT WIRED IN** - JS `encodeSequence()` is used instead.
 * Kept for future optimization if profiling shows encoding is a bottleneck.
 *
 * Encodes nucleotide characters to numeric codes:
 * - A/a -> 0, C/c -> 1, G/g -> 2, T/t/U/u -> 3, other -> 4 (N)
 *
 * This would be used by CanvasSequenceGridRenderer for O(1) lookups during rendering.
 * WASM version is ~4x faster than JS for large sequences due to tighter loops,
 * but encoding only happens once per sequence change (not per frame).
 *
 * # Arguments
 * * `seq` - DNA/RNA sequence string
 *
 * # Returns
 * Uint8Array with encoded values (0-4)
 */
export function encode_sequence_fast(seq: string): Uint8Array;

/**
 * Get the maximum allowed k for dense k-mer counting.
 */
export function get_dense_kmer_max_k(): number;

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
 * Check if a k value is valid for dense k-mer counting.
 *
 * Returns true if 1 <= k <= DENSE_KMER_MAX_K (10).
 */
export function is_valid_dense_kmer_k(k: number): boolean;

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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_bonddetectionresult_free: (a: number, b: number) => void;
  readonly __wbg_codonusageresult_free: (a: number, b: number) => void;
  readonly __wbg_densekmerresult_free: (a: number, b: number) => void;
  readonly __wbg_get_hoeffdingresult_d: (a: number) => number;
  readonly __wbg_get_hoeffdingresult_n: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_bray_curtis_dissimilarity: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_containment_a_in_b: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_containment_b_in_a: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_cosine_similarity: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_k: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_shared_kmers: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_unique_kmers_a: (a: number) => number;
  readonly __wbg_get_kmeranalysisresult_unique_kmers_b: (a: number) => number;
  readonly __wbg_gridresult_free: (a: number, b: number) => void;
  readonly __wbg_hoeffdingresult_free: (a: number, b: number) => void;
  readonly __wbg_kmeranalysisresult_free: (a: number, b: number) => void;
  readonly __wbg_pcaresult_free: (a: number, b: number) => void;
  readonly __wbg_repeatresult_free: (a: number, b: number) => void;
  readonly __wbg_set_hoeffdingresult_d: (a: number, b: number) => void;
  readonly __wbg_set_hoeffdingresult_n: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_bray_curtis_dissimilarity: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_containment_a_in_b: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_containment_b_in_a: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_cosine_similarity: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_k: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_shared_kmers: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_unique_kmers_a: (a: number, b: number) => void;
  readonly __wbg_set_kmeranalysisresult_unique_kmers_b: (a: number, b: number) => void;
  readonly analyze_kmers: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly bonddetectionresult_bond_count: (a: number) => number;
  readonly bonddetectionresult_bonds: (a: number) => [number, number];
  readonly build_grid: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly calculate_gc_content: (a: number, b: number) => number;
  readonly codonusageresult_json: (a: number) => [number, number];
  readonly compute_cumulative_gc_skew: (a: number, b: number) => [number, number];
  readonly compute_diff_mask: (a: number, b: number, c: number, d: number) => [number, number];
  readonly compute_diff_mask_encoded: (a: number, b: number, c: number, d: number) => [number, number];
  readonly compute_gc_skew: (a: number, b: number, c: number, d: number) => [number, number];
  readonly compute_linguistic_complexity: (a: number, b: number, c: number) => number;
  readonly compute_micro_runs: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
  readonly compute_windowed_complexity: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly count_codon_usage: (a: number, b: number, c: number) => number;
  readonly count_kmers_dense: (a: number, b: number, c: number) => number;
  readonly count_kmers_dense_canonical: (a: number, b: number, c: number) => number;
  readonly densekmerresult_counts: (a: number) => any;
  readonly densekmerresult_k: (a: number) => number;
  readonly densekmerresult_total_valid: (a: number) => bigint;
  readonly densekmerresult_unique_count: (a: number) => number;
  readonly detect_bonds_spatial: (a: number, b: number, c: number, d: number) => number;
  readonly detect_palindromes: (a: number, b: number, c: number, d: number) => number;
  readonly detect_tandem_repeats: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly encode_sequence_fast: (a: number, b: number) => [number, number];
  readonly get_dense_kmer_max_k: () => number;
  readonly gridresult_json: (a: number) => [number, number];
  readonly hoeffdings_d: (a: number, b: number, c: number, d: number) => number;
  readonly is_valid_dense_kmer_k: (a: number) => number;
  readonly jensen_shannon_divergence: (a: number, b: number, c: number, d: number) => number;
  readonly jensen_shannon_divergence_from_counts: (a: number, b: number, c: number, d: number) => number;
  readonly kmer_hoeffdings_d: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly levenshtein_distance: (a: number, b: number, c: number, d: number) => number;
  readonly min_hash_jaccard: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly pca_power_iteration: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
  readonly pcaresult_eigenvalues: (a: number) => [number, number];
  readonly pcaresult_eigenvectors: (a: number) => [number, number];
  readonly pcaresult_n_features: (a: number) => number;
  readonly repeatresult_json: (a: number) => [number, number];
  readonly reverse_complement: (a: number, b: number) => [number, number];
  readonly shannon_entropy: (a: number, b: number) => number;
  readonly shannon_entropy_from_counts: (a: number, b: number) => number;
  readonly translate_sequence: (a: number, b: number, c: number) => [number, number];
  readonly init_panic_hook: () => void;
  readonly __wbg_set_kmeranalysisresult_jaccard_index: (a: number, b: number) => void;
  readonly __wbg_get_kmeranalysisresult_jaccard_index: (a: number) => number;
  readonly pcaresult_n_components: (a: number) => number;
  readonly __wbg_get_vector3_x: (a: number) => number;
  readonly __wbg_get_vector3_y: (a: number) => number;
  readonly __wbg_get_vector3_z: (a: number) => number;
  readonly __wbg_model3d_free: (a: number, b: number) => void;
  readonly __wbg_set_vector3_x: (a: number, b: number) => void;
  readonly __wbg_set_vector3_y: (a: number, b: number) => void;
  readonly __wbg_set_vector3_z: (a: number, b: number) => void;
  readonly __wbg_vector3_free: (a: number, b: number) => void;
  readonly model3d_new: (a: number, b: number, c: number, d: number) => number;
  readonly render_ascii_model: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
