/* tslint:disable */
/* eslint-disable */

/**
 * Result of bond detection
 */
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

export class CgrCountsResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly counts: Uint32Array;
    readonly entropy: number;
    readonly k: number;
    readonly max_count: number;
    readonly resolution: number;
    readonly total_points: number;
}

/**
 * Result of codon usage analysis.
 */
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

/**
 * Result of dense k-mer counting.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class DenseKmerResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the k-mer counts as a Uint32Array.
     * Length is 4^k where each index represents a k-mer in base-4 encoding:
     * - A=0, C=1, G=2, T=3
     * - Index = sum(base[i] * 4^(k-1-i)) for i in 0..k
     *
     * Example for k=2: index 0=AA, 1=AC, 2=AG, 3=AT, 4=CA, ... 15=TT
     */
    readonly counts: Uint32Array;
    /**
     * K value used for counting.
     */
    readonly k: number;
    /**
     * Total number of valid k-mers counted (windows without N/ambiguous bases).
     */
    readonly total_valid: bigint;
    /**
     * Get the number of unique k-mers (non-zero counts).
     */
    readonly unique_count: number;
}

/**
 * Result buffers for dotplot computation.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class DotPlotBuffers {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly bins: number;
    /**
     * Flattened direct identity values (row-major, bins*bins).
     */
    readonly direct: Float32Array;
    /**
     * Flattened inverted identity values (row-major, bins*bins).
     */
    readonly inverted: Float32Array;
    readonly window: number;
}

/**
 * Result of functional group detection.
 * Contains flat arrays of atom indices for each functional group type.
 */
export class FunctionalGroupResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Number of aromatic rings.
     */
    readonly aromatic_count: number;
    /**
     * Get aromatic ring atom indices as flat array.
     */
    readonly aromatic_indices: Uint32Array;
    /**
     * Number of disulfide bonds.
     */
    readonly disulfide_count: number;
    /**
     * Get disulfide bond pairs as flat array [s1, s2, s1, s2, ...].
     */
    readonly disulfide_pairs: Uint32Array;
    /**
     * Number of phosphate groups.
     */
    readonly phosphate_count: number;
    /**
     * Get phosphate group data.
     */
    readonly phosphate_data: Uint32Array;
    /**
     * Get sizes of each aromatic ring.
     */
    readonly ring_sizes: Uint32Array;
}

/**
 * Result of grid building for sequence viewport
 */
export class GridResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly json: string;
}

/**
 * Result of Hoeffding's D computation
 */
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

/**
 * Result of KL divergence window scan.
 */
export class KLScanResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the k-mer size used
     */
    readonly k: number;
    /**
     * Get the KL divergence values as Float32Array
     */
    readonly kl_values: Float32Array;
    /**
     * Get the window start positions as Uint32Array
     */
    readonly positions: Uint32Array;
    /**
     * Get the number of windows
     */
    readonly window_count: number;
}

export class KmerAnalysisResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    bray_curtis_dissimilarity: number;
    containment_a_in_b: number;
    containment_b_in_a: number;
    cosine_similarity: number;
    jaccard_index: number;
    k: number;
    shared_kmers: number;
    unique_kmers_a: number;
    unique_kmers_b: number;
}

/**
 * Result of MinHash signature computation.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class MinHashSignature {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * K value used for hashing.
     */
    readonly k: number;
    /**
     * Number of hash functions (signature length).
     */
    readonly num_hashes: number;
    /**
     * Get the signature as a Uint32Array.
     * Length equals num_hashes parameter.
     * Each element is the minimum hash value for that seed.
     */
    readonly signature: Uint32Array;
    /**
     * Total number of valid k-mers hashed.
     */
    readonly total_kmers: bigint;
}

export class Model3D {
    free(): void;
    [Symbol.dispose](): void;
    constructor(vertices: Float64Array, edges: Uint32Array);
}

