use wasm_bindgen::prelude::*;
use std::collections::HashMap;
use js_sys;

mod renderer;

pub use renderer::{render_ascii_model, Model3D, Vector3};

// ============================================================================
// Core Genetics Functions - HOT PATH optimizations
// ============================================================================

/// Standard DNA codon table (Translation Table 1)
/// Maps 64 codons to their amino acid single-letter codes.
fn codon_to_aa(b0: u8, b1: u8, b2: u8) -> u8 {
    // Encode codon as 6-bit index: (base0 << 4) | (base1 << 2) | base2
    // where A=0, C=1, G=2, T=3
    let encode_base = |b: u8| -> Option<u8> {
        match b {
            b'A' | b'a' => Some(0),
            b'C' | b'c' => Some(1),
            b'G' | b'g' => Some(2),
            b'T' | b't' | b'U' | b'u' => Some(3),
            _ => None, // N or other ambiguous
        }
    };

    let (e0, e1, e2) = match (encode_base(b0), encode_base(b1), encode_base(b2)) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => return b'X', // Unknown codon
    };

    let idx = ((e0 as usize) << 4) | ((e1 as usize) << 2) | (e2 as usize);

    // Precomputed codon table: index = (base0*16 + base1*4 + base2)
    // Order: AAA, AAC, AAG, AAT, ACA, ACC, ACG, ACT, ...
    const TABLE: &[u8; 64] = b"KNKNTTTTRSRSIIMIQHQHPPPPRRRRLLLLEDEDAAAAGGGGVVVV*Y*YSSSS*CWCLFLF";
    TABLE[idx]
}

/// Translate DNA sequence to amino acid sequence.
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `frame` - Reading frame (0, 1, or 2)
///
/// # Returns
/// Amino acid sequence as a string. Unknown codons (containing N) become 'X'.
#[wasm_bindgen]
pub fn translate_sequence(seq: &str, frame: u8) -> String {
    let bytes = seq.as_bytes();
    let frame = (frame as usize).min(2);

    if bytes.len() < frame + 3 {
        return String::new();
    }

    let num_codons = (bytes.len() - frame) / 3;
    let mut result = Vec::with_capacity(num_codons);

    let mut i = frame;
    while i + 3 <= bytes.len() {
        let aa = codon_to_aa(bytes[i], bytes[i + 1], bytes[i + 2]);
        result.push(aa);
        i += 3;
    }

    // SAFETY: codon_to_aa only returns ASCII characters
    unsafe { String::from_utf8_unchecked(result) }
}

/// Compute reverse complement of DNA sequence.
///
/// Handles all IUPAC ambiguity codes correctly:
/// - Standard: A<->T, G<->C
/// - Ambiguity: R<->Y, K<->M, S<->S, W<->W, B<->V, D<->H, N<->N
///
/// # Arguments
/// * `seq` - DNA sequence string
///
/// # Returns
/// Reverse complement sequence (preserving case).
#[wasm_bindgen]
pub fn reverse_complement(seq: &str) -> String {
    let bytes = seq.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());

    // Process in reverse
    for &b in bytes.iter().rev() {
        let comp = match b {
            // Standard bases
            b'A' => b'T', b'T' => b'A', b'G' => b'C', b'C' => b'G',
            b'a' => b't', b't' => b'a', b'g' => b'c', b'c' => b'g',
            // IUPAC ambiguity codes
            b'N' => b'N', b'n' => b'n',
            b'R' => b'Y', b'r' => b'y', // Purine (A/G) -> Pyrimidine (T/C)
            b'Y' => b'R', b'y' => b'r',
            b'S' => b'S', b's' => b's', // Strong (G/C)
            b'W' => b'W', b'w' => b'w', // Weak (A/T)
            b'K' => b'M', b'k' => b'm', // Keto (G/T) -> Amino (A/C)
            b'M' => b'K', b'm' => b'k',
            b'B' => b'V', b'b' => b'v', // Not A -> Not T
            b'V' => b'B', b'v' => b'b',
            b'D' => b'H', b'd' => b'h', // Not C -> Not G
            b'H' => b'D', b'h' => b'd',
            // U (RNA) treated as T
            b'U' => b'A', b'u' => b'a',
            // Unknown - keep as is
            other => other,
        };
        result.push(comp);
    }

    // SAFETY: We only transform ASCII characters to ASCII
    unsafe { String::from_utf8_unchecked(result) }
}

/// Calculate GC content percentage.
///
/// Only counts unambiguous A, T, G, C bases. N and other ambiguity codes
/// are excluded from both numerator and denominator.
///
/// # Arguments
/// * `seq` - DNA sequence string
///
/// # Returns
/// GC content as percentage (0-100). Returns 0 if no valid bases.
#[wasm_bindgen]
pub fn calculate_gc_content(seq: &str) -> f64 {
    let bytes = seq.as_bytes();
    let mut gc_count = 0u64;
    let mut total_count = 0u64;

    for &b in bytes {
        match b {
            b'G' | b'g' | b'C' | b'c' => {
                gc_count += 1;
                total_count += 1;
            }
            b'A' | b'a' | b'T' | b't' | b'U' | b'u' => {
                total_count += 1;
            }
            _ => {} // Skip N and other ambiguous bases
        }
    }

    if total_count == 0 {
        0.0
    } else {
        (gc_count as f64 / total_count as f64) * 100.0
    }
}

/// Result of codon usage analysis.
#[wasm_bindgen]
pub struct CodonUsageResult {
    /// JSON-encoded codon counts: { "ATG": 5, "TTT": 12, ... }
    json: String,
}

#[wasm_bindgen]
impl CodonUsageResult {
    /// Get the codon counts as a JSON string.
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
}

/// Count codon usage in a DNA sequence.
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `frame` - Reading frame (0, 1, or 2)
///
/// # Returns
/// CodonUsageResult with JSON-encoded codon counts.
#[wasm_bindgen]
pub fn count_codon_usage(seq: &str, frame: u8) -> CodonUsageResult {
    let bytes = seq.as_bytes();
    let frame = (frame as usize).min(2);

    let mut counts: HashMap<String, usize> = HashMap::new();

    let mut i = frame;
    while i + 3 <= bytes.len() {
        // Extract codon and uppercase it
        let codon_bytes = &bytes[i..i + 3];
        let codon: String = codon_bytes.iter()
            .map(|&b| (b as char).to_ascii_uppercase())
            .collect();

        *counts.entry(codon).or_insert(0) += 1;
        i += 3;
    }

    // Serialize to JSON
    let json = serde_json_lite_encode(&counts);
    CodonUsageResult { json }
}

/// Simple JSON encoder for HashMap<String, usize>
/// Avoids serde_json dependency for smaller WASM size.
fn serde_json_lite_encode(map: &HashMap<String, usize>) -> String {
    let mut result = String::from("{");
    let mut first = true;

    for (key, value) in map {
        if !first {
            result.push(',');
        }
        first = false;
        result.push('"');
        result.push_str(key);
        result.push_str("\":");
        result.push_str(&value.to_string());
    }

    result.push('}');
    result
}

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let v1: Vec<char> = s1.chars().collect();
    let v2: Vec<char> = s2.chars().collect();
    
    let m = v1.len();
    let n = v2.len();

    if m == 0 { return n; }
    if n == 0 { return m; }

    // Ensure v1 is the shorter string for O(min(M, N)) space
    if m > n {
        return levenshtein_impl(&v2, &v1);
    }
    levenshtein_impl(&v1, &v2)
}

fn levenshtein_impl(s1: &[char], s2: &[char]) -> usize {
    let m = s1.len();
    let mut costs: Vec<usize> = (0..=m).collect();

    for (j, &c2) in s2.iter().enumerate() {
        let mut previous_substitution_cost = costs[0];
        costs[0] = j + 1;

        for (i, &c1) in s1.iter().enumerate() {
            let insertion_cost = costs[i];
            let deletion_cost = costs[i+1];
            
            let substitution_cost = if c1 == c2 {
                previous_substitution_cost
            } else {
                previous_substitution_cost + 1
            };

            previous_substitution_cost = deletion_cost;
            
            costs[i+1] = substitution_cost.min(insertion_cost + 1).min(deletion_cost + 1);
        }
    }

    costs[m]
}

#[wasm_bindgen]
pub struct KmerAnalysisResult {
    pub k: usize,
    pub unique_kmers_a: usize,
    pub unique_kmers_b: usize,
    pub shared_kmers: usize,
    pub jaccard_index: f64,
    pub containment_a_in_b: f64,
    pub containment_b_in_a: f64,
    pub cosine_similarity: f64,
    pub bray_curtis_dissimilarity: f64,
}

fn extract_kmer_freqs(sequence: &str, k: usize) -> HashMap<String, usize> {
    let mut freqs = HashMap::new();
    // Pre-allocate assuming roughly seq_len - k unique kmers
    if sequence.len() < k {
        return freqs;
    }
    
    // Convert to bytes for faster processing. 
    // We assume input is mostly ASCII DNA. Multibyte chars are handled safely by String::from_utf8_lossy if needed,
    // but here we just process bytes and construct Strings for the map keys.
    let seq_bytes = sequence.as_bytes();
    
    // We can iterate windows on bytes.
    // Handling uppercase: we can uppercase the key when inserting.
    
    for i in 0..=(seq_bytes.len() - k) {
        let window = &seq_bytes[i..i+k];
        
        // Check for 'N' or 'n'
        // 'N' is 78, 'n' is 110.
        // Actually, let's just create the string and check.
        // Optimizing this loop is tricky without custom Hasher or encoding.
        // The safest path that is still faster than JS is reducing allocations via strict loops.
        
        // Check for N without allocation
        let has_n = window.iter().any(|&b| b == b'N' || b == b'n');
        if has_n {
            continue;
        }

        // Create String and uppercase
        // from_utf8_lossy returns Cow. 
        // We know it's valid UTF8 if input was valid str.
        let kmer_str = std::str::from_utf8(window).unwrap_or("").to_uppercase();
        
        *freqs.entry(kmer_str).or_insert(0) += 1;
    }
    freqs
}

#[wasm_bindgen]
pub fn analyze_kmers(sequence_a: &str, sequence_b: &str, k: usize) -> KmerAnalysisResult {
    let freqs_a = extract_kmer_freqs(sequence_a, k);
    let freqs_b = extract_kmer_freqs(sequence_b, k);

    let set_a_len = freqs_a.len();
    let set_b_len = freqs_b.len();

    // Iterate over the smaller map for intersection
    let (smaller, larger) = if set_a_len < set_b_len {
        (&freqs_a, &freqs_b)
    } else {
        (&freqs_b, &freqs_a)
    };

    let intersection_count = smaller.keys().filter(|kmer| larger.contains_key(*kmer)).count();
    let union_size = set_a_len + set_b_len - intersection_count;
    
    let jaccard = if union_size > 0 {
        intersection_count as f64 / union_size as f64
    } else {
        1.0
    };

    let containment_a_in_b = if set_a_len > 0 {
        intersection_count as f64 / set_a_len as f64
    } else {
        0.0
    };

    let containment_b_in_a = if set_b_len > 0 {
        intersection_count as f64 / set_b_len as f64
    } else {
        0.0
    };

    // For Cosine/Bray-Curtis, we need to iterate the union.
    // Optimization: iterate keys of A, calculate partials. Iterate keys of B, calculate partials for keys NOT in A.
    // Or just collect union keys.
    
    let mut dot_product = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    let mut sum_diff = 0.0;
    let mut sum_total = 0.0;

    // Iterate all keys in A
    for (kmer, &count_a) in &freqs_a {
        let count_a = count_a as f64;
        let count_b = *freqs_b.get(kmer).unwrap_or(&0) as f64;
        
        dot_product += count_a * count_b;
        norm_a += count_a * count_a;
        // norm_b will be calculated fully later? No, we need to sum all B.
        // Let's do it simply to avoid mistakes.
        
        sum_diff += (count_a - count_b).abs();
        sum_total += count_a + count_b;
    }

    // Iterate keys in B that are NOT in A
    for (kmer, &count_b) in &freqs_b {
        if !freqs_a.contains_key(kmer) {
            let count_b = count_b as f64;
            // count_a is 0
            // dot_product += 0 * count_b -> 0
            // norm_a += 0 -> 0
            
            sum_diff += count_b; // abs(0 - count_b)
            sum_total += count_b;
        }
        // Calculate norm_b separately
        norm_b += (count_b as f64).powi(2);
    }

    let cosine_sim = if norm_a > 0.0 && norm_b > 0.0 {
        dot_product / (norm_a.sqrt() * norm_b.sqrt())
    } else {
        0.0
    };

    let bray_curtis = if sum_total > 0.0 {
        sum_diff / sum_total
    } else {
        0.0
    };

    KmerAnalysisResult {
        k,
        unique_kmers_a: set_a_len,
        unique_kmers_b: set_b_len,
        shared_kmers: intersection_count,
        jaccard_index: jaccard,
        containment_a_in_b,
        containment_b_in_a,
        cosine_similarity: cosine_sim,
        bray_curtis_dissimilarity: bray_curtis,
    }
}

#[wasm_bindgen]
pub fn min_hash_jaccard(sequence_a: &str, sequence_b: &str, k: usize, num_hashes: usize) -> f64 {
    if num_hashes == 0 {
        return 0.0;
    }

    let sig_a = get_min_hash_signature(sequence_a, k, num_hashes);
    let sig_b = get_min_hash_signature(sequence_b, k, num_hashes);

    // If either sequence had no valid k-mers, signatures will be all MAX; treat as zero similarity.
    let empty_sig_a = sig_a.iter().all(|&v| v == u32::MAX);
    let empty_sig_b = sig_b.iter().all(|&v| v == u32::MAX);
    if empty_sig_a || empty_sig_b {
        return 0.0;
    }

    let mut matches = 0;
    for i in 0..num_hashes {
        if sig_a[i] == sig_b[i] {
            matches += 1;
        }
    }

    matches as f64 / num_hashes as f64
}

