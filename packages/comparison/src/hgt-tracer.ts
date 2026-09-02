import { jaccardIndex, extractKmerSet } from './kmer-analysis';
import type { GeneInfo } from '@phage-explorer/core';
import type { HGTAnalysis, GenomicIsland, DonorCandidate, PassportStamp } from './types';
import { getMinHashCache, makeCacheKeyFromId } from './minhash-cache';

const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;

// ============================================================================
// WASM MinHash Types and Loader
// ============================================================================

interface MinHashSignature {
  signature: Uint32Array;
  total_kmers: bigint;
  k: number;
  num_hashes: number;
  free(): void;
}

type MinHashSignatureFn = (seq: Uint8Array, k: number, numHashes: number) => MinHashSignature;
type MinHashJaccardFn = (sigA: Uint32Array, sigB: Uint32Array) => number;

let wasmMinHashSignature: MinHashSignatureFn | null = null;
let wasmMinHashSignatureCanonical: MinHashSignatureFn | null = null;
let wasmMinHashJaccardFromSignatures: MinHashJaccardFn | null = null;
let wasmMinHashAvailable = false;

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/**
 * Initialize WASM MinHash functions (non-blocking).
 * Exported so consumers can await it if desired.
 */
export async function initMinHashWasm(): Promise<void> {
  if (wasmMinHashAvailable) return;
  try {
    const wasm = await import('@phage/wasm-compute');
    // wasm-compute may require explicit async init (depending on build target).
    const maybeInit = (wasm as unknown as { default?: () => Promise<void> }).default;
    if (typeof maybeInit === 'function') {
      await maybeInit();
    }
    wasmMinHashSignature = wasm.minhash_signature;
    wasmMinHashSignatureCanonical = wasm.minhash_signature_canonical;
    wasmMinHashJaccardFromSignatures = wasm.minhash_jaccard_from_signatures;

    // Quick test to verify functions work
    if (textEncoder && wasmMinHashSignature && wasmMinHashJaccardFromSignatures) {
      const testBytes = textEncoder.encode('ATCGATCGATCG');
      const testSig = wasmMinHashSignature(testBytes, 4, 16);
      const testJaccard = wasmMinHashJaccardFromSignatures(testSig.signature, testSig.signature);
      testSig.free();
      wasmMinHashAvailable = testJaccard === 1.0;
    }
  } catch {
    wasmMinHashAvailable = false;
  }
}

// Deliberately NOT initialized at module load.
//
// This module is imported by both the browser app and the Bun-based TUI, and
// a top-level async WASM import fires in environments that cannot service it,
// which is why the module-load call was removed. The cost of removing it was
// that nothing else ever called `initMinHashWasm`, so `wasmMinHashAvailable`
// stayed false forever and every MinHash path silently fell back to the exact
// k=15 Set-Jaccard implementation.
//
// Callers that know they are in a context where WASM can load -- a browser
// worker or effect, not module scope -- should await `initMinHashWasm()` once
// before analysis. It is idempotent, self-testing (it verifies a known
// signature round-trips to a Jaccard of exactly 1.0 before declaring WASM
// usable), and swallows its own failures, so a caller that awaits it can never
// be made worse off than one that does not.

/** Whether the WASM MinHash path is active. Exposed for diagnostics and tests. */
export function isMinHashWasmAvailable(): boolean {
  return wasmMinHashAvailable;
}

/**
 * Internal helper to compute signature from a normalized sequence.
 * Does NOT check cache.
 */
function computeSignatureInternal(
  normalizedSeq: string,
  k: number,
  numHashes: number,
  canonical: boolean
): Uint32Array | null {
  const encoder = textEncoder;
  if (!wasmMinHashAvailable || !encoder) return null;

  const fn = canonical ? wasmMinHashSignatureCanonical : wasmMinHashSignature;
  if (!fn) return null;

  if (normalizedSeq.length < k) return null;

  try {
    const bytes = encoder.encode(normalizedSeq);
    const sig = fn(bytes, k, numHashes);
    const result = new Uint32Array(sig.signature); // Copy before free
    sig.free();
    return result;
  } catch {
    return null;
  }
}

/**
 * Compute MinHash signature for a sequence using WASM.
 * Uses the global cache for transparent reuse across calls.
 * Returns null if WASM unavailable or sequence too short.
 */
