/**
 * Analysis Worker - Heavy computation for sequence analysis
 *
 * Runs in a Web Worker to avoid blocking the UI thread.
 * Uses Comlink for type-safe communication.
 */

import * as Comlink from 'comlink';
import {
  computeDinucleotideFrequencies,
  computeGcContent,
  computeKmerFrequencies,
  computePhasePortrait,
  decomposeBias,
  performPCA,
  simulateTranscriptionFlow,
  translateSequence,
} from '@phage-explorer/core';
import {
  topKFromDenseCounts,
  canUseDenseKmerCounts,
} from '@phage-explorer/core/analysis/dense-kmer';
import { gpuCompute } from './gpu/GPUCompute';
import { getWasmCompute, getWasmComputeVariant } from '../lib/wasm-loader';
import { createWorkerAnalysisRecord } from './analysis-evidence';
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
  KmerVectorRequest,
  GenomicSignaturePcaRequest,
  BiasDecompositionRequest,
  BiasDecompositionWorkerResult,
  PhasePortraitRequest,
  SharedAnalysisRequest,
  SharedAnalysisWorkerAPI,
  SequenceBytesRef,
} from './types';

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

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

function asciiToAcgt05(b: number): 0 | 1 | 2 | 3 | 4 {
  // Uppercase
  if (b === 65 || b === 97) return 0; // A/a
  if (b === 67 || b === 99) return 1; // C/c
  if (b === 71 || b === 103) return 2; // G/g
  if (b === 84 || b === 116) return 3; // T/t
  if (b === 85 || b === 117) return 3; // U/u -> T
  return 4; // N/ambiguous
}