fn get_min_hash_signature(seq: &str, k: usize, num_hashes: usize) -> Vec<u32> {
    let mut signature = vec![u32::MAX; num_hashes];
    let seq_bytes = seq.as_bytes(); // Optimization: use bytes

    if seq.len() < k || num_hashes == 0 {
        return signature;
    }

    for i in 0..=(seq.len() - k) {
        let window = &seq_bytes[i..i+k];

        // Check for N
        if window.iter().any(|&b| b == b'N' || b == b'n') {
            continue;
        }

        // We need a string for consistent hashing with JS implementation or just consistent logic
        // JS uses: hash(kmer, h * 0x9e3779b9)
        // Let's implement the same FNV-1a inspired hash from JS code

        // JS hash function logic:
        // h = seed;
        // for char code: h ^= code, h = imul(h, 0x01000193)
        // return h >>> 0

        // We can replicate this.
        // window is &[u8].
        // We need to handle case insensitivity (uppercase).

        for h_idx in 0..num_hashes {
            let seed = (h_idx as u32).wrapping_mul(0x9e3779b9);
            let mut h = seed;

            for &byte in window {
                // To uppercase: 'a'..='z' -> -32
                let b = if byte >= b'a' && byte <= b'z' {
                    byte - 32
                } else {
                    byte
                };

                h ^= b as u32;
                h = h.wrapping_mul(0x01000193);
            }

            if h < signature[h_idx] {
                signature[h_idx] = h;
            }
        }
    }
    signature
}

// ============================================================================
// Dense K-mer Counter (bytes-first ABI)
// Optimized for browser-based k-mer analysis with typed array output
// See: docs/WASM_ABI_SPEC.md for conventions
// ============================================================================

/// Maximum k value for dense counting (4^10 = 1,048,576 entries = ~4MB)
const DENSE_KMER_MAX_K: usize = 10;

/// Result of dense k-mer counting.
///
/// # Ownership
/// The caller must call `.free()` to release WASM memory.
#[wasm_bindgen]
pub struct DenseKmerResult {
    /// Dense count array of length 4^k
    counts: Vec<u32>,
    /// Total valid k-mers counted (excludes windows with N)
    total_valid: u64,
    /// K value used
    k: usize,
}

#[wasm_bindgen]
impl DenseKmerResult {
    /// Get the k-mer counts as a Uint32Array.
    /// Length is 4^k where each index represents a k-mer in base-4 encoding:
    /// - A=0, C=1, G=2, T=3
    /// - Index = sum(base[i] * 4^(k-1-i)) for i in 0..k
    ///
    /// Example for k=2: index 0=AA, 1=AC, 2=AG, 3=AT, 4=CA, ... 15=TT
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> js_sys::Uint32Array {
        let arr = js_sys::Uint32Array::new_with_length(self.counts.len() as u32);
        arr.copy_from(&self.counts);
        arr
    }

    /// Total number of valid k-mers counted (windows without N/ambiguous bases).
    #[wasm_bindgen(getter)]
    pub fn total_valid(&self) -> u64 {
        self.total_valid
    }

    /// K value used for counting.
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> usize {
        self.k
    }

    /// Get the number of unique k-mers (non-zero counts).
    #[wasm_bindgen(getter)]
    pub fn unique_count(&self) -> usize {
        self.counts.iter().filter(|&&c| c > 0).count()
    }
}

/// Error codes for dense k-mer counting.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum DenseKmerError {
    /// K value exceeds safe maximum (currently 10)
    KTooLarge = 1,
    /// K value is zero
    KZero = 2,
    /// Sequence is shorter than k
    SequenceTooShort = 3,
}

/// Dense k-mer counting with typed array output.
///
/// Uses a rolling 2-bit index algorithm with no per-position heap allocations.
/// Ambiguous bases (N and non-ACGT) reset the rolling state.
///
/// # Arguments
/// * `seq` - Sequence as bytes (ASCII). Accepts both upper and lower case.
/// * `k` - K-mer size. Must be 1 <= k <= 10 (4^10 = ~4MB max array).
///
/// # Returns
/// `DenseKmerResult` with:
/// - `counts`: Uint32Array of length 4^k (dense count vector)
/// - `total_valid`: Total valid k-mers counted
/// - `k`: K value used
/// - `unique_count`: Number of unique k-mers observed
///
/// Returns an empty result with all-zero counts if k is invalid.
///
/// # Ownership
/// Caller must call `.free()` when done to release WASM memory.
///
/// # Ambiguous Bases
/// Windows containing non-ACGT bases are skipped. The rolling state resets
/// on any ambiguous base, so no k-mer spans an N.
///
/// # Example (from JS)
/// ```js
/// const result = wasm.count_kmers_dense(sequenceBytes, 6);
/// try {
///   const counts = result.counts; // Uint32Array[4096]
///   const total = result.total_valid;
///   // Use counts...
/// } finally {
///   result.free(); // Required!
/// }
/// ```
///
/// # Determinism
/// Output is fully deterministic. No random number generation.
///
/// @see phage_explorer-vk7b.1.1
/// @see docs/WASM_ABI_SPEC.md
#[wasm_bindgen]
pub fn count_kmers_dense(seq: &[u8], k: usize) -> DenseKmerResult {
    // Validate k
    if k == 0 || k > DENSE_KMER_MAX_K {
        // Return empty result for invalid k
        return DenseKmerResult {
            counts: Vec::new(),
            total_valid: 0,
            k,
        };
    }

    // Calculate array size: 4^k
    let array_size = 1usize << (2 * k); // 4^k = 2^(2k)
    let mut counts = vec![0u32; array_size];

    // Mask for k bases: (4^k - 1) = all 1s in the lower 2k bits
    let mask = array_size - 1;

    // Rolling index state
    let mut rolling_index: usize = 0;
    let mut valid_bases: usize = 0; // How many consecutive valid bases we have
    let mut total_valid: u64 = 0;

    for &byte in seq {
        // Encode base to 2-bit value (A=0, C=1, G=2, T=3)
        let base_code = match byte {
            b'A' | b'a' => 0usize,
            b'C' | b'c' => 1usize,
            b'G' | b'g' => 2usize,
            b'T' | b't' | b'U' | b'u' => 3usize,
            _ => {
                // Ambiguous base - reset rolling state
                rolling_index = 0;
                valid_bases = 0;
                continue;
            }
        };

        // Update rolling index: shift left by 2 bits, add new base, mask to k bases
        rolling_index = ((rolling_index << 2) | base_code) & mask;
        valid_bases += 1;

        // Only count once we have k valid bases
        if valid_bases >= k {
            counts[rolling_index] = counts[rolling_index].saturating_add(1);
            total_valid += 1;
        }
    }

    DenseKmerResult {
        counts,
        total_valid,
        k,
    }
}

/// Dense k-mer counting with reverse complement combined.
///
/// Counts both forward and reverse complement k-mers into the same array.
/// Uses canonical k-mers (min of forward and RC) for strand-independent analysis.
///
/// # Arguments
/// * `seq` - Sequence as bytes (ASCII)
/// * `k` - K-mer size (1 <= k <= 10)
///
/// # Returns
/// `DenseKmerResult` with combined forward + RC counts.
///
/// # Note
/// For odd k values, forward and RC k-mers are always different.
/// For even k values, some palindromic k-mers are their own RC.
#[wasm_bindgen]
pub fn count_kmers_dense_canonical(seq: &[u8], k: usize) -> DenseKmerResult {
    // Validate k
    if k == 0 || k > DENSE_KMER_MAX_K {
        return DenseKmerResult {
            counts: Vec::new(),
            total_valid: 0,
            k,
        };
    }

    let array_size = 1usize << (2 * k);
    let mut counts = vec![0u32; array_size];
    let mask = array_size - 1;

    // We need to track both forward and reverse complement rolling indices
    let mut fwd_index: usize = 0;
    let mut rc_index: usize = 0;
    let mut valid_bases: usize = 0;
    let mut total_valid: u64 = 0;

    // Shift amount for RC: we build RC from the right (LSB)
    let rc_shift = 2 * (k - 1);

    for &byte in seq {
        // Encode base to 2-bit value
        let base_code = match byte {
            b'A' | b'a' => 0usize,
            b'C' | b'c' => 1usize,
            b'G' | b'g' => 2usize,
            b'T' | b't' | b'U' | b'u' => 3usize,
            _ => {
                fwd_index = 0;
                rc_index = 0;
                valid_bases = 0;
                continue;
            }
        };

        // Complement: A<->T (0<->3), C<->G (1<->2)
        let comp_code = 3 - base_code;

        // Forward: shift left, add new base at LSB
        fwd_index = ((fwd_index << 2) | base_code) & mask;

        // RC: shift right, add complement at MSB position
        rc_index = (rc_index >> 2) | (comp_code << rc_shift);

        valid_bases += 1;

        if valid_bases >= k {
            // Use canonical (smaller index) for strand-independent counting
            let canonical = fwd_index.min(rc_index);
            counts[canonical] = counts[canonical].saturating_add(1);
            total_valid += 1;
        }
    }

    DenseKmerResult {
        counts,
        total_valid,
        k,
    }
}

/// Check if a k value is valid for dense k-mer counting.
///
/// Returns true if 1 <= k <= DENSE_KMER_MAX_K (10).
#[wasm_bindgen]
pub fn is_valid_dense_kmer_k(k: usize) -> bool {
    k >= 1 && k <= DENSE_KMER_MAX_K
}

/// Get the maximum allowed k for dense k-mer counting.
#[wasm_bindgen]
pub fn get_dense_kmer_max_k() -> usize {
    DENSE_KMER_MAX_K
}

// ============================================================================
// MinHash Signature (rolling index, typed array output)
// Optimized for fast similarity estimation without string allocations
// See: phage_explorer-vk7b.2.1
// ============================================================================

/// Result of MinHash signature computation.
///
/// # Ownership
/// The caller must call `.free()` to release WASM memory.
#[wasm_bindgen]
pub struct MinHashSignature {
    /// Signature values (minimum hash values for each seed)
    signature: Vec<u32>,
    /// Total valid k-mers processed
    total_kmers: u64,
    /// K value used
    k: usize,
}

#[wasm_bindgen]
impl MinHashSignature {
    /// Get the signature as a Uint32Array.
    /// Length equals num_hashes parameter.
    /// Each element is the minimum hash value for that seed.
    #[wasm_bindgen(getter)]
    pub fn signature(&self) -> js_sys::Uint32Array {
        let arr = js_sys::Uint32Array::new_with_length(self.signature.len() as u32);
        arr.copy_from(&self.signature);
        arr
    }

    /// Total number of valid k-mers hashed.
    #[wasm_bindgen(getter)]
    pub fn total_kmers(&self) -> u64 {
        self.total_kmers
    }

    /// K value used for hashing.
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> usize {
        self.k
    }

    /// Number of hash functions (signature length).
    #[wasm_bindgen(getter)]
    pub fn num_hashes(&self) -> usize {
        self.signature.len()
    }
}

