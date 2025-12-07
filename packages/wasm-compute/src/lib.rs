use wasm_bindgen::prelude::*;
use std::collections::HashMap;

mod renderer;

pub use renderer::{render_ascii_model, Model3D, Vector3};

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
    let sig_a = get_min_hash_signature(sequence_a, k, num_hashes);
    let sig_b = get_min_hash_signature(sequence_b, k, num_hashes);

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

    if seq.len() < k {
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
