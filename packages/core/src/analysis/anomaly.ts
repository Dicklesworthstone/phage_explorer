/**
 * Information-Theoretic Sequence Anomaly Scanner
 *
 * Detects anomalous regions using:
 * 1. Kullback-Leibler (KL) Divergence of k-mer distributions vs global background.
 * 2. Compression Ratio (Lempel-Ziv / Deflate approximation) to find low-complexity or repetitive regions.
 *
 * @see phage_explorer-vk7b.5
 */

import { deflate } from 'pako';
import {
  canUseDenseKmerCounts,
  countKmersDenseJS,
  countsToFrequencies,
  type DenseKmerCountResult,
} from './dense-kmer';

// ============================================================================
// WASM K-mer Counter Loader
// ============================================================================

const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;

interface WasmDenseKmerResult {
  counts: Uint32Array;
  total_valid: bigint;
  k: number;
  unique_count: number;
  free(): void;
}

interface WasmKLScanResult {
  kl_values: Float32Array;
  positions: Uint32Array;
  window_count: number;
  k: number;
  free(): void;
}

type WasmCountKmersFn = (seq: Uint8Array, k: number) => WasmDenseKmerResult;
type WasmScanKLFn = (seq: Uint8Array, k: number, windowSize: number, stepSize: number) => WasmKLScanResult;

let wasmCountKmersDense: WasmCountKmersFn | null = null;
let wasmScanKLWindows: WasmScanKLFn | null = null;
let wasmAvailable = false;
let wasmKLScanAvailable = false;
let wasmKmerInitPromise: Promise<void> | null = null;

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * Initialize WASM k-mer counting and KL scanning (non-blocking).
 */
async function initWasmKmerCounter(): Promise<void> {
  if (wasmAvailable) return;
  // Guard against concurrent initialization attempts (allow retry if WASM is unavailable).
  if (wasmKmerInitPromise) return wasmKmerInitPromise;
  wasmKmerInitPromise = (async () => {
    try {
      const wasm = await import('@phage/wasm-compute');
      // wasm-compute may require explicit async init (depending on build target).
      // Keep this best-effort so we can fall back cleanly if init fails.
      const maybeInit = (wasm as unknown as { default?: () => Promise<void> }).default;
      if (typeof maybeInit === 'function') {
        await maybeInit();
      }
      wasmCountKmersDense = wasm.count_kmers_dense;
      wasmScanKLWindows = wasm.scan_kl_windows;

      // Quick test to verify dense k-mer counting works
      if (textEncoder && wasmCountKmersDense) {
        const testBytes = textEncoder.encode('ACGTACGT');
        const result = wasmCountKmersDense(testBytes, 2);
        wasmAvailable = result.counts.length === 16; // 4^2 = 16
        result.free();
      }

      // Test KL scan function
      if (wasmAvailable && textEncoder && wasmScanKLWindows) {
        const testBytes = textEncoder.encode('ACGTACGTACGTACGTACGT');
        const klResult = wasmScanKLWindows(testBytes, 2, 8, 4);
        wasmKLScanAvailable = klResult.window_count > 0;
        klResult.free();
      }
    } catch {
      wasmAvailable = false;
      wasmKLScanAvailable = false;
      wasmCountKmersDense = null;
      wasmScanKLWindows = null;
    }
  })().finally(() => {
    wasmKmerInitPromise = null;
  });

  return wasmKmerInitPromise;
}

// Initialize on module load (non-blocking)
initWasmKmerCounter().catch(() => { /* WASM unavailable */ });

/**
 * Count k-mers using WASM (fast) or JS fallback.
 * Returns dense counts as Uint32Array with totalValid.
 */
function countKmersDense(sequence: string, k: number): DenseKmerCountResult {
  // Try WASM first
  if (wasmAvailable && textEncoder && wasmCountKmersDense) {
    try {
      const bytes = textEncoder.encode(sequence);
      const result = wasmCountKmersDense(bytes, k);
      const counts = new Uint32Array(result.counts); // Copy before free
      const totalValid = Number(result.total_valid);
      const uniqueCount = result.unique_count;
      result.free();
      return { counts, totalValid, k, uniqueCount };
    } catch {
      // Fall through to JS
    }
  }

  // JS fallback
  return countKmersDenseJS(sequence, k);
}

export interface AnomalyResult {
  position: number;
  klDivergence: number;
  compressionRatio: number;
  isAnomalous: boolean;
  anomalyType?: 'HGT' | 'Repetitive' | 'Regulatory' | 'Unknown';
}

export interface AnomalyScanResult {
  windows: AnomalyResult[];
  globalKmerFreq: Map<string, number>;
  thresholds: {
    kl: number;
    compression: number;
  };
  /** Raw KL divergence values as Float32Array (for fast post-processing) */
  klValues?: Float32Array;
  /** Raw compression ratio values as Float32Array (for fast post-processing) */
  compressionValues?: Float32Array;
  /** Whether WASM acceleration was used */
  usedWasm?: boolean;
}

