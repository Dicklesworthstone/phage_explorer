/**
 * WASM Module Loader - Worker-safe cached initialization
 *
 * Provides a single, reusable pattern for loading the wasm-compute module
 * that works in both main thread and workers.
 *
 * Features:
 * - One-time initialization with cached result
 * - Safe for concurrent callers (deduplicates in-flight loads)
 * - Works in main thread and module workers
 * - Clear error messages and fallback behavior
 * - Dev-only structured logging
 *
 * ## Usage
 *
 * ```ts
 * import { getWasmCompute, isWasmComputeAvailable } from './lib/wasm-loader';
 *
 * // Quick sync check (after first load attempt)
 * if (isWasmComputeAvailable()) {
 *   // WASM is ready
 * }
 *
 * // Get the module (async, cached)
 * const wasm = await getWasmCompute();
 * if (wasm) {
 *   // Use WASM functions
 *   const result = wasm.compute_gc_skew(sequence, windowSize);
 * } else {
 *   // Fall back to JS implementation
 * }
 * ```
 *
 * ## Worker Usage
 *
 * The loader is designed to work identically in workers:
 *
 * ```ts
 * // In a worker file
 * import { getWasmCompute } from '../lib/wasm-loader';
 *
 * async function processData(data: Uint8Array) {
 *   const wasm = await getWasmCompute();
 *   if (wasm) {
 *     return wasm.some_function(data);
 *   }
 *   return fallbackJsImplementation(data);
 * }
 * ```
 *
 * @module wasm-loader
 * @see phage_explorer-8qk2.2
 */

import { canUseWasm, canUseWasmSimd } from './browser-capabilities';

// ============================================================================
// Types
// ============================================================================

import type {
  BondDetectionResult,
  CgrCountsResult,
  CodonUsageResult,
  DenseKmerResult,
  DotPlotBuffers,
  HoeffdingResult,
  MinHashSignature,
  MyersDiffResult,
  RepeatResult,
  SequenceHandle,
} from '@phage/wasm-compute';

/**
 * Result from WASM functional group detection.
 */
export interface FunctionalGroupsResult {
  aromatic_indices: Uint32Array;
  ring_sizes: Uint32Array;
  aromatic_count: number;
  disulfide_pairs: Uint32Array;
  disulfide_count: number;
  phosphate_data: Uint32Array;
  phosphate_count: number;
  free?: () => void;
}

/**
 * The wasm-compute module type.
 * We keep this as a minimal structural interface so we can avoid `typeof import(...)`
 * type annotations (enforced by our ESLint config) while still providing strong typing
 * for the exports we actually use across the app.
 */
export interface WasmComputeModule {
  /**
   * Optional wasm-bindgen init export (varies by bundler/build target).
   * Some builds expose an async init function; others (especially CJS wrappers)
   * may expose the module namespace on `default`.
   */
  default?: unknown;
  /** Optional panic hook for better error messages. */
  init_panic_hook?: () => void;

  // --- Sequence analysis ---
  compute_gc_skew?: (seq: string, window_size: number, step_size: number) => Float64Array;
  compute_cumulative_gc_skew?: (seq: string) => Float64Array;
  compute_windowed_entropy_acgt?: (seq: string, window_size: number, step_size: number) => Float64Array;

  count_codon_usage?: (seq: string, frame: number) => CodonUsageResult;
  count_kmers_dense?: (seq: Uint8Array, k: number) => DenseKmerResult;
  count_kmers_dense_canonical?: (seq: Uint8Array, k: number) => DenseKmerResult;

  detect_palindromes?: (seq: string, min_len: number, max_gap: number, max_results?: number) => RepeatResult;
  detect_tandem_repeats?: (seq: string, min_unit: number, max_unit: number, min_copies: number, max_results?: number) => RepeatResult;

  // --- Dot plot ---
  dotplot_self_buffers?: (seq: Uint8Array, bins: number, window: number) => DotPlotBuffers;
  SequenceHandle?: new (seq: Uint8Array) => SequenceHandle;

  // --- Diff ---
  equal_len_diff?: (seq_a: Uint8Array, seq_b: Uint8Array) => MyersDiffResult;
  myers_diff?: (seq_a: Uint8Array, seq_b: Uint8Array) => MyersDiffResult;
  myers_diff_with_limit?: (seq_a: Uint8Array, seq_b: Uint8Array, max_edits: number) => MyersDiffResult;

  // --- Visualizations ---
  hilbert_rgba?: (seq_bytes: Uint8Array, order: number, colors_rgb: Uint8Array) => Uint8Array;
  cgr_counts?: (seq_bytes: Uint8Array, k: number) => CgrCountsResult;

  // --- 3D structure ---
  detect_bonds_spatial?: (positions: Float32Array, elements: string) => BondDetectionResult;
  detect_functional_groups?: (positions: Float32Array, elements: string, bonds: Uint32Array) => FunctionalGroupsResult;