/// Fast 64-bit to 32-bit hash mixing (splitmix-style).
/// Takes a 64-bit k-mer index and a seed, returns a 32-bit hash.
#[inline(always)]
fn mix_hash(index: u64, seed: u32) -> u32 {
    // Combine index with seed
    let mut x = index ^ (seed as u64);
    // Splitmix64-style mixing
    x = x.wrapping_mul(0x9E3779B97F4A7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
    x = x ^ (x >> 31);
    // Take lower 32 bits
    x as u32
}

/// Compute MinHash signature using rolling k-mer index.
///
/// Uses a rolling 2-bit index algorithm with no per-k-mer string allocations.
/// Much faster than the string-based approach for long sequences.
///
/// # Arguments
/// * `seq` - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
/// * `k` - K-mer size (no practical limit, uses u64 index)
/// * `num_hashes` - Number of hash functions (signature length)
///
/// # Returns
/// MinHashSignature with `num_hashes` minimum values.
///
/// # Algorithm
/// 1. Maintain rolling 64-bit k-mer index (allows k up to 32)
/// 2. For each valid k-mer, compute hash for each seed
/// 3. Track minimum hash value per seed
/// 4. Ambiguous bases reset rolling state (no k-mer spans N)
#[wasm_bindgen]
pub fn minhash_signature(seq: &[u8], k: usize, num_hashes: usize) -> MinHashSignature {
    // Edge cases
    if k == 0 || num_hashes == 0 || seq.len() < k {
        return MinHashSignature {
            signature: vec![u32::MAX; num_hashes],
            total_kmers: 0,
            k,
        };
    }

    // Limit k to 32 for u64 index (4^32 = 2^64)
    let k = k.min(32);

    let mut signature = vec![u32::MAX; num_hashes];
    let mut total_kmers: u64 = 0;

    // Rolling state
    let mut rolling_index: u64 = 0;
    let mut valid_bases: usize = 0;
    let mask: u64 = if k >= 32 { u64::MAX } else { (1u64 << (2 * k)) - 1 };

    // Pre-compute seeds for each hash function
    let seeds: Vec<u32> = (0..num_hashes)
        .map(|i| (i as u32).wrapping_mul(0x9e3779b9))
        .collect();

    for &byte in seq {
        // Encode base: A=0, C=1, G=2, T/U=3
        let base_code: u64 = match byte {
            b'A' | b'a' => 0,
            b'C' | b'c' => 1,
            b'G' | b'g' => 2,
            b'T' | b't' | b'U' | b'u' => 3,
            _ => {
                // Ambiguous base - reset rolling state
                rolling_index = 0;
                valid_bases = 0;
                continue;
            }
        };

        // Update rolling index: shift left by 2 bits, add new base
        rolling_index = ((rolling_index << 2) | base_code) & mask;
        valid_bases += 1;

        // Once we have k valid bases, we have a valid k-mer
        if valid_bases >= k {
            total_kmers += 1;

            // Compute hash for each seed and update minimum
            for (i, &seed) in seeds.iter().enumerate() {
                let h = mix_hash(rolling_index, seed);
                if h < signature[i] {
                    signature[i] = h;
                }
            }
        }
    }

    MinHashSignature {
        signature,
        total_kmers,
        k,
    }
}

/// Compute MinHash signature using canonical k-mers (strand-independent).
///
/// For each k-mer position, uses the minimum of forward and reverse complement
/// indices before hashing. This makes the signature identical regardless of
/// which strand the sequence represents.
///
/// # Arguments
/// * `seq` - Sequence as bytes (ASCII). Case-insensitive, U treated as T.
/// * `k` - K-mer size (capped at 32 for u64 index)
/// * `num_hashes` - Number of hash functions (signature length)
///
/// # Returns
/// MinHashSignature with strand-independent hashes.
#[wasm_bindgen]
pub fn minhash_signature_canonical(seq: &[u8], k: usize, num_hashes: usize) -> MinHashSignature {
    // Edge cases
    if k == 0 || num_hashes == 0 || seq.len() < k {
        return MinHashSignature {
            signature: vec![u32::MAX; num_hashes],
            total_kmers: 0,
            k,
        };
    }

    // Limit k to 32 for u64 index
    let k = k.min(32);

    let mut signature = vec![u32::MAX; num_hashes];
    let mut total_kmers: u64 = 0;

    // Rolling state for both forward and reverse complement
    let mut fwd_index: u64 = 0;
    let mut rc_index: u64 = 0;
    let mut valid_bases: usize = 0;
    let mask: u64 = if k >= 32 { u64::MAX } else { (1u64 << (2 * k)) - 1 };
    let rc_shift = 2 * (k - 1);

    // Pre-compute seeds
    let seeds: Vec<u32> = (0..num_hashes)
        .map(|i| (i as u32).wrapping_mul(0x9e3779b9))
        .collect();

    for &byte in seq {
        // Encode base: A=0, C=1, G=2, T=3
        let (base_code, comp_code): (u64, u64) = match byte {
            b'A' | b'a' => (0, 3), // A complement is T (3)
            b'C' | b'c' => (1, 2), // C complement is G (2)
            b'G' | b'g' => (2, 1), // G complement is C (1)
            b'T' | b't' | b'U' | b'u' => (3, 0), // T complement is A (0)
            _ => {
                // Ambiguous base - reset
                fwd_index = 0;
                rc_index = 0;
                valid_bases = 0;
                continue;
            }
        };

        // Forward: shift left, add new base at LSB
        fwd_index = ((fwd_index << 2) | base_code) & mask;

        // RC: shift right, add complement at MSB position
        rc_index = (rc_index >> 2) | (comp_code << rc_shift);

        valid_bases += 1;

        if valid_bases >= k {
            total_kmers += 1;

            // Use canonical (smaller) index for strand independence
            let canonical = fwd_index.min(rc_index);

            // Compute hash for each seed
            for (i, &seed) in seeds.iter().enumerate() {
                let h = mix_hash(canonical, seed);
                if h < signature[i] {
                    signature[i] = h;
                }
            }
        }
    }

    MinHashSignature {
        signature,
        total_kmers,
        k,
    }
}

/// Estimate Jaccard similarity between two MinHash signatures.
///
/// # Arguments
/// * `sig_a` - First signature (Uint32Array)
/// * `sig_b` - Second signature (must have same length as sig_a)
///
/// # Returns
/// Estimated Jaccard similarity (0.0 to 1.0).
/// Returns 0.0 if signatures have different lengths or are empty.
#[wasm_bindgen]
pub fn minhash_jaccard_from_signatures(sig_a: &[u32], sig_b: &[u32]) -> f64 {
    if sig_a.len() != sig_b.len() || sig_a.is_empty() {
        return 0.0;
    }

    // Check for empty signatures (all MAX)
    let empty_a = sig_a.iter().all(|&v| v == u32::MAX);
    let empty_b = sig_b.iter().all(|&v| v == u32::MAX);
    if empty_a || empty_b {
        return 0.0;
    }

    let matches = sig_a.iter().zip(sig_b.iter())
        .filter(|(&a, &b)| a == b)
        .count();

    matches as f64 / sig_a.len() as f64
}

// ============================================================================
// DotPlot Kernel (flat Float32 buffers, no substring allocations)
// See: phage_explorer-gim2.1.1
// ============================================================================

#[inline(always)]
fn dotplot_upper_ascii(byte: u8) -> u8 {
    if byte >= b'a' && byte <= b'z' {
        byte - 32
    } else {
        byte
    }
}

#[inline(always)]
fn dotplot_complement_upper(byte: u8) -> u8 {
    // Must match `packages/core/src/codons.ts::reverseComplement` behavior for uppercase inputs.
    match byte {
        b'A' => b'T',
        b'T' => b'A',
        b'G' => b'C',
        b'C' => b'G',
        // Ambiguity codes (IUPAC)
        b'N' => b'N',
        b'R' => b'Y',
        b'Y' => b'R',
        b'S' => b'S',
        b'W' => b'W',
        b'K' => b'M',
        b'M' => b'K',
        b'B' => b'V',
        b'D' => b'H',
        b'H' => b'D',
        b'V' => b'B',
        // Keep unknown chars as-is (matches JS fallback path).
        _ => byte,
    }
}

/// Result buffers for dotplot computation.
///
/// # Ownership
/// The caller must call `.free()` to release WASM memory.
#[wasm_bindgen]
pub struct DotPlotBuffers {
    direct: Vec<f32>,
    inverted: Vec<f32>,
    bins: usize,
    window: usize,
}

#[wasm_bindgen]
impl DotPlotBuffers {
    /// Flattened direct identity values (row-major, bins*bins).
    #[wasm_bindgen(getter)]
    pub fn direct(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.direct.len() as u32);
        arr.copy_from(&self.direct);
        arr
    }

    /// Flattened inverted identity values (row-major, bins*bins).
    #[wasm_bindgen(getter)]
    pub fn inverted(&self) -> js_sys::Float32Array {
        let arr = js_sys::Float32Array::new_with_length(self.inverted.len() as u32);
        arr.copy_from(&self.inverted);
        arr
    }

    #[wasm_bindgen(getter)]
    pub fn bins(&self) -> usize {
        self.bins
    }

    #[wasm_bindgen(getter)]
    pub fn window(&self) -> usize {
        self.window
    }
}

/// Compute dotplot identity buffers for a sequence against itself.
///
/// Matches the semantics of `packages/core/src/analysis/dot-plot.ts` but avoids substring
/// allocations and object-heavy grids by returning flat typed arrays.
///
/// # Arguments
/// * `seq` - Sequence bytes (ASCII). Case-insensitive, U treated as T.
/// * `bins` - Plot resolution (bins x bins). If 0, returns empty buffers.
/// * `window` - Window size in bases. If 0, derives a conservative default similar to JS.
///
/// # Output layout
/// Row-major, with index `i*bins + j`.
#[wasm_bindgen]
pub fn dotplot_self_buffers(seq: &[u8], bins: usize, window: usize) -> DotPlotBuffers {
    if seq.is_empty() || bins == 0 {
        return DotPlotBuffers {
            direct: Vec::new(),
            inverted: Vec::new(),
            bins: 0,
            window: 0,
        };
    }

    // Uppercase once for JS parity: core `computeDotPlot` uses `sequence.toUpperCase()`.
    let upper: Vec<u8> = seq.iter().copied().map(dotplot_upper_ascii).collect();
    let len = upper.len();

    // Match JS default: max(20, floor(len/bins) || len), clamped to [1, len].
    let derived_window = {
        let base = if bins > 0 { len / bins } else { len };
        let base = if base == 0 { len } else { base };
        std::cmp::max(20usize, base)
    };
    let window = if window == 0 { derived_window } else { window };
    let window = std::cmp::max(1usize, std::cmp::min(len, window));

    // Precompute starts[] exactly like JS: floor(i * step) where step is float.
    let mut starts: Vec<usize> = vec![0; bins];
    if bins > 1 {
        let span = (len - window) as f64;
        let step = span / (bins as f64 - 1.0);
        for i in 0..bins {
            let s = ((i as f64) * step).floor() as usize;
            starts[i] = std::cmp::min(s, len - window);
        }
    } else if bins == 1 {
        starts[0] = 0;
    }

    let n = bins * bins;
    let mut direct = vec![0.0f32; n];
    let mut inverted = vec![0.0f32; n];
    let denom = window as f32;

    for i in 0..bins {
        let a0 = starts[i];

        for j in i..bins {
            let b0 = starts[j];

            let mut same_dir: u32 = 0;
            let mut same_inv: u32 = 0;

            // Direct: compare aligned window positions.
            // Inverted: compare reverse-complement of A window against B.
            for k in 0..window {
                let a = upper[a0 + k];
                let b = upper[b0 + k];
                if a == b {
                    same_dir += 1;
                }

                let a_rc = dotplot_complement_upper(upper[a0 + (window - 1 - k)]);
                if a_rc == b {
                    same_inv += 1;
                }
            }

            let dir_val = (same_dir as f32) / denom;
            let inv_val = (same_inv as f32) / denom;

            let idx1 = i * bins + j;
            direct[idx1] = dir_val;
            inverted[idx1] = inv_val;

            if i != j {
                let idx2 = j * bins + i;
                direct[idx2] = dir_val;
                inverted[idx2] = inv_val;
            }
        }
    }

    DotPlotBuffers {
        direct,
        inverted,
        bins,
        window,
    }
}

#[cfg(test)]
mod dotplot_tests {
    use super::*;

    #[test]
    fn dotplot_self_buffers_matches_expected_acgt() {
        // Mirrors `packages/core/src/analysis/dot-plot.test.ts` expectations.
        let result = dotplot_self_buffers(b"ACGT", 2, 2);

        assert_eq!(result.bins, 2);
        assert_eq!(result.window, 2);
        assert_eq!(result.direct.len(), 4);
        assert_eq!(result.inverted.len(), 4);

        // Row-major indices:
        // (0,0)=0 (0,1)=1
        // (1,0)=2 (1,1)=3
        assert!((result.direct[0] - 1.0).abs() < 1e-6);
        assert!((result.inverted[0] - 0.0).abs() < 1e-6);

        assert!((result.direct[1] - 0.0).abs() < 1e-6);
        assert!((result.inverted[1] - 1.0).abs() < 1e-6);

        assert!((result.direct[2] - 0.0).abs() < 1e-6);
        assert!((result.inverted[2] - 1.0).abs() < 1e-6);

        assert!((result.direct[3] - 1.0).abs() < 1e-6);
        assert!((result.inverted[3] - 0.0).abs() < 1e-6);
    }
}

// ============================================================================
// PCA (Principal Component Analysis) via Power Iteration
// Optimized matrix operations for high-dimensional genomic data
// ============================================================================

/// Result of PCA computation
#[wasm_bindgen]
pub struct PCAResult {
    /// Flattened eigenvectors (n_components * n_features), row-major
    eigenvectors: Vec<f64>,
    /// Eigenvalues for each component
    eigenvalues: Vec<f64>,
    /// Number of components computed
    n_components: usize,
    /// Number of features (dimensions)
    n_features: usize,
}

#[wasm_bindgen]
impl PCAResult {
    /// Get eigenvectors as flat array (row-major: [pc1_feat1, pc1_feat2, ..., pc2_feat1, ...])
    #[wasm_bindgen(getter)]
    pub fn eigenvectors(&self) -> Vec<f64> {
        self.eigenvectors.clone()
    }

    /// Get eigenvalues
    #[wasm_bindgen(getter)]
    pub fn eigenvalues(&self) -> Vec<f64> {
        self.eigenvalues.clone()
    }

    /// Number of components
    #[wasm_bindgen(getter)]
    pub fn n_components(&self) -> usize {
        self.n_components
    }

    /// Number of features
    #[wasm_bindgen(getter)]
    pub fn n_features(&self) -> usize {
        self.n_features
    }
}

/// Compute PCA using power iteration method.
///
/// # Arguments
/// * `data` - Flattened row-major matrix (n_samples * n_features)
/// * `n_samples` - Number of samples (rows)
/// * `n_features` - Number of features (columns)
/// * `n_components` - Number of principal components to extract
/// * `max_iterations` - Maximum iterations for power iteration (default: 100)
/// * `tolerance` - Convergence tolerance (default: 1e-8)
///
/// # Returns
/// PCAResult containing eigenvectors and eigenvalues.
///
/// # Algorithm
/// Uses power iteration to find top eigenvectors of X^T * X without forming
/// the full covariance matrix. This is memory-efficient for high-dimensional
/// data (e.g., k-mer frequencies with 4^k features).
#[wasm_bindgen]
pub fn pca_power_iteration(
    data: &[f64],
    n_samples: usize,
    n_features: usize,
    n_components: usize,
    max_iterations: usize,
    tolerance: f64,
) -> PCAResult {
    if data.len() != n_samples * n_features || n_samples == 0 || n_features == 0 {
        return PCAResult {
            eigenvectors: Vec::new(),
            eigenvalues: Vec::new(),
            n_components: 0,
            n_features,
        };
    }

    let max_iter = if max_iterations == 0 { 100 } else { max_iterations };
    let tol = if tolerance <= 0.0 { 1e-8 } else { tolerance };
    let n_comp = n_components.min(n_samples).min(n_features);

    // Compute mean for each feature
    let mut mean = vec![0.0; n_features];
    for i in 0..n_samples {
        let row_start = i * n_features;
        for j in 0..n_features {
            mean[j] += data[row_start + j];
        }
    }
    for j in 0..n_features {
        mean[j] /= n_samples as f64;
    }

    // Center the data (create centered copy)
    let mut centered = vec![0.0; n_samples * n_features];
    for i in 0..n_samples {
        let row_start = i * n_features;
        for j in 0..n_features {
            centered[row_start + j] = data[row_start + j] - mean[j];
        }
    }

    // Find principal components
    let mut eigenvectors = Vec::with_capacity(n_comp * n_features);
    let mut eigenvalues = Vec::with_capacity(n_comp);
    let mut previous_components: Vec<Vec<f64>> = Vec::new();

    for _ in 0..n_comp {
        let (eigenvector, eigenvalue) = power_iteration_single(
            &centered,
            n_samples,
            n_features,
            &previous_components,
            max_iter,
            tol,
        );

        eigenvectors.extend(&eigenvector);
        eigenvalues.push(eigenvalue);
        previous_components.push(eigenvector);
    }

    PCAResult {
        eigenvectors,
        eigenvalues,
        n_components: n_comp,
        n_features,
    }
}