/**
 * Result of Myers diff computation.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class MyersDiffResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Number of deletions.
     */
    readonly deletions: number;
    /**
     * Edit distance (total number of edits).
     */
    readonly edit_distance: number;
    /**
     * Error message if any.
     */
    readonly error: string | undefined;
    /**
     * Sequence identity as fraction (0.0 - 1.0).
     */
    readonly identity: number;
    /**
     * Number of insertions.
     */
    readonly insertions: number;
    /**
     * Length of sequence A.
     */
    readonly len_a: number;
    /**
     * Length of sequence B.
     */
    readonly len_b: number;
    /**
     * Get mask for sequence A as Uint8Array.
     * Values: 0=MATCH, 1=MISMATCH, 3=DELETE
     */
    readonly mask_a: Uint8Array;
    /**
     * Get mask for sequence B as Uint8Array.
     * Values: 0=MATCH, 1=MISMATCH, 2=INSERT
     */
    readonly mask_b: Uint8Array;
    /**
     * Number of matching positions.
     */
    readonly matches: number;
    /**
     * Number of mismatches (substitutions).
     */
    readonly mismatches: number;
    /**
     * Whether the computation was truncated.
     */
    readonly truncated: boolean;
}

/**
 * Result of PCA computation
 */
export class PCAResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
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
    /**
     * Number of features
     */
    readonly n_features: number;
}

/**
 * PCA result buffers in f32.
 *
 * # Ownership
 * The caller must call `.free()` to release WASM memory.
 */
export class PCAResultF32 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Eigenvalues (sample-covariance scale, i.e. divided by (n_samples - 1) when n_samples > 1).
     */
    readonly eigenvalues: Float32Array;
    /**
     * Eigenvectors as flat array (row-major: [pc1_feat1, pc1_feat2, ..., pc2_feat1, ...]).
     */
    readonly eigenvectors: Float32Array;
    /**
     * Mean vector used for centering.
     */
    readonly mean: Float32Array;
    readonly n_components: number;
    readonly n_features: number;
    /**
     * Total variance of centered data (sample-covariance scale).
     */
    readonly total_variance: number;
}

/**
 * Result of PDB parsing containing atom data.
 *
 * Returns flat arrays suitable for direct use with detect_bonds_spatial.
 * This parser is intentionally minimal (no external crates) to keep WASM size small.
 */
export class PDBParseResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly atom_count: number;
    readonly atom_names: string;
    readonly chain_ids: string;
    readonly elements: string;
    readonly error: string;
    readonly positions: Float32Array;
    readonly res_names: string;
    readonly res_seqs: Int32Array;
}

/**
 * Result of repeat detection
 */
export class RepeatResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly json: string;
}

/**
 * A handle to a sequence stored in WASM memory.
 *
 * This struct stores an encoded DNA sequence once and exposes fast methods
 * for various analyses without re-copying the sequence each call.
 *
 * # Usage
 *
 * ```js
 * const handle = SequenceHandle.new(sequenceBytes);
 * try {
 *   const gcSkew = handle.gc_skew(100, 10);
 *   const kmerCounts = handle.count_kmers(4);
 *   // ... use results
 * } finally {
 *   handle.free(); // MUST call to release WASM memory
 * }
 * ```
 *
 * # Memory Management
 *
 * The caller MUST call `.free()` when done to release WASM memory.
 * Failing to do so will leak memory.
 *
 * @see phage_explorer-8qk2.5
 */
