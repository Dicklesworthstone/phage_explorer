/**
 * Shared genome sketch cache.
 *
 * ## Why this exists
 *
 * Three overlays need k-mer set similarity between genomes and none of them
 * had it, so each invented a number instead:
 *
 * - Environmental provenance displayed a "containment" of
 *   `0.3 + seededUnit(hashString(name)) * 0.5` — a hash of the phage name.
 * - Phylodynamics built its distance matrix from sequences that were
 *   themselves hashes of accession strings.
 * - CRISPR fell back to scanning six hardcoded 6-mers.
 *
 * The Rust MinHash kernel that answers all three has existed for months; it
 * simply was never initialised, so every consumer silently used a slower exact
 * path or a fabricated constant. This module is the shared surface those
 * overlays consume, so the sketch for a given genome is computed once.
 *
 * ## Jaccard is not containment
 *
 * This distinction is the reason the module exists rather than a
 * `jaccard()` helper being enough.
 *
 *   Jaccard(A,B)     = |A ∩ B| / |A ∪ B|   symmetric
 *   containment(A,B) = |A ∩ B| / |A|       asymmetric
 *
 * A 40 kb phage genome fully present inside a 5 Mb metagenomic sample has
 * containment 1.0 and Jaccard about 0.008. Using Jaccard where containment is
 * meant reports "not present" for a genome that is entirely present, which is
 * exactly backwards for the question environmental provenance asks. Any
 * novelty score built on the wrong one is wrong in the most misleading
 * direction.
 *
 * ## Exact and estimated
 *
 * Both paths are provided deliberately. The exact path builds real k-mer sets
 * and is ground truth; the estimated path reads MinHash signatures and is what
 * scales. Tests assert the estimate tracks the exact value, so the estimator
 * cannot silently drift into producing plausible nonsense — the failure mode
 * this whole module exists to retire.
 */

import { computeSignature, MINHASH_DEFAULT_K, MINHASH_DEFAULT_HASHES } from './hgt-tracer';

/** Sketch of one genome: its MinHash signature plus its distinct k-mer count. */
export interface GenomeSketch {
  /** Stable identity for cache keying, e.g. a phage id or a label. */
  id: string;
  /** MinHash signature, one slot per hash function. */
  signature: Uint32Array;
  /**
   * Number of DISTINCT k-mers, which is what containment divides by. Estimated
   * from the signature when the sequence is large, exact when it is small.
   */
  cardinality: number;
  k: number;
}

/** 2^32, the hash space the Rust kernel maps into. */
const HASH_SPACE = 4294967296;

/**
 * Encode a k-mer as a 32-bit integer. Valid for k <= 16, since 4^16 = 2^32.
 * Returns null for any window containing an ambiguous base, matching the
 * kernel's documented rule of resetting rolling state rather than guessing.
 */
function encodeKmer(seq: string, start: number, k: number): number | null {
  let code = 0;
  for (let i = 0; i < k; i++) {
    const c = seq.charCodeAt(start + i);
    let base: number;
    // A/a=0 C/c=1 G/g=2 T/t/U/u=3
    if (c === 65 || c === 97) base = 0;
    else if (c === 67 || c === 99) base = 1;
    else if (c === 71 || c === 103) base = 2;
    else if (c === 84 || c === 116 || c === 85 || c === 117) base = 3;
    else return null;
    code = (code * 4 + base) >>> 0;
  }
  return code;
}

/**
 * Exact distinct k-mer set, as packed 32-bit codes.
 *
 * Practical for this project's genomes: the largest, phiKZ at 280 kb, yields
 * at most 280k entries. Not appropriate for metagenome-scale input, which is
 * what the estimated path is for.
 */
export function kmerSet(sequence: string, k = MINHASH_DEFAULT_K): Set<number> {
  const set = new Set<number>();
  if (k <= 0 || k > 16 || sequence.length < k) return set;
  const seq = sequence.toUpperCase();
  for (let i = 0; i + k <= seq.length; i++) {
    const code = encodeKmer(seq, i, k);
    if (code !== null) set.add(code);
  }
  return set;
}

/** Exact Jaccard similarity between two k-mer sets. */
export function exactJaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const v of small) if (large.has(v)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Exact containment of `a` within `b`: the fraction of a's k-mers that b also
 * has. Asymmetric on purpose.
 */
export function exactContainment(a: Set<number>, b: Set<number>): number {
  if (a.size === 0) return 0;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  return intersection / a.size;
}

/**
 * Estimate the number of distinct k-mers behind a signature.
 *
 * The kernel uses one independent hash function per slot, so each slot holds
 * the minimum of n uniform draws from [0, 2^32). The expected minimum of n
 * such draws is HASH_SPACE / (n + 1), which inverts to n ≈ HASH_SPACE / mean − 1.
 * Averaging across slots reduces the variance of a single draw.
 *
 * Slots left at u32::MAX are unfilled (the kernel's empty marker) and are
 * excluded, otherwise a short sequence's padding would drag the mean up and
 * report a far smaller cardinality than the truth.
 */
export function estimateCardinality(signature: Uint32Array): number {
  let sum = 0;
  let used = 0;
  for (const v of signature) {
    if (v === 0xffffffff) continue;
    sum += v;
    used++;
  }
  if (used === 0) return 0;
  const mean = sum / used;
  if (mean <= 0) return 0;
  return Math.max(0, HASH_SPACE / mean - 1);
}

/**
 * Jaccard estimated from two signatures: the fraction of slots that agree.
 *
 * Requires signatures built with the same k and the same number of hashes,
 * since slot i is only comparable to slot i of the same seed.
 */
export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let matches = 0;
  let compared = 0;
  for (let i = 0; i < n; i++) {
    // Two unfilled slots carry no information either way.
    if (a[i] === 0xffffffff && b[i] === 0xffffffff) continue;
    compared++;
    if (a[i] === b[i]) matches++;
  }
  return compared === 0 ? 0 : matches / compared;
}