/// Single power iteration to find one eigenvector
fn power_iteration_single(
    centered: &[f64],
    n_samples: usize,
    n_features: usize,
    previous_components: &[Vec<f64>],
    max_iterations: usize,
    tolerance: f64,
) -> (Vec<f64>, f64) {
    // Initialize with pseudo-random vector (deterministic for reproducibility)
    let mut v: Vec<f64> = (0..n_features)
        .map(|i| ((i * 7919 + 104729) % 1000) as f64 / 1000.0 - 0.5)
        .collect();

    // Remove projections onto previous components
    for pc in previous_components {
        deflate_vec(&mut v, pc);
    }
    normalize_vec(&mut v);

    let mut eigenvalue = 0.0;

    for _ in 0..max_iterations {
        // Compute X^T * X * v = X^T * (X * v)
        // First: Xv = X * v (n_samples x 1)
        let xv = multiply_xv(centered, &v, n_samples, n_features);

        // Then: X^T * Xv (n_features x 1)
        let mut xtxv = multiply_xt_u(centered, &xv, n_samples, n_features);

        // Remove projections onto previous components
        for pc in previous_components {
            deflate_vec(&mut xtxv, pc);
        }

        // Compute eigenvalue (Rayleigh quotient)
        let new_eigenvalue = dot_product_vec(&v, &xtxv);

        // Normalize to get new eigenvector estimate
        normalize_vec(&mut xtxv);

        // Check convergence
        let diff: f64 = v.iter().zip(xtxv.iter()).map(|(a, b)| (a - b).abs()).sum();

        v = xtxv;
        eigenvalue = new_eigenvalue;

        if diff < tolerance {
            break;
        }
    }

    // Scale eigenvalue by (n_samples - 1) for sample covariance
    let scaled_eigenvalue = if n_samples > 1 {
        eigenvalue / (n_samples - 1) as f64
    } else {
        eigenvalue
    };

    (v, scaled_eigenvalue)
}

/// Multiply X (row-major, n x d) by vector v (d x 1), returns (n x 1)
fn multiply_xv(x: &[f64], v: &[f64], n_samples: usize, n_features: usize) -> Vec<f64> {
    let mut result = vec![0.0; n_samples];
    for i in 0..n_samples {
        let row_start = i * n_features;
        let mut sum = 0.0;
        for j in 0..n_features {
            sum += x[row_start + j] * v[j];
        }
        result[i] = sum;
    }
    result
}

/// Multiply X^T (d x n) by vector u (n x 1), returns (d x 1)
fn multiply_xt_u(x: &[f64], u: &[f64], n_samples: usize, n_features: usize) -> Vec<f64> {
    let mut result = vec![0.0; n_features];
    for i in 0..n_samples {
        let row_start = i * n_features;
        let ui = u[i];
        for j in 0..n_features {
            result[j] += x[row_start + j] * ui;
        }
    }
    result
}

/// Remove projection of v onto u: v = v - (v·u) * u
fn deflate_vec(v: &mut [f64], u: &[f64]) {
    let proj = dot_product_vec(v, u);
    for i in 0..v.len() {
        v[i] -= proj * u[i];
    }
}