function computeMinHashSignature(
  sequence: string,
  k: number,
  numHashes: number,
  canonical = true
): Uint32Array | null {
  if (!wasmMinHashAvailable || !textEncoder) return null;

  // Normalize to uppercase BEFORE cache lookup for consistent keys
  const normalizedSeq = sequence.toUpperCase();

  // Use cache for transparent reuse
  const cache = getMinHashCache();
  return cache.getOrCompute(normalizedSeq, k, numHashes, canonical, () => {
    return computeSignatureInternal(normalizedSeq, k, numHashes, canonical);
  });
}

export interface HGTOptions {
  window?: number;
  step?: number;
  zThreshold?: number;
  minValidRatio?: number;
}

interface WindowStat {
  start: number;
  end: number;
  gc: number;
  z: number;
}

const HALLMARK_KEYWORDS = [
  'integrase',
  'transposase',
  'recombinase',
  'lysogeny',
  'tail fiber',
  'tail-spike',
  'tRNA',
  'capsid',
  'portal',
  'terminase',
  'restriction',
  'methyltransferase',
];

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[], m: number): number {
  if (values.length === 0) return 0;
  const v = values.reduce((s, x) => s + Math.pow(x - m, 2), 0) / values.length;
  return Math.sqrt(v);
}

// Lookup table for GC calculation
// Bit 0 (1): Valid base (A,C,G,T)
// Bit 1 (2): GC base (G,C)
const GC_TABLE = new Uint8Array(128);
// A=65, T=84, a=97, t=116 -> Valid (1)
[65, 84, 97, 116].forEach(c => GC_TABLE[c] = 1);
// C=67, G=71, c=99, g=103 -> Valid (1) + GC (2) = 3
[67, 71, 99, 103].forEach(c => GC_TABLE[c] = 3);

function computeGC(seq: string, start = 0, end?: number): { percent: number; total: number } {
  let gc = 0;
  let total = 0;
  const limit = end ?? seq.length;
  
  for (let i = start; i < limit; i++) {
    const code = seq.charCodeAt(i);
    // Use lookup table for speed (avoids 8 comparisons per char)
    // Checks valid ASCII range implicitly (undefined for >127, undefined & mask is 0)
    const flags = GC_TABLE[code];
    
    if (flags) {
      if (flags & 2) gc++;
      total++;
    }
  }
  return {
    percent: total > 0 ? (gc / total) * 100 : 0,
    total,
  };
}

function slidingGC(
  sequence: string,
  window = 2000,
  step = 1000,
  minValidRatio = 0.5
): WindowStat[] {
  const stats: WindowStat[] = [];
  const validWindows: { start: number; end: number; gc: number }[] = [];
  const len = sequence.length;

  // First pass: Collect valid GC values to compute robust statistics
  for (let start = 0; start < len; start += step) {
    const end = Math.min(start + window, len);
    const windowLen = end - start;
    if (windowLen === 0) break;
    
    // Use optimized computeGC with indices to avoid slicing
    const { percent, total } = computeGC(sequence, start, end);
    
    // Skip windows with insufficient valid data (e.g. gaps/Ns)
    if (total < windowLen * minValidRatio) continue;

    validWindows.push({ start, end, gc: percent });
  }

  const gcValues = validWindows.map(w => w.gc);
  const mu = mean(gcValues);
  const sigma = std(gcValues, mu) || 1;

  // Second pass: Compute Z-scores for valid windows
  for (const w of validWindows) {
    const z = (w.gc - mu) / sigma;
    stats.push({ start: w.start, end: w.end, gc: w.gc, z });
  }

  return stats;
}

function mergeIslands(windows: WindowStat[], zThreshold = 2): GenomicIsland[] {
  const islands: GenomicIsland[] = [];
  // Extend type locally to track count for averaging
  let current: (GenomicIsland & { count: number }) | null = null;

  for (const w of windows) {
    if (Math.abs(w.z) >= zThreshold) {
      if (!current || w.start > current.end) {
        if (current) {
          const island = { ...current } as (GenomicIsland & { count?: number });
          delete island.count;
          islands.push(island);
        }
        current = { 
          start: w.start, 
          end: w.end, 
          gc: w.gc, 
          zScore: w.z, 
          genes: [], 
          hallmarks: [], 
          donors: [], 
          amelioration: 'unknown',
          count: 1 
        };
      } else {
        // Weighted average update
        const n = current.count;
        current.end = w.end;
        current.gc = (current.gc * n + w.gc) / (n + 1);
        current.zScore = (current.zScore * n + w.z) / (n + 1);
        current.count++;
      }
    } else if (current) {
      // Strip internal count property
      const island = { ...current } as (GenomicIsland & { count?: number });
      delete island.count;
      islands.push(island);
      current = null;
    }
  }
  if (current) {
    const island = { ...current } as (GenomicIsland & { count?: number });
    delete island.count;
    islands.push(island);
  }
  return islands;
}