/**
 * Calculate k-mer frequencies for a sequence
 */
function getKmerFrequencies(sequence: string, k: number): Map<string, number> {
  const freq = new Map<string, number>();
  const total = sequence.length - k + 1;
  if (total <= 0) return freq;

  let validTotal = 0;
  for (let i = 0; i < total; i++) {
    const kmer = sequence.slice(i, i + k);
    if (kmer.includes('N')) continue;
    freq.set(kmer, (freq.get(kmer) || 0) + 1);
    validTotal++;
  }

  // Normalize
  if (validTotal === 0) return freq;
  for (const [kmer, count] of freq) {
    freq.set(kmer, count / validTotal);
  }

  return freq;
}

/**
 * Calculate KL Divergence between two distributions (P || Q)
 * D_KL(P || Q) = sum(P(i) * log2(P(i) / Q(i)))
 */
function calculateKLDivergence(p: Map<string, number>, q: Map<string, number>): number {
  let dkl = 0;
  const epsilon = 1e-6; // Smoothing for missing k-mers

  for (const [kmer, pVal] of p) {
    const qVal = q.get(kmer) || epsilon;
    if (pVal > 0) {
      dkl += pVal * Math.log2(pVal / qVal);
    }
  }

  return Math.max(0, dkl);
}

/**
 * Calculate KL Divergence between two dense frequency arrays (P || Q).
 * D_KL(P || Q) = sum(P(i) * log2(P(i) / Q(i)))
 *
 * Uses typed arrays for ~10x faster iteration than Map-based version.
 */
function calculateKLDivergenceDense(p: Float32Array, q: Float32Array): number {
  if (p.length !== q.length) return 0;

  let dkl = 0;
  const epsilon = 1e-6; // Smoothing for zero-frequency k-mers

  for (let i = 0; i < p.length; i++) {
    const pVal = p[i];
    if (pVal > 0) {
      const qVal = q[i] > 0 ? q[i] : epsilon;
      dkl += pVal * Math.log2(pVal / qVal);
    }
  }

  return Math.max(0, dkl);
}

/**
 * Calculate compression ratio (Original Size / Compressed Size)
 * Higher ratio = Lower complexity (more compressible)
 */
function calculateCompressionRatio(sequence: string): number {
  if (sequence.length === 0) return 1;
  try {
    const compressed = deflate(sequence);
    // Guard against empty compressed output (shouldn't happen, but defensive)
    if (compressed.length === 0) return 1;
    return sequence.length / compressed.length;
  } catch {
    return 1;
  }
}

function p95IndexForLength(length: number): number {
  // Correct 95th percentile: for n items, index is floor((n-1) * 0.95).
  // This ensures we select the 95th percentile element (0-based), not the 96th.
  return Math.max(0, Math.floor((length - 1) * 0.95));
}

/**
 * Scan sequence for anomalies
 *
 * Uses WASM-accelerated dense k-mer counting when k <= 10. Measured 1.0-1.3x
 * for the counting itself (`bun run bench:wasm`); the "~10x" here was never
 * measured and is wrong for this kernel.
 * processing on large genomes. Falls back to Map-based counting for k > 10.
 */
export function scanForAnomalies(
  sequence: string,
  windowSize = 500,
  stepSize = 100,
  k = 4
): AnomalyScanResult {
  // Preserve original coordinate space: replace non-ACGT bases with 'N' instead of dropping them.
  // This avoids shifting window positions relative to the original genome.
  // Note: U→T normalization handles RNA sequences (WASM/JS counters also treat U as T).
  const seq = sequence.toUpperCase().replace(/U/g, 'T').replace(/[^ACGT]/g, 'N');
  if (seq.length < windowSize || windowSize <= 0 || stepSize <= 0) {
    return {
      windows: [],
      globalKmerFreq: new Map(),
      thresholds: { kl: 0, compression: 0 },
    };
  }

  // Use dense path for k <= 10 (WASM-accelerated)
  const useDensePath = canUseDenseKmerCounts(k);

  if (useDensePath) {
    return scanForAnomaliesDense(seq, windowSize, stepSize, k);
  }

  // Fallback: Map-based path for k > 10
  return scanForAnomaliesSparse(seq, windowSize, stepSize, k);
}

/**
 * Dense k-mer path using WASM acceleration.
 *
 * Performance tiers:
 * 1. Ultra-fast: a single WASM call computes all KL values. The "~100x" this
 *    line claimed was never measured; scan_kl_windows has no JS counterpart to
 *    compare against, so no ratio is quoted.
 * 2. Fast: per-window WASM k-mer counting. Faster than the Map-based path, but
 *    the dense counting kernel itself measures 1.0-1.3x against typed-array JS,
 *    not the "~10x" claimed here.
 * 3. Fallback: JS dense k-mer counting
 */
