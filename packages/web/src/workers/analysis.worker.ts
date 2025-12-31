/**
 * Analysis Worker - Heavy computation for sequence analysis
 *
 * Runs in a Web Worker to avoid blocking the UI thread.
 * Uses Comlink for type-safe communication.
 */

import * as Comlink from 'comlink';
import { simulateTranscriptionFlow } from '@phage-explorer/core';
import {
  DENSE_KMER_MAX_K,
  topKFromDenseCounts,
  canUseDenseKmerCounts,
} from '@phage-explorer/core/analysis/dense-kmer';
import { gpuCompute } from './gpu/GPUCompute';
import { getWasmCompute } from '../lib/wasm-loader';
import type {
  AnalysisRequest,
  AnalysisResult,
  ProgressInfo,
  GCSkewResult,
  ComplexityResult,
  BendabilityResult,
  PromoterResult,
  RepeatResult,
  CodonUsageResult,
  KmerSpectrumResult,
  SharedAnalysisRequest,
  SharedAnalysisWorkerAPI,
  SequenceBytesRef,
} from './types';

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

// Dinucleotide bendability values (simplified model)
const BENDABILITY: Record<string, number> = {
  'AA': 0.35, 'AT': 0.31, 'AC': 0.32, 'AG': 0.29,
  'TA': 0.36, 'TT': 0.35, 'TC': 0.30, 'TG': 0.27,
  'CA': 0.27, 'CT': 0.29, 'CC': 0.25, 'CG': 0.20,
  'GA': 0.30, 'GT': 0.32, 'GC': 0.24, 'GG': 0.25,
};

// Standard genetic code
const CODON_TABLE: Record<string, string> = {
  'TTT': 'F', 'TTC': 'F', 'TTA': 'L', 'TTG': 'L',
  'CTT': 'L', 'CTC': 'L', 'CTA': 'L', 'CTG': 'L',
  'ATT': 'I', 'ATC': 'I', 'ATA': 'I', 'ATG': 'M',
  'GTT': 'V', 'GTC': 'V', 'GTA': 'V', 'GTG': 'V',
  'TCT': 'S', 'TCC': 'S', 'TCA': 'S', 'TCG': 'S',
  'CCT': 'P', 'CCC': 'P', 'CCA': 'P', 'CCG': 'P',
  'ACT': 'T', 'ACC': 'T', 'ACA': 'T', 'ACG': 'T',
  'GCT': 'A', 'GCC': 'A', 'GCA': 'A', 'GCG': 'A',
  'TAT': 'Y', 'TAC': 'Y', 'TAA': '*', 'TAG': '*',
  'CAT': 'H', 'CAC': 'H', 'CAA': 'Q', 'CAG': 'Q',
  'AAT': 'N', 'AAC': 'N', 'AAA': 'K', 'AAG': 'K',
  'GAT': 'D', 'GAC': 'D', 'GAA': 'E', 'GAG': 'E',
  'TGT': 'C', 'TGC': 'C', 'TGA': '*', 'TGG': 'W',
  'CGT': 'R', 'CGC': 'R', 'CGA': 'R', 'CGG': 'R',
  'AGT': 'S', 'AGC': 'S', 'AGA': 'R', 'AGG': 'R',
  'GGT': 'G', 'GGC': 'G', 'GGA': 'G', 'GGG': 'G',
};

// ============================================================
// Byte-backed sequence helpers (no giant intermediate strings)
// ============================================================

function isACGTAsciiByte(b: number): boolean {
  // Upper + lower case; treat U as T for robustness.
  return (
    b === 65 || b === 67 || b === 71 || b === 84 || b === 85 ||
    b === 97 || b === 99 || b === 103 || b === 116 || b === 117
  );
}

function asciiToAcgt05(b: number): 0 | 1 | 2 | 3 | 4 {
  // Uppercase
  if (b === 65 || b === 97) return 0; // A/a
  if (b === 67 || b === 99) return 1; // C/c
  if (b === 71 || b === 103) return 2; // G/g
  if (b === 84 || b === 116) return 3; // T/t
  if (b === 85 || b === 117) return 3; // U/u -> T
  return 4; // N/ambiguous
}