/// Normalize vector in place to unit length
fn normalize_vec(v: &mut [f64]) {
    let norm: f64 = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Dot product of two vectors
fn dot_product_vec(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

// ============================================================================
// Hoeffding's D - Measures statistical dependence between two vectors
// Based on: https://github.com/Dicklesworthstone/fast_vector_similarity
// ============================================================================

/// Compute average ranks for a vector, handling ties correctly.
/// Returns a vector of ranks where ties receive the average of their positions.
fn average_rank(data: &[f64]) -> Vec<f64> {
    let n = data.len();
    if n == 0 {
        return Vec::new();
    }

    // Create index-value pairs and sort by value
    let mut indexed: Vec<(usize, f64)> = data.iter().cloned().enumerate().collect();
    indexed.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut ranks = vec![0.0; n];
    let mut i = 0;

    while i < n {
        // Find all elements with the same value (ties)
        let mut j = i;
        let mut total_rank = 0.0;

        while j < n && indexed[j].1 == indexed[i].1 {
            total_rank += (j + 1) as f64; // Ranks are 1-based
            j += 1;
        }

        // Assign average rank to all tied elements
        let avg_rank = total_rank / (j - i) as f64;
        for k in i..j {
            ranks[indexed[k].0] = avg_rank;
        }

        i = j;
    }

    ranks
}

/// Result of Hoeffding's D computation
#[wasm_bindgen]
pub struct HoeffdingResult {
    /// Hoeffding's D statistic. Range: approximately [-0.5, 1]
    /// Values near 0 indicate independence, larger values indicate dependence.
    /// Unlike correlation, captures non-linear relationships.
    pub d: f64,
    /// Number of observations used
    pub n: usize,
}

/// Compute Hoeffding's D statistic for measuring statistical dependence.
///
/// Hoeffding's D is a non-parametric measure of association that can detect
/// any type of dependence (linear or non-linear) between two variables.
/// Unlike Pearson correlation (linear only) or Spearman/Kendall (monotonic),
/// Hoeffding's D can detect complex non-monotonic relationships.
///
/// # Arguments
/// * `x` - First vector of observations (as a JS Float64Array)
/// * `y` - Second vector of observations (must have same length as x)
///
/// # Returns
/// HoeffdingResult containing the D statistic and sample size.
/// D ranges approximately from -0.5 to 1, where:
/// - D ≈ 0: variables are independent
/// - D > 0: variables are dependent
/// - D = 1: perfect dependence
///
/// # Performance
/// O(n²) time complexity. For very large vectors (n > 10000), consider
/// sampling or using approximate methods.
///
/// # Example Use Cases for Genome Analysis
/// - Compare k-mer frequency vectors between genomes
/// - Detect non-linear relationships in GC content distributions
/// - Measure codon usage similarity accounting for complex dependencies
#[wasm_bindgen]
pub fn hoeffdings_d(x: &[f64], y: &[f64]) -> HoeffdingResult {
    let n = x.len();

    // Handle edge cases
    if n != y.len() || n < 5 {
        return HoeffdingResult { d: 0.0, n };
    }

    let nf = n as f64;

    // Compute ranks (1-based, with ties handled via average)
    let r = average_rank(x);
    let s = average_rank(y);

    // Compute Q values for each observation
    // Q[i] = 1 + (number of points with both x and y less than point i)
    //        + 0.25 * (number of points with both x and y equal to point i, excluding i itself)
    //        + 0.5 * (number of points with x equal and y less, plus x less and y equal)
    let mut q = vec![0.0; n];

    for i in 0..n {
        let ri = r[i];
        let si = s[i];

        let mut less_than = 0.0;
        let mut equal_both = 0.0;
        let mut equal_r = 0.0;
        let mut equal_s = 0.0;

        for j in 0..n {
            if i == j {
                continue;
            }

            let rj = r[j];
            let sj = s[j];

            if rj < ri && sj < si {
                less_than += 1.0;
            } else if rj == ri && sj == si {
                equal_both += 1.0;
            } else if rj == ri && sj < si {
                equal_r += 1.0;
            } else if rj < ri && sj == si {
                equal_s += 1.0;
            }
        }

        q[i] = 1.0 + less_than + 0.25 * equal_both + 0.5 * (equal_r + equal_s);
    }

    // Compute the three D terms
    // D1 = sum of (Q[i] - 1) * (Q[i] - 3)
    // Note: This is (Q-1) * ((Q-1) - 2), matching the standard Hoeffding's D formula
    let d1: f64 = q.iter().map(|&qi| (qi - 1.0) * (qi - 3.0)).sum();

    // D2 = sum of (R[i] - 1) * (R[i] - 2) * (S[i] - 1) * (S[i] - 2)
    let d2: f64 = r.iter()
        .zip(s.iter())
        .map(|(&ri, &si)| (ri - 1.0) * (ri - 2.0) * (si - 1.0) * (si - 2.0))
        .sum();

    // D3 = sum of (R[i] - 1) * (S[i] - 1) * (Q[i] - 1)
    let d3: f64 = r.iter()
        .zip(s.iter())
        .zip(q.iter())
        .map(|((&ri, &si), &qi)| (ri - 1.0) * (si - 1.0) * (qi - 1.0))
        .sum();

    // Hoeffding's D formula
    // D = 30 * ((n-2)(n-3) * D1 + D2 - 2(n-2) * D3) / (n(n-1)(n-2)(n-3)(n-4))
    let denom = nf * (nf - 1.0) * (nf - 2.0) * (nf - 3.0) * (nf - 4.0);
    let numerator = 30.0 * ((nf - 2.0) * (nf - 3.0) * d1 + d2 - 2.0 * (nf - 2.0) * d3);

    let d = if denom.abs() > 1e-10 {
        numerator / denom
    } else {
        0.0
    };

    HoeffdingResult { d, n }
}

/// Compute Hoeffding's D between two k-mer frequency vectors derived from sequences.
///
/// This is a convenience function that:
/// 1. Extracts k-mer frequencies from both sequences
/// 2. Creates aligned frequency vectors for all unique k-mers
/// 3. Computes Hoeffding's D on the frequency vectors
///
/// # Arguments
/// * `sequence_a` - First DNA sequence
/// * `sequence_b` - Second DNA sequence
/// * `k` - K-mer size (typically 3-7 for genome comparison)
///
/// # Returns
/// Hoeffding's D statistic measuring dependence between k-mer frequency profiles.
/// Higher values indicate more similar frequency patterns (non-linear similarity).
#[wasm_bindgen]
pub fn kmer_hoeffdings_d(sequence_a: &str, sequence_b: &str, k: usize) -> HoeffdingResult {
    if k == 0 {
        return HoeffdingResult { d: 0.0, n: 0 };
    }

    let freqs_a = extract_kmer_freqs(sequence_a, k);
    let freqs_b = extract_kmer_freqs(sequence_b, k);

    if freqs_a.is_empty() && freqs_b.is_empty() {
        return HoeffdingResult { d: 1.0, n: 0 }; // Both empty = perfect agreement
    }

    // Build aligned vectors: include all k-mers from both sequences
    let mut all_kmers: Vec<&String> = freqs_a.keys().chain(freqs_b.keys()).collect();
    all_kmers.sort();
    all_kmers.dedup();

    let n = all_kmers.len();
    if n < 5 {
        // Not enough data points for meaningful Hoeffding's D
        return HoeffdingResult { d: 0.0, n };
    }

    let x: Vec<f64> = all_kmers.iter()
        .map(|kmer| *freqs_a.get(*kmer).unwrap_or(&0) as f64)
        .collect();
    let y: Vec<f64> = all_kmers.iter()
        .map(|kmer| *freqs_b.get(*kmer).unwrap_or(&0) as f64)
        .collect();

    hoeffdings_d(&x, &y)
}

// ============================================================================
// Entropy Functions - Information-theoretic sequence analysis
// ============================================================================

/// Compute Shannon entropy from a probability distribution.
///
/// H(X) = -Σ p(x) * log2(p(x))
///
/// # Arguments
/// * `probs` - Probability distribution (must sum to ~1.0)
///
/// # Returns
/// Shannon entropy in bits. Returns 0 for empty or invalid input.
#[wasm_bindgen]
pub fn shannon_entropy(probs: &[f64]) -> f64 {
    if probs.is_empty() {
        return 0.0;
    }

    let mut entropy = 0.0;
    for &p in probs {
        if p > 0.0 && p <= 1.0 {
            entropy -= p * p.log2();
        }
    }

    // Clamp to non-negative (numerical precision issues can make it slightly negative)
    entropy.max(0.0)
}

/// Compute Shannon entropy from a frequency count array.
/// Converts counts to probabilities internally.
///
/// # Arguments
/// * `counts` - Array of frequency counts
///
/// # Returns
/// Shannon entropy in bits.
#[wasm_bindgen]
pub fn shannon_entropy_from_counts(counts: &[f64]) -> f64 {
    let total: f64 = counts.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }

    let mut entropy = 0.0;
    for &count in counts {
        if count > 0.0 {
            let p = count / total;
            entropy -= p * p.log2();
        }
    }

    entropy.max(0.0)
}

/// Compute Jensen-Shannon Divergence between two probability distributions.
///
/// JSD(P || Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M)
/// where M = 0.5 * (P + Q)
///
/// This is a symmetric and bounded (0 to 1 when using log2) divergence measure.
///
/// # Arguments
/// * `p` - First probability distribution
/// * `q` - Second probability distribution (must have same length as p)
///
/// # Returns
/// JSD value in range [0, 1]. Returns 0 if inputs are identical, 1 if completely different.
#[wasm_bindgen]
pub fn jensen_shannon_divergence(p: &[f64], q: &[f64]) -> f64 {
    if p.len() != q.len() || p.is_empty() {
        return 0.0;
    }

    let n = p.len();
    let mut jsd = 0.0;

    for i in 0..n {
        let pi = p[i].max(0.0);
        let qi = q[i].max(0.0);
        let mi = 0.5 * (pi + qi);

        if mi > 0.0 {
            if pi > 0.0 {
                jsd += 0.5 * pi * (pi / mi).log2();
            }
            if qi > 0.0 {
                jsd += 0.5 * qi * (qi / mi).log2();
            }
        }
    }

    // Clamp to valid range [0, 1]
    jsd.max(0.0).min(1.0)
}

/// Compute JSD between two count arrays.
/// Normalizes to probabilities internally.
#[wasm_bindgen]
pub fn jensen_shannon_divergence_from_counts(counts_a: &[f64], counts_b: &[f64]) -> f64 {
    if counts_a.len() != counts_b.len() || counts_a.is_empty() {
        return 0.0;
    }

    let total_a: f64 = counts_a.iter().sum();
    let total_b: f64 = counts_b.iter().sum();

    if total_a <= 0.0 || total_b <= 0.0 {
        return if total_a <= 0.0 && total_b <= 0.0 { 0.0 } else { 1.0 };
    }

    let p: Vec<f64> = counts_a.iter().map(|&c| c / total_a).collect();
    let q: Vec<f64> = counts_b.iter().map(|&c| c / total_b).collect();

    jensen_shannon_divergence(&p, &q)
}

// ============================================================================
// Repeat Detection - Palindromes and Tandem Repeats
// ============================================================================

/// Result of repeat detection
#[wasm_bindgen]
pub struct RepeatResult {
    /// JSON-encoded array of detected repeats
    json: String,
}

#[wasm_bindgen]
impl RepeatResult {
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
}

/// Detect palindromic (inverted repeat) sequences in DNA.
///
/// A palindrome in DNA is a sequence that reads the same on the complementary
/// strand in reverse (e.g., GAATTC and its complement CTTAAG reversed).
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `min_len` - Minimum palindrome arm length (typically 4-6)
/// * `max_gap` - Maximum gap/spacer between palindrome arms (0 for perfect palindromes)
///
/// # Returns
/// RepeatResult with JSON array of {start, end, arm_length, gap, sequence}
#[wasm_bindgen]
pub fn detect_palindromes(seq: &str, min_len: usize, max_gap: usize) -> RepeatResult {
    let bytes = seq.as_bytes();
    let n = bytes.len();
    let mut results: Vec<String> = Vec::new();

    if n < min_len * 2 {
        return RepeatResult { json: "[]".to_string() };
    }

    // Check every potential center position
    for center in min_len..(n - min_len + 1) {
        for gap in 0..=max_gap {
            if center < min_len + gap / 2 || center + gap / 2 + min_len > n {
                continue;
            }

            let half_gap = gap / 2;
            let mut arm_len = 0;

            // Expand outward checking for complementary bases
            for offset in 0..min_len.max((n - center - half_gap).min(center - half_gap)) {
                let left_idx = center - half_gap - offset - 1;
                let right_idx = center + half_gap + offset;

                if right_idx >= n {
                    break;
                }

                let left_base = bytes[left_idx];
                let right_base = bytes[right_idx];

                if is_complement(left_base, right_base) {
                    arm_len = offset + 1;
                } else {
                    break;
                }
            }

            if arm_len >= min_len {
                let start = center - half_gap - arm_len;
                let end = center + half_gap + arm_len;
                let subseq = std::str::from_utf8(&bytes[start..end]).unwrap_or("");

                results.push(format!(
                    "{{\"start\":{},\"end\":{},\"arm_length\":{},\"gap\":{},\"sequence\":\"{}\"}}",
                    start, end, arm_len, gap, subseq
                ));
            }
        }
    }

    RepeatResult {
        json: format!("[{}]", results.join(",")),
    }
}

/// Check if two bases are complements
fn is_complement(a: u8, b: u8) -> bool {
    matches!(
        (a.to_ascii_uppercase(), b.to_ascii_uppercase()),
        (b'A', b'T') | (b'T', b'A') | (b'G', b'C') | (b'C', b'G') |
        (b'A', b'U') | (b'U', b'A')
    )
}

/// Detect tandem repeats (consecutive copies of a pattern).
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `min_unit` - Minimum repeat unit length
/// * `max_unit` - Maximum repeat unit length
/// * `min_copies` - Minimum number of consecutive copies
///
/// # Returns
/// RepeatResult with JSON array of {start, end, unit, copies, sequence}
#[wasm_bindgen]
pub fn detect_tandem_repeats(
    seq: &str,
    min_unit: usize,
    max_unit: usize,
    min_copies: usize,
) -> RepeatResult {
    let bytes = seq.as_bytes();
    let n = bytes.len();
    let mut results: Vec<String> = Vec::new();

    if n < min_unit * min_copies {
        return RepeatResult { json: "[]".to_string() };
    }

    // For each starting position
    for start in 0..n {
        // For each unit length
        for unit_len in min_unit..=max_unit.min(n - start) {
            let unit = &bytes[start..start + unit_len];

            // Count consecutive copies
            let mut copies = 1;
            let mut pos = start + unit_len;

            while pos + unit_len <= n {
                let candidate = &bytes[pos..pos + unit_len];
                if candidate.eq_ignore_ascii_case(unit) {
                    copies += 1;
                    pos += unit_len;
                } else {
                    break;
                }
            }

            if copies >= min_copies {
                let end = start + copies * unit_len;
                let unit_str = std::str::from_utf8(unit).unwrap_or("").to_uppercase();
                let subseq = std::str::from_utf8(&bytes[start..end]).unwrap_or("");

                results.push(format!(
                    "{{\"start\":{},\"end\":{},\"unit\":\"{}\",\"copies\":{},\"sequence\":\"{}\"}}",
                    start, end, unit_str, copies, subseq
                ));
            }
        }
    }

    RepeatResult {
        json: format!("[{}]", results.join(",")),
    }
}

// ============================================================================
// GC Skew and Sequence Complexity
// ============================================================================

/// Compute GC skew using a sliding window.
///
/// GC skew = (G - C) / (G + C)
///
/// GC skew is used to identify the origin and terminus of replication in
/// bacterial genomes. Positive skew indicates leading strand, negative
/// indicates lagging strand.
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `window_size` - Size of sliding window
/// * `step_size` - Step between windows (1 for maximum resolution)
///
/// # Returns
/// Array of GC skew values for each window position.
#[wasm_bindgen]
pub fn compute_gc_skew(seq: &str, window_size: usize, step_size: usize) -> Vec<f64> {
    let bytes = seq.as_bytes();
    let n = bytes.len();

    if window_size == 0 || step_size == 0 || n < window_size {
        return Vec::new();
    }

    let num_windows = (n - window_size) / step_size + 1;
    let mut results = Vec::with_capacity(num_windows);

    for i in 0..num_windows {
        let start = i * step_size;
        let window = &bytes[start..start + window_size];

        let mut g_count = 0u32;
        let mut c_count = 0u32;

        for &base in window {
            match base {
                b'G' | b'g' => g_count += 1,
                b'C' | b'c' => c_count += 1,
                _ => {}
            }
        }

        let total = g_count + c_count;
        let skew = if total > 0 {
            (g_count as f64 - c_count as f64) / total as f64
        } else {
            0.0
        };

        results.push(skew);
    }

    results
}

/// Compute cumulative GC skew (useful for visualizing replication origin).
///
/// The cumulative skew will have a minimum at the origin of replication
/// and maximum at the terminus.
#[wasm_bindgen]
pub fn compute_cumulative_gc_skew(seq: &str) -> Vec<f64> {
    let bytes = seq.as_bytes();
    let mut cumulative = Vec::with_capacity(bytes.len());
    let mut sum = 0.0;

    for &base in bytes {
        match base {
            b'G' | b'g' => sum += 1.0,
            b'C' | b'c' => sum -= 1.0,
            _ => {}
        }
        cumulative.push(sum);
    }

    cumulative
}

/// Compute linguistic complexity of a sequence.
///
/// Linguistic complexity = (number of distinct substrings) / (maximum possible substrings)
///
/// This measures how "random" or information-rich a sequence is.
/// Low complexity indicates repetitive regions.
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `max_k` - Maximum substring length to consider
///
/// # Returns
/// Complexity score in range [0, 1] where 1 = maximum complexity.
#[wasm_bindgen]
pub fn compute_linguistic_complexity(seq: &str, max_k: usize) -> f64 {
    let bytes = seq.as_bytes();
    let n = bytes.len();

    if n == 0 || max_k == 0 {
        return 0.0;
    }

    let max_k = max_k.min(n);
    let mut total_distinct = 0u64;
    let mut total_possible = 0u64;

    for k in 1..=max_k {
        let mut seen: std::collections::HashSet<&[u8]> = std::collections::HashSet::new();

        for i in 0..=n.saturating_sub(k) {
            seen.insert(&bytes[i..i + k]);
        }

        total_distinct += seen.len() as u64;

        // Maximum possible distinct k-mers is min(4^k, n-k+1) for DNA
        let max_possible = (4u64.pow(k as u32)).min((n - k + 1) as u64);
        total_possible += max_possible;
    }

    if total_possible == 0 {
        0.0
    } else {
        total_distinct as f64 / total_possible as f64
    }
}

/// Compute local complexity in sliding windows.
///
/// # Arguments
/// * `seq` - DNA sequence string
/// * `window_size` - Size of sliding window
/// * `step_size` - Step between windows
/// * `k` - K-mer size for complexity calculation
///
/// # Returns
/// Array of complexity values for each window.
#[wasm_bindgen]
pub fn compute_windowed_complexity(
    seq: &str,
    window_size: usize,
    step_size: usize,
    k: usize,
) -> Vec<f64> {
    let bytes = seq.as_bytes();
    let n = bytes.len();

    if window_size == 0 || step_size == 0 || k == 0 || n < window_size || k > window_size {
        return Vec::new();
    }

    let num_windows = (n - window_size) / step_size + 1;
    let mut results = Vec::with_capacity(num_windows);

    for i in 0..num_windows {
        let start = i * step_size;
        let window = &bytes[start..start + window_size];

        // Count distinct k-mers in this window
        let mut seen: std::collections::HashSet<&[u8]> = std::collections::HashSet::new();
        for j in 0..=window.len().saturating_sub(k) {
            seen.insert(&window[j..j + k]);
        }

        let distinct = seen.len() as f64;
        let max_possible = (4u64.pow(k as u32) as f64).min((window.len() - k + 1) as f64);

        let complexity = if max_possible > 0.0 {
            distinct / max_possible
        } else {
            0.0
        };

        results.push(complexity);
    }

    results
}

// ============================================================================
// Grid Building - HOT PATH for viewport rendering
// ============================================================================

/// Result of grid building for sequence viewport
#[wasm_bindgen]
pub struct GridResult {
    /// JSON-encoded grid data
    json: String,
}

#[wasm_bindgen]
impl GridResult {
    #[wasm_bindgen(getter)]
    pub fn json(&self) -> String {
        self.json.clone()
    }
}

// ============================================================================
// Spatial-Hash Bond Detection - O(N) algorithm for molecular structure
// ============================================================================

/// Element covalent radii in Angstroms for bond detection
/// Matches the JavaScript implementation exactly for consistency
const fn element_radius(element: u8) -> f32 {
    match element {
        b'H' => 0.31,
        b'C' => 0.76,
        b'N' => 0.71,
        b'O' => 0.66,
        b'S' => 1.05,
        b'P' => 1.07,
        _ => 0.80, // Default for unknown elements
    }
}

/// Maximum possible bond distance: (1.07 + 1.07) * 1.25 = 2.675 Å
/// We use 2.7 Å as the cell size for the spatial hash
const CELL_SIZE: f32 = 2.7;
const BOND_TOLERANCE: f32 = 1.25;

/// Result of bond detection
#[wasm_bindgen]
pub struct BondDetectionResult {
    /// Flat array of bond pairs: [a0, b0, a1, b1, ...]
    /// Each pair (a, b) represents a bond between atom indices a and b
    bonds: Vec<u32>,
    /// Number of bonds found
    bond_count: usize,
}

#[wasm_bindgen]
impl BondDetectionResult {
    /// Get bonds as flat array [a0, b0, a1, b1, ...]
    #[wasm_bindgen(getter)]
    pub fn bonds(&self) -> Vec<u32> {
        self.bonds.clone()
    }

    /// Get the number of bonds
    #[wasm_bindgen(getter)]
    pub fn bond_count(&self) -> usize {
        self.bond_count
    }
}

/// Spatial hash grid for O(1) neighbor lookups
struct SpatialHash {
    cells: HashMap<(i32, i32, i32), Vec<usize>>,
    cell_size: f32,
}

impl SpatialHash {
    fn new(cell_size: f32) -> Self {
        SpatialHash {
            cells: HashMap::new(),
            cell_size,
        }
    }

    #[inline]
    fn cell_coords(&self, x: f32, y: f32, z: f32) -> (i32, i32, i32) {
        (
            (x / self.cell_size).floor() as i32,
            (y / self.cell_size).floor() as i32,
            (z / self.cell_size).floor() as i32,
        )
    }

    fn insert(&mut self, idx: usize, x: f32, y: f32, z: f32) {
        let coords = self.cell_coords(x, y, z);
        self.cells.entry(coords).or_insert_with(Vec::new).push(idx);
    }

    /// Get indices of atoms in the same and neighboring cells (27 cells total)
    fn get_neighbors(&self, x: f32, y: f32, z: f32) -> impl Iterator<Item = usize> + '_ {
        let (cx, cy, cz) = self.cell_coords(x, y, z);

        // Iterate over 3x3x3 neighboring cells
        (-1..=1).flat_map(move |dx| {
            (-1..=1).flat_map(move |dy| {
                (-1..=1).flat_map(move |dz| {
                    self.cells
                        .get(&(cx + dx, cy + dy, cz + dz))
                        .map(|v| v.iter().copied())
                        .into_iter()
                        .flatten()
                })
            })
        })
    }
}