export class SequenceHandle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Count k-mers using dense array (for k <= 10).
     *
     * Returns a DenseKmerResult with counts for all 4^k possible k-mers.
     * K-mers containing N are skipped.
     *
     * # Arguments
     * * `k` - K-mer size (1-10)
     *
     * # Returns
     * DenseKmerResult with counts, or empty result if k is invalid.
     */
    count_kmers(k: number): DenseKmerResult;
    /**
     * Compute cumulative GC skew.
     *
     * Running sum of (G - C) / (G + C) contribution per base.
     * The cumulative skew typically shows the origin (minimum) and terminus (maximum)
     * of replication for circular genomes.
     *
     * # Returns
     * Float64Array with cumulative skew at each position.
     */
    cumulative_gc_skew(): Float64Array;
    /**
     * Compute self-similarity dot plot using pre-encoded sequence.
     *
     * This is more efficient than `dotplot_self_buffers` when running multiple
     * analyses on the same sequence (e.g., progressive refinement with preview
     * then full resolution).
     *
     * # Arguments
     * * `bins` - Number of bins for the grid (bins × bins output)
     * * `window` - Window size in bases. If 0, derives a conservative default.
     *
     * # Returns
     * DotPlotBuffers containing direct and inverted similarity matrices.
     *
     * @see phage_explorer-8qk2.6
     */
    dotplot_self(bins: number, window: number): DotPlotBuffers;
    /**
     * Compute GC skew values for sliding windows.
     *
     * GC skew = (G - C) / (G + C) for each window.
     * Returns an empty array if window_size or step_size is 0, or if
     * the sequence is shorter than window_size.
     *
     * # Arguments
     * * `window_size` - Size of the sliding window
     * * `step_size` - Step between windows
     *
     * # Returns
     * Float64Array of GC skew values, one per window position.
     */
    gc_skew(window_size: number, step_size: number): Float64Array;
    /**
     * Compute MinHash signature for similarity estimation.
     *
     * Uses canonical k-mers (lexicographically smaller of forward/reverse complement)
     * for strand-independent comparison.
     *
     * # Arguments
     * * `num_hashes` - Number of hash functions (signature size)
     * * `k` - K-mer size
     *
     * # Returns
     * MinHashSignature containing the signature.
     */
    minhash(num_hashes: number, k: number): MinHashSignature;
    /**
     * Create a new SequenceHandle from raw sequence bytes.
     *
     * The sequence is encoded into a compact representation stored in WASM memory.
     * Case-insensitive: a/A, c/C, g/G, t/T are all valid.
     * U is treated as T. Ambiguous/invalid bases are stored as N (code 4).
     *
     * # Arguments
     * * `seq_bytes` - ASCII bytes of the DNA/RNA sequence
     *
     * # Returns
     * A new SequenceHandle that must be freed with `.free()` when done.
     */
    constructor(seq_bytes: Uint8Array);
    /**
     * Get the encoded sequence as a Uint8Array.
     *
     * Values: A=0, C=1, G=2, T=3, N=4
     *
     * This is useful for passing to other WASM functions or for debugging.
     */
    readonly encoded_bytes: Uint8Array;
    /**
     * Get the original sequence length.
     */
    readonly length: number;
    /**
     * Get the count of valid (non-N) bases.
     */
    readonly valid_count: number;
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
 * Compute Chaos Game Representation (CGR) counts for a sequence.
 *
 * Semantics match `packages/core/src/analysis/cgr.ts`:
 * - Non-ACGT characters are skipped (no state update).
 * - "Transient removal" uses the raw index: we only start plotting after `i >= k-1`,
 *   where `i` is the index in the *original* input (including skipped chars).
 *
 * # Inputs
 * - `seq_bytes`: ASCII DNA/RNA bytes OR already-encoded ACGT05 (0..=4).
 * - `k`: CGR depth (resolution = 2^k). k=0 yields a 1x1 grid.
 *
 * # Outputs
 * - Dense grid counts as `Uint32Array` (row-major, length = resolution*resolution)
 * - Metadata: resolution, max_count, total_points, entropy (Shannon, base2)
 */
export function cgr_counts(seq_bytes: Uint8Array, k: number): CgrCountsResult;

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
 * Compute normalized Shannon entropy (0..=1) in sliding windows over A/C/G/T bases.
 *
 * Semantics match `packages/web/src/workers/analysis.worker.ts`:
 * - Non-ACGT bases are ignored (do not contribute to counts/total).
 * - Windows are taken at starts `i = 0, step, 2*step, ...` while `i < n - window_size`
 *   (note: this intentionally excludes the final full window at `i = n - window_size`).
 * - Output values are Shannon entropy in bits divided by 2 (max for 4 symbols).
 *
 * # Arguments
 * * `seq` - DNA sequence string (case-insensitive; U treated as T).
 * * `window_size` - Size of each window.
 * * `step_size` - Step between windows.
 *
 * # Returns
 * Array of normalized entropy values (0..=1), one per window.
 */
export function compute_windowed_entropy_acgt(seq: string, window_size: number, step_size: number): Float64Array;

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
 * Detect functional groups (aromatic rings, disulfides, phosphates) using WASM.
 *
 * This replaces the O(N²) JavaScript implementation with an optimized Rust version.
 * The adjacency list is built once and reused for all detection algorithms.
 *
 * # Arguments
 * * `positions` - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
 * * `elements` - String of element symbols (one char per atom: "CCCCNNO...")
 * * `bonds` - Flat array of bond pairs [a0, b0, a1, b1, ...] from detect_bonds_spatial
 *
 * # Returns
 * FunctionalGroupResult with typed arrays for each group type.
 */