function encodeAsciiToAcgt05(src: Uint8Array, dst?: Uint8Array): Uint8Array {
  const out = dst ?? new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = asciiToAcgt05(src[i]);
  }
  return out;
}

interface Rolling2BitState {
  /** Packed 2-bit codes for the last k bases. */
  value: number;
  /** Consecutive valid (ACGT) bases observed so far (resets on ambiguity). */
  valid: number;
  /** Bitmask for keeping only the last k codes (2*k bits). */
  mask: number;
  k: number;
}

function createRolling2BitState(k: number): Rolling2BitState {
  // This representation is limited to k <= 15 (2*k <= 30) to stay in safe 32-bit bitwise ops.
  const safeK = Math.max(1, Math.min(15, Math.floor(k)));
  return {
    value: 0,
    valid: 0,
    mask: (1 << (safeK * 2)) - 1,
    k: safeK,
  };
}

/**
 * Rolling 2-bit update with deterministic ambiguity handling.
 *
 * ABI rule: anything not A/C/G/T (code 4) resets rolling state, so no k-mer spans ambiguity.
 * Returns true if the rolling window is "full" (k consecutive valid bases observed).
 */
function rolling2bitUpdate(state: Rolling2BitState, code: 0 | 1 | 2 | 3 | 4): boolean {
  if (code > 3) {
    state.value = 0;
    state.valid = 0;
    return false;
  }

  state.value = ((state.value << 2) | code) & state.mask;
  state.valid = Math.min(state.k, state.valid + 1);
  return state.valid === state.k;
}

function decodeAsciiBytes(bytes: Uint8Array): string {
  if (textDecoder) return textDecoder.decode(bytes);

  const CHUNK = 0x2000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    out += String.fromCharCode(...chunk);
  }
  return out;
}

function decodeSequenceRef(ref: SequenceBytesRef): string {
  const view = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);

  if (ref.encoding === 'ascii') {
    const slice = ref.length < view.length ? view.subarray(0, ref.length) : view;
    return decodeAsciiBytes(slice);
  }

  // Temporary compatibility path: map 0-4 codes to ASCII bases.
  const out = new Uint8Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const code = view[i] ?? 4;
    out[i] =
      code === 0 ? 65 : // A
      code === 1 ? 67 : // C
      code === 2 ? 71 : // G
      code === 3 ? 84 : // T
      78;              // N
  }
  return decodeAsciiBytes(out);
}

function getSequenceBytesView(ref: SequenceBytesRef): Uint8Array {
  const view = new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength);
  return ref.length < view.length ? view.subarray(0, ref.length) : view;
}

/**
 * Calculate GC skew along the sequence
 */
function calculateGCSkew(sequence: string, windowSize = 1000): GCSkewResult {
  const seq = sequence.toUpperCase();
  const skew: number[] = [];
  const cumulative: number[] = [];
  let cumSum = 0;

  for (let i = 0; i < seq.length - windowSize; i += windowSize / 4) {
    const window = seq.slice(i, i + windowSize);
    let g = 0, c = 0;
    for (const char of window) {
      if (char === 'G') g++;
      else if (char === 'C') c++;
    }
    const total = g + c;
    const skewVal = total > 0 ? (g - c) / total : 0;
    skew.push(skewVal);
    cumSum += skewVal;
    cumulative.push(cumSum);
  }

  // Find origin (min cumulative) and terminus (max cumulative)
  let minIdx = 0, maxIdx = 0;
  let minVal = cumulative[0], maxVal = cumulative[0];
  for (let i = 1; i < cumulative.length; i++) {
    if (cumulative[i] < minVal) {
      minVal = cumulative[i];
      minIdx = i;
    }
    if (cumulative[i] > maxVal) {
      maxVal = cumulative[i];
      maxIdx = i;
    }
  }

  const stepSize = windowSize / 4;
  return {
    type: 'gc-skew',
    skew,
    cumulative,
    originPosition: minIdx * stepSize,
    terminusPosition: maxIdx * stepSize,
  };
}