/// Detect bonds using spatial hashing for O(N) complexity.
///
/// This is the CRITICAL optimization replacing the O(N²) algorithm.
/// For a 50,000 atom structure:
/// - Old: 1.25 billion comparisons → 30-60+ seconds
/// - New: ~1 million comparisons → <1 second
///
/// # Arguments
/// * `positions` - Flat array of atom positions [x0, y0, z0, x1, y1, z1, ...]
/// * `elements` - String of element symbols (one char per atom: "CCCCNNO...")
///
/// # Returns
/// BondDetectionResult with pairs of bonded atom indices.
///
/// # Algorithm
/// 1. Build spatial hash with cell size = max bond distance (~2.7Å)
/// 2. For each atom, only check atoms in neighboring 27 cells
/// 3. Reduces O(N²) to O(N * k) where k ≈ 20 atoms per neighborhood
#[wasm_bindgen]
pub fn detect_bonds_spatial(positions: &[f32], elements: &str) -> BondDetectionResult {
    let num_atoms = elements.len();

    // Validate input
    if positions.len() != num_atoms * 3 {
        return BondDetectionResult {
            bonds: Vec::new(),
            bond_count: 0,
        };
    }

    if num_atoms == 0 {
        return BondDetectionResult {
            bonds: Vec::new(),
            bond_count: 0,
        };
    }

    let element_bytes = elements.as_bytes();

    // Build spatial hash
    let mut grid = SpatialHash::new(CELL_SIZE);
    for i in 0..num_atoms {
        let x = positions[i * 3];
        let y = positions[i * 3 + 1];
        let z = positions[i * 3 + 2];
        grid.insert(i, x, y, z);
    }

    // Detect bonds using spatial hash
    let mut bonds = Vec::with_capacity(num_atoms * 4); // Estimate ~4 bonds per atom

    for i in 0..num_atoms {
        let x1 = positions[i * 3];
        let y1 = positions[i * 3 + 1];
        let z1 = positions[i * 3 + 2];
        let r1 = element_radius(element_bytes[i]);

        // Only check neighboring cells
        for j in grid.get_neighbors(x1, y1, z1) {
            // Only check j > i to avoid duplicate bonds
            if j <= i {
                continue;
            }

            let x2 = positions[j * 3];
            let y2 = positions[j * 3 + 1];
            let z2 = positions[j * 3 + 2];

            let dx = x1 - x2;
            let dy = y1 - y2;
            let dz = z1 - z2;
            let dist_sq = dx * dx + dy * dy + dz * dz;

            let r2 = element_radius(element_bytes[j]);
            let threshold = (r1 + r2) * BOND_TOLERANCE;
            let threshold_sq = threshold * threshold;

            if dist_sq <= threshold_sq {
                bonds.push(i as u32);
                bonds.push(j as u32);
            }
        }
    }

    let bond_count = bonds.len() / 2;
    BondDetectionResult { bonds, bond_count }
}

// ============================================================================
// Grid Building - HOT PATH for viewport rendering
// ============================================================================

/// Build a grid of sequence data for viewport rendering.
///
/// This is the HOT PATH called on every scroll. Optimized for minimal
/// allocations and fast character processing.
///
/// # Arguments
/// * `seq` - Full sequence string
/// * `start_index` - Starting position in sequence (0-based)
/// * `cols` - Number of columns in grid
/// * `rows` - Number of rows in grid
/// * `mode` - Display mode: "dna", "aa", or "dual"
/// * `frame` - Reading frame for AA translation (0, 1, or 2)
///
/// # Returns
/// GridResult with JSON-encoded rows, each containing:
/// - cells: array of {char, phase, is_stop, is_start} for DNA mode
/// - cells: array of {char, codon, is_stop, is_start} for AA mode
#[wasm_bindgen]
pub fn build_grid(
    seq: &str,
    start_index: usize,
    cols: usize,
    rows: usize,
    mode: &str,
    frame: i8,
) -> GridResult {
    let bytes = seq.as_bytes();
    let n = bytes.len();

    if cols == 0 || rows == 0 || start_index >= n {
        return GridResult { json: "[]".to_string() };
    }

    let frame = frame.rem_euclid(3) as usize;
    let mode_is_aa = mode == "aa";
    let _mode_is_dual = mode == "dual"; // Reserved for future dual-view support

    let mut result_rows: Vec<String> = Vec::with_capacity(rows);

    for row in 0..rows {
        let row_start = start_index + row * cols;
        if row_start >= n {
            break;
        }

        let row_end = (row_start + cols).min(n);
        let mut cells: Vec<String> = Vec::with_capacity(cols);

        if mode_is_aa {
            // Amino acid mode: translate codons
            let mut i = row_start;
            // Adjust to codon boundary
            let offset = (i as i64 - frame as i64).rem_euclid(3) as usize;
            if offset != 0 {
                i += 3 - offset;
            }

            while i + 3 <= row_end && i + 3 <= n {
                let aa = codon_to_aa(bytes[i], bytes[i + 1], bytes[i + 2]);
                let codon: String = bytes[i..i + 3]
                    .iter()
                    .map(|&b| (b as char).to_ascii_uppercase())
                    .collect();

                let is_stop = aa == b'*';
                let is_start = aa == b'M';

                cells.push(format!(
                    "{{\"char\":\"{}\",\"codon\":\"{}\",\"pos\":{},\"is_stop\":{},\"is_start\":{}}}",
                    aa as char, codon, i, is_stop, is_start
                ));

                i += 3;
            }
        } else {
            // DNA mode (or dual)
            for i in row_start..row_end {
                let base = bytes[i];
                let char_upper = (base as char).to_ascii_uppercase();

                // Calculate codon phase (position within codon)
                let phase = ((i as i64 - frame as i64).rem_euclid(3)) as u8;

                // Check if this position starts a stop or start codon
                let (is_stop, is_start) = if phase == 0 && i + 3 <= n {
                    let aa = codon_to_aa(bytes[i], bytes[i + 1], bytes[i + 2]);
                    (aa == b'*', aa == b'M')
                } else {
                    (false, false)
                };

                cells.push(format!(
                    "{{\"char\":\"{}\",\"pos\":{},\"phase\":{},\"is_stop\":{},\"is_start\":{}}}",
                    char_upper, i, phase, is_stop, is_start
                ));
            }
        }

        let row_json = format!(
            "{{\"row\":{},\"start\":{},\"end\":{},\"cells\":[{}]}}",
            row,
            row_start,
            row_end,
            cells.join(",")
        );
        result_rows.push(row_json);
    }

    GridResult {
        json: format!("[{}]", result_rows.join(",")),
    }
}

// ============================================================================
// Sequence Rendering Optimizations (Hot Path)
// ============================================================================
//
// STATUS: NOT CURRENTLY WIRED IN
//
// These functions were written as potential WASM optimizations for
// CanvasSequenceGridRenderer.ts, but are NOT currently used. The JS
// implementation was already optimized with single-pass run-length encoding
// algorithms that achieve 60fps rendering.
//
// Why not wired in:
// 1. The JS implementation is already efficient (single-pass, typed arrays)
// 2. WASM boundary overhead (data copying, async loading) may negate gains
// 3. For typical genome sizes (50-300kb), JS renders in <3ms per frame
// 4. Adding optional WASM loading adds complexity without clear benefit
//
// When to consider wiring in:
// - If profiling shows renderMicroBatch is a bottleneck (>8ms/frame)
// - For very large sequences (>1MB) where WASM's tighter loops help
// - If we add multi-threaded rendering via Web Workers + SharedArrayBuffer
//
// To wire in: Add optional WASM loading in CanvasSequenceGridRenderer.ts
// and call these functions instead of the JS equivalents when available.
//
// See: packages/web/src/rendering/CanvasSequenceGridRenderer.ts
//      - encodeSequence() at line ~33 (JS equivalent of encode_sequence_fast)
//      - renderMicroBatch() at line ~833 (JS equivalent of compute_micro_runs)
// ============================================================================

/// Fast sequence encoding for canvas rendering.
///
/// **STATUS: NOT WIRED IN** - JS `encodeSequence()` is used instead.
/// Kept for future optimization if profiling shows encoding is a bottleneck.
///
/// Encodes nucleotide characters to numeric codes:
/// - A/a -> 0, C/c -> 1, G/g -> 2, T/t/U/u -> 3, other -> 4 (N)
///
/// This would be used by CanvasSequenceGridRenderer for O(1) lookups during rendering.
/// WASM version is ~4x faster than JS for large sequences due to tighter loops,
/// but encoding only happens once per sequence change (not per frame).
///
/// # Arguments
/// * `seq` - DNA/RNA sequence string
///
/// # Returns
/// Uint8Array with encoded values (0-4)
#[wasm_bindgen]
pub fn encode_sequence_fast(seq: &str) -> Vec<u8> {
    let bytes = seq.as_bytes();
    let mut encoded = Vec::with_capacity(bytes.len());

    for &b in bytes {
        let code = match b {
            b'A' | b'a' => 0,
            b'C' | b'c' => 1,
            b'G' | b'g' => 2,
            b'T' | b't' | b'U' | b'u' => 3,
            _ => 4, // N or other
        };
        encoded.push(code);
    }

    encoded
}

/// Compute color runs for micro batch rendering.
///
/// **STATUS: NOT WIRED IN** - JS `renderMicroBatch()` is used instead.
/// Kept for future optimization if profiling shows rendering is a bottleneck.
/// The JS version already uses the same single-pass algorithm and achieves 60fps.
///
/// This performs single-pass run-length encoding on an encoded sequence,
/// producing runs grouped by color. The output is a flat Float32Array where
/// every 4 values represent: [color_code, row_y, x, width].
///
/// Runs are sorted by color so the JS renderer only needs 5 fillStyle changes.
///
/// # Arguments
/// * `encoded` - Pre-encoded sequence (values 0-4)
/// * `start_row` - First visible row index
/// * `end_row` - Last visible row index (exclusive)
/// * `cols` - Number of columns per row
/// * `cell_width` - Width of each cell in pixels
/// * `cell_height` - Height of each cell in pixels
/// * `offset_y` - Y offset for first visible row (sub-pixel scrolling)
/// * `start_row_offset` - startRow value from visible range (for row Y calculation)
///
/// # Returns
/// Float32Array with runs: [color, y, x, width, color, y, x, width, ...]
/// First value is the total number of runs.
#[wasm_bindgen]
pub fn compute_micro_runs(
    encoded: &[u8],
    start_row: u32,
    end_row: u32,
    cols: u32,
    cell_width: f32,
    cell_height: f32,
    offset_y: f32,
    start_row_offset: u32,
) -> Vec<f32> {
    // Pre-allocate for typical case (estimate ~1 run per 5 cells due to compression)
    let estimated_runs = ((end_row - start_row) as usize * cols as usize) / 5;

    // Store runs grouped by color (5 vectors)
    let mut runs_by_color: [Vec<[f32; 3]>; 5] = Default::default();
    for color_runs in &mut runs_by_color {
        color_runs.reserve(estimated_runs / 5);
    }

    let seq_len = encoded.len() as u32;

    for row in start_row..end_row {
        let row_start = row * cols;
        if row_start >= seq_len {
            break;
        }
        let row_end = ((row + 1) * cols).min(seq_len);

        let row_y = (row - start_row_offset) as f32 * cell_height + offset_y;

        // Get first cell's color
        let first_idx = row_start as usize;
        if first_idx >= encoded.len() {
            break;
        }

        let mut run_code = encoded[first_idx];
        let mut run_start_col: u32 = 0;

        for i in (row_start + 1)..row_end {
            let idx = i as usize;
            if idx >= encoded.len() {
                break;
            }
            let code = encoded[idx];
            if code != run_code {
                // End current run
                let col = i - row_start;
                let x = run_start_col as f32 * cell_width;
                let width = (col - run_start_col) as f32 * cell_width;
                if run_code < 5 {
                    runs_by_color[run_code as usize].push([row_y, x, width]);
                }
                run_code = code;
                run_start_col = col;
            }
        }

        // Final run in row
        let final_col = row_end - row_start;
        if final_col > run_start_col && run_code < 5 {
            let x = run_start_col as f32 * cell_width;
            let width = (final_col - run_start_col) as f32 * cell_width;
            runs_by_color[run_code as usize].push([row_y, x, width]);
        }
    }

    // Count total runs
    let total_runs: usize = runs_by_color.iter().map(|v| v.len()).sum();

    // Output format: [total_runs, color0_count, color1_count, ..., color4_count, then all runs]
    // Each run: [y, x, width] (color is implicit from position)
    let mut result = Vec::with_capacity(6 + total_runs * 3);

    // Header: total runs + count per color
    result.push(total_runs as f32);
    for color_runs in &runs_by_color {
        result.push(color_runs.len() as f32);
    }

    // Runs grouped by color
    for color_runs in &runs_by_color {
        for run in color_runs {
            result.push(run[0]); // y
            result.push(run[1]); // x
            result.push(run[2]); // width
        }
    }

    result
}

/// Compute diff mask between two sequences.
///
/// **STATUS: NOT WIRED IN** - Diff computation happens in JS.
/// Kept for future optimization if diff mode becomes a performance concern.
/// Diff is computed once per sequence change, not per frame, so JS is adequate.
///
/// Compares a query sequence against a reference sequence and produces
/// a diff mask indicating the type of difference at each position:
/// - 0: Match
/// - 1: Mismatch (substitution)
/// - 2: Insertion (in query relative to ref - not computed here, placeholder)
/// - 3: Deletion (in query relative to ref - not computed here, placeholder)
///
/// For simple pairwise comparison without alignment, only 0 and 1 are used.
///
/// # Arguments
/// * `query` - Query sequence (the one being displayed)
/// * `reference` - Reference sequence to compare against
///
/// # Returns
/// Uint8Array with diff codes (0 = match, 1 = mismatch)
#[wasm_bindgen]
pub fn compute_diff_mask(query: &str, reference: &str) -> Vec<u8> {
    let query_bytes = query.as_bytes();
    let ref_bytes = reference.as_bytes();
    let len = query_bytes.len();

    let mut mask = vec![0u8; len];

    // Compare character by character (case-insensitive)
    let ref_len = ref_bytes.len();
    for i in 0..len {
        if i < ref_len {
            let q = query_bytes[i].to_ascii_uppercase();
            let r = ref_bytes[i].to_ascii_uppercase();
            if q != r {
                mask[i] = 1; // Mismatch
            }
        } else {
            // Query extends beyond reference
            mask[i] = 1;
        }
    }

    mask
}