  // --- MinHash / similarity ---
  minhash_signature?: (seq: Uint8Array, k: number, num_hashes: number) => MinHashSignature;
  minhash_signature_canonical?: (seq: Uint8Array, k: number, num_hashes: number) => MinHashSignature;
  minhash_jaccard_from_signatures?: (sig_a: Uint32Array, sig_b: Uint32Array) => number;

  // --- Genetics & sequence analysis ---
  translate_sequence?: (seq: string, frame: number) => string;
  reverse_complement?: (seq: string) => string;
  calculate_gc_content?: (seq: string) => number;
  is_valid_dense_kmer_k?: (k: number) => boolean;
  get_dense_kmer_max_k?: () => number;
  encode_sequence_fast?: (seq: string) => Uint8Array;
  compute_diff_mask?: (seq_a: string, seq_b: string) => Uint8Array;
  compute_diff_mask_encoded?: (encoded_a: Uint8Array, encoded_b: Uint8Array) => Uint8Array;
  compute_micro_runs?: (
    encoded: Uint8Array,
    start_row: number,
    end_row: number,
    cols: number,
    cell_width: number,
    cell_height: number,
    offset_y: number,
    start_row_offset: number
  ) => Float32Array;
  shannon_entropy?: (probs: Float64Array) => number;
  shannon_entropy_from_counts?: (counts: Float64Array) => number;
  jensen_shannon_divergence?: (p: Float64Array, q: Float64Array) => number;
  jensen_shannon_divergence_from_counts?: (counts_p: Float64Array, counts_q: Float64Array) => number;
  kl_divergence_dense?: (p_counts: Uint32Array, q_counts: Uint32Array) => number;
  compute_linguistic_complexity?: (seq: string, k_max: number) => number;
  compute_windowed_complexity?: (seq: string, window_size: number, step_size: number, k: number) => Float64Array;
  hoeffdings_d?: (x: Float64Array, y: Float64Array) => HoeffdingResult;
  kmer_hoeffdings_d?: (sequence_a: string, sequence_b: string, k: number) => HoeffdingResult;
}

export type WasmComputeVariant = 'baseline' | 'simd';

/**
 * Result of attempting to load the WASM module.
 */
export type WasmLoadResult =
  | { ok: true; module: WasmComputeModule; variant: WasmComputeVariant }
  | { ok: false; error: string };

/**
 * Loading state for the WASM module.
 */
export type WasmLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; module: WasmComputeModule; variant: WasmComputeVariant }
  | { status: 'failed'; error: string };

// ============================================================================
// State
// ============================================================================

/** Current load state */
let loadState: WasmLoadState = { status: 'idle' };

/** In-flight load promise (for deduplication) */
let loadPromise: Promise<WasmLoadResult> | null = null;

// ============================================================================
// Logging (dev-only)
// ============================================================================

const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;

function log(message: string, data?: Record<string, unknown>): void {
  if (!isDev) return;
  if (data) {
    console.log(`[wasm-loader] ${message}`, data);
  } else {
    console.log(`[wasm-loader] ${message}`);
  }
}

function warn(message: string, error?: unknown): void {
  if (!isDev) return;
  if (error) {
    console.warn(`[wasm-loader] ${message}`, error);
  } else {
    console.warn(`[wasm-loader] ${message}`);
  }
}

// ============================================================================
// Core Loading Logic
// ============================================================================

/**
 * Attempt to load the wasm-compute module.
 * This is the internal implementation that does the actual work.
 */