/**
 * Calculate sequence complexity (Shannon entropy + linguistic)
 */
function calculateComplexity(sequence: string, windowSize = 100): ComplexityResult {
  const seq = sequence.toUpperCase();
  const entropy: number[] = [];
  const linguistic: number[] = [];
  const lowComplexityRegions: Array<{ start: number; end: number }> = [];

  const stepSize = windowSize / 2;
  let inLowRegion = false;
  let regionStart = 0;

  for (let i = 0; i < seq.length - windowSize; i += stepSize) {
    const window = seq.slice(i, i + windowSize);

    // Shannon entropy
    const counts: Record<string, number> = {};
    for (const char of window) {
      if ('ACGT'.includes(char)) {
        counts[char] = (counts[char] || 0) + 1;
      }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    let ent = 0;
    if (total > 0) {
      for (const count of Object.values(counts)) {
        const p = count / total;
        if (p > 0) ent -= p * Math.log2(p);
      }
    }
    entropy.push(ent / 2); // Normalize to 0-1

    // Linguistic complexity (unique trimers)
    const kmers = new Set<string>();
    for (let j = 0; j <= window.length - 3; j++) {
      const kmer = window.slice(j, j + 3);
      if (!/[^ACGT]/.test(kmer)) kmers.add(kmer);
    }
    const maxPossible = Math.min(64, window.length - 2);
    linguistic.push(maxPossible > 0 ? kmers.size / maxPossible : 0);

    // Track low complexity regions
    const isLow = ent / 2 < 0.5;
    if (isLow && !inLowRegion) {
      inLowRegion = true;
      regionStart = i;
    } else if (!isLow && inLowRegion) {
      inLowRegion = false;
      lowComplexityRegions.push({ start: regionStart, end: i });
    }
  }

  if (inLowRegion) {
    lowComplexityRegions.push({ start: regionStart, end: seq.length });
  }

  return { type: 'complexity', entropy, linguistic, lowComplexityRegions };
}

/**
 * Calculate DNA bendability profile
 */
function calculateBendability(sequence: string, windowSize = 50): BendabilityResult {
  const seq = sequence.toUpperCase();
  const values: number[] = [];
  const flexibleRegions: Array<{ start: number; end: number; avgBendability: number }> = [];

  const stepSize = windowSize / 4;
  let inFlexRegion = false;
  let regionStart = 0;
  let regionSum = 0;
  let regionCount = 0;

  for (let i = 0; i < seq.length - windowSize; i += stepSize) {
    const window = seq.slice(i, i + windowSize);
    let sum = 0, count = 0;

    for (let j = 0; j < window.length - 1; j++) {
      const di = window[j] + window[j + 1];
      if (BENDABILITY[di] !== undefined) {
        sum += BENDABILITY[di];
        count++;
      }
    }

    const avg = count > 0 ? sum / count : 0.3;
    values.push(avg);

    // Track flexible regions (above average bendability)
    const isFlexible = avg > 0.32;
    if (isFlexible && !inFlexRegion) {
      inFlexRegion = true;
      regionStart = i;
      regionSum = avg;
      regionCount = 1;
    } else if (isFlexible && inFlexRegion) {
      regionSum += avg;
      regionCount++;
    } else if (!isFlexible && inFlexRegion) {
      inFlexRegion = false;
      flexibleRegions.push({
        start: regionStart,
        end: i,
        avgBendability: regionSum / regionCount,
      });
    }
  }

  if (inFlexRegion) {
    flexibleRegions.push({
      start: regionStart,
      end: seq.length,
      avgBendability: regionSum / regionCount,
    });
  }

  return { type: 'bendability', values, flexibleRegions };
}

/**
 * Find promoters and RBS sites
 */
function findPromoters(sequence: string): PromoterResult {
  const sites: PromoterResult['sites'] = [];
  const seq = sequence.toUpperCase();

  // -10 box (TATAAT-like)
  const tatBox = /T[AT]T[AT][AT]T/g;
  let match;
  while ((match = tatBox.exec(seq)) !== null) {
    const upstream = seq.slice(Math.max(0, match.index - 25), match.index);
    const has35 = /TT[GC][AC][CG][AT]/.test(upstream);
    sites.push({
      type: 'promoter',
      position: match.index,
      sequence: seq.slice(match.index, match.index + 6),
      score: has35 ? 0.9 : 0.6,
      motif: '-10 box' + (has35 ? ' + -35 box' : ''),
    });
    if (sites.length >= 100) break;
  }

  // Shine-Dalgarno/RBS
  const rbsPattern = /[AG]GG[AG]GG/g;
  while ((match = rbsPattern.exec(seq)) !== null) {
    sites.push({
      type: 'rbs',
      position: match.index,
      sequence: seq.slice(match.index, match.index + 6),
      score: 0.8,
      motif: 'Shine-Dalgarno',
    });
    if (sites.length >= 100) break;
  }

  sites.sort((a, b) => a.position - b.position);
  return { type: 'promoters', sites: sites.slice(0, 100) };
}

/**
 * Find repeat sequences
 */
function findRepeats(sequence: string, minLength = 8, maxGap = 5000): RepeatResult {
  const repeats: RepeatResult['repeats'] = [];
  const seq = sequence.toUpperCase();

  const step = Math.max(1, Math.floor(seq.length / 500));

  const reverseComplement = (s: string): string => {
    const comp: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };
    return s.split('').reverse().map(c => comp[c] || c).join('');
  };

  for (let i = 0; i < seq.length - minLength; i += step) {
    const pattern = seq.slice(i, i + minLength);
    if (/[^ACGT]/.test(pattern)) continue;

    const searchStart = Math.min(i + minLength, seq.length);
    const searchEnd = Math.min(i + maxGap, seq.length);
    const searchRegion = seq.slice(searchStart, searchEnd);

    // Direct repeats
    let idx = searchRegion.indexOf(pattern);
    if (idx !== -1 && repeats.length < 50) {
      repeats.push({
        type: 'direct',
        position1: i,
        position2: searchStart + idx,
        sequence: pattern,
        length: minLength,
      });
    }

    // Inverted repeats
    const revComp = reverseComplement(pattern);
    idx = searchRegion.indexOf(revComp);
    if (idx !== -1 && repeats.length < 50) {
      repeats.push({
        type: 'inverted',
        position1: i,
        position2: searchStart + idx,
        sequence: pattern,
        length: minLength,
      });
    }

    // Palindromes
    if (pattern === revComp && repeats.length < 50) {
      repeats.push({
        type: 'palindrome',
        position1: i,
        sequence: pattern,
        length: minLength,
      });
    }
  }

  return { type: 'repeats', repeats };
}