/// Compute diff mask from pre-encoded sequences (faster than string version).
///
/// **STATUS: NOT WIRED IN** - See `compute_diff_mask` above.
/// This is the faster variant that operates on pre-encoded sequences.
///
/// # Arguments
/// * `query_encoded` - Pre-encoded query sequence (values 0-4)
/// * `ref_encoded` - Pre-encoded reference sequence (values 0-4)
///
/// # Returns
/// Uint8Array with diff codes (0 = match, 1 = mismatch)
#[wasm_bindgen]
pub fn compute_diff_mask_encoded(query_encoded: &[u8], ref_encoded: &[u8]) -> Vec<u8> {
    let len = query_encoded.len();
    let ref_len = ref_encoded.len();

    let mut mask = vec![0u8; len];

    for i in 0..len {
        if i < ref_len {
            if query_encoded[i] != ref_encoded[i] {
                mask[i] = 1;
            }
        } else {
            mask[i] = 1;
        }
    }

    mask
}

// ============================================================================
// KL Divergence for Anomaly Detection
// ============================================================================

/// Compute Kullback-Leibler divergence between two dense k-mer count arrays.
///
/// D_KL(P || Q) = sum(P(i) * log2(P(i) / Q(i)))
///
/// Both arrays are normalized internally to probability distributions.
/// Missing k-mers in Q are smoothed with epsilon to avoid log(0).
///
/// # Arguments
/// * `p_counts` - Dense count array for distribution P (window)
/// * `q_counts` - Dense count array for distribution Q (background)
///
/// # Returns
/// KL divergence value (non-negative). Returns 0.0 if inputs are invalid.
///
/// # Note
/// Arrays must be the same length. For k-mer analysis, length should be 4^k.
///
/// @see phage_explorer-vk7b.5
#[wasm_bindgen]
pub fn kl_divergence_dense(p_counts: &[u32], q_counts: &[u32]) -> f64 {
    if p_counts.len() != q_counts.len() || p_counts.is_empty() {
        return 0.0;
    }

    // Calculate totals for normalization
    let p_total: u64 = p_counts.iter().map(|&c| c as u64).sum();
    let q_total: u64 = q_counts.iter().map(|&c| c as u64).sum();

    if p_total == 0 || q_total == 0 {
        return 0.0;
    }

    let p_total_f = p_total as f64;
    let q_total_f = q_total as f64;
    let epsilon = 1e-10; // Smoothing for zero counts in Q

    let mut kl = 0.0;

    for i in 0..p_counts.len() {
        let p_val = p_counts[i] as f64 / p_total_f;
        if p_val > 0.0 {
            let q_val = (q_counts[i] as f64 / q_total_f).max(epsilon);
            kl += p_val * (p_val / q_val).log2();
        }
    }

    kl.max(0.0) // Ensure non-negative due to floating point
}

/// Result of KL divergence window scan.
#[wasm_bindgen]
pub struct KLScanResult {
    /// KL divergence values for each window position
    kl_values: Vec<f32>,
    /// Window positions (start indices)
    positions: Vec<u32>,
    /// Number of windows scanned
    window_count: usize,
    /// K-mer size used
    k: usize,
}

#[wasm_bindgen]
impl KLScanResult {
    /// Get the KL divergence values as Float32Array
    #[wasm_bindgen(getter)]
    pub fn kl_values(&self) -> Vec<f32> {
        self.kl_values.clone()
    }

    /// Get the window start positions as Uint32Array
    #[wasm_bindgen(getter)]
    pub fn positions(&self) -> Vec<u32> {
        self.positions.clone()
    }

    /// Get the number of windows
    #[wasm_bindgen(getter)]
    pub fn window_count(&self) -> usize {
        self.window_count
    }

    /// Get the k-mer size used
    #[wasm_bindgen(getter)]
    pub fn k(&self) -> usize {
        self.k
    }
}

/// Scan a sequence for k-mer KL divergence anomalies.
///
/// Computes KL divergence of each sliding window against the global
/// sequence background. This is the core computation for anomaly detection.
///
/// # Arguments
/// * `seq` - Sequence bytes (ASCII DNA)
/// * `k` - K-mer size (1-10)
/// * `window_size` - Size of each window in bases
/// * `step_size` - Step size between windows
///
/// # Returns
/// `KLScanResult` with:
/// - `kl_values`: Float32Array of KL divergence for each window
/// - `positions`: Uint32Array of window start positions
/// - `window_count`: Number of windows scanned
///
/// # Performance
/// Uses dense k-mer counting for O(1) k-mer lookups.
/// Avoids string allocations by working directly with byte arrays.
///
/// # Example (from JS)
/// ```js
/// const seqBytes = new TextEncoder().encode(sequence);
/// const result = wasm.scan_kl_windows(seqBytes, 4, 500, 100);
/// try {
///   const klValues = result.kl_values; // Float32Array
///   const positions = result.positions; // Uint32Array
///   // Process anomalies...
/// } finally {
///   result.free();
/// }
/// ```
///
/// @see phage_explorer-vk7b.5
#[wasm_bindgen]
pub fn scan_kl_windows(
    seq: &[u8],
    k: usize,
    window_size: usize,
    step_size: usize,
) -> KLScanResult {
    // Validate inputs
    if k == 0 || k > DENSE_KMER_MAX_K || window_size == 0 || step_size == 0 {
        return KLScanResult {
            kl_values: Vec::new(),
            positions: Vec::new(),
            window_count: 0,
            k,
        };
    }

    if seq.len() < window_size || window_size < k {
        return KLScanResult {
            kl_values: Vec::new(),
            positions: Vec::new(),
            window_count: 0,
            k,
        };
    }

    let array_size = 1usize << (2 * k);
    let mask = array_size - 1;

    // Step 1: Compute global k-mer counts
    let mut global_counts = vec![0u32; array_size];
    let mut global_total: u64 = 0;

    {
        let mut rolling_index: usize = 0;
        let mut valid_bases: usize = 0;

        for &byte in seq {
            let base_code = match byte {
                b'A' | b'a' => 0usize,
                b'C' | b'c' => 1usize,
                b'G' | b'g' => 2usize,
                b'T' | b't' | b'U' | b'u' => 3usize,
                _ => {
                    rolling_index = 0;
                    valid_bases = 0;
                    continue;
                }
            };

            rolling_index = ((rolling_index << 2) | base_code) & mask;
            valid_bases += 1;

            if valid_bases >= k {
                global_counts[rolling_index] = global_counts[rolling_index].saturating_add(1);
                global_total += 1;
            }
        }
    }

    if global_total == 0 {
        return KLScanResult {
            kl_values: Vec::new(),
            positions: Vec::new(),
            window_count: 0,
            k,
        };
    }

    let global_total_f = global_total as f64;
    let epsilon = 1e-10;

    // Step 2: Scan sliding windows
    let mut kl_values = Vec::new();
    let mut positions = Vec::new();

    let mut pos = 0usize;
    while pos + window_size <= seq.len() {
        // Compute window k-mer counts
        let window = &seq[pos..pos + window_size];
        let mut window_counts = vec![0u32; array_size];
        let mut window_total: u64 = 0;

        let mut rolling_index: usize = 0;
        let mut valid_bases: usize = 0;

        for &byte in window {
            let base_code = match byte {
                b'A' | b'a' => 0usize,
                b'C' | b'c' => 1usize,
                b'G' | b'g' => 2usize,
                b'T' | b't' | b'U' | b'u' => 3usize,
                _ => {
                    rolling_index = 0;
                    valid_bases = 0;
                    continue;
                }
            };

            rolling_index = ((rolling_index << 2) | base_code) & mask;
            valid_bases += 1;

            if valid_bases >= k {
                window_counts[rolling_index] = window_counts[rolling_index].saturating_add(1);
                window_total += 1;
            }
        }

        // Compute KL divergence: D_KL(window || global)
        let kl = if window_total > 0 {
            let window_total_f = window_total as f64;
            let mut kl_sum = 0.0f64;

            for i in 0..array_size {
                let p_val = window_counts[i] as f64 / window_total_f;
                if p_val > 0.0 {
                    let q_val = (global_counts[i] as f64 / global_total_f).max(epsilon);
                    kl_sum += p_val * (p_val / q_val).log2();
                }
            }

            kl_sum.max(0.0) as f32
        } else {
            0.0f32
        };

        kl_values.push(kl);
        positions.push(pos as u32);

        pos += step_size;
    }

    let window_count = kl_values.len();

    KLScanResult {
        kl_values,
        positions,
        window_count,
        k,
    }
}

// ============================================================================
// Myers Diff Algorithm for DNA Sequences
// Implements O(ND) diff with compact mask encoding + summary stats
// See: phage_explorer-kyo0.1.1
// ============================================================================

/// Op codes for diff mask encoding.
/// Using small values to fit in Uint8Array efficiently.
pub const DIFF_OP_MATCH: u8 = 0;
pub const DIFF_OP_MISMATCH: u8 = 1;  // Substitution
pub const DIFF_OP_INSERT: u8 = 2;    // Present in B, not in A
pub const DIFF_OP_DELETE: u8 = 3;    // Present in A, not in B

/// Guardrails for Myers diff to prevent OOM/long runtime.
/// These can be adjusted based on profiling.
pub const DIFF_MAX_LEN: usize = 500_000;       // Max sequence length
pub const DIFF_MAX_EDIT_DISTANCE: usize = 10_000;  // Max edit distance to compute

/// Result of Myers diff computation.
///
/// # Ownership
/// The caller must call `.free()` to release WASM memory.
#[wasm_bindgen]
pub struct MyersDiffResult {
    /// Diff mask for sequence A: MATCH/MISMATCH/DELETE codes
    mask_a: Vec<u8>,
    /// Diff mask for sequence B: MATCH/MISMATCH/INSERT codes
    mask_b: Vec<u8>,
    /// Edit distance (total edits)
    edit_distance: usize,
    /// Number of matches
    matches: usize,
    /// Number of mismatches (substitutions)
    mismatches: usize,
    /// Number of insertions (in B, not in A)
    insertions: usize,
    /// Number of deletions (in A, not in B)
    deletions: usize,
    /// Whether computation was truncated due to guardrails
    truncated: bool,
    /// Error message if any
    error: Option<String>,
}

#[wasm_bindgen]
impl MyersDiffResult {
    /// Get mask for sequence A as Uint8Array.
    /// Values: 0=MATCH, 1=MISMATCH, 3=DELETE
    #[wasm_bindgen(getter)]
    pub fn mask_a(&self) -> js_sys::Uint8Array {
        let arr = js_sys::Uint8Array::new_with_length(self.mask_a.len() as u32);
        arr.copy_from(&self.mask_a);
        arr
    }

    /// Get mask for sequence B as Uint8Array.
    /// Values: 0=MATCH, 1=MISMATCH, 2=INSERT
    #[wasm_bindgen(getter)]
    pub fn mask_b(&self) -> js_sys::Uint8Array {
        let arr = js_sys::Uint8Array::new_with_length(self.mask_b.len() as u32);
        arr.copy_from(&self.mask_b);
        arr
    }

    /// Edit distance (total number of edits).
    #[wasm_bindgen(getter)]
    pub fn edit_distance(&self) -> usize {
        self.edit_distance
    }

    /// Number of matching positions.
    #[wasm_bindgen(getter)]
    pub fn matches(&self) -> usize {
        self.matches
    }

    /// Number of mismatches (substitutions).
    #[wasm_bindgen(getter)]
    pub fn mismatches(&self) -> usize {
        self.mismatches
    }

    /// Number of insertions.
    #[wasm_bindgen(getter)]
    pub fn insertions(&self) -> usize {
        self.insertions
    }

    /// Number of deletions.
    #[wasm_bindgen(getter)]
    pub fn deletions(&self) -> usize {
        self.deletions
    }

    /// Sequence identity as fraction (0.0 - 1.0).
    #[wasm_bindgen(getter)]
    pub fn identity(&self) -> f64 {
        let total = self.matches + self.mismatches + self.insertions + self.deletions;
        if total == 0 {
            1.0
        } else {
            self.matches as f64 / total as f64
        }
    }

    /// Whether the computation was truncated.
    #[wasm_bindgen(getter)]
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    /// Error message if any.
    #[wasm_bindgen(getter)]
    pub fn error(&self) -> Option<String> {
        self.error.clone()
    }

    /// Length of sequence A.
    #[wasm_bindgen(getter)]
    pub fn len_a(&self) -> usize {
        self.mask_a.len()
    }

    /// Length of sequence B.
    #[wasm_bindgen(getter)]
    pub fn len_b(&self) -> usize {
        self.mask_b.len()
    }
}

/// Normalize a DNA base for comparison.
/// - Case-insensitive (returns uppercase code)
/// - U treated as T
/// - Returns the byte as-is for ambiguous bases (N, etc.)
#[inline(always)]
fn normalize_base(b: u8) -> u8 {
    match b {
        b'A' | b'a' => b'A',
        b'C' | b'c' => b'C',
        b'G' | b'g' => b'G',
        b'T' | b't' | b'U' | b'u' => b'T',
        other => other.to_ascii_uppercase(),
    }
}

/// Compare two normalized bases for equality.
/// N does not match anything including itself (conservative behavior).
#[inline(always)]
fn bases_equal(a: u8, b: u8) -> bool {
    let na = normalize_base(a);
    let nb = normalize_base(b);
    // N doesn't match anything
    if na == b'N' || nb == b'N' {
        return false;
    }
    na == nb
}

/// Compute Myers diff between two DNA sequences.
///
/// Uses the Myers O(ND) algorithm with bounded edit distance for safety.
/// Returns a diff result with masks for both sequences and summary statistics.
///
/// # Arguments
/// * `seq_a` - First sequence (bytes)
/// * `seq_b` - Second sequence (bytes)
///
/// # Returns
/// MyersDiffResult with masks and statistics.
///
/// # Guardrails
/// - Max sequence length: 500,000 bp
/// - Max edit distance: 10,000
/// - If exceeded, returns truncated result with partial stats
#[wasm_bindgen]
pub fn myers_diff(seq_a: &[u8], seq_b: &[u8]) -> MyersDiffResult {
    myers_diff_with_limit(seq_a, seq_b, DIFF_MAX_EDIT_DISTANCE)
}

