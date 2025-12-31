# JS↔WASM ABI Conventions for Performance Kernels

> **Bead**: phage_explorer-8qk2.1
> **Status**: Implemented
> **Blocks**: 10 beads (worker loader, sequence transport, k-mer, MinHash, dotplot, diff, Hilbert, CGR, PCA)

This document defines the **canonical ABI patterns** for all new WASM performance kernels in Phage Explorer. Following these conventions ensures:

- Minimal boundary overhead (no JSON parsing, no repeated string copies)
- Clear ownership rules (no memory leaks)
- Deterministic output (reproducible results)
- Consistent ambiguous base handling

---

## 1. Input Conventions

### 1.1 Sequence Data: Bytes-First API

**Preferred**: Pass sequences as `Uint8Array` (ASCII bytes or encoded 0-4 codes).

```typescript
// GOOD: Bytes-first (zero-copy potential with SharedArrayBuffer)
function analyze_kmers_bytes(seq: Uint8Array, k: number): KmerResult;

// ACCEPTABLE: String convenience wrapper (for one-off calls)
function analyze_kmers(seq: string, k: number): KmerResult;
```

**Encoding scheme** (0-4 codes):
| Code | Base |
|------|------|
| 0 | A/a |
| 1 | C/c |
| 2 | G/g |
| 3 | T/t/U/u |
| 4 | N/other |

**Rationale**:
- Workers can pass encoded sequences via `postMessage` with transfer
- With `SharedArrayBuffer` (when `crossOriginIsolated`), zero-copy is possible
- Avoids UTF-8 validation overhead on every call

### 1.2 Numeric Arrays: Typed Arrays

**Required**: Use typed arrays for numeric input.

```typescript
// GOOD: Float32Array for positions
function detect_bonds_spatial(positions: Float32Array, elements: string): BondResult;

// GOOD: Float64Array for high-precision data
function pca_power_iteration(data: Float64Array, ...): PCAResult;
```

### 1.3 Preallocated Output Buffers (Optional)

For hot-path functions called repeatedly, consider accepting preallocated output buffers:

```rust
// Rust signature allowing caller to provide output buffer
#[wasm_bindgen]
pub fn compute_gc_skew_into(
    seq: &[u8],
    window_size: usize,
    step_size: usize,
    output: &mut [f32],  // Caller-provided buffer
) -> usize;  // Returns number of values written
```

---

## 2. Output Conventions

### 2.1 Typed Arrays for Hot Paths

**Required**: Return typed arrays for numeric results in performance-critical paths.

```typescript
// GOOD: Direct typed array return
function compute_gc_skew(seq: string, window: number, step: number): Float64Array;
function encode_sequence_fast(seq: string): Uint8Array;

// BAD: JSON string that requires parsing
function compute_gc_skew_json(seq: string, ...): string;  // AVOID
```

### 2.2 Struct Results with Getters

For complex results with multiple fields, use wasm-bindgen structs with typed array getters:

```rust
#[wasm_bindgen]
pub struct KmerCountResult {
    // Private storage
    counts: Vec<u32>,
    kmers: Vec<u8>,  // Flat array of k-mer bytes
}

#[wasm_bindgen]
impl KmerCountResult {
    #[wasm_bindgen(getter)]
    pub fn counts(&self) -> Uint32Array {
        // Returns a copy to JS heap
        Uint32Array::from(&self.counts[..])
    }

    #[wasm_bindgen(getter)]
    pub fn kmers(&self) -> Uint8Array {
        Uint8Array::from(&self.kmers[..])
    }
}
```

### 2.3 Multi-Array Results: Header + Flat Layout

When returning multiple arrays, use a flat layout with a header:

```
Output format: [header..., data...]

Example for color runs:
[total_runs, count_color0, count_color1, ..., count_color4, y0, x0, w0, y1, x1, w1, ...]
```

```rust
// Returns Float32Array with embedded counts
pub fn compute_micro_runs(...) -> Vec<f32> {
    let mut result = Vec::with_capacity(6 + total_runs * 3);

    // Header: run counts per color
    result.push(total_runs as f32);
    for color_runs in &runs_by_color {
        result.push(color_runs.len() as f32);
    }

    // Data: runs grouped by color
    for color_runs in &runs_by_color {
        for run in color_runs {
            result.push(run.y);
            result.push(run.x);
            result.push(run.width);
        }
    }

    result
}
```