/**
 * Calculate codon usage statistics
 */
function calculateCodonUsage(sequence: string): CodonUsageResult {
  const seq = sequence.toUpperCase().replace(/[^ACGT]/g, '');
  const usage: Record<string, number> = {};
  const rscu: Record<string, number> = {};

  // Count codons
  for (let i = 0; i <= seq.length - 3; i += 3) {
    const codon = seq.slice(i, i + 3);
    if (CODON_TABLE[codon]) {
      usage[codon] = (usage[codon] || 0) + 1;
    }
  }

  // Calculate RSCU (Relative Synonymous Codon Usage)
  const aaGroups: Record<string, string[]> = {};
  for (const [codon, aa] of Object.entries(CODON_TABLE)) {
    if (!aaGroups[aa]) aaGroups[aa] = [];
    aaGroups[aa].push(codon);
  }

  for (const [, codons] of Object.entries(aaGroups)) {
    const total = codons.reduce((sum, c) => sum + (usage[c] || 0), 0);
    const expected = total / codons.length;
    for (const codon of codons) {
      rscu[codon] = expected > 0 ? (usage[codon] || 0) / expected : 0;
    }
  }

  return { type: 'codon-usage', usage, rscu };
}

/**
 * Calculate k-mer spectrum
 *
 * Uses a tiered approach for performance:
 * 1. GPU (k <= 12) - fastest when available
 * 2. WASM dense counter (k <= 10) - fast, no string allocations
 * 3. CPU Map-based fallback - slowest, used for k > 10 without GPU
 *
 * @see phage_explorer-vk7b.3
 */
