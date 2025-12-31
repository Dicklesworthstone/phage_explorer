# JS ↔ WASM ABI Conventions (Phage Explorer)

This document defines **one consistent, performance-oriented ABI** for JS/TS ↔ Rust/WASM work in Phage Explorer.

The intent is to make future WASM kernels (k-mers, dotplots, diffs, PCA, etc.) *fast by default* by avoiding boundary mistakes:
- shipping giant strings repeatedly
- returning JSON for hot paths
- unclear ownership / `.free()` leaks
- inconsistent handling of ambiguous bases

## Capability tiers (progressive enhancement)

We target “newest browsers fastest” while preserving broad compatibility:

| Tier | Capabilities | Recommended transport | Notes |
|------|--------------|------------------------|------|
| A | WASM + `crossOriginIsolated` + `SharedArrayBuffer` | Zero-copy sequence sharing between main thread and workers (SAB) | Requires COOP/COEP; not always available (embedded contexts, some Safari cases). |
| B | WASM but **no** SAB | Transferable `ArrayBuffer` | Avoid structured-cloned strings; transfer buffers to workers. |
| C | No WASM | JS fallback | Must stay correct; may be slower. |

WASM kernels must be optional and feature-detected; never UA-sniff.

## Canonical sequence encodings

All compute kernels that scan genomes should be **bytes-first**.

### `ascii` (raw bytes)
- Type: `Uint8Array`
- Contents: ASCII bytes for the original sequence.
- Allowed: upper/lowercase A/C/G/T/N; optionally U/u.
- Use when the source of truth is a DB string and we want a cheap “ship once, reuse many times” representation.

### `acgt05` (encoded bases)
- Type: `Uint8Array`
- Values:
  - `0 = A`
  - `1 = C`
  - `2 = G`
  - `3 = T` (and U treated as T)
  - `4 = N/other/ambiguous`
- Use when the caller wants the cheapest possible inner loop (2-bit rolling indexes, etc).

### Ambiguous base rule (global invariant)
For any “rolling k-mer” style kernel:
- Any base outside unambiguous A/C/G/T **resets** the rolling state.
- No k-mer may span across an ambiguous base.

This is deterministic, fast, and prevents subtle cross-k-mer contamination.

## Typed-array I/O (preferred)

### Inputs
- Prefer passing `Uint8Array`/`Float32Array`/`Uint32Array` rather than strings.
- Avoid per-call allocations by:
  - batching multiple outputs into one call
  - passing precomputed/cached inputs (bytes) into multiple kernels

### Outputs
- Prefer typed arrays that are ready for downstream usage:
  - rendering (dotplot buffers, heatmaps)
  - post-processing (top-K extraction, PCA projections)
- Avoid JSON outputs for hot paths.

### Copy semantics (important)
With wasm-bindgen’s default generated JS glue:
- Typed arrays passed into WASM are typically **copied into WASM memory**.
- Typed arrays returned from WASM are typically **copied out** into a fresh JS typed array.

This is still a huge win for hot loops, but it means:
- Don’t call into WASM per-position/per-row; batch work.
- If boundary copies become the bottleneck, consider a `SequenceHandle`-style API (store encoded data in WASM memory once) or SAB-backed worker-side preprocessing.

## Ownership & lifetime

### Plain values / typed arrays
If a function returns a JS typed array (not wrapped in a class), the caller does not need to `.free()` it.

### wasm-bindgen classes
If a function returns a wasm-bindgen class instance (e.g., `CodonUsageResult`, `PCAResult`), the caller **must** call `.free()` when done.

Rule of thumb:
- “Object with `.free()`” → you own a WASM allocation.
- “Just a typed array” → JS GC owns it.

## Determinism requirements

All kernels must be deterministic for the same input bytes and parameters:
- no RNG in core algorithms (unless seeded and documented)
- stable floating point behavior where possible (prefer f32 consistently if we render in f32)
- for PCA: resolve sign ambiguity in TS glue (stable axis orientation)

## Error handling

Prefer explicit, structured failure modes over panics:
- return `{ ok: false, code, reason }` style wrappers (or throw a JS `Error` only for truly exceptional cases)
- include guardrails in APIs that could allocate huge buffers (e.g., dense `4^k` counters)

## Concrete ABI examples (targets for new kernels)

These are the “reference shapes” future kernels should follow.

### 1) Dense k-mer counts (`vk7b.1`)

**Input**
- `seq: Uint8Array` (`ascii` or `acgt05`)
- `k: number`

**Output**
- `counts: Uint32Array` length `4^k`
- `totalValidKmers: number`
- optional `errorCode` or `ok` boolean when `k` exceeds safe caps

**Guardrails**
- Web default cap should be conservative (likely `k <= 10`).

### 2) MinHash signature (`vk7b.2`)

**Input**
- `seq: Uint8Array`
- `k: number`
- `numHashes: number`
- optional `seeds: Uint32Array` (or use deterministic built-in seeds)

**Output**
- `signature: Uint32Array` length `numHashes`

### 3) Dotplot buffers (`gim2.1`)

**Input**
- `a: Uint8Array`, `b: Uint8Array`
- `bins: number`
- `window: number`
- `step: number` (or derived)

**Output**
- `direct: Float32Array` length `bins*bins`
- `inverted: Float32Array` length `bins*bins` (if UI wants both)

**UX note**
- Worker-level progressive refinement should compute a small preview first (e.g., `bins=40`) and refine to final bins after.