/// Compute Myers diff with custom edit distance limit.
///
/// # Arguments
/// * `seq_a` - First sequence (bytes)
/// * `seq_b` - Second sequence (bytes)
/// * `max_d` - Maximum edit distance to compute
#[wasm_bindgen]
pub fn myers_diff_with_limit(seq_a: &[u8], seq_b: &[u8], max_d: usize) -> MyersDiffResult {
    let n = seq_a.len();
    let m = seq_b.len();

    // Check length guardrails
    if n > DIFF_MAX_LEN || m > DIFF_MAX_LEN {
        return MyersDiffResult {
            mask_a: vec![],
            mask_b: vec![],
            edit_distance: 0,
            matches: 0,
            mismatches: 0,
            insertions: 0,
            deletions: 0,
            truncated: true,
            error: Some(format!(
                "Sequence too long: len_a={}, len_b={}, max={}",
                n, m, DIFF_MAX_LEN
            )),
        };
    }

    // Empty sequence cases
    if n == 0 && m == 0 {
        return MyersDiffResult {
            mask_a: vec![],
            mask_b: vec![],
            edit_distance: 0,
            matches: 0,
            mismatches: 0,
            insertions: 0,
            deletions: 0,
            truncated: false,
            error: None,
        };
    }

    if n == 0 {
        // All insertions
        return MyersDiffResult {
            mask_a: vec![],
            mask_b: vec![DIFF_OP_INSERT; m],
            edit_distance: m,
            matches: 0,
            mismatches: 0,
            insertions: m,
            deletions: 0,
            truncated: false,
            error: None,
        };
    }

    if m == 0 {
        // All deletions
        return MyersDiffResult {
            mask_a: vec![DIFF_OP_DELETE; n],
            mask_b: vec![],
            edit_distance: n,
            matches: 0,
            mismatches: 0,
            insertions: 0,
            deletions: n,
            truncated: false,
            error: None,
        };
    }

    // Fast path: equal-length sequences - check if all match first
    if n == m {
        let mut all_match = true;
        for i in 0..n {
            if !bases_equal(seq_a[i], seq_b[i]) {
                all_match = false;
                break;
            }
        }
        if all_match {
            return MyersDiffResult {
                mask_a: vec![DIFF_OP_MATCH; n],
                mask_b: vec![DIFF_OP_MATCH; m],
                edit_distance: 0,
                matches: n,
                mismatches: 0,
                insertions: 0,
                deletions: 0,
                truncated: false,
                error: None,
            };
        }
    }

    // Run Myers algorithm
    myers_diff_core(seq_a, seq_b, max_d)
}

/// Core Myers diff algorithm implementation.
///
/// Myers O(ND) algorithm finds the shortest edit script.
/// We trace back to reconstruct the alignment.
fn myers_diff_core(seq_a: &[u8], seq_b: &[u8], max_d: usize) -> MyersDiffResult {
    let n = seq_a.len() as isize;
    let m = seq_b.len() as isize;
    let max_steps = (n + m) as usize;
    let max_d = max_d.min(max_steps);

    // V array stores furthest reaching point for each diagonal k
    // Diagonal k = x - y (where x is position in A, y is position in B)
    // We need diagonals from -(max_d) to +(max_d)
    // Array index: k + offset where offset = max_d
    let offset = max_d as isize;
    let v_size = 2 * max_d + 1;

    // Store V arrays for each d value (for traceback)
    let mut history: Vec<Vec<isize>> = Vec::with_capacity(max_d + 1);
    let mut v: Vec<isize> = vec![-1; v_size];
    v[offset as usize] = 0; // Start at (0,0)

    let mut found_d: Option<usize> = None;

    // Forward pass: find shortest edit path
    'outer: for d in 0..=max_d {
        // Save current V for traceback
        history.push(v.clone());

        for k in (-(d as isize)..=(d as isize)).step_by(2) {
            let idx = (k + offset) as usize;

            // Choose starting x based on whether we came from diagonal k-1 or k+1
            let mut x: isize;
            if k == -(d as isize) {
                // Must come from k+1 (insertion from B)
                x = v[(k + 1 + offset) as usize];
            } else if k == (d as isize) {
                // Must come from k-1 (deletion from A)
                x = v[(k - 1 + offset) as usize] + 1;
            } else {
                // Choose the path that goes further
                let from_above = v[(k - 1 + offset) as usize] + 1; // deletion
                let from_left = v[(k + 1 + offset) as usize];       // insertion
                x = if from_above > from_left { from_above } else { from_left };
            }

            let mut y = x - k;

            // Extend along diagonal (matches)
            // Note: y can be negative if k > x, so we must check y >= 0
            while x >= 0 && y >= 0 && x < n && y < m && bases_equal(seq_a[x as usize], seq_b[y as usize]) {
                x += 1;
                y += 1;
            }

            v[idx] = x;

            // Check if we've reached the end
            if x >= n && y >= m {
                found_d = Some(d);
                history.push(v.clone()); // Save final state
                break 'outer;
            }
        }
    }

    // Check if we found a solution
    let final_d = match found_d {
        Some(d) => d,
        None => {
            // Edit distance exceeded limit
            return MyersDiffResult {
                mask_a: vec![],
                mask_b: vec![],
                edit_distance: 0,
                matches: 0,
                mismatches: 0,
                insertions: 0,
                deletions: 0,
                truncated: true,
                error: Some(format!(
                    "Edit distance exceeds limit: max_d={}",
                    max_d
                )),
            };
        }
    };

    // Traceback to reconstruct alignment
    // Build edit script in reverse, then reverse at the end
    let mut edits: Vec<(u8, usize, usize)> = Vec::new(); // (op, pos_a, pos_b)

    let mut x = n as usize;
    let mut y = m as usize;
    let mut d = final_d;

    while x > 0 || y > 0 {
        if d == 0 {
            // Only matches remain
            while x > 0 && y > 0 {
                x -= 1;
                y -= 1;
                edits.push((DIFF_OP_MATCH, x, y));
            }
            break;
        }

        let k = x as isize - y as isize;
        let v_prev = &history[d - 1];

        // Determine if we came from k-1 (deletion) or k+1 (insertion)
        let k_prev_del = k - 1;
        let k_prev_ins = k + 1;

        let from_del = if ((k_prev_del + offset) as usize) < v_prev.len() {
            v_prev[(k_prev_del + offset) as usize]
        } else {
            -2
        };
        let from_ins = if ((k_prev_ins + offset) as usize) < v_prev.len() {
            v_prev[(k_prev_ins + offset) as usize]
        } else {
            -2
        };

        // Compute snake start point
        let snake_start_x: usize;
        let is_deletion: bool;

        if k == -(d as isize) {
            // Must be insertion
            snake_start_x = from_ins as usize;
            is_deletion = false;
        } else if k == (d as isize) {
            // Must be deletion
            snake_start_x = (from_del + 1) as usize;
            is_deletion = true;
        } else if from_del + 1 > from_ins {
            // Deletion gives better path
            snake_start_x = (from_del + 1) as usize;
            is_deletion = true;
        } else {
            // Insertion gives better path
            snake_start_x = from_ins as usize;
            is_deletion = false;
        }

        let snake_start_y = (snake_start_x as isize - k) as usize;

        // Trace matches in the snake
        while x > snake_start_x && y > snake_start_y {
            x -= 1;
            y -= 1;
            edits.push((DIFF_OP_MATCH, x, y));
        }

        // The edit step
        if is_deletion {
            if x > 0 {
                x -= 1;
                edits.push((DIFF_OP_DELETE, x, y));
            }
        } else {
            if y > 0 {
                y -= 1;
                edits.push((DIFF_OP_INSERT, x, y));
            }
        }

        d -= 1;
    }

    // Reverse to get forward order
    edits.reverse();

    // Build masks from edits
    let mut mask_a = vec![DIFF_OP_MATCH; seq_a.len()];
    let mut mask_b = vec![DIFF_OP_MATCH; seq_b.len()];
    let mut matches = 0usize;
    let mismatches = 0usize; // Myers algorithm doesn't produce substitutions, only ins/del
    let mut insertions = 0usize;
    let mut deletions = 0usize;

    for (op, pos_a, pos_b) in edits {
        match op {
            DIFF_OP_MATCH => {
                if pos_a < mask_a.len() {
                    mask_a[pos_a] = DIFF_OP_MATCH;
                }
                if pos_b < mask_b.len() {
                    mask_b[pos_b] = DIFF_OP_MATCH;
                }
                matches += 1;
            }
            DIFF_OP_DELETE => {
                if pos_a < mask_a.len() {
                    mask_a[pos_a] = DIFF_OP_DELETE;
                }
                deletions += 1;
            }
            DIFF_OP_INSERT => {
                if pos_b < mask_b.len() {
                    mask_b[pos_b] = DIFF_OP_INSERT;
                }
                insertions += 1;
            }
            _ => {}
        }
    }

    MyersDiffResult {
        mask_a,
        mask_b,
        edit_distance: final_d,
        matches,
        mismatches,
        insertions,
        deletions,
        truncated: false,
        error: None,
    }
}

/// Fast equal-length diff for sequences with only substitutions.
///
/// This is O(n) and much faster than Myers when we know there are no indels.
/// Use this when sequences are already aligned or have equal length.
///
/// # Arguments
/// * `seq_a` - First sequence (bytes)
/// * `seq_b` - Second sequence (bytes)
///
/// # Returns
/// MyersDiffResult with mask codes 0=MATCH, 1=MISMATCH only.
#[wasm_bindgen]
pub fn equal_len_diff(seq_a: &[u8], seq_b: &[u8]) -> MyersDiffResult {
    let n = seq_a.len();
    let m = seq_b.len();

    if n != m {
        return MyersDiffResult {
            mask_a: vec![],
            mask_b: vec![],
            edit_distance: 0,
            matches: 0,
            mismatches: 0,
            insertions: 0,
            deletions: 0,
            truncated: true,
            error: Some(format!(
                "Sequences must have equal length for equal_len_diff: {} vs {}",
                n, m
            )),
        };
    }

    let mut mask = Vec::with_capacity(n);
    let mut matches = 0usize;
    let mut mismatches = 0usize;

    for i in 0..n {
        if bases_equal(seq_a[i], seq_b[i]) {
            mask.push(DIFF_OP_MATCH);
            matches += 1;
        } else {
            mask.push(DIFF_OP_MISMATCH);
            mismatches += 1;
        }
    }

    MyersDiffResult {
        mask_a: mask.clone(),
        mask_b: mask,
        edit_distance: mismatches,
        matches,
        mismatches,
        insertions: 0,
        deletions: 0,
        truncated: false,
        error: None,
    }
}

#[cfg(test)]
mod myers_diff_tests {
    use super::*;

    #[test]
    fn test_identical_sequences() {
        let result = myers_diff(b"ACGT", b"ACGT");
        assert_eq!(result.edit_distance, 0);
        assert_eq!(result.matches, 4);
        assert_eq!(result.insertions, 0);
        assert_eq!(result.deletions, 0);
        assert!(!result.truncated);
        assert!(result.error.is_none());
        assert_eq!(result.mask_a.len(), 4);
        assert_eq!(result.mask_b.len(), 4);
    }

    #[test]
    fn test_empty_sequences() {
        let result = myers_diff(b"", b"");
        assert_eq!(result.edit_distance, 0);
        assert_eq!(result.matches, 0);
        assert!(!result.truncated);
    }

    #[test]
    fn test_insertion() {
        // B has extra base
        let result = myers_diff(b"ACGT", b"ACGGT");
        assert_eq!(result.edit_distance, 1);
        assert_eq!(result.insertions, 1);
        assert_eq!(result.deletions, 0);
        assert_eq!(result.matches, 4);
    }

    #[test]
    fn test_deletion() {
        // A has extra base
        let result = myers_diff(b"ACGGT", b"ACGT");
        assert_eq!(result.edit_distance, 1);
        assert_eq!(result.deletions, 1);
        assert_eq!(result.insertions, 0);
        assert_eq!(result.matches, 4);
    }

    #[test]
    fn test_case_insensitive() {
        let result = myers_diff(b"acgt", b"ACGT");
        assert_eq!(result.edit_distance, 0);
        assert_eq!(result.matches, 4);
    }

    #[test]
    fn test_u_treated_as_t() {
        let result = myers_diff(b"ACGU", b"ACGT");
        assert_eq!(result.edit_distance, 0);
        assert_eq!(result.matches, 4);
    }

    #[test]
    fn test_n_never_matches() {
        // N doesn't match anything, not even N
        let result = myers_diff(b"ANCGT", b"ATCGT");
        // N vs T is a mismatch, handled as edit
        assert!(result.edit_distance > 0);
    }

    #[test]
    fn test_equal_len_diff_identical() {
        let result = equal_len_diff(b"ACGT", b"ACGT");
        assert_eq!(result.edit_distance, 0);
        assert_eq!(result.matches, 4);
        assert_eq!(result.mismatches, 0);
    }

    #[test]
    fn test_equal_len_diff_with_mismatches() {
        let result = equal_len_diff(b"ACGT", b"ACCT");
        assert_eq!(result.edit_distance, 1);
        assert_eq!(result.matches, 3);
        assert_eq!(result.mismatches, 1);
    }

    #[test]
    fn test_equal_len_diff_different_lengths() {
        let result = equal_len_diff(b"ACGT", b"ACG");
        assert!(result.truncated);
        assert!(result.error.is_some());
    }

    #[test]
    fn test_guardrails_max_edit_distance() {
        // Create sequences with high edit distance
        let a = vec![b'A'; 100];
        let b = vec![b'G'; 100];
        let result = myers_diff_with_limit(&a, &b, 10);
        // Should truncate since edit distance is 100 but limit is 10
        assert!(result.truncated);
    }
}