### 2.4 When JSON is Acceptable

JSON output is acceptable for:
- **Infrequent calls** (once per phage selection, not per frame)
- **Complex nested structures** that would be awkward as flat arrays
- **Debug/development endpoints**

```rust
// OK: Called once per analysis, not in render loop
pub fn detect_palindromes(...) -> RepeatResult {
    RepeatResult { json: format!("[{}]", results.join(",")) }
}
```

---

## 3. Ownership & Lifetime

### 3.1 When `.free()` is Required

**Rule**: wasm-bindgen objects with `private constructor` and `free(): void` MUST be freed by the caller when done.

```typescript
// TypeScript pattern for managed WASM objects
const result = wasm.analyze_kmers(seqA, seqB, k);
try {
    // Use result.jaccard_index, etc.
    console.log(result.jaccard_index);
} finally {
    result.free();  // REQUIRED: prevents WASM heap leak
}

// Or use Symbol.dispose (modern TS/JS)
using result = wasm.analyze_kmers(seqA, seqB, k);
// Automatically freed when scope exits
```

### 3.2 When `.free()` is NOT Required

**Plain typed arrays** returned directly are copied to the JS heap and managed by JS GC:

```typescript
// Float64Array is a JS object, GC will collect it
const skew = wasm.compute_gc_skew(seq, 1000, 100);
// No .free() needed - standard JS GC applies
```

### 3.3 Documentation Template

Every WASM function that returns a struct MUST document ownership:

```rust
/// # Ownership
/// The returned `KmerAnalysisResult` is owned by the caller.
/// Call `.free()` when done to release WASM memory, or use `using` syntax.
#[wasm_bindgen]
pub fn analyze_kmers(...) -> KmerAnalysisResult;
```

---

## 4. Determinism

### 4.1 No Random Number Generation

WASM kernels MUST NOT use random number generators in core algorithms:

```rust
// BAD: Non-deterministic
let v: Vec<f64> = (0..n).map(|_| rand::random()).collect();

// GOOD: Deterministic pseudo-random initialization
let v: Vec<f64> = (0..n)
    .map(|i| ((i * 7919 + 104729) % 1000) as f64 / 1000.0 - 0.5)
    .collect();
```

### 4.2 PCA Eigenvector Sign Convention

Eigenvectors are determined up to a sign. For reproducibility:

**Convention**: The first non-zero component of each eigenvector MUST be positive.

```rust
// After computing eigenvector, normalize sign
fn normalize_eigenvector_sign(v: &mut [f64]) {
    if let Some(first_nonzero) = v.iter().find(|&&x| x.abs() > 1e-10) {
        if *first_nonzero < 0.0 {
            for x in v.iter_mut() {
                *x = -*x;
            }
        }
    }
}
```

### 4.3 Floating-Point Determinism

- Use `f64` for accumulation to minimize rounding differences
- Document any platform-specific behavior (rare with standard IEEE 754)

---

## 5. Ambiguous Base Handling

### 5.1 K-mer Analysis: Skip Windows with N

**Policy**: Any base outside {A, C, G, T} resets the rolling k-mer state.

```rust
// Rolling k-mer extraction
for window in seq_bytes.windows(k) {
    // Skip windows containing N or other ambiguous bases
    if window.iter().any(|&b| !matches!(b, b'A'|b'a'|b'C'|b'c'|b'G'|b'g'|b'T'|b't')) {
        continue;  // Reset - this k-mer is invalid
    }
    // Process valid k-mer...
}
```

### 5.2 Translation: Unknown Codons Return 'X'

```rust
fn codon_to_aa(b0: u8, b1: u8, b2: u8) -> u8 {
    // If any base is ambiguous, return 'X' for unknown
    if !is_standard_base(b0) || !is_standard_base(b1) || !is_standard_base(b2) {
        return b'X';
    }
    // Normal translation...
}
```

### 5.3 GC Content: Exclude Ambiguous Bases

```rust
// Only count unambiguous bases
for &b in bytes {
    match b {
        b'G' | b'g' | b'C' | b'c' => { gc_count += 1; total_count += 1; }
        b'A' | b'a' | b'T' | b't' => { total_count += 1; }
        _ => {}  // Skip N and other ambiguous bases
    }
}
```

---

## 6. Concrete Example ABIs

### 6.1 K-mer Counts

