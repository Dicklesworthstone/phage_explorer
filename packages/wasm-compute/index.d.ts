declare module '@phage/wasm-compute' {
  /**
   * Initialize the WASM module with the compiled binary.
   */
  export default function init(buffer?: ArrayBuffer | Uint8Array): Promise<void>;

  /**
   * Compute Levenshtein distance using the Rust/WASM implementation.
   */
  export function levenshtein_distance(a: string, b: string): number;

  // ============================================================================
  // Core Genetics Functions - HOT PATH optimizations
  // ============================================================================

  /**
   * Translate DNA sequence to amino acid sequence.
   *
   * @param seq - DNA sequence string
   * @param frame - Reading frame (0, 1, or 2)
   * @returns Amino acid sequence. Unknown codons (containing N) become 'X'.
   */
  export function translate_sequence(seq: string, frame: number): string;

  /**
   * Compute reverse complement of DNA sequence.
   *
   * Handles all IUPAC ambiguity codes correctly:
   * - Standard: A<->T, G<->C
   * - Ambiguity: R<->Y, K<->M, S<->S, W<->W, B<->V, D<->H, N<->N
   *
   * @param seq - DNA sequence string
   * @returns Reverse complement sequence (preserving case).
   */
  export function reverse_complement(seq: string): string;

  /**
   * Calculate GC content percentage.
   *
   * Only counts unambiguous A, T, G, C bases. N and other ambiguity codes
   * are excluded from both numerator and denominator.
   *
   * @param seq - DNA sequence string
   * @returns GC content as percentage (0-100). Returns 0 if no valid bases.
   */
  export function calculate_gc_content(seq: string): number;

  /**
   * Result of codon usage analysis.
   */
  export class CodonUsageResult {
    free(): void;
    /** Get the codon counts as a JSON string. */
    readonly json: string;
  }

  /**
   * Count codon usage in a DNA sequence.
   *
   * @param seq - DNA sequence string
   * @param frame - Reading frame (0, 1, or 2)
   * @returns CodonUsageResult with JSON-encoded codon counts.
   */
  export function count_codon_usage(seq: string, frame: number): CodonUsageResult;

  /**
   * Result of k-mer analysis between two sequences.
   */
  export class KmerAnalysisResult {
    free(): void;
    readonly k: number;
    readonly unique_kmers_a: number;
    readonly unique_kmers_b: number;
    readonly shared_kmers: number;
    readonly jaccard_index: number;
    readonly containment_a_in_b: number;
    readonly containment_b_in_a: number;
    readonly cosine_similarity: number;
    readonly bray_curtis_dissimilarity: number;
  }

  /**
   * Perform k-mer analysis between two sequences.
   * Returns metrics including Jaccard index, containment, cosine similarity, etc.
   */
  export function analyze_kmers(
    sequence_a: string,
    sequence_b: string,
    k: number
  ): KmerAnalysisResult;

  /**
   * Estimate Jaccard similarity using MinHash algorithm.
   * Much faster than exact computation for large sequences.
   */
  export function min_hash_jaccard(
    sequence_a: string,
    sequence_b: string,
    k: number,
    num_hashes: number
  ): number;



  /**
   * Result of Hoeffding's D computation.
   */
  export class HoeffdingResult {
    free(): void;
    /** Hoeffding's D statistic. Range: approximately [-0.5, 1]. */
    readonly d: number;
    /** Number of observations used. */
    readonly n: number;
  }

  /**
   * Compute Hoeffding's D statistic for measuring statistical dependence.
   *
   * Hoeffding's D is a non-parametric measure of association that can detect
   * any type of dependence (linear or non-linear) between two variables.
   * Unlike Pearson correlation (linear only) or Spearman/Kendall (monotonic),
   * Hoeffding's D can detect complex non-monotonic relationships.
   *
   * @param x - First vector of observations (Float64Array)
   * @param y - Second vector of observations (must have same length as x)
   * @returns HoeffdingResult containing the D statistic and sample size.
   *
   * D ranges approximately from -0.5 to 1:
   * - D ≈ 0: variables are independent
   * - D > 0: variables are dependent
   * - D = 1: perfect dependence
   *
   * O(n²) time complexity. For large vectors (n > 10000), consider sampling.
   */
  export function hoeffdings_d(x: Float64Array, y: Float64Array): HoeffdingResult;



  /**
   * Compute Hoeffding's D between two k-mer frequency vectors derived from sequences.
   *
   * Convenience function that:
   * 1. Extracts k-mer frequencies from both sequences
   * 2. Creates aligned frequency vectors for all unique k-mers
   * 3. Computes Hoeffding's D on the frequency vectors
   *
   * @param sequence_a - First DNA sequence
   * @param sequence_b - Second DNA sequence
   * @param k - K-mer size (typically 3-7 for genome comparison)
   * @returns HoeffdingResult measuring dependence between k-mer frequency profiles.
   */
  export function kmer_hoeffdings_d(
    sequence_a: string,
    sequence_b: string,
    k: number
  ): HoeffdingResult;

  // ============================================================================
  // Entropy Functions - Information-theoretic sequence analysis
  // ============================================================================

  /**
   * Compute Shannon entropy from a probability distribution.
   * H(X) = -Σ p(x) * log2(p(x))
   *
   * @param probs - Probability distribution (must sum to ~1.0)
   * @returns Shannon entropy in bits. Returns 0 for empty or invalid input.
   */
  export function shannon_entropy(probs: Float64Array): number;

  /**
   * Compute Shannon entropy from a frequency count array.
   * Converts counts to probabilities internally.
   *
   * @param counts - Array of frequency counts
   * @returns Shannon entropy in bits.
   */
  export function shannon_entropy_from_counts(counts: Float64Array): number;

  /**
   * Compute Jensen-Shannon Divergence between two probability distributions.
   * JSD(P || Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M) where M = 0.5 * (P + Q)
   *
   * This is a symmetric and bounded (0 to 1 when using log2) divergence measure.
   *
   * @param p - First probability distribution
   * @param q - Second probability distribution (must have same length as p)
   * @returns JSD value in range [0, 1]. Returns 0 if inputs are identical.
   */
  export function jensen_shannon_divergence(p: Float64Array, q: Float64Array): number;

  /**
   * Compute JSD between two count arrays.
   * Normalizes to probabilities internally.
   */
  export function jensen_shannon_divergence_from_counts(
    counts_a: Float64Array,
    counts_b: Float64Array
  ): number;

  // ============================================================================
  // Repeat Detection - Palindromes and Tandem Repeats
  // ============================================================================

  /**
   * Result of repeat detection.
   */
  export class RepeatResult {
    free(): void;
    /** JSON-encoded array of detected repeats */
    readonly json: string;
  }

  /**
   * Detect palindromic (inverted repeat) sequences in DNA.
   *
   * A palindrome in DNA is a sequence that reads the same on the complementary
   * strand in reverse (e.g., GAATTC and its complement CTTAAG reversed).
   *
   * @param seq - DNA sequence string
   * @param min_len - Minimum palindrome arm length (typically 4-6)
   * @param max_gap - Maximum gap/spacer between palindrome arms (0 for perfect palindromes)
   * @returns RepeatResult with JSON array of {start, end, arm_length, gap, sequence}
   */
  export function detect_palindromes(
    seq: string,
    min_len: number,
    max_gap: number
  ): RepeatResult;

  /**
   * Detect tandem repeats (consecutive copies of a pattern).
   *
   * @param seq - DNA sequence string
   * @param min_unit - Minimum repeat unit length
   * @param max_unit - Maximum repeat unit length
   * @param min_copies - Minimum number of consecutive copies
   * @returns RepeatResult with JSON array of {start, end, unit, copies, sequence}
   */
  export function detect_tandem_repeats(
    seq: string,
    min_unit: number,
    max_unit: number,
    min_copies: number
  ): RepeatResult;

  // ============================================================================
  // GC Skew and Sequence Complexity
  // ============================================================================

  /**
   * Compute GC skew using a sliding window.
   * GC skew = (G - C) / (G + C)
   *
   * Used to identify the origin and terminus of replication in bacterial genomes.
   *
   * @param seq - DNA sequence string
   * @param window_size - Size of sliding window
   * @param step_size - Step between windows (1 for maximum resolution)
   * @returns Array of GC skew values for each window position.
   */
  export function compute_gc_skew(
    seq: string,
    window_size: number,
    step_size: number
  ): Float64Array;

  /**
   * Compute cumulative GC skew (useful for visualizing replication origin).
   * The cumulative skew will have a minimum at the origin of replication
   * and maximum at the terminus.
   */
  export function compute_cumulative_gc_skew(seq: string): Float64Array;

  /**
   * Compute linguistic complexity of a sequence.
   * Linguistic complexity = (number of distinct substrings) / (maximum possible substrings)
   *
   * This measures how "random" or information-rich a sequence is.
   * Low complexity indicates repetitive regions.
   *
   * @param seq - DNA sequence string
   * @param max_k - Maximum substring length to consider
   * @returns Complexity score in range [0, 1] where 1 = maximum complexity.
   */
  export function compute_linguistic_complexity(seq: string, max_k: number): number;

  /**
   * Compute local complexity in sliding windows.
   *
   * @param seq - DNA sequence string
   * @param window_size - Size of sliding window
   * @param step_size - Step between windows
   * @param k - K-mer size for complexity calculation
   * @returns Array of complexity values for each window.
   */
  export function compute_windowed_complexity(
    seq: string,
    window_size: number,
    step_size: number,
    k: number
  ): Float64Array;

  // ============================================================================
  // Grid Building - HOT PATH for viewport rendering
  // ============================================================================

  /**
   * Result of grid building for sequence viewport.


  // ============================================================================
  // Dense K-mer Counter (WASM ABI: bytes-first, typed-array output)
  // @see docs/wasm-abi.md, phage_explorer-vk7b.1
  // ============================================================================

  /**
   * Error codes for dense k-mer counting.
   */
  export enum DenseKmerError {
    KTooLarge = 1,
    KZero = 2,
    SequenceTooShort = 3,
  }

  /**
   * Result of dense k-mer counting.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   *
   * @example
   * ```ts
   * const result = wasm.count_kmers_dense(sequenceBytes, 6);
   * try {
   *   const counts = result.counts; // Uint32Array[4096]
   *   const total = Number(result.total_valid); // bigint → number
   * } finally {
   *   result.free(); // Required!
   * }
   * ```
   */
  export class DenseKmerResult {
    free(): void;
    /**
     * Dense count array of length 4^k.
     * Index encoding: A=0, C=1, G=2, T=3
     * Index = sum(base[i] * 4^(k-1-i)) for i in 0..k
     */
    readonly counts: Uint32Array;
    /** Total valid k-mers counted (Rust u64 → JS bigint) */
    readonly total_valid: bigint;
    /** K value used */
    readonly k: number;
    /** Number of unique k-mers (non-zero counts) */
    readonly unique_count: number;
  }

  /**
   * Dense k-mer counting with typed array output.
   *
   * Uses a rolling 2-bit index algorithm with no per-position heap allocations.
   * Ambiguous bases (N and non-ACGT) reset the rolling state.
   *
   * @param seq - Sequence as bytes (ASCII). Accepts both upper and lower case.
   * @param k - K-mer size. Must be 1 <= k <= 10 (4^10 = ~4MB max array).
   * @returns DenseKmerResult (caller must call `.free()`)
   *
   * Returns empty result with all-zero counts if k is invalid.
   *
   * @see phage_explorer-vk7b.1.1
   * @see docs/wasm-abi.md
   */
  export function count_kmers_dense(seq: Uint8Array, k: number): DenseKmerResult;

  /**
   * Dense k-mer counting with reverse complement combined.
   *
   * Counts both forward and reverse complement k-mers into the same array.
   * Uses canonical k-mers (min of forward and RC) for strand-independent analysis.
   *
   * @param seq - Sequence as bytes (ASCII)
   * @param k - K-mer size (1 <= k <= 10)
   * @returns DenseKmerResult with combined forward + RC counts
   */
  export function count_kmers_dense_canonical(seq: Uint8Array, k: number): DenseKmerResult;

  /**
   * Check if a k value is valid for dense k-mer counting.
   * Returns true if 1 <= k <= 10.
   */
  export function is_valid_dense_kmer_k(k: number): boolean;

  /**
   * Get the maximum allowed k for dense k-mer counting (currently 10).
   */
  export function get_dense_kmer_max_k(): number;

  // ============================================================================
  // MinHash Signature (rolling index, typed array output)
  // @see phage_explorer-vk7b.2.1
  // ============================================================================

  /**
   * Result of MinHash signature computation.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   *
   * @example
   * ```ts
   * const sig = wasm.minhash_signature(seqBytes, 16, 128);
   * try {
   *   const values = sig.signature; // Uint32Array[128]
   *   const totalKmers = Number(sig.total_kmers);
   * } finally {
   *   sig.free(); // Required!
   * }
   * ```
   */
  export class MinHashSignature {
    free(): void;
    /** Signature values as Uint32Array (minimum hash for each seed) */
    readonly signature: Uint32Array;
    /** Total valid k-mers hashed (bigint from Rust u64) */
    readonly total_kmers: bigint;
    /** K value used */
    readonly k: number;
    /** Number of hash functions (signature length) */
    readonly num_hashes: number;
  }

  /**
   * Compute MinHash signature using rolling k-mer index.
   *
   * Uses a rolling 2-bit index algorithm with no per-k-mer string allocations.
   * Much faster than string-based approach for long sequences.
   *
   * @param seq - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
   * @param k - K-mer size (capped at 32 for u64 index)
   * @param num_hashes - Number of hash functions (signature length, e.g., 128)
   * @returns MinHashSignature (caller must call `.free()`)
   *
   * @see phage_explorer-vk7b.2.1
   */
  export function minhash_signature(seq: Uint8Array, k: number, num_hashes: number): MinHashSignature;

  /**
   * Compute MinHash signature using canonical k-mers (strand-independent).
   *
   * For each k-mer position, uses the minimum of forward and reverse complement
   * indices before hashing. This makes the signature identical regardless of
   * which strand the sequence represents.
   *
   * @param seq - Sequence as bytes (ASCII)
   * @param k - K-mer size (capped at 32)
   * @param num_hashes - Number of hash functions
   * @returns MinHashSignature with strand-independent hashes
   */
  export function minhash_signature_canonical(seq: Uint8Array, k: number, num_hashes: number): MinHashSignature;

  /**
   * Estimate Jaccard similarity between two MinHash signatures.
   *
   * @param sig_a - First signature (Uint32Array)
   * @param sig_b - Second signature (must have same length)
   * @returns Estimated Jaccard similarity (0.0 to 1.0)
   */
  export function minhash_jaccard_from_signatures(sig_a: Uint32Array, sig_b: Uint32Array): number;

  // ============================================================================
  // Spatial-Hash Bond Detection
  // ============================================================================

  /**
   * Result of spatial-hash bond detection.
   */
  export class BondDetectionResult {
    free(): void;
    /** Flat array of bond pairs: [a0, b0, a1, b1, ...] */
    readonly bonds: Uint32Array;
    /** Number of bonds found */
    readonly bond_count: number;
  }

  /**
   * Detect bonds using spatial hashing for O(N) complexity.
   *
   * This is the CRITICAL optimization replacing the O(N²) algorithm.
   * For a 50,000 atom structure:
   * - Old: ~60+ seconds
   * - New: <1 second
   *
   * @param positions - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
   * @param elements - String of element symbols (one char per atom: "CCCCNNO...")
   * @returns BondDetectionResult with pairs of bonded atom indices
   */
  export function detect_bonds_spatial(positions: Float32Array, elements: string): BondDetectionResult;

  // ============================================================================
  // Functional Group Detection
  // ============================================================================

  /**
   * Result of functional group detection.
   * Contains typed arrays for aromatic rings, disulfide bonds, and phosphate groups.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   */
  export class FunctionalGroupResult {
    free(): void;
    /** Flat array of aromatic ring atom indices (6 per ring). */
    readonly aromatic_indices: Uint32Array;
    /** Number of atoms in each aromatic ring (all 6 for 6-membered rings). */
    readonly ring_sizes: Uint32Array;
    /** Disulfide bond pairs: [s1, s2, s1, s2, ...]. */
    readonly disulfide_pairs: Uint32Array;
    /** Phosphate group data: [p_idx, num_oxygens, o1, o2, o3, ...] per group. */
    readonly phosphate_data: Uint32Array;
    /** Number of aromatic rings found. */
    readonly aromatic_count: number;
    /** Number of disulfide bonds found. */
    readonly disulfide_count: number;
    /** Number of phosphate groups found. */
    readonly phosphate_count: number;
  }

  /**
   * Detect functional groups using spatial-hash optimized algorithm.
   *
   * Detects:
   * - Aromatic rings: 6-membered planar carbon rings
   * - Disulfide bonds: S-S bonds within 2.2 Å
   * - Phosphate groups: P with 3+ oxygen neighbors
   *
   * @param positions - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
   * @param elements - String of element symbols (one char per atom: "CCCCNNO...")
   * @param bonds - Flat array of bond pairs [a0, b0, a1, b1, ...] from detect_bonds_spatial
   * @returns FunctionalGroupResult with typed arrays for each group type
   */
  export function detect_functional_groups(
    positions: Float32Array,
    elements: string,
    bonds: Uint32Array
  ): FunctionalGroupResult;

  // ============================================================================
  // Dot Plot (Self-Similarity Matrix)
  // ============================================================================

  /**
   * Result of dot plot computation.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   */
  export class DotPlotBuffers {
    free(): void;
    /** Direct similarity values (row-major, bins × bins) */
    readonly direct: Float32Array;
    /** Inverted (reverse complement) similarity values (row-major, bins × bins) */
    readonly inverted: Float32Array;
    /** Number of bins in each dimension */
    readonly bins: number;
    /** Window size used for computation */
    readonly window: number;
  }

  /**
   * Compute self-similarity dot plot from sequence bytes.
   *
   * @param seq - Sequence bytes (ASCII)
   * @param bins - Number of bins for the grid (bins × bins output)
   * @param window - Window size in bases. If 0, derives a conservative default.
   * @returns DotPlotBuffers containing direct and inverted similarity matrices
   */
  export function dotplot_self_buffers(seq: Uint8Array, bins: number, window: number): DotPlotBuffers;

  // ============================================================================
  // Sequence Rendering Helpers (Optional, not currently wired in)
  // ============================================================================

  /**
   * Fast sequence encoding for canvas rendering.
   * Encodes nucleotides to numeric codes: A=0, C=1, G=2, T=3, other=4.
   */
  export function encode_sequence_fast(seq: string): Uint8Array;

  /**
   * Compute diff mask between two sequences.
   * Returns 0 for match, 1 for mismatch at each position.
   */
  export function compute_diff_mask(query: string, reference: string): Uint8Array;

  /**
   * Compute diff mask from pre-encoded sequences (faster).
   */
  export function compute_diff_mask_encoded(query_encoded: Uint8Array, ref_encoded: Uint8Array): Uint8Array;

  // ============================================================================
  // KL Divergence for Anomaly Detection
  // @see phage_explorer-vk7b.5
  // ============================================================================

  /**
   * Compute Kullback-Leibler divergence between two dense k-mer count arrays.
   *
   * D_KL(P || Q) = sum(P(i) * log2(P(i) / Q(i)))
   *
   * Both arrays are normalized internally to probability distributions.
   * Missing k-mers in Q are smoothed with epsilon to avoid log(0).
   *
   * @param p_counts - Dense count array for distribution P (window)
   * @param q_counts - Dense count array for distribution Q (background)
   * @returns KL divergence value (non-negative). Returns 0.0 if inputs are invalid.
   */
  export function kl_divergence_dense(p_counts: Uint32Array, q_counts: Uint32Array): number;

  /**
   * Result of KL divergence window scan.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   *
   * @example
   * ```ts
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
   */
  export class KLScanResult {
    free(): void;
    /** KL divergence values for each window position */
    readonly kl_values: Float32Array;
    /** Window start positions as Uint32Array */
    readonly positions: Uint32Array;
    /** Number of windows scanned */
    readonly window_count: number;
    /** K-mer size used */
    readonly k: number;
  }

  /**
   * Scan a sequence for k-mer KL divergence anomalies.
   *
   * Computes KL divergence of each sliding window against the global
   * sequence background. This is the core computation for anomaly detection.
   *
   * Uses dense k-mer counting internally for O(1) k-mer lookups and avoids
   * string allocations by working directly with byte arrays.
   *
   * @param seq - Sequence bytes (ASCII DNA)
   * @param k - K-mer size (1-10)
   * @param window_size - Size of each window in bases
   * @param step_size - Step size between windows
   * @returns KLScanResult (caller must call `.free()`)
   *
   * @see phage_explorer-vk7b.5
   */
  export function scan_kl_windows(seq: Uint8Array, k: number, window_size: number, step_size: number): KLScanResult;

  // ============================================================================
  // Myers Diff/Alignment
  // @see phage_explorer-kyo0.1
  // ============================================================================

  /**
   * Result of Myers diff alignment.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   *
   * Mask codes:
   * - 0 = MATCH
   * - 1 = MISMATCH (substitution)
   * - 2 = INSERT (in B, not in A)
   * - 3 = DELETE (in A, not in B)
   *
   * @example
   * ```ts
   * const encoder = new TextEncoder();
   * const seqA = encoder.encode('ACGT');
   * const seqB = encoder.encode('ACCT');
   * const result = wasm.myers_diff(seqA, seqB);
   * try {
   *   console.log('Identity:', result.identity);
   *   console.log('Mask A:', result.mask_a); // Uint8Array
   * } finally {
   *   result.free();
   * }
   * ```
   */
  export class MyersDiffResult {
    free(): void;
    /** Diff mask for sequence A (0=MATCH, 1=MISMATCH, 3=DELETE) */
    readonly mask_a: Uint8Array;
    /** Diff mask for sequence B (0=MATCH, 1=MISMATCH, 2=INSERT) */
    readonly mask_b: Uint8Array;
    /** Edit distance (total edits) */
    readonly edit_distance: number;
    /** Number of matching positions */
    readonly matches: number;
    /** Number of mismatches (substitutions) */
    readonly mismatches: number;
    /** Number of insertions */
    readonly insertions: number;
    /** Number of deletions */
    readonly deletions: number;
    /** Sequence identity as fraction (0.0 - 1.0) */
    readonly identity: number;
    /** Whether computation was truncated due to guardrails */
    readonly truncated: boolean;
    /** Error message if any */
    readonly error: string | undefined;
    /** Length of sequence A */
    readonly len_a: number;
    /** Length of sequence B */
    readonly len_b: number;
  }

  /**
   * Compute Myers diff between two DNA sequences.
   *
   * Uses Myers O(ND) algorithm with guardrails:
   * - Max sequence length: 500,000 bp
   * - Max edit distance: 10,000
   *
   * If guardrails are exceeded, returns a truncated result with
   * `truncated: true` and an error message.
   *
   * @param seq_a - First sequence bytes (ASCII DNA)
   * @param seq_b - Second sequence bytes (ASCII DNA)
   * @returns MyersDiffResult (caller must call `.free()`)
   *
   * @see phage_explorer-kyo0.1.1
   */
  export function myers_diff(seq_a: Uint8Array, seq_b: Uint8Array): MyersDiffResult;

  /**
   * Compute Myers diff with custom edit distance limit.
   *
   * @param seq_a - First sequence bytes
   * @param seq_b - Second sequence bytes
   * @param max_d - Maximum edit distance to compute
   * @returns MyersDiffResult
   */
  export function myers_diff_with_limit(seq_a: Uint8Array, seq_b: Uint8Array, max_d: number): MyersDiffResult;

  /**
   * Fast O(n) diff for equal-length sequences.
   *
   * Only computes mismatches (no insertions/deletions possible).
   * Much faster than myers_diff for same-length sequences.
   *
   * @param seq_a - First sequence bytes
   * @param seq_b - Second sequence bytes (must have same length as seq_a)
   * @returns MyersDiffResult with mask codes 0=MATCH, 1=MISMATCH only
   */
  export function equal_len_diff(seq_a: Uint8Array, seq_b: Uint8Array): MyersDiffResult;

  // ============================================================================
  // SequenceHandle - Zero-copy sequence storage in WASM memory
  // @see phage_explorer-8qk2.5
  // ============================================================================

  /**
   * A handle to a sequence stored in WASM memory.
   *
   * This struct stores an encoded DNA sequence once and exposes fast methods
   * for various analyses without re-copying the sequence each call.
   *
   * IMPORTANT: Must call `.free()` when done to release WASM memory.
   *
   * @example
   * ```ts
   * const encoder = new TextEncoder();
   * const seqBytes = encoder.encode(genomeSequence);
   * const handle = new SequenceHandle(seqBytes);
   * try {
   *   // Run multiple analyses on the same sequence - no re-copying!
   *   const gcSkew = handle.gc_skew(100, 10);
   *   const kmerCounts = handle.count_kmers(6);
   *   const minhash = handle.minhash(128, 16);
   *   // ... use results
   * } finally {
   *   handle.free(); // Required!
   * }
   * ```
   *
   * @see phage_explorer-8qk2.5
   */
  export class SequenceHandle {
    /**
     * Create a new SequenceHandle from raw sequence bytes.
     *
     * The sequence is encoded into a compact representation stored in WASM memory.
     * Case-insensitive: a/A, c/C, g/G, t/T are all valid.
     * U is treated as T. Ambiguous/invalid bases are stored as N (code 4).
     *
     * @param seq_bytes - ASCII bytes of the DNA/RNA sequence
     */
    constructor(seq_bytes: Uint8Array);

    /** Release WASM memory. MUST call when done. */
    free(): void;

    /** Original sequence length. */
    readonly length: number;

    /** Count of valid (non-N) bases. */
    readonly valid_count: number;

    /**
     * Get the encoded sequence as a Uint8Array.
     * Values: A=0, C=1, G=2, T=3, N=4
     */
    readonly encoded_bytes: Uint8Array;

    /**
     * Compute GC skew values for sliding windows.
     *
     * GC skew = (G - C) / (G + C) for each window.
     *
     * @param window_size - Size of the sliding window
     * @param step_size - Step between windows
     * @returns Float64Array of GC skew values, one per window position
     */
    gc_skew(window_size: number, step_size: number): Float64Array;

    /**
     * Compute cumulative GC skew.
     *
     * Running sum of G-C contribution per base.
     * Minimum indicates origin of replication, maximum indicates terminus.
     *
     * @returns Float64Array with cumulative skew at each position
     */
    cumulative_gc_skew(): Float64Array;

    /**
     * Compute windowed Shannon entropy (normalized 0..=1) for sliding windows.
     *
     * @param window_size - Window size in bases
     * @param step_size - Step between windows
     * @returns Float64Array of normalized entropy values
     */
    windowed_entropy(window_size: number, step_size: number): Float64Array;

    /**
     * Count k-mers using dense array (for k <= 10).
     *
     * Returns a DenseKmerResult with counts for all 4^k possible k-mers.
     * K-mers containing N are skipped.
     *
     * @param k - K-mer size (1-10)
     * @returns DenseKmerResult with counts, or empty result if k is invalid
     */
    count_kmers(k: number): DenseKmerResult;

    /**
     * Compute MinHash signature for similarity estimation.
     *
     * Uses canonical k-mers (strand-independent) for comparison.
     *
     * @param num_hashes - Number of hash functions (signature size, e.g., 128)
     * @param k - K-mer size
     * @returns MinHashSignature containing the signature
     */
    minhash(num_hashes: number, k: number): MinHashSignature;

    /**
     * Compute self-similarity dot plot using pre-encoded sequence.
     *
     * This is more efficient than `dotplot_self_buffers` when running multiple
     * analyses on the same sequence (e.g., progressive refinement with preview
     * then full resolution).
     *
     * @param bins - Number of bins for the grid (bins × bins output)
     * @param window - Window size in bases. If 0, derives a conservative default.
     * @returns DotPlotBuffers containing direct and inverted similarity matrices
     *
     * @see phage_explorer-8qk2.6
     */
    dotplot_self(bins: number, window: number): DotPlotBuffers;
  }

}