function attachGenes(islands: GenomicIsland[], genes: GeneInfo[]): void {
  for (const island of islands) {
    island.genes = genes.filter(g => g.startPos <= island.end && g.endPos >= island.start);
    island.hallmarks = island.genes
      .filter(g => {
        const text = `${g.name ?? ''} ${g.product ?? ''}`.toLowerCase();
        return HALLMARK_KEYWORDS.some(k => text.includes(k));
      })
      .map(g => g.product?.trim() || g.name || g.locusTag || 'unknown');
  }
}

function inferDonors(
  islandSeq: string,
  referenceSets: Record<string, Set<string>>,
  k = 15
): DonorCandidate[] {
  const islandSet = extractKmerSet(islandSeq, k);
  if (islandSet.size === 0) return [];
  const candidates: DonorCandidate[] = [];

  for (const [taxon, refSet] of Object.entries(referenceSets)) {
    if (refSet.size === 0) continue;
    const j = jaccardIndex(islandSet, refSet);
    // Note: WASM min_hash_jaccard could be used here for better performance if available
    candidates.push({
      taxon,
      similarity: j,
      confidence: j > 0.3 ? 'high' : j > 0.15 ? 'medium' : 'low',
      evidence: 'kmer',
    });
  }

  return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// ============================================================================
// MinHash-based Donor Inference (fast approximate path)
// ============================================================================

/**
 * Default MinHash parameters tuned for HGT donor inference.
 *
 * ## Accuracy Tradeoffs
 *
 * MinHash provides approximate Jaccard similarity with configurable accuracy:
 * - 128 hashes: ~1-3% error, excellent for ranking (default)
 * - 256 hashes: ~0.5-1.5% error, more precise but slower
 * - 64 hashes: ~2-5% error, faster but may mis-rank close candidates
 *
 * For HGT donor inference, the ranking order matters more than exact values.
 * MinHash is well-suited because:
 * - True donor is usually clearly distinct (Jaccard > 0.3)
 * - Close candidates can optionally be refined with exact Jaccard
 * - Speed enables analysis of large reference libraries
 *
 * k=16 provides good specificity for detecting sequence similarity
 * without being so long that minor mutations destroy matches.
 */
const MINHASH_K = 16;
const MINHASH_NUM_HASHES = 128;

/**
 * Infer potential donor taxa using MinHash signatures (fast approximate).
 *
 * This is much faster than exact Jaccard for large reference libraries:
 * - O(n) per sequence for signature computation (vs O(n) for extractKmerSet)
 * - O(h) per comparison where h=num_hashes (vs O(k) where k=num_unique_kmers)
 *
 * Accuracy tradeoffs documented in acceptance criteria:
 * - MinHash provides approximate Jaccard with ~1-3% error for typical parameters
 * - For HGT ranking, approximate similarity is usually sufficient
 * - Optionally refine top-3 with exact Jaccard if needed
 */
function inferDonorsMinHash(
  islandSeq: string,
  referenceSignatures: Record<string, Uint32Array>,
  k = MINHASH_K,
  refineTopN = 0, // 0 = no refinement, 3 = refine top 3 with exact
  referenceSketches?: Record<string, string> // For optional exact refinement (lazy)
): DonorCandidate[] {
  if (!wasmMinHashJaccardFromSignatures) return [];

  const islandSig = computeMinHashSignature(islandSeq, k, MINHASH_NUM_HASHES, true);
  if (!islandSig) return [];

  const candidates: DonorCandidate[] = [];

  for (const [taxon, refSig] of Object.entries(referenceSignatures)) {
    if (refSig.length !== islandSig.length) continue;

    const similarity = wasmMinHashJaccardFromSignatures(islandSig, refSig);
    candidates.push({
      taxon,
      similarity,
      confidence: similarity > 0.3 ? 'high' : similarity > 0.15 ? 'medium' : 'low',
      evidence: 'minhash',
    });
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);

  // Optional: refine top-N with exact Jaccard for accuracy
  // We only compute k-mer sets for the top N candidates to save memory/time
  if (refineTopN > 0 && referenceSketches) {
    const islandSet = extractKmerSet(islandSeq, k);
    if (islandSet.size > 0) {
      for (let i = 0; i < Math.min(refineTopN, candidates.length); i++) {
        const c = candidates[i];
        const refSeq = referenceSketches[c.taxon];
        if (refSeq) {
          const refSet = extractKmerSet(refSeq, k);
          if (refSet.size > 0) {
            c.similarity = jaccardIndex(islandSet, refSet);
            c.evidence = 'kmer'; // Mark as exact
          }
        }
      }
      // Re-sort in case exact refinement changed order
      candidates.sort((a, b) => b.similarity - a.similarity);
    }
  }

  return candidates.slice(0, 5);
}

/**
 * Precompute MinHash signatures for reference sequences.
 * Uses ID-based caching for efficient reuse across repeated calls.
 * Returns null if WASM MinHash is unavailable.
 */
function precomputeReferenceSignatures(
  referenceSketches: Record<string, string>,
  k = MINHASH_K
): Record<string, Uint32Array> | null {
  if (!wasmMinHashAvailable) return null;

  const cache = getMinHashCache();
  const signatures: Record<string, Uint32Array> = {};

  for (const [taxon, seq] of Object.entries(referenceSketches)) {
    // Use taxon ID for stable cache key (avoids rehashing entire reference)
    const cacheKey = makeCacheKeyFromId(taxon, k, MINHASH_NUM_HASHES, true);
    let sig = cache.get(cacheKey);

    if (!sig) {
      // Normalize here once
      const normalizedSeq = seq.toUpperCase();
      // Compute WITHOUT using the sequence-based cache lookup, to avoid double-caching
      sig = computeSignatureInternal(normalizedSeq, k, MINHASH_NUM_HASHES, true);
      
      if (sig) {
        cache.set(cacheKey, sig);
      }
    }

    if (sig) {
      signatures[taxon] = sig;
    }
  }

  // If no signatures could be computed, return null
  return Object.keys(signatures).length > 0 ? signatures : null;
}

function estimateAmelioration(gcDelta: number): 'recent' | 'intermediate' | 'ancient' | 'unknown' {
  const abs = Math.abs(gcDelta);
  if (abs > 5) return 'recent';
  if (abs > 2) return 'intermediate';
  if (abs > 0) return 'ancient';
  return 'unknown';
}

export function analyzeHGTProvenance(
  genomeSequence: string,
  genes: GeneInfo[],
  referenceSketches: Record<string, string> = {},
  options?: HGTOptions
): HGTAnalysis {
  const { percent: genomeGC } = computeGC(genomeSequence);
  const windowSize = options?.window ?? 2000;
  const step = options?.step ?? 1000;
  const zThreshold = options?.zThreshold ?? 2;
  const minValidRatio = options?.minValidRatio ?? 0.5;

  const windows = slidingGC(genomeSequence, windowSize, step, minValidRatio);
  const islands = mergeIslands(windows, zThreshold);
  attachGenes(islands, genes);

  // Try MinHash path first (much faster for large reference libraries)
  const referenceSignatures = precomputeReferenceSignatures(referenceSketches, MINHASH_K);
  const useMinHash = referenceSignatures !== null;

  // Fallback: pre-compute reference k-mer sets for exact Jaccard if NOT using MinHash
  const k = useMinHash ? MINHASH_K : 15;
  let referenceSets: Record<string, Set<string>> | undefined;
  
  if (!useMinHash) {
    referenceSets = {};
    for (const [taxon, seq] of Object.entries(referenceSketches)) {
      referenceSets[taxon] = extractKmerSet(seq, k);
    }
  }

  const stamps: PassportStamp[] = islands.map(island => {
    const seq = genomeSequence.slice(island.start, island.end);

    // Use MinHash path when available (fast approximate), else exact Jaccard
    // Pass referenceSketches to MinHash path for optional lazy refinement
    const donors = useMinHash
      ? inferDonorsMinHash(seq, referenceSignatures!, MINHASH_K, 0, referenceSketches)
      : inferDonors(seq, referenceSets!, k);

    const best = donors[0] ?? null;
    const amelioration = estimateAmelioration(island.gc - genomeGC);
    island.donors = donors;

    return {
      island,
      donor: best,
      donorDistribution: donors,
      amelioration,
      transferMechanism: 'unknown',
      gcDelta: island.gc - genomeGC,
      hallmarks: island.hallmarks,
    };
  });

  // Dev-only: log cache performance
  if (isDev && useMinHash) {
    const stats = getMinHashCache().getStats();
    console.log('[hgt-tracer] MinHash cache stats:', {
      hitRate: `${(stats.hitRate * 100).toFixed(1)}%`,
      entries: stats.entries,
      bytesUsed: `${(stats.bytes / 1024).toFixed(1)}KB`,
      islands: islands.length,
    });
  }

  return {
    genomeGC,
    islands,
    stamps,
  };
}