```rust
/// Dense k-mer counting with typed array output.
///
/// # Input
/// - `seq`: Sequence as bytes (ASCII or 0-4 encoded)
/// - `k`: K-mer size (typically 3-8)
///
/// # Output
/// KmerCountResult with:
/// - `counts`: Uint32Array of length 4^k (dense count vector)
/// - `total`: Total valid k-mers counted
///
/// # Ownership
/// Caller must call `.free()` on the result.
///
/// # Ambiguous Bases
/// Windows containing non-ACGT bases are skipped.
#[wasm_bindgen]
pub fn count_kmers_dense(seq: &[u8], k: usize) -> KmerCountResult;
```

### 6.2 MinHash Signature

```rust
/// Compute MinHash signature for fast approximate Jaccard.
///
/// # Input
/// - `seq`: Sequence as bytes
/// - `k`: K-mer size
/// - `num_hashes`: Signature size (typically 128-1024)
///
/// # Output
/// Uint32Array of length `num_hashes` containing min-hash values.
/// Direct array return (no `.free()` needed).
///
/// # Determinism
/// Uses deterministic hash seeds: seed[i] = i * 0x9e3779b9
///
/// # Ambiguous Bases
/// K-mers containing N are skipped.
#[wasm_bindgen]
pub fn minhash_signature(seq: &[u8], k: usize, num_hashes: usize) -> Uint32Array;
```

### 6.3 Dotplot Buffer

```rust
/// Compute dotplot match matrix as flat Float32Array.
///
/// # Input
/// - `seq_a`, `seq_b`: Sequences as bytes
/// - `window`: Window size for matching
/// - `bins_x`, `bins_y`: Output resolution
///
/// # Output
/// DotplotResult with:
/// - `direct`: Float32Array[bins_x * bins_y] for forward matches
/// - `inverted`: Float32Array[bins_x * bins_y] for reverse complement matches
/// - `max_value`: Maximum intensity for normalization
///
/// Values are row-major: pixel[y][x] = buffer[y * bins_x + x]
///
/// # Ownership
/// Caller must call `.free()` on the result.
#[wasm_bindgen]
pub fn compute_dotplot(
    seq_a: &[u8],
    seq_b: &[u8],
    window: usize,
    bins_x: usize,
    bins_y: usize,
) -> DotplotResult;
```

---

## 7. Worker Integration Patterns

### 7.1 WASM Module Loading

```typescript
// Centralized loader with caching
let wasmModule: typeof import('@phage/wasm-compute') | null = null;
let wasmLoadPromise: Promise<typeof import('@phage/wasm-compute') | null> | null = null;

async function getWasmModule() {
    if (wasmModule) return wasmModule;
    if (wasmLoadPromise) return wasmLoadPromise;

    wasmLoadPromise = (async () => {
        try {
            const mod = await import('@phage/wasm-compute');
            mod.init_panic_hook();
            wasmModule = mod;
            return mod;
        } catch (err) {
            console.warn('[worker] WASM unavailable, using JS fallback:', err);
            return null;
        }
    })();

    return wasmLoadPromise;
}
```

### 7.2 Fallback Pattern

```typescript
async function analyzeKmers(seqA: string, seqB: string, k: number) {
    const wasm = await getWasmModule();

    if (wasm) {
        const result = wasm.analyze_kmers(seqA, seqB, k);
        try {
            return {
                jaccard: result.jaccard_index,
                // ... extract other fields
            };
        } finally {
            result.free();
        }
    }

    // JS fallback
    return analyzeKmersJS(seqA, seqB, k);
}
```

---

## 8. Summary Checklist

For each new WASM kernel, verify:

- [ ] **Inputs**: Uses `&[u8]` or typed arrays, not just strings
- [ ] **Outputs**: Returns typed arrays or struct with typed array getters
- [ ] **Ownership**: Documented whether `.free()` is required
- [ ] **Determinism**: No `rand`, deterministic initialization
- [ ] **Ambiguous bases**: Documented handling (skip/reset/error)
- [ ] **Fallback**: JS fallback exists for when WASM unavailable
- [ ] **Tests**: Unit tests verify WASM and JS produce identical output

---

## References

- **Bead phage_explorer-8qk2**: WASM data plane epic
- **Bead phage_explorer-8qk2.7**: Browser feature matrix (crossOriginIsolated detection)
- **Current implementation**: `packages/wasm-compute/src/lib.rs`
- **Worker usage example**: `packages/web/src/visualization/structure.worker.ts`