async function loadWasmModule(): Promise<WasmLoadResult> {
  // Quick check: is WASM even supported?
  if (!canUseWasm()) {
    const error = 'WebAssembly not supported in this environment';
    warn(error);
    return { ok: false, error };
  }

  try {
    log('Loading wasm-compute module...');
    const startTime = performance.now();

    const tryLoad = async (
      variant: WasmComputeVariant
    ): Promise<{ module: WasmComputeModule; variant: WasmComputeVariant }> => {
      const wasm =
        variant === 'simd'
          ? ((await import('@phage/wasm-compute/simd')) as unknown as WasmComputeModule)
          : await import('@phage/wasm-compute');

      // Initialize the module if it has an init function.
      //
      // Our inlined wasm-pack wrapper exports an idempotent default `init()` that must succeed for
      // wasm exports to be usable. If init throws, treat this variant as failed so callers fall
      // back to the baseline build or JS implementations instead of using a half-initialized module.
      const maybeInit = (wasm as unknown as { default?: unknown }).default;
      if (typeof maybeInit === 'function') {
        await (maybeInit as () => Promise<void>)();
        log('WASM init() called successfully', { variant });
      }

      // Initialize panic hook for better error messages (if available)
      try {
        if (typeof wasm.init_panic_hook === 'function') {
          wasm.init_panic_hook();
          log('WASM panic hook initialized', { variant });
        }
      } catch {
        // Panic hook is optional
      }

      return { module: wasm, variant };
    };

    // Prefer SIMD build when supported, but always fall back to baseline.
    const preferSimd = await canUseWasmSimd().catch(() => false);
    const candidates: WasmComputeVariant[] = preferSimd ? ['simd', 'baseline'] : ['baseline'];

    let lastError: unknown = null;
    for (const variant of candidates) {
      try {
        const loaded = await tryLoad(variant);
        const elapsed = performance.now() - startTime;
        log('WASM module loaded successfully', {
          variant: loaded.variant,
          elapsed: `${elapsed.toFixed(1)}ms`,
        });
        return { ok: true, module: loaded.module, variant: loaded.variant };
      } catch (e) {
        lastError = e;
        warn(`Failed to load WASM variant: ${variant}`, e);
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    return { ok: false, error: errorMessage };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    warn('Failed to load WASM module', error);
    return { ok: false, error: errorMessage };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get the wasm-compute module, loading it if necessary.
 *
 * This function is safe to call from multiple places concurrently.
 * It will deduplicate in-flight loads and cache the result.
 *
 * @returns The WASM module if available, null if loading failed
 *
 * @example
 * ```ts
 * const wasm = await getWasmCompute();
 * if (wasm) {
 *   const skew = wasm.compute_gc_skew(sequence, 100);
 * }
 * ```
 */
export async function getWasmCompute(): Promise<WasmComputeModule | null> {
  // Fast path: already loaded
  if (loadState.status === 'ready') {
    return loadState.module;
  }

  // Fast path: already failed
  if (loadState.status === 'failed') {
    return null;
  }

  // Check if there's an in-flight load to share
  if (loadPromise) {
    const result = await loadPromise;
    return result.ok ? result.module : null;
  }

  // Start a new load
  loadState = { status: 'loading' };
  loadPromise = loadWasmModule();

  try {
    const result = await loadPromise;

    if (result.ok) {
      loadState = { status: 'ready', module: result.module, variant: result.variant };
      return result.module;
    } else {
      loadState = { status: 'failed', error: result.error };
      return null;
    }
  } finally {
    loadPromise = null;
  }
}

/**
 * Get the wasm-compute module with detailed result info.
 *
 * Use this when you need to know the specific error or want to
 * handle the loading state explicitly.
 *
 * @returns Detailed load result
 */
export async function getWasmComputeResult(): Promise<WasmLoadResult> {
  // Snapshot the current state so TypeScript doesn't incorrectly narrow `loadState`
  // across the `await` boundary below (since `getWasmCompute()` mutates `loadState`).
  const existing = loadState;

  // Fast path: already loaded
  if (existing.status === 'ready') {
    return { ok: true, module: existing.module, variant: existing.variant };
  }

  // Fast path: already failed
  if (existing.status === 'failed') {
    return { ok: false, error: existing.error };
  }

  // Load if needed
  const module = await getWasmCompute();
  if (module) {
    return loadState.status === 'ready'
      ? { ok: true, module: loadState.module, variant: loadState.variant }
      : { ok: true, module, variant: 'baseline' };
  }

  // Prefer the recorded failure reason when available.
  return loadState.status === 'failed'
    ? { ok: false, error: loadState.error }
    : { ok: false, error: 'WASM module unavailable' };
}

/**
 * Check if the WASM module is available.
 *
 * This is a synchronous check that returns true only if the module
 * has already been loaded successfully. Use this for quick guards
 * after the initial load.
 *
 * @returns true if WASM is ready to use
 */
export function isWasmComputeAvailable(): boolean {
  return loadState.status === 'ready';
}

/**
 * Check if WASM loading has failed.
 *
 * @returns true if WASM loading was attempted and failed
 */
export function isWasmComputeFailed(): boolean {
  return loadState.status === 'failed';
}

/**
 * Get the current load state.
 *
 * Useful for debugging and status display.
 *
 * @returns Current load state
 */
export function getWasmLoadState(): WasmLoadState {
  return loadState;
}

/**
 * Get the loaded WASM variant (baseline vs SIMD) when available.
 *
 * @returns The selected variant if loaded, otherwise null
 */
export function getWasmComputeVariant(): WasmComputeVariant | null {
  return loadState.status === 'ready' ? loadState.variant : null;
}

/**
 * Get the failure reason if loading failed.
 *
 * @returns Error message if failed, undefined otherwise
 */
export function getWasmFailureReason(): string | undefined {
  return loadState.status === 'failed' ? loadState.error : undefined;
}

/**
 * Preload the WASM module without waiting for the result.
 *
 * Call this early (e.g., during app init) to start loading in the background.
 * Subsequent calls to getWasmCompute() will return the cached result.
 *
 * @example
 * ```ts
 * // In App.tsx or similar
 * useEffect(() => {
 *   preloadWasmCompute();
 * }, []);
 * ```
 */
export function preloadWasmCompute(): void {
  if (loadState.status === 'idle') {
    // Fire and forget - the load will be cached
    void getWasmCompute();
  }
}

// ============================================================================
// Reset (for testing)
// ============================================================================

/**
 * Reset the loader state. For testing only.
 * @internal
 */
export function _resetWasmLoader(): void {
  loadState = { status: 'idle' };
  loadPromise = null;
}