async function calculateKmerSpectrum(sequence: string, k = 6): Promise<KmerSpectrumResult> {
  const seq = sequence.toUpperCase().replace(/[^ACGT]/g, '');
  let spectrum: Array<{ kmer: string; count: number; frequency: number }> | null = null;
  let uniqueKmers = 0;
  let totalKmers = Math.max(1, seq.length - k + 1);

  // Tier 1: Try GPU if k is small enough (shader limit)
  if (k <= 12) {
    try {
      const gpuSupported = await gpuCompute.ready();
      if (gpuSupported) {
        const counts = await gpuCompute.countKmers(seq, k);
        if (counts) {
          uniqueKmers = counts.size;
          spectrum = Array.from(counts.entries())
            .map(([kmer, count]) => ({
              kmer,
              count,
              frequency: count / totalKmers,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 100);
        }
      }
    } catch (e) {
      console.warn('GPU k-mer count failed, trying WASM fallback', e);
      spectrum = null;
    }
  }

  // Tier 2: Try WASM dense counter (k <= 10, ~4MB max)
  // This is the key optimization: no per-k-mer string allocations
  if (!spectrum && canUseDenseKmerCounts(k)) {
    try {
      const wasm = await getWasmCompute();
      if (wasm) {
        // Convert sequence to bytes for WASM
        const seqBytes = new TextEncoder().encode(seq);
        const result = wasm.count_kmers_dense(seqBytes, k);

        try {
          const counts = result.counts;
          // total_valid is bigint from Rust u64
          totalKmers = Number(result.total_valid);
          uniqueKmers = result.unique_count;

          // Extract top 100 k-mers efficiently (min-heap, O(n log 100))
          const topKmers = topKFromDenseCounts(counts, k, 100);
          spectrum = topKmers.map(({ kmer, count }) => ({
            kmer,
            count,
            frequency: totalKmers > 0 ? count / totalKmers : 0,
          }));
        } finally {
          // IMPORTANT: Free WASM memory
          result.free();
        }
      }
    } catch (e) {
      console.warn('WASM k-mer count failed, falling back to CPU', e);
      spectrum = null;
    }
  }

  // Tier 3: CPU fallback (slow, uses Map<string, number>)
  if (!spectrum) {
    const counts = new Map<string, number>();
    for (let i = 0; i <= seq.length - k; i++) {
      const kmer = seq.slice(i, i + k);
      counts.set(kmer, (counts.get(kmer) || 0) + 1);
    }
    uniqueKmers = counts.size;
    totalKmers = Math.max(1, seq.length - k + 1);
    spectrum = Array.from(counts.entries())
      .map(([kmer, count]) => ({
        kmer,
        count,
        frequency: count / totalKmers,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);
  }

  return {
    type: 'kmer-spectrum',
    kmerSize: k,
    spectrum,
    uniqueKmers,
    totalKmers,
  };
}

function calculateGCSkewFromRef(ref: SequenceBytesRef, windowSize = 1000): GCSkewResult {
  const bytes = getSequenceBytesView(ref);
  const skew: number[] = [];
  const cumulative: number[] = [];
  let cumSum = 0;

  const winSize = Math.max(1, Math.floor(windowSize));
  const stepSize = Math.max(1, Math.floor(winSize / 4));

  for (let i = 0; i < bytes.length - winSize; i += stepSize) {
    const end = Math.min(bytes.length, i + winSize);
    let g = 0;
    let c = 0;

    if (ref.encoding === 'ascii') {
      for (let j = i; j < end; j++) {
        const b = bytes[j];
        if (b === 71 || b === 103) g++; // G/g
        else if (b === 67 || b === 99) c++; // C/c
      }
    } else {
      // acgt05 codes: A=0, C=1, G=2, T=3, N=4
      for (let j = i; j < end; j++) {
        const code = bytes[j];
        if (code === 2) g++;
        else if (code === 1) c++;
      }
    }

    const total = g + c;
    const skewVal = total > 0 ? (g - c) / total : 0;
    skew.push(skewVal);
    cumSum += skewVal;
    cumulative.push(cumSum);
  }

  // Find origin (min cumulative) and terminus (max cumulative)
  let minIdx = 0;
  let maxIdx = 0;
  let minVal = cumulative[0] ?? 0;
  let maxVal = cumulative[0] ?? 0;
  for (let i = 1; i < cumulative.length; i++) {
    const val = cumulative[i];
    if (val < minVal) {
      minVal = val;
      minIdx = i;
    }
    if (val > maxVal) {
      maxVal = val;
      maxIdx = i;
    }
  }

  return {
    type: 'gc-skew',
    skew,
    cumulative,
    originPosition: minIdx * stepSize,
    terminusPosition: maxIdx * stepSize,
  };
}

async function runAnalysisImpl(request: AnalysisRequest): Promise<AnalysisResult> {
  const { type, sequence, options = {} } = request;

  switch (type) {
    case 'gc-skew':
      return calculateGCSkew(sequence, options.windowSize || 1000);
    case 'complexity':
      return calculateComplexity(sequence, options.windowSize || 100);
    case 'bendability':
      return calculateBendability(sequence, options.windowSize || 50);
    case 'promoters':
      return findPromoters(sequence);
    case 'repeats':
      return findRepeats(sequence, options.minLength || 8, options.maxGap || 5000);
    case 'codon-usage':
      return calculateCodonUsage(sequence);
    case 'kmer-spectrum':
      return await calculateKmerSpectrum(sequence, options.kmerSize || 6);
    case 'transcription-flow': {
      const flow = simulateTranscriptionFlow(sequence);
      return { type: 'transcription-flow', ...flow };
    }
    default:
      throw new Error(`Unknown analysis type: ${type}`);
  }
}

async function runAnalysisWithProgressImpl(
  request: AnalysisRequest,
  onProgress: (progress: ProgressInfo) => void
): Promise<AnalysisResult> {
  onProgress({ current: 0, total: 100, message: `Starting ${request.type} analysis...` });
  const result = await runAnalysisImpl(request);
  onProgress({ current: 100, total: 100, message: 'Complete' });
  return result;
}

/**
 * Analysis Worker API implementation
 */
const workerAPI: SharedAnalysisWorkerAPI = {
  runAnalysis: runAnalysisImpl,

  runAnalysisWithProgress: runAnalysisWithProgressImpl,

  async runAnalysisShared(request: SharedAnalysisRequest): Promise<AnalysisResult> {
    if (request.type === 'gc-skew') {
      return calculateGCSkewFromRef(request.sequenceRef, request.options?.windowSize || 1000);
    }

    // Fall back to string-based implementations for now (some rely on regex/string APIs).
    const sequence = decodeSequenceRef(request.sequenceRef);
    return runAnalysisImpl({ type: request.type, sequence, options: request.options });
  },

  async runAnalysisSharedWithProgress(
    request: SharedAnalysisRequest,
    onProgress: (progress: ProgressInfo) => void
  ): Promise<AnalysisResult> {
    onProgress({ current: 0, total: 100, message: `Starting ${request.type} analysis...` });

    const result =
      request.type === 'gc-skew'
        ? calculateGCSkewFromRef(request.sequenceRef, request.options?.windowSize || 1000)
        : await runAnalysisImpl({
            type: request.type,
            sequence: decodeSequenceRef(request.sequenceRef),
            options: request.options,
          });

    onProgress({ current: 100, total: 100, message: 'Complete' });
    return result;
  },
};

// Expose worker API via Comlink
Comlink.expose(workerAPI);