function scanForAnomaliesDense(
  seq: string,
  windowSize: number,
  stepSize: number,
  k: number
): AnomalyScanResult {
  const numWindows = Math.floor((seq.length - windowSize) / stepSize) + 1;
  if (numWindows <= 0) {
    return {
      windows: [],
      globalKmerFreq: new Map(),
      thresholds: { kl: 0, compression: 0 },
      usedWasm: wasmAvailable,
    };
  }

  // Ultra-fast path: Single WASM call for all KL values
  if (wasmKLScanAvailable && textEncoder && wasmScanKLWindows) {
    try {
      const seqBytes = textEncoder.encode(seq);
      const klResult = wasmScanKLWindows(seqBytes, k, windowSize, stepSize);
      if (klResult.window_count > 0) {
        const klValues = Float32Array.from(klResult.kl_values);
        const positions = Uint32Array.from(klResult.positions);
        klResult.free();
        return finishScanWithKLValues(seq, windowSize, k, klValues, positions);
      }
      klResult.free();
    } catch {
      // Fall through to per-window path
    }
  }

  // 1. Compute global background model using dense counts
  const globalCounts = countKmersDense(seq, k);
  const globalFreq = countsToFrequencies(globalCounts.counts, globalCounts.totalValid);

  // Pre-allocate typed arrays for raw values
  const klValuesArray = new Float32Array(numWindows);
  const compressionValuesArray = new Float32Array(numWindows);
  const windows: AnomalyResult[] = [];

  // 2. Sliding window scan with dense k-mer counting
  let windowIndex = 0;
  for (let i = 0; i <= seq.length - windowSize; i += stepSize) {
    const windowSeq = seq.slice(i, i + windowSize);

    // Dense k-mer counting (WASM or JS fallback)
    const windowCounts = countKmersDense(windowSeq, k);
    const windowFreq = countsToFrequencies(windowCounts.counts, windowCounts.totalValid);

    // KL Divergence using dense arrays
    const kl = calculateKLDivergenceDense(windowFreq, globalFreq);

    // Compression Ratio
    // Ignore ambiguous bases for compression so Ns don't dominate the signal.
    const comp = calculateCompressionRatio(windowSeq.replace(/N/g, ''));

    klValuesArray[windowIndex] = kl;
    compressionValuesArray[windowIndex] = comp;

    windows.push({
      position: i,
      klDivergence: kl,
      compressionRatio: comp,
      isAnomalous: false,
    });

    windowIndex++;
  }

  // 3. Determine thresholds (95th percentile)
  const sortedKL = Float32Array.from(klValuesArray).sort();
  const sortedComp = Float32Array.from(compressionValuesArray).sort();

  const p95Index = p95IndexForLength(windows.length);

  const thresholdKL = sortedKL[p95Index] || 0;
  const thresholdComp = sortedComp[p95Index] || 0;

  // 4. Classify anomalies
  for (const w of windows) {
    if (w.klDivergence > thresholdKL && w.compressionRatio < thresholdComp) {
      w.isAnomalous = true;
      w.anomalyType = 'HGT';
    } else if (w.compressionRatio > thresholdComp) {
      w.isAnomalous = true;
      w.anomalyType = 'Repetitive';
    } else if (w.klDivergence > thresholdKL) {
      w.isAnomalous = true;
      w.anomalyType = 'Unknown';
    }
  }

  // Convert dense global counts to Map for API compatibility
  // (only needed for return value, not used in computation)
  const globalFreqMap = denseToSparseFrequencies(globalCounts.counts, globalCounts.totalValid, k);

  if (isDev) {
    console.log('[anomaly] Dense path used:', {
      wasmUsed: wasmAvailable,
      windows: windows.length,
      k,
      globalKmers: globalCounts.uniqueCount,
    });
  }

  return {
    windows,
    globalKmerFreq: globalFreqMap,
    thresholds: {
      kl: thresholdKL,
      compression: thresholdComp,
    },
    klValues: klValuesArray,
    compressionValues: compressionValuesArray,
    usedWasm: wasmAvailable,
  };
}

/**
 * Sparse Map-based path for k > 10.
 * Original implementation preserved for compatibility.
 */