function popcount32(x: number): number {
  // Force to unsigned 32-bit.
  let v = x >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Compute linguistic complexity for k=3 in a window using a 64-bit bitset.
 *
 * Semantics match the existing JS implementation:
 * - k-mers containing non-ACGT are skipped (no contribution).
 * - Denominator is `min(64, windowSize - 2)` (does not adjust for ambiguity).
 *
 * Note: We treat U as T for robustness, consistent with other kernels.
 */
function uniqueTrimerRatioAt(seq: string, start: number, windowSize: number): number {
  const maxPossible = Math.min(64, windowSize - 2);
  if (maxPossible <= 0) return 0;

  let seenLo = 0;
  let seenHi = 0;

  let rolling = 0;
  let valid = 0;

  const end = start + windowSize;
  for (let pos = start; pos < end; pos++) {
    const code = asciiToAcgt05(seq.charCodeAt(pos));
    if (code > 3) {
      rolling = 0;
      valid = 0;
      continue;
    }

    rolling = ((rolling << 2) | code) & 0x3f; // keep last 6 bits (3 bases)
    valid = valid < 3 ? valid + 1 : 3;
    if (valid < 3) continue;

    if (rolling < 32) {
      seenLo |= 1 << rolling;
    } else {
      seenHi |= 1 << (rolling - 32);
    }
  }

  const unique = popcount32(seenLo) + popcount32(seenHi);
  return unique / maxPossible;
}

function decodeAsciiBytes(bytes: Uint8Array): string {
  if (textDecoder) {
    // TextDecoder.decode() rejects views over SharedArrayBuffer; copy to a regular buffer first
    const safeBuf =
      typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer
        ? new Uint8Array(bytes)
        : bytes;
    return textDecoder.decode(safeBuf);
  }

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
 * Calculate GC skew along the sequence (JS fallback)
 */
function calculateGCSkewJS(seq: string, windowSize: number, stepSize: number): GCSkewResult {
  const safeWindow = Math.max(1, Math.floor(windowSize));
  const safeStep = Math.max(1, Math.floor(stepSize));

  // If the window is larger than the sequence, return an empty result instead of crashing.
  if (seq.length < safeWindow) {
    return {
      type: 'gc-skew',
      skew: [],
      cumulative: [],
      originPosition: 0,
      terminusPosition: 0,
    };
  }

  const skew: number[] = [];
  const cumulative: number[] = [];
  let cumSum = 0;
  let cumulativeIndex = 0;

  for (let i = 0; i <= seq.length - safeWindow; i += safeStep) {
    const window = seq.slice(i, i + safeWindow);
    let g = 0, c = 0;
    for (const char of window) {
      if (char === 'G') g++;
      else if (char === 'C') c++;
    }
    const total = g + c;
    const skewVal = total > 0 ? (g - c) / total : 0;
    skew.push(skewVal);
    // Match the WASM per-base G-C prefix, sampled at this window's start.
    while (cumulativeIndex <= i) {
      const base = seq[cumulativeIndex++];
      if (base === 'G' || base === 'g') cumSum++;
      else if (base === 'C' || base === 'c') cumSum--;
    }
    cumulative.push(cumSum);
  }

  if (cumulative.length === 0) {
    return {
      type: 'gc-skew',
      skew: [],
      cumulative: [],
      originPosition: 0,
      terminusPosition: 0,
    };
  }

  // Find origin (min cumulative) and terminus (max cumulative)
  let minIdx = 0, maxIdx = 0;
  let minVal = cumulative[0] ?? 0, maxVal = cumulative[0] ?? 0;
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

  return {
    type: 'gc-skew',
    skew,
    cumulative,
    originPosition: minIdx * safeStep,
    terminusPosition: maxIdx * safeStep,
    engine: 'js',
  };
}

/**
 * Calculate GC skew along the sequence
 * Uses WASM acceleration when available, falls back to JS.
 */
async function calculateGCSkewWasm(sequence: string, windowSize = 1000): Promise<GCSkewResult> {
  const seq = sequence.toUpperCase();
  const stepSize = Math.max(1, Math.floor(windowSize / 4));

  try {
    const wasm = await getWasmCompute();
    if (
      wasm &&
      typeof wasm.compute_gc_skew === 'function' &&
      typeof wasm.compute_cumulative_gc_skew === 'function'
    ) {
      // Use WASM for acceleration
      const skew = Array.from(wasm.compute_gc_skew(seq, windowSize, stepSize));

      // Deliberately NOT Array.from: compute_cumulative_gc_skew returns one
      // value PER BASE -- 300,000 for a 300 kb genome -- and the loop below
      // reads only every stepSize-th one, about 1,200 of them. Boxing all
      // 300,000 into a JS array to look at 0.4% of them cost 10 ms of an
      // 11.8 ms call, measured; the kernel itself is 1.8 ms. Float64Array
      // supports the .length and [i] this function needs, so keeping the typed
      // array is both faster and semantically identical.
      const cumulative = wasm.compute_cumulative_gc_skew(seq);

      // Trim cumulative to match skew length (WASM returns per-base cumulative)
      // Sample at stepSize intervals to match skew positions
      const cumulativeSampled: number[] = [];
      for (let i = 0; i < skew.length; i++) {
        const pos = i * stepSize;
        if (pos < cumulative.length) {
          cumulativeSampled.push(cumulative[pos]);
        } else if (cumulative.length > 0) {
          cumulativeSampled.push(cumulative[cumulative.length - 1]);
        }
      }

      // Find origin (min cumulative) and terminus (max cumulative)
      let minIdx = 0, maxIdx = 0;
      let minVal = cumulativeSampled[0] ?? 0, maxVal = cumulativeSampled[0] ?? 0;
      for (let i = 1; i < cumulativeSampled.length; i++) {
        if (cumulativeSampled[i] < minVal) {
          minVal = cumulativeSampled[i];
          minIdx = i;
        }
        if (cumulativeSampled[i] > maxVal) {
          maxVal = cumulativeSampled[i];
          maxIdx = i;
        }
      }

      return {
        type: 'gc-skew',
        skew,
        cumulative: cumulativeSampled,
        originPosition: minIdx * stepSize,
        terminusPosition: maxIdx * stepSize,
        engine: getWasmComputeVariant() === 'simd' ? 'wasm-simd' : 'wasm-baseline',
      };
    }
  } catch (err) {
    // WASM failed, fall back to JS
    if (typeof console !== 'undefined') {
      console.warn('[analysis.worker] WASM GC skew failed, using JS fallback:', err);
    }
  }

  // JS fallback
  return calculateGCSkewJS(seq, windowSize, stepSize);
}

/**
 * Calculate sequence complexity (Shannon entropy + linguistic)
 */
async function calculateComplexity(sequence: string, windowSize = 100): Promise<ComplexityResult> {
  const seq = sequence.toUpperCase();
  const entropy: number[] = [];
  const linguistic: number[] = [];
  const lowComplexityRegions: Array<{ start: number; end: number }> = [];

  const windowSizeInt = Math.max(1, Math.floor(windowSize));
  const stepSize = Math.max(1, Math.floor(windowSizeInt / 2));
  let inLowRegion = false;
  let regionStart = 0;

  // Prefer WASM for windowed entropy + k-mer complexity (fast, low GC churn).
  // Bead: phage_explorer-yvs8.4
  try {
    const wasm = await getWasmCompute();
    if (wasm && typeof wasm.compute_windowed_entropy_acgt === 'function') {
      const wasmEntropy = wasm.compute_windowed_entropy_acgt(seq, windowSizeInt, stepSize);
      const windowCount = wasmEntropy.length;

      for (let i = 0; i < windowCount; i++) {
        const e = wasmEntropy[i] ?? 0;
        entropy.push(e);
        linguistic.push(uniqueTrimerRatioAt(seq, i * stepSize, windowSizeInt));

        const isLow = e < 0.5;
        const pos = i * stepSize;
        if (isLow && !inLowRegion) {
          inLowRegion = true;
          regionStart = pos;
        } else if (!isLow && inLowRegion) {
          inLowRegion = false;
          lowComplexityRegions.push({ start: regionStart, end: pos });
        }
      }

      if (inLowRegion) {
        lowComplexityRegions.push({ start: regionStart, end: seq.length });
      }

      return { type: 'complexity', entropy, linguistic, lowComplexityRegions };
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[analysis.worker] WASM complexity failed, using JS fallback:', err);
    }
  }

  for (let i = 0; i < seq.length - windowSizeInt; i += stepSize) {
    const window = seq.slice(i, i + windowSizeInt);

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

    // Linguistic complexity (unique trimers), low-allocation fast path.
    linguistic.push(uniqueTrimerRatioAt(seq, i, windowSizeInt));

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

  const windowSizeInt = Math.max(1, Math.floor(windowSize));
  const stepSize = Math.max(1, Math.floor(windowSizeInt / 4));
  let inFlexRegion = false;
  let regionStart = 0;
  let regionSum = 0;
  let regionCount = 0;

  for (let i = 0; i <= seq.length - windowSizeInt; i += stepSize) {
    const window = seq.slice(i, i + windowSizeInt);
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
async function findRepeats(sequence: string, minLength = 8, maxGap = 5000): Promise<RepeatResult> {
  const wasm = await getWasmCompute();
  const repeats: RepeatResult['repeats'] = [];
  const seen = new Set<string>();
  const seq = sequence.toUpperCase();

  const step = Math.max(1, Math.floor(seq.length / 500));

  const reverseComplement = (s: string): string => {
    if (wasm && typeof wasm.reverse_complement === 'function') {
      try {
        return wasm.reverse_complement(s);
      } catch {
        // fallback
      }
    }
    const comp: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };
    return s.split('').reverse().map(c => comp[c] || c).join('');
  };

  const pushRepeat = (repeat: RepeatResult['repeats'][number]): void => {
    const key = `${repeat.type}:${repeat.position1}:${repeat.position2 ?? ''}:${repeat.sequence}`;
    if (seen.has(key)) return;
    seen.add(key);
    repeats.push(repeat);
  };

  // Keep the existing heuristic direct/inverted repeat scan (fast and noise-resistant).
  // We cap this so we leave space for WASM-derived palindromes/tandem repeats.
  const heuristicCap = 30;

  for (let i = 0; i < seq.length - minLength; i += step) {
    const pattern = seq.slice(i, i + minLength);
    if (/[^ACGT]/.test(pattern)) continue;

    const searchStart = Math.min(i + minLength, seq.length);
    const searchEnd = Math.min(i + maxGap, seq.length);
    const searchRegion = seq.slice(searchStart, searchEnd);

    // Direct repeats
    let idx = searchRegion.indexOf(pattern);
    if (idx !== -1 && repeats.length < heuristicCap) {
      pushRepeat({
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
    if (idx !== -1 && repeats.length < heuristicCap) {
      pushRepeat({
        type: 'inverted',
        position1: i,
        position2: searchStart + idx,
        sequence: pattern,
        length: minLength,
      });
    }

    if (repeats.length >= heuristicCap) break;
  }

  // Prefer WASM palindrome/tandem repeat detection when available.
  // Bead: phage_explorer-yvs8.3
  const maxResults = 50;
  const remaining = Math.max(0, maxResults - repeats.length);
  let didUseWasm = false;

  // Guardrails: the current Rust algorithms scan the whole sequence and can be slow/noisy on very large genomes.
  // Keep big-phage behavior stable by falling back to heuristics only.
  const wasmLengthThreshold = 120_000;

  try {
    const wasm = await getWasmCompute();
    if (wasm && remaining > 0 && seq.length <= wasmLengthThreshold && typeof wasm.detect_palindromes === 'function') {
      didUseWasm = true;

      // Palindromes: treat `minLength` as a minimum total length target, but Rust takes arm length.
      // Clamp the hairpin loop/spacer to avoid pathological work when callers pass large gaps.
      const minArmLen = Math.max(2, Math.floor(minLength / 2));
      const maxPalindromeGap = Math.min(50, Math.max(0, Math.floor(maxGap)));

      const palResult = wasm.detect_palindromes(seq, minArmLen, maxPalindromeGap);
      try {
        const parsed: unknown = JSON.parse(palResult.json);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (repeats.length >= maxResults) break;
            if (!item || typeof item !== 'object') continue;

            const start = Number((item as { start?: unknown }).start);
            const end = Number((item as { end?: unknown }).end);
            const sequenceStr = (item as { sequence?: unknown }).sequence;

            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            const s = Math.max(0, Math.floor(start));
            const e = Math.min(seq.length, Math.floor(end));
            if (e <= s) continue;

            const subseq =
              typeof sequenceStr === 'string' && sequenceStr.length > 0
                ? sequenceStr
                : seq.slice(s, e);

            // Filter noisy ambiguous palindromes (typically N-runs).
            if (/[^ACGTU]/i.test(subseq)) continue;

            pushRepeat({
              type: 'palindrome',
              position1: s,
              sequence: subseq.toUpperCase(),
              length: e - s,
            });
          }
        }
      } finally {
        palResult.free();
      }

      if (repeats.length < maxResults && typeof wasm.detect_tandem_repeats === 'function') {
        // Tandem repeats: scan for consecutive repeats of a unit of length ~minLength/2..minLength.
        // This keeps results useful and avoids flooding the UI with tiny microsatellites.
        const minUnit = Math.max(2, Math.floor(minLength / 2));
        const maxUnit = Math.max(minUnit, Math.min(64, Math.floor(minLength)));
        const minCopies = 2;

        const tandemResult = wasm.detect_tandem_repeats(seq, minUnit, maxUnit, minCopies);
        try {
          const parsed: unknown = JSON.parse(tandemResult.json);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (repeats.length >= maxResults) break;
              if (!item || typeof item !== 'object') continue;

              const start = Number((item as { start?: unknown }).start);
              const end = Number((item as { end?: unknown }).end);
              const unit = (item as { unit?: unknown }).unit;
              const copies = Number((item as { copies?: unknown }).copies);

              if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(copies)) continue;
              if (typeof unit !== 'string' || unit.length === 0) continue;

              const s = Math.max(0, Math.floor(start));
              const e = Math.min(seq.length, Math.floor(end));
              if (e <= s) continue;

              const unitUpper = unit.toUpperCase();
              if (/[^ACGTU]/.test(unitUpper)) continue;

              const unitLen = unitUpper.length;
              const pos2 = s + unitLen;
              pushRepeat({
                type: 'tandem',
                position1: s,
                position2: pos2 < e ? pos2 : undefined,
                sequence: unitUpper,
                length: Math.max(1, Math.floor(unitLen * copies)),
              });
            }
          }
        } finally {
          tandemResult.free();
        }
      }
    }
  } catch {
    didUseWasm = false;
  }

  // JS fallback: re-add simple palindromes when WASM wasn't used (keeps behavior close to previous overlay).
  if (!didUseWasm && repeats.length < maxResults) {
    for (let i = 0; i < seq.length - minLength; i += step) {
      const pattern = seq.slice(i, i + minLength);
      if (/[^ACGT]/.test(pattern)) continue;
      const revComp = reverseComplement(pattern);
      if (pattern === revComp && repeats.length < maxResults) {
        pushRepeat({
          type: 'palindrome',
          position1: i,
          sequence: pattern,
          length: minLength,
        });
      }
      if (repeats.length >= maxResults) break;
    }
  }

  repeats.sort((a, b) => a.position1 - b.position1);
  return { type: 'repeats', repeats: repeats.slice(0, maxResults) };
}

/**
 * Calculate codon usage statistics
 */
async function calculateCodonUsage(sequence: string): Promise<CodonUsageResult> {
  const seq = sequence.toUpperCase().replace(/[^ACGT]/g, '');
  const usage: Record<string, number> = {};
  const rscu: Record<string, number> = {};

  // Count codons (prefer WASM to avoid JS string slicing in tight loops).
  // Note: wasm-compute currently returns counts as JSON; we parse and keep the
  // existing JS behavior for RSCU computation.
  //
  // Bead: phage_explorer-yvs8.2
  //
  // IMPORTANT: We pass the cleaned `seq` (ACGT-only) so results match the
  // previous implementation (which removed ambiguous bases).
  let didUseWasm = false;
  try {
    const wasm = await getWasmCompute();
    if (wasm && typeof wasm.count_codon_usage === 'function') {
      const result = wasm.count_codon_usage(seq, 0);
      try {
        const parsed: unknown = JSON.parse(result.json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [codon, count] of Object.entries(parsed)) {
            if (typeof count === 'number' && Number.isFinite(count)) {
              usage[codon] = count;
            }
          }
          didUseWasm = true;
        }
      } finally {
        result.free();
      }
    }
  } catch {
    didUseWasm = false;
  }

  if (!didUseWasm) {
    // Count codons (JS fallback)
    for (let i = 0; i <= seq.length - 3; i += 3) {
      const codon = seq.slice(i, i + 3);
      if (CODON_TABLE[codon]) {
        usage[codon] = (usage[codon] || 0) + 1;
      }
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
      if (wasm && textEncoder && typeof wasm.count_kmers_dense === 'function') {
        // Convert sequence to bytes for WASM
        const seqBytes = textEncoder.encode(seq);
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
  let cumulativeIndex = 0;

  const winSize = Math.max(1, Math.floor(windowSize));
  const stepSize = Math.max(1, Math.floor(winSize / 4));

  for (let i = 0; i <= bytes.length - winSize; i += stepSize) {
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
    while (cumulativeIndex <= i) {
      const base = bytes[cumulativeIndex++];
      if (ref.encoding === 'ascii') {
        if (base === 71 || base === 103) cumSum++;
        else if (base === 67 || base === 99) cumSum--;
      } else {
        if (base === 2) cumSum++;
        else if (base === 1) cumSum--;
      }
    }
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
    engine: 'js',
  };
}

async function calculateGCSkewFromRefWasm(ref: SequenceBytesRef, windowSize = 1000): Promise<GCSkewResult> {
  const wasm = await getWasmCompute();
  if (wasm?.SequenceHandle && ref.encoding === 'ascii') {
    try {
      const bytes = getSequenceBytesView(ref);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const winSize = Math.max(1, Math.floor(windowSize));
        const stepSize = Math.max(1, Math.floor(winSize / 4));
        const skew = Array.from(handle.gc_skew(winSize, stepSize));
        const cumulative = handle.cumulative_gc_skew();
        const cumulativeSampled: number[] = [];
        for (let i = 0; i < skew.length; i++) {
          const pos = i * stepSize;
          if (pos < cumulative.length) {
            cumulativeSampled.push(cumulative[pos]);
          } else if (cumulative.length > 0) {
            cumulativeSampled.push(cumulative[cumulative.length - 1]);
          }
        }
        let minIdx = 0;
        let maxIdx = 0;
        let minVal = cumulativeSampled[0] ?? 0;
        let maxVal = cumulativeSampled[0] ?? 0;
        for (let i = 1; i < cumulativeSampled.length; i++) {
          const val = cumulativeSampled[i];
          if (val < minVal) {
            minVal = val;
            minIdx = i;
          }
          if (val > maxVal) {
            maxVal = val;
            maxIdx = i;
          }
        }
        const variant = getWasmComputeVariant();
        return {
          type: 'gc-skew',
          skew,
          cumulative: cumulativeSampled,
          originPosition: minIdx * stepSize,
          terminusPosition: maxIdx * stepSize,
          engine: variant === 'simd' ? 'wasm-simd' : 'wasm-baseline',
        };
      } finally {
        handle.free();
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[analysis.worker] SequenceHandle GC skew failed, falling back to JS:', err);
      }
    }
  }
  return calculateGCSkewFromRef(ref, windowSize);
}

async function calculateKmerSpectrumFromRefWasm(ref: SequenceBytesRef, k = 4): Promise<KmerSpectrumResult> {
  if (k <= 10) {
    const wasm = await getWasmCompute();
    if (wasm?.SequenceHandle && ref.encoding === 'ascii') {
      try {
        const bytes = getSequenceBytesView(ref);
        const handle = new wasm.SequenceHandle(bytes);
        try {
          const res = handle.count_kmers(k);
          const totalValid = Number(res.total_valid);
          const counts = res.counts;
          const alphabet = ['A', 'C', 'G', 'T'];
          let uniqueKmers = 0;
          const spectrum: Array<{ kmer: string; count: number; frequency: number }> = [];
          for (let idx = 0; idx < counts.length; idx++) {
            const count = counts[idx];
            if (count > 0) {
              uniqueKmers++;
              const temp = idx;
              let kmer = '';
              for (let pos = k - 1; pos >= 0; pos--) {
                const baseIdx = (temp >> (pos * 2)) & 3;
                kmer += alphabet[baseIdx];
              }
              spectrum.push({ kmer, count, frequency: totalValid > 0 ? count / totalValid : 0 });
            }
          }
          spectrum.sort((a, b) => b.count - a.count);
          return {
            type: 'kmer-spectrum',
            kmerSize: k,
            spectrum: spectrum.slice(0, 100),
            uniqueKmers,
            totalKmers: totalValid,
          };
        } finally {
          handle.free();
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[analysis.worker] SequenceHandle k-mer counting failed, falling back to JS:', err);
        }
      }
    }
  }
  const sequence = decodeSequenceRef(ref);
  return calculateKmerSpectrum(sequence, k);
}

async function calculateComplexityFromRefWasm(ref: SequenceBytesRef, windowSize = 100): Promise<ComplexityResult> {
  const wasm = await getWasmCompute();
  const windowSizeInt = Math.max(1, Math.floor(windowSize));
  const stepSize = Math.max(1, Math.floor(windowSizeInt / 2));

  if (wasm?.SequenceHandle && ref.encoding === 'ascii') {
    try {
      const bytes = getSequenceBytesView(ref);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const wasmEntropy = handle.windowed_entropy(windowSizeInt, stepSize);
        const seq = decodeSequenceRef(ref);
        const entropy: number[] = [];
        const linguistic: number[] = [];
        const lowComplexityRegions: Array<{ start: number; end: number }> = [];
        let inLowRegion = false;
        let regionStart = 0;

        for (let i = 0; i < wasmEntropy.length; i++) {
          const e = wasmEntropy[i] ?? 0;
          entropy.push(e);
          linguistic.push(uniqueTrimerRatioAt(seq, i * stepSize, windowSizeInt));

          const isLow = e < 0.5;
          const pos = i * stepSize;
          if (isLow && !inLowRegion) {
            inLowRegion = true;
            regionStart = pos;
          } else if (!isLow && inLowRegion) {
            inLowRegion = false;
            lowComplexityRegions.push({ start: regionStart, end: pos });
          }
        }
        if (inLowRegion) {
          lowComplexityRegions.push({ start: regionStart, end: seq.length });
        }
        return { type: 'complexity', entropy, linguistic, lowComplexityRegions };
      } finally {
        handle.free();
      }
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[analysis.worker] SequenceHandle entropy failed, falling back to JS:', err);
      }
    }
  }
  const sequence = decodeSequenceRef(ref);
  return calculateComplexity(sequence, windowSize);
}

async function computeAnalysisResult(request: AnalysisRequest): Promise<AnalysisResult> {
  const { type, sequence, options = {} } = request;

  switch (type) {
    case 'gc-skew':
      return await calculateGCSkewWasm(sequence, options.windowSize || 1000);
    case 'complexity':
      return await calculateComplexity(sequence, options.windowSize || 100);
    case 'bendability':
      return calculateBendability(sequence, options.windowSize || 50);
    case 'promoters':
      return findPromoters(sequence);
    case 'repeats':
      return await findRepeats(sequence, options.minLength || 8, options.maxGap || 5000);
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

async function runAnalysisImpl(request: AnalysisRequest): Promise<AnalysisResult> {
  const result = await computeAnalysisResult(request);
  if (!request.evidenceContext) return result;
  try {
    return { ...result, evidenceRecord: await createWorkerAnalysisRecord(result, request.sequence, request.options ?? {}, request.evidenceContext, 'string') };
  } catch (error) {
    // Export bounds must not disable a valid analysis of a large input.
    return { ...result, evidenceError: error instanceof Error ? error.message : 'Could not preserve analysis evidence.' };
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

// ============================================================
// PCA-family compute (off main thread)
// ============================================================

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function calculateGCFromAscii(seq: string): number {
  let gc = 0;
  let total = 0;
  for (let i = 0; i < seq.length; i++) {
    const c = seq.charCodeAt(i);
    // A/C/G/T (upper + lower). Treat U as T elsewhere; GC counts should ignore it.
    const isA = c === 65 || c === 97;
    const isC = c === 67 || c === 99;
    const isG = c === 71 || c === 103;
    const isT = c === 84 || c === 116;
    if (isA || isC || isG || isT) {
      total++;
      if (isC || isG) gc++;
    }
  }
  return total > 0 ? gc / total : 0.5;
}

async function computeKmerVectorImpl(request: KmerVectorRequest) {
  const { phageId, name, sequenceRef, options } = request;
  if (!sequenceRef) {
    throw new Error('Missing sequenceRef for k-mer vector');
  }

  const sequence = decodeSequenceRef(sequenceRef);
  const frequencies = computeKmerFrequencies(sequence, options);

  const wasm = await getWasmCompute();
  const gcContent =
    wasm && typeof wasm.calculate_gc_content === 'function'
      ? wasm.calculate_gc_content(sequence)
      : computeGcContent(sequence);

  return {
    phageId,
    name,
    frequencies,
    gcContent,
    genomeLength: sequenceRef.length ?? sequence.length,
  };
}

async function computeGenomicSignaturePcaImpl(request: GenomicSignaturePcaRequest) {
  const { vectors, frequencies, dim, options } = request;

  if (!Array.isArray(vectors) || vectors.length < 3) return null;
  if (!isFiniteNumber(dim) || dim <= 0) return null;
  if (!(frequencies instanceof Float32Array)) return null;

  const n = vectors.length;
  if (frequencies.length !== n * dim) {
    throw new Error(`Invalid PCA matrix: expected ${n * dim} floats, got ${frequencies.length}`);
  }

  const kmerVectors = vectors.map((meta, i) => ({
    ...meta,
    frequencies: frequencies.subarray(i * dim, (i + 1) * dim),
  }));

  return performPCA(kmerVectors, options);
}

async function computeBiasDecompositionImpl(request: BiasDecompositionRequest): Promise<BiasDecompositionWorkerResult | null> {
  const { sequenceRef, windowSize, stepSize } = request;
  if (!sequenceRef) return null;

  const win = Math.max(1, Math.floor(windowSize));
  const step = Math.max(1, Math.floor(stepSize));

  const sequence = decodeSequenceRef(sequenceRef);
  if (!sequence || sequence.length < win * 2) return null;

  const windows: Array<{ name: string; vector: number[]; gc: number; pos: number }> = [];
  for (let start = 0; start + win <= sequence.length; start += step) {
    const windowSeq = sequence.slice(start, start + win);
    const vector = computeDinucleotideFrequencies(windowSeq);
    const gc = calculateGCFromAscii(windowSeq);
    windows.push({
      name: `${start}-${start + win}`,
      vector,
      gc,
      pos: start,
    });
  }

  if (windows.length < 3) return null;

  const decomposition = decomposeBias(windows);
  if (!decomposition) return null;

  return {
    decomposition,
    gcContents: windows.map((w) => w.gc),
    positions: windows.map((w) => w.pos),
  };
}

async function computePhasePortraitImpl(request: PhasePortraitRequest) {
  const { sequenceRef, windowSize, stepSize } = request;
  if (!sequenceRef) return null;

  const win = Math.max(1, Math.floor(windowSize));
  const step = Math.max(1, Math.floor(stepSize));

  const sequence = decodeSequenceRef(sequenceRef);
  if (!sequence || sequence.length < 100) return null;

  const wasm = await getWasmCompute();
  let aaSequence: string;
  if (wasm && typeof wasm.translate_sequence === 'function') {
    try {
      aaSequence = wasm.translate_sequence(sequence, 0);
    } catch {
      aaSequence = translateSequence(sequence, 0);
    }
  } else {
    aaSequence = translateSequence(sequence, 0);
  }
  if (!aaSequence || aaSequence.length < win) return null;

  return computePhasePortrait(aaSequence, win, step);
}

/**
 * Analysis Worker API implementation
 */
const workerAPI: SharedAnalysisWorkerAPI = {
  runAnalysis: runAnalysisImpl,

  runAnalysisWithProgress: runAnalysisWithProgressImpl,

  computeKmerVector: computeKmerVectorImpl,
  computeGenomicSignaturePca: computeGenomicSignaturePcaImpl,
  computeBiasDecomposition: computeBiasDecompositionImpl,
  computePhasePortrait: computePhasePortraitImpl,

  async runAnalysisShared(request: SharedAnalysisRequest): Promise<AnalysisResult> {
    let result: AnalysisResult;
    if (request.type === 'gc-skew') {
      result = await calculateGCSkewFromRefWasm(request.sequenceRef, request.options?.windowSize || 1000);
    } else if (request.type === 'kmer-spectrum') {
      result = await calculateKmerSpectrumFromRefWasm(request.sequenceRef, request.options?.kmerSize || 4);
    } else if (request.type === 'complexity') {
      result = await calculateComplexityFromRefWasm(request.sequenceRef, request.options?.windowSize || 100);
    } else {
      // Some kernels require strings; keep the byte-backed hot paths above.
      result = await computeAnalysisResult({ type: request.type, sequence: decodeSequenceRef(request.sequenceRef), options: request.options });
    }
    if (!request.evidenceContext) return result;
    try {
      return { ...result, evidenceRecord: await createWorkerAnalysisRecord(result, decodeSequenceRef(request.sequenceRef), request.options ?? {}, request.evidenceContext, 'shared') };
    } catch (error) {
      return { ...result, evidenceError: error instanceof Error ? error.message : 'Could not preserve analysis evidence.' };
    }
  },

  async runAnalysisSharedWithProgress(
    request: SharedAnalysisRequest,
    onProgress: (progress: ProgressInfo) => void
  ): Promise<AnalysisResult> {
    onProgress({ current: 0, total: 100, message: `Starting ${request.type} analysis...` });

    const result = await workerAPI.runAnalysisShared(request);

    onProgress({ current: 100, total: 100, message: 'Complete' });
    return result;
  },
};

// Expose worker API via Comlink
Comlink.expose(workerAPI);
