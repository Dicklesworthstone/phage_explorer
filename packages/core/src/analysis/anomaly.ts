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

type WasmCountKmersFn = (seq: Uint8Array, k: number) => WasmDenseKmerResult;

let wasmCountKmersDense: WasmCountKmersFn | null = null;
let wasmAvailable = false;

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * Initialize WASM k-mer counting (non-blocking).
 */
async function initWasmKmerCounter(): Promise<void> {
  if (wasmAvailable) return;
  try {
    const wasm = await import('@phage/wasm-compute');
    wasmCountKmersDense = wasm.count_kmers_dense;

    // Quick test to verify it works
    if (textEncoder && wasmCountKmersDense) {
      const testBytes = textEncoder.encode('ACGTACGT');
      const result = wasmCountKmersDense(testBytes, 2);
      wasmAvailable = result.counts.length === 16; // 4^2 = 16
      result.free();
    }
  } catch {
    wasmAvailable = false;
  }
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

  for (let i = 0; i < total; i++) {
    const kmer = sequence.slice(i, i + k);
    freq.set(kmer, (freq.get(kmer) || 0) + 1);
  }

  // Normalize
  for (const [kmer, count] of freq) {
    freq.set(kmer, count / total);
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
    return sequence.length / compressed.length;
  } catch {
    return 1;
  }
}

/**
 * Scan sequence for anomalies
 *
 * Uses WASM-accelerated dense k-mer counting when k <= 10 for ~10x faster
 * processing on large genomes. Falls back to Map-based counting for k > 10.
 */
export function scanForAnomalies(
  sequence: string,
  windowSize = 500,
  stepSize = 100,
  k = 4
): AnomalyScanResult {
  const seq = sequence.toUpperCase().replace(/[^ACGT]/g, '');
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
 * ~10x faster than Map-based for large sequences.
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
    const comp = calculateCompressionRatio(windowSeq);

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

  const p95Index = Math.floor(windows.length * 0.95);

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
    const comp = calculateCompressionRatio(windowSeq);

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

  const p95Index = Math.floor(windows.length * 0.95);

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