export function detect_functional_groups(positions: Float32Array, elements: string, bonds: Uint32Array): FunctionalGroupResult;

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
 * Compute dotplot identity buffers for a sequence against itself.
 *
 * Matches the semantics of `packages/core/src/analysis/dot-plot.ts` but avoids substring
 * allocations and object-heavy grids by returning flat typed arrays.
 *
 * # Arguments
 * * `seq` - Sequence bytes (ASCII). Case-insensitive, U treated as T.
 * * `bins` - Plot resolution (bins x bins). If 0, returns empty buffers.
 * * `window` - Window size in bases. If 0, derives a conservative default similar to JS.
 *
 * # Output layout
 * Row-major, with index `i*bins + j`.
 */
export function dotplot_self_buffers(seq: Uint8Array, bins: number, window: number): DotPlotBuffers;

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
 * Fast equal-length diff for sequences with only substitutions.
 *
 * This is O(n) and much faster than Myers when we know there are no indels.
 * Use this when sequences are already aligned or have equal length.
 *
 * # Arguments
 * * `seq_a` - First sequence (bytes)
 * * `seq_b` - Second sequence (bytes)
 *
 * # Returns
 * MyersDiffResult with mask codes 0=MATCH, 1=MISMATCH only.
 */
export function equal_len_diff(seq_a: Uint8Array, seq_b: Uint8Array): MyersDiffResult;

/**
 * Get the maximum allowed k for dense k-mer counting.
 */
export function get_dense_kmer_max_k(): number;

/**
 * Render a Hilbert curve visualization as a flat RGBA buffer.
 *
 * # Inputs
 * - `seq_bytes`: ASCII DNA/RNA bytes OR already-encoded ACGT05 (0..=4).
 * - `order`: Hilbert order (grid size = 2^order). Must be within guardrails.
 * - `colors_rgb`: packed RGB palette for [A,C,G,T,N] as 15 bytes.
 *
 * # Output
 * - `Vec<u8>` interpreted as RGBA bytes (length = (2^order)^2 * 4).
 *
 * # Guardrails
 * - Caps order to avoid OOM. Returns an empty vec if requested output would exceed limits.
 */
export function hilbert_rgba(seq_bytes: Uint8Array, order: number, colors_rgb: Uint8Array): Uint8Array;

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
 * Compute Kullback-Leibler divergence between two dense k-mer count arrays.
 *
 * D_KL(P || Q) = sum(P(i) * log2(P(i) / Q(i)))
 *
 * Both arrays are normalized internally to probability distributions.
 * Missing k-mers in Q are smoothed with epsilon to avoid log(0).
 *
 * # Arguments
 * * `p_counts` - Dense count array for distribution P (window)
 * * `q_counts` - Dense count array for distribution Q (background)
 *
 * # Returns
 * KL divergence value (non-negative). Returns 0.0 if inputs are invalid.
 *
 * # Note
 * Arrays must be the same length. For k-mer analysis, length should be 4^k.
 *
 * @see phage_explorer-vk7b.5
 */
export function kl_divergence_dense(p_counts: Uint32Array, q_counts: Uint32Array): number;

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
 * Estimate Jaccard similarity between two MinHash signatures.
 *
 * # Arguments
 * * `sig_a` - First signature (Uint32Array)
 * * `sig_b` - Second signature (must have same length as sig_a)
 *
 * # Returns
 * Estimated Jaccard similarity (0.0 to 1.0).
 * Returns 0.0 if signatures have different lengths or are empty.
 */
export function minhash_jaccard_from_signatures(sig_a: Uint32Array, sig_b: Uint32Array): number;

/**
 * Compute MinHash signature using rolling k-mer index.
 *
 * Uses a rolling 2-bit index algorithm with no per-k-mer string allocations.
 * Much faster than the string-based approach for long sequences.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
 * * `k` - K-mer size (no practical limit, uses u64 index)
 * * `num_hashes` - Number of hash functions (signature length)
 *
 * # Returns
 * MinHashSignature with `num_hashes` minimum values.
 *
 * # Algorithm
 * 1. Maintain rolling 64-bit k-mer index (allows k up to 32)
 * 2. For each valid k-mer, compute hash for each seed
 * 3. Track minimum hash value per seed
 * 4. Ambiguous bases reset rolling state (no k-mer spans N)
 */
export function minhash_signature(seq: Uint8Array, k: number, num_hashes: number): MinHashSignature;

