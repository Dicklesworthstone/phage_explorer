/**
 * K-mer Counting Compute Shader
 *
 * Counts k-mers in a DNA sequence using atomic operations.
 * Maps sequence characters to 2-bit integers (A=0, C=1, G=2, T=3).
 * Supports k up to 12 (24 bits).
 */

// Bindings
// 0: Input sequence (packed uint32 array)
// 1: Output counts (atomic uint32 array)
// 2: Uniforms (sequence length, k)

@group(0) @binding(0) var<storage, read> sequence: array<u32>;
@group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;

struct Uniforms {
  sequenceLength: u32,
  k: u32,
}
@group(0) @binding(2) var<uniform> u: Uniforms;

// Mapping: A=00, C=01, G=10, T=11
// ASCII: A=65, C=67, G=71, T=84
// Helper to extract base from packed char
fn get_base(char_code: u32) -> u32 {
  // Simple hash: (code >> 1) & 3
  // A(65) -> 1000001 >> 1 = 100000 & 3 = 0
  // C(67) -> 1000011 >> 1 = 100001 & 3 = 1
  // G(71) -> 1000111 >> 1 = 100011 & 3 = 3 (Wait, G should be 2)
  // T(84) -> 1010100 >> 1 = 101010 & 3 = 2 (Wait, T should be 3)
  
  // Better mapping via look-up table or bit manipulation
  // Let's assume input is already packed 2-bit integers for efficiency
  // But usually we pass string buffer (u8).
  // Let's assume input is u32 array containing raw ASCII chars (4 per u32).
  
  // For now, let's assume input is ALREADY packed 2-bit integers in u32
  // This simplifies the shader significantly.
  // We will pack it in JS.
  return char_code;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  
  if (index >= u.sequenceLength - u.k + 1) {
    return;
  }

  // Extract k-mer at index
  // Since we assumed packed format in JS, we need to reconstruct the k-mer value
  // Sequence is array<u32>, where each u32 holds 16 bases (2 bits each).
  
  var kmer: u32 = 0u;
  
  // Read bases
  // This is complex to do efficiently with arbitrary k and packing.
  // Let's simplify: Input is array<u32> where each u32 is ONE base (0..3).
  // Takes more memory but simplest shader logic.
  
  for (var i = 0u; i < u.k; i = i + 1u) {
    let base = sequence[index + i];
    if (base > 3u) {
      // Invalid base (N), skip this k-mer
      return;
    }
    kmer = (kmer << 2u) | base;
  }
  
  // Atomically increment count
  atomicAdd(&counts[kmer], 1u);
}