function scanForAnomaliesSparse(
  seq: string,
  windowSize: number,
  stepSize: number,
  k: number
): AnomalyScanResult {
  // 1. Compute global background model
  const globalFreq = getKmerFrequencies(seq, k);

  const windows: AnomalyResult[] = [];

  // 2. Sliding window scan
  for (let i = 0; i <= seq.length - windowSize; i += stepSize) {
    const windowSeq = seq.slice(i, i + windowSize);

    // KL Divergence
    const windowFreq = getKmerFrequencies(windowSeq, k);
    const kl = calculateKLDivergence(windowFreq, globalFreq);

    // Compression Ratio
    // Ignore ambiguous bases for compression so Ns don't dominate the signal.
    const comp = calculateCompressionRatio(windowSeq.replace(/N/g, ''));

    windows.push({
      position: i,
      klDivergence: kl,
      compressionRatio: comp,
      isAnomalous: false,
    });
  }

  // 3. Determine thresholds (95th percentile)
  const klValues = windows.map(w => w.klDivergence).sort((a, b) => a - b);
  const compValues = windows.map(w => w.compressionRatio).sort((a, b) => a - b);

  const p95Index = p95IndexForLength(windows.length);

  const thresholdKL = klValues[p95Index] || 0;
  const thresholdComp = compValues[p95Index] || 0;

  // 4. Classify anomalies
  for (const w of windows) {
    if (w.klDivergence > thresholdKL && w.compressionRatio < thresholdComp) {
      w.isAnomalous = true;
      w.anomalyType = 'HGT';
    } else if (w.compressionRatio > thresholdComp) {
      w.isAnomalous = true;
      w.anomalyType = 'Repetitive';
    } else if (w.klDivergence > thresholdKL) {
      w.isAnomalous = true;
      w.anomalyType = 'Unknown';
    }
  }

  return {
    windows,
    globalKmerFreq: globalFreq,
    thresholds: {
      kl: thresholdKL,
      compression: thresholdComp,
    },
    usedWasm: false,
  };
}

/**
 * Convert dense counts to sparse Map<string, number> for API compatibility.
 * Only generates k-mer strings for non-zero counts.
 */
function denseToSparseFrequencies(
  counts: Uint32Array,
  totalValid: number,
  k: number
): Map<string, number> {
  const freq = new Map<string, number>();
  if (totalValid <= 0) return freq;

  const invTotal = 1.0 / totalValid;
  const bases = ['A', 'C', 'G', 'T'];

  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];
    if (count === 0) continue;

    // Convert index to k-mer string
    let kmer = '';
    let idx = index;
    for (let i = 0; i < k; i++) {
      kmer = bases[idx & 3] + kmer;
      idx >>= 2;
    }

    freq.set(kmer, count * invTotal);
  }

  return freq;
}

/**
 * Finish anomaly scan after getting KL values from WASM.
 * Computes compression ratios and classifies anomalies.
 */
function finishScanWithKLValues(
  seq: string,
  windowSize: number,
  k: number,
  klValues: Float32Array,
  positions: Uint32Array
): AnomalyScanResult {
  const compressionValues = new Float32Array(klValues.length);
  const windows: AnomalyResult[] = [];

  // Compute compression ratios for each window
  for (let i = 0; i < klValues.length; i++) {
    const pos = positions[i];
    const windowSeq = seq.slice(pos, pos + windowSize);
    // Ignore ambiguous bases for compression so Ns don't dominate the signal.
    const comp = calculateCompressionRatio(windowSeq.replace(/N/g, ''));
    compressionValues[i] = comp;

    windows.push({
      position: pos,
      klDivergence: klValues[i],
      compressionRatio: comp,
      isAnomalous: false,
    });
  }

  // Determine thresholds (95th percentile)
  const sortedKL = Float32Array.from(klValues).sort();
  const sortedComp = Float32Array.from(compressionValues).sort();

  const p95Index = p95IndexForLength(windows.length);

  const thresholdKL = sortedKL[p95Index] || 0;
  const thresholdComp = sortedComp[p95Index] || 0;

  // Classify anomalies
  for (const w of windows) {
    if (w.klDivergence > thresholdKL && w.compressionRatio < thresholdComp) {
      w.isAnomalous = true;
      w.anomalyType = 'HGT';
    } else if (w.compressionRatio > thresholdComp) {
      w.isAnomalous = true;
      w.anomalyType = 'Repetitive';
    } else if (w.klDivergence > thresholdKL) {
      w.isAnomalous = true;
      w.anomalyType = 'Unknown';
    }
  }

  // Generate global freq map for API compatibility
  const globalCounts = countKmersDense(seq, k);
  const globalFreqMap = denseToSparseFrequencies(globalCounts.counts, globalCounts.totalValid, k);

  if (isDev) {
    console.log('[anomaly] WASM KL scan used:', {
      windows: windows.length,
      k,
      klScanWasm: true,
    });
  }

  return {
    windows,
    globalKmerFreq: globalFreqMap,
    thresholds: {
      kl: thresholdKL,
      compression: thresholdComp,
    },
    klValues,
    compressionValues,
    usedWasm: true,
  };
}