/**
 * Compute MinHash signature using canonical k-mers (strand-independent).
 *
 * For each k-mer position, uses the minimum of forward and reverse complement
 * indices before hashing. This makes the signature identical regardless of
 * which strand the sequence represents.
 *
 * # Arguments
 * * `seq` - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
 * * `k` - K-mer size (capped at 32 for u64 index)
 * * `num_hashes` - Number of hash functions (signature length)
 *
 * # Returns
 * MinHashSignature with strand-independent hashes.
 */
export function minhash_signature_canonical(seq: Uint8Array, k: number, num_hashes: number): MinHashSignature;

/**
 * Compute Myers diff between two DNA sequences.
 *
 * Uses the Myers O(ND) algorithm with bounded edit distance for safety.
 * Returns a diff result with masks for both sequences and summary statistics.
 *
 * # Arguments
 * * `seq_a` - First sequence (bytes)
 * * `seq_b` - Second sequence (bytes)
 *
 * # Returns
 * MyersDiffResult with masks and statistics.
 *
 * # Guardrails
 * - Max sequence length: 500,000 bp
 * - Max edit distance: 10,000
 * - If exceeded, returns truncated result with partial stats
 */
export function myers_diff(seq_a: Uint8Array, seq_b: Uint8Array): MyersDiffResult;

/**
 * Compute Myers diff with custom edit distance limit.
 *
 * # Arguments
 * * `seq_a` - First sequence (bytes)
 * * `seq_b` - Second sequence (bytes)
 * * `max_d` - Maximum edit distance to compute
 */
export function myers_diff_with_limit(seq_a: Uint8Array, seq_b: Uint8Array, max_d: number): MyersDiffResult;

/**
 * Parse a PDB file (string content) into atom data.
 *
 * This is a minimal parser optimized for speed and small WASM size.
 * It extracts only the fields needed for 3D structure visualization:
 * - Coordinates (x, y, z)
 * - Element symbol
 * - Atom name
 * - Chain ID
 * - Residue sequence number
 * - Residue name
 *
 * # Arguments
 * * `pdb_content` - Raw PDB file content as string
 *
 * # Returns
 * PDBParseResult with flat arrays ready for bond detection and rendering.
 *
 * # PDB Format Reference (fixed columns):
 * - Columns 1-6: Record type ("ATOM  " or "HETATM")
 * - Columns 13-16: Atom name
 * - Column 18-20: Residue name
 * - Column 22: Chain ID
 * - Columns 23-26: Residue sequence number
 * - Columns 31-38: X coordinate (Angstroms)
 * - Columns 39-46: Y coordinate
 * - Columns 47-54: Z coordinate
 * - Columns 77-78: Element symbol (right-justified)
 */
export function parse_pdb(pdb_content: string): PDBParseResult;

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
 * Compute PCA using power iteration (f32 data path).
 *
 * This entrypoint is designed to accept JS `Float32Array` inputs without the caller
 * having to upcast to `Float64Array`.
 *
 * Determinism:
 * - Initialization is deterministic (no randomness).
 * - Output eigenvectors are canonicalized to a stable sign (largest-magnitude element is positive).
 */
export function pca_power_iteration_f32(data: Float32Array, n_samples: number, n_features: number, n_components: number, max_iterations: number, tolerance: number): PCAResultF32;

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
 * Scan a sequence for k-mer KL divergence anomalies.
 *
 * Computes KL divergence of each sliding window against the global
 * sequence background. This is the core computation for anomaly detection.
 *
 * # Arguments
 * * `seq` - Sequence bytes (ASCII DNA)
 * * `k` - K-mer size (1-10)
 * * `window_size` - Size of each window in bases
 * * `step_size` - Step size between windows
 *
 * # Returns
 * `KLScanResult` with:
 * - `kl_values`: Float32Array of KL divergence for each window
 * - `positions`: Uint32Array of window start positions
 * - `window_count`: Number of windows scanned
 *
 * # Performance
 * Uses dense k-mer counting for O(1) k-mer lookups.
 * Avoids string allocations by working directly with byte arrays.
 *
 * # Example (from JS)
 * ```js
 * const seqBytes = new TextEncoder().encode(sequence);
 * const result = wasm.scan_kl_windows(seqBytes, 4, 500, 100);
 * try {
 *   const klValues = result.kl_values; // Float32Array
 *   const positions = result.positions; // Uint32Array
 *   // Process anomalies...
 * } finally {
 *   result.free();
 * }
 * ```
 *
 * @see phage_explorer-vk7b.5
 */
export function scan_kl_windows(seq: Uint8Array, k: number, window_size: number, step_size: number): KLScanResult;

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