/**
 * Estimate containment of `a` within `b` from their sketches.
 *
 * MinHash gives Jaccard directly, not containment, so containment is recovered
 * algebraically. With J = |A∩B| / |A∪B| and |A∪B| = |A| + |B| − |A∩B|:
 *
 *   |A∩B| = J(|A| + |B|) / (1 + J)
 *   containment(A,B) = |A∩B| / |A|
 *
 * This is the standard derivation used by Mash screen. It is only as good as
 * the two cardinality estimates, which is why they are carried on the sketch
 * rather than recomputed ad hoc.
 */
export function estimateContainment(a: GenomeSketch, b: GenomeSketch): number {
  if (a.cardinality <= 0) return 0;
  const j = estimateJaccard(a.signature, b.signature);
  if (j <= 0) return 0;
  const intersection = (j * (a.cardinality + b.cardinality)) / (1 + j);
  return Math.min(1, intersection / a.cardinality);
}

/** Distinct-k-mer count is exact below this length, estimated above it. */
const EXACT_CARDINALITY_MAX_BASES = 400_000;

/**
 * Build a sketch for one genome.
 *
 * Returns null when no signature can be produced, rather than a zeroed sketch:
 * a sketch full of zeros compares as "totally dissimilar" to everything, which
 * is the silent-wrong-answer failure this module exists to avoid. Callers must
 * handle null and say so in the UI.
 */
export function buildSketch(
  id: string,
  sequence: string,
  k = MINHASH_DEFAULT_K,
  numHashes = MINHASH_DEFAULT_HASHES
): GenomeSketch | null {
  const signature = computeSignature(sequence, k, numHashes);
  if (!signature) return null;

  const cardinality =
    sequence.length <= EXACT_CARDINALITY_MAX_BASES
      ? kmerSet(sequence, k).size
      : estimateCardinality(signature);

  return { id, signature, cardinality, k };
}

/**
 * Sketches for a set of genomes, computed once and reused.
 *
 * Deliberately not an LRU. The catalogue is 24 genomes and every consumer wants
 * all of them; evicting one only to recompute it moments later is the opposite
 * of the point. `clear()` exists for tests and for a catalogue change.
 */
export class SketchCache {
  private sketches = new Map<string, GenomeSketch>();
  private computeCount = 0;

  constructor(
    private readonly k = MINHASH_DEFAULT_K,
    private readonly numHashes = MINHASH_DEFAULT_HASHES
  ) {}

  /** Compute a sketch once per id. Repeat calls return the cached one. */
  getOrBuild(id: string, sequence: string): GenomeSketch | null {
    const existing = this.sketches.get(id);
    if (existing) return existing;
    const sketch = buildSketch(id, sequence, this.k, this.numHashes);
    if (!sketch) return null;
    this.computeCount++;
    this.sketches.set(id, sketch);
    return sketch;
  }

  get(id: string): GenomeSketch | null {
    return this.sketches.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.sketches.has(id);
  }

  get size(): number {
    return this.sketches.size;
  }

  /** How many sketches were actually computed. Lets tests prove reuse. */
  get computations(): number {
    return this.computeCount;
  }

  clear(): void {
    this.sketches.clear();
    this.computeCount = 0;
  }

  /**
   * Rank other sketches by Jaccard similarity to `queryId`, descending.
   * The query itself is excluded so it cannot be its own nearest neighbour.
   */
  nearest(queryId: string, limit = 5): Array<{ id: string; similarity: number }> {
    const query = this.sketches.get(queryId);
    if (!query) return [];
    const scored: Array<{ id: string; similarity: number }> = [];
    for (const [id, sketch] of this.sketches) {
      if (id === queryId) continue;
      scored.push({ id, similarity: estimateJaccard(query.signature, sketch.signature) });
    }
    scored.sort((x, y) => y.similarity - x.similarity);
    return scored.slice(0, limit);
  }

  /** Containment of `queryId` within `referenceId`. Asymmetric. */
  containment(queryId: string, referenceId: string): number | null {
    const q = this.sketches.get(queryId);
    const r = this.sketches.get(referenceId);
    if (!q || !r) return null;
    return estimateContainment(q, r);
  }

  /**
   * The largest containment of `queryId` within any other sketch, with the
   * reference that achieved it. This is the shape environmental provenance
   * needs for a novelty score: novelty is 1 − maxContainment.
   */
  maxContainment(queryId: string): { referenceId: string; containment: number } | null {
    const q = this.sketches.get(queryId);
    if (!q) return null;
    let best: { referenceId: string; containment: number } | null = null;
    for (const [id, sketch] of this.sketches) {
      if (id === queryId) continue;
      const c = estimateContainment(q, sketch);
      if (!best || c > best.containment) best = { referenceId: id, containment: c };
    }
    return best;
  }
}
