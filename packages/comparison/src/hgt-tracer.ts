import { jaccardIndex, extractKmerSet } from './kmer-analysis';
import type { GeneInfo } from '@phage-explorer/core';
import type { HGTAnalysis, GenomicIsland, DonorCandidate, PassportStamp } from './types';

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
 */
async function initMinHashWasm(): Promise<void> {
  if (wasmMinHashAvailable) return;
  try {
    const wasm = await import('@phage/wasm-compute');
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

// Initialize on module load (non-blocking)
initMinHashWasm().catch(() => { /* WASM unavailable */ });

/**
 * Compute MinHash signature for a sequence using WASM.
 * Returns null if WASM unavailable or sequence too short.
 */
function computeMinHashSignature(
  sequence: string,
  k: number,
  numHashes: number,
  canonical = true
): Uint32Array | null {
  if (!wasmMinHashAvailable || !textEncoder) return null;

  const fn = canonical ? wasmMinHashSignatureCanonical : wasmMinHashSignature;
  if (!fn) return null;

  try {
    const bytes = textEncoder.encode(sequence.toUpperCase());
    if (bytes.length < k) return null;

    const sig = fn(bytes, k, numHashes);
    const result = new Uint32Array(sig.signature); // Copy before free
    sig.free();
    return result;
  } catch {
    return null;
  }
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

function computeGC(seq: string): { percent: number; total: number } {
  let gc = 0;
  let total = 0;
  for (const c of seq) {
    const u = c.toUpperCase();
    if (u === 'G' || u === 'C') gc++;
    if (u === 'A' || u === 'T' || u === 'G' || u === 'C') total++;
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

  // First pass: Collect valid GC values to compute robust statistics
  for (let start = 0; start < sequence.length; start += step) {
    const slice = sequence.slice(start, start + window);
    if (!slice.length) break;
    
    const { percent, total } = computeGC(slice);
    
    // Skip windows with insufficient valid data (e.g. gaps/Ns)
    if (total < slice.length * minValidRatio) continue;

    validWindows.push({ start, end: start + slice.length, gc: percent });
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
  referenceSets?: Record<string, Set<string>> // For optional exact refinement
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
  if (refineTopN > 0 && referenceSets) {
    const islandSet = extractKmerSet(islandSeq, k);
    if (islandSet.size > 0) {
      for (let i = 0; i < Math.min(refineTopN, candidates.length); i++) {
        const c = candidates[i];
        const refSet = referenceSets[c.taxon];
        if (refSet && refSet.size > 0) {
          c.similarity = jaccardIndex(islandSet, refSet);
          c.evidence = 'kmer'; // Mark as exact
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
 * Returns null if WASM MinHash is unavailable.
 */
function precomputeReferenceSignatures(
  referenceSketches: Record<string, string>,
  k = MINHASH_K
): Record<string, Uint32Array> | null {
  if (!wasmMinHashAvailable) return null;

  const signatures: Record<string, Uint32Array> = {};

  for (const [taxon, seq] of Object.entries(referenceSketches)) {
    const sig = computeMinHashSignature(seq, k, MINHASH_NUM_HASHES, true);
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

  // Fallback: pre-compute reference k-mer sets for exact Jaccard
  // Also used for optional top-N refinement in MinHash path
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
    const donors = useMinHash
      ? inferDonorsMinHash(seq, referenceSignatures, MINHASH_K, 0, referenceSets)
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

  return {
    genomeGC,
    islands,
    stamps,
  };
}
