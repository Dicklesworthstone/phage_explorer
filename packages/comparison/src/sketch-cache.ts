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
 *
 * Which one runs is decided by measurement, not by preference. Jaccard is
 * estimated because the estimate was measured accurate; containment is computed
 * exactly at catalogue scale because the estimate was measured inaccurate there
 * AND slower. The calibration note below records both results and the design
 * they forced.
 */

import { computeSignature, MINHASH_DEFAULT_K, MINHASH_DEFAULT_HASHES } from './hgt-tracer';

/**
 * Measured error behaviour of the estimators below.
 *
 * These figures come from calibration runs over synthetic genomes, not from
 * intuition, and they changed the design. Method and numbers are recorded here
 * because a tolerance nobody can reproduce is a guess wearing a result's
 * clothes.
 *
 * **Jaccard** — the kernel uses m independent hash functions and slot i matches
 * with probability exactly J, so m*jhat ~ Binomial(m, J):
 *     E[jhat] = J,  SD(jhat) = sqrt(J(1-J)/m)
 * At m=128 that predicts SD 0.031 at J=0.14 and 0.042 at J=0.33. Measured over
 * 30 trials per point: 0.025 and 0.035. Bias below 0.011 throughout. The model
 * holds and is slightly conservative.
 *
 * **Cardinality** — each slot holds the minimum of n uniform draws, with
 * E[min] = M/(n+1); averaging m of them and inverting gives a relative standard
 * error of about 1/sqrt(m) = 8.8% at m=128. Measured over 40 genomes: signed
 * SD 8.4%, bias -0.2%. The model holds.
 *
 * **Containment** — this one did NOT hold, and the finding drove the design.
 * Containment is recovered algebraically as
 *     C = j(|A| + |B|) / ((1 + j)|A|)
 * whose leading factor is 1 + |B|/|A|. That multiplies the error in j by the
 * size ratio, so the estimator is least accurate in exactly the regime it
 * exists for: a small genome inside a much larger one. Measured, with a
 * 4 kb insert fully contained (true C = 1.0) in hosts of growing size:
 *
 *     ratio    1     2     4     8    16    32
 *     mean|e|  .000  .025  .051  .071  .114  .123
 *     max|e|   .000  .097  .237  .596  .609  .743
 *
 * A reported containment of 0.88 where the truth is 1.00 is not a rounding
 * difference; it changes the conclusion.
 *
 * **What the exact path actually costs.** A first pass at this timed "build
 * k-mer sets and intersect" (134 ms) against "build two sketches and estimate"
 * (277 ms) and concluded the exact path was cheaper. That comparison was wrong:
 * it charged each path for work the shipped code does either way, and a run
 * with the churn controlled put both builds at 190-270 ms together. The claim
 * is withdrawn. Here are the numbers that survive a controlled measurement,
 * on a 48 kb genome against a 280 kb one:
 *
 *   - The old code ALREADY built the full k-mer set for every sequence at or
 *     below the threshold, to get an exact cardinality, and then discarded it.
 *     Retaining it is the entire change.
 *   - Building the packed sorted array instead of a Set costs about 1.5x on
 *     that one pass: 97 ms against 64 ms at 280 kb, median of five. The extra
 *     is the sort. It happens once per genome and is cached.
 *   - Per comparison, the counted answer takes 0.67 ms against the estimate's
 *     0.14 ms. Both vanish against the one-time build.
 *   - Memory is the real price: about 8 MB of Uint32 for the whole catalogue.
 *
 * So exact containment is not free, it is cheap — roughly 250 ms once across
 * the catalogue and 8 MB held. For an error that reached 0.61 in the regime
 * that matters, that is worth paying.
 *
 * Containment is therefore exact by default and estimated only above
 * EXACT_KMER_MAX_BASES, where the estimate reports its own uncertainty.
 * Reproduce with the calibration harness described in the tests.
 */

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
  /**
   * The distinct k-mers themselves, sorted ascending, retained for sequences at
   * or below EXACT_KMER_MAX_BASES and null above it.
   *
   * This is what makes exact containment possible, and it is the reason the
   * representation is a packed Uint32Array rather than a Set: the whole 24-genome
   * catalogue is roughly 2M distinct k-mers, which is 8 MB packed and well over
   * 100 MB as JS Sets. Sorted order also makes intersection a linear merge with
   * no allocation.
   */
  codes: Uint32Array | null;
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
 * The same distinct k-mers as `kmerSet`, packed into a sorted Uint32Array.
 *
 * `kmerSet` stays the readable ground truth used in tests; this is the storage
 * format the cache retains, because a Set of 2M numbers costs more than ten
 * times what the packed array does and cannot be merge-intersected.
 */
export function kmerCodes(sequence: string, k = MINHASH_DEFAULT_K): Uint32Array {
  if (k <= 0 || k > 16 || sequence.length < k) return new Uint32Array(0);
  const seq = sequence.toUpperCase();
  const raw = new Uint32Array(seq.length - k + 1);
  let n = 0;
  for (let i = 0; i + k <= seq.length; i++) {
    const code = encodeKmer(seq, i, k);
    if (code !== null) raw[n++] = code;
  }
  const filled = raw.subarray(0, n);
  filled.sort();
  // Collapse duplicates in place; `filled` is already sorted.
  let out = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || filled[i] !== filled[i - 1]) filled[out++] = filled[i];
  }
  return filled.slice(0, out);
}

/** Size of the intersection of two sorted, deduplicated code arrays. */
function intersectionSize(a: Uint32Array, b: Uint32Array): number {
  let i = 0;
  let j = 0;
  let hits = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x === y) {
      hits++;
      i++;
      j++;
    } else if (x < y) {
      i++;
    } else {
      j++;
    }
  }
  return hits;
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

/**
 * One-standard-deviation uncertainty on an estimated containment.
 *
 * Propagated from the only noisy input, jhat, by the delta method. With
 *     C(j) = j(|A| + |B|) / ((1 + j)|A|)
 *     dC/dj = (|A| + |B|) / (|A| (1 + j)^2)
 *     SD(jhat) = sqrt(j(1 - j) / m)      [binomial over m hash slots]
 * so
 *     SD(C) ~ (|A| + |B|) / (|A| (1 + j)^2) * sqrt(j(1 - j) / m)
 *
 * The leading factor is the whole problem: it is 1 + |B|/|A| to first order, so
 * the uncertainty grows with the size ratio. Checked against the amplification
 * run at ratio 32 (|A| ~ 4k, |B| ~ 128k, true C = 1): predicted SD 0.48 against
 * a measured spread consistent with 0.4-0.5 once the clamp at 1 is accounted
 * for. Slightly conservative, which is the direction an error bar should err.
 *
 * Reporting this rather than a bare number is the point. A containment of 0.88
 * plus or minus 0.48 and a containment of 0.88 plus or minus 0.01 are different
 * findings, and the caller cannot tell them apart from the point estimate.
 *
 * Two floors keep the interval honest at the bottom of the range, where the
 * plain binomial formula collapses to nonsense:
 *
 * - jhat is a count of matching slots divided by m, so it moves in steps of
 *   1/m. The apparatus cannot resolve a difference finer than one slot no
 *   matter what the formula says, so SD(jhat) never goes below 1/m.
 *
 * - jhat = 0 does NOT mean J = 0. Zero successes in m Bernoulli trials bounds
 *   J below roughly 3/m at 95% confidence (the rule of three); it does not
 *   establish J = 0. Returning 0 uncertainty there would be the single most
 *   misleading answer available, because a zero reading is precisely the case
 *   where the sketch has told you least. At a 100x size ratio that bound
 *   propagates to an interval covering the whole range, and it should: 128
 *   hashes have no resolving power for containment at that ratio, and saying so
 *   is the correct output.
 */
export function containmentUncertainty(a: GenomeSketch, b: GenomeSketch): number {
  if (a.cardinality <= 0) return 1;
  const m = Math.min(a.signature.length, b.signature.length);
  if (m === 0) return 1;
  const j = estimateJaccard(a.signature, b.signature);
  const slope = (a.cardinality + b.cardinality) / (a.cardinality * (1 + j) ** 2);
  const sdJ = j <= 0 ? 3 / m : Math.max(Math.sqrt((j * (1 - j)) / m), 1 / m);
  return Math.min(1, slope * sdJ);
}

/** How a containment figure was arrived at. */
export type ContainmentMethod = 'exact' | 'estimated';

/** A containment figure carrying how it was obtained and how much to trust it. */
export interface ContainmentResult {
  /** Fraction of the query's k-mers the reference also has, in [0, 1]. */
  containment: number;
  method: ContainmentMethod;
  /**
   * One-standard-deviation uncertainty. Exactly 0 for the exact method, since
   * it is a count and not an estimate.
   */
  uncertainty: number;
}

/**
 * Containment of `a` within `b`, exact where possible.
 *
 * Exact whenever both sketches retained their k-mers, which is every genome in
 * this project's catalogue. This is not a fallback to a slow path: the k-mers
 * were already being built for the cardinality, so the marginal cost is a sort
 * at build time and half a millisecond per comparison. See the calibration note
 * at the top of the file for the numbers and for why the estimate was not good
 * enough here.
 */
export function containmentOf(a: GenomeSketch, b: GenomeSketch): ContainmentResult {
  if (a.codes && b.codes) {
    if (a.codes.length === 0) return { containment: 0, method: 'exact', uncertainty: 0 };
    return {
      containment: intersectionSize(a.codes, b.codes) / a.codes.length,
      method: 'exact',
      uncertainty: 0,
    };
  }
  return {
    containment: estimateContainment(a, b),
    method: 'estimated',
    uncertainty: containmentUncertainty(a, b),
  };
}

/**
 * Above this sequence length the exact k-mer set is neither retained nor
 * counted, and both cardinality and containment fall back to the signature.
 *
 * 400 kb comfortably covers this project's largest genome (phiKZ, 280 kb) and
 * excludes metagenome-scale input, which is the regime the sketch is actually
 * for. One threshold, because both uses have the same rationale: can we afford
 * to hold the real k-mer set for this sequence.
 */
const EXACT_KMER_MAX_BASES = 400_000;

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

  // One pass builds the k-mer set, and it serves both purposes: it IS the exact
  // cardinality, and it is what exact containment intersects against.
  const codes = sequence.length <= EXACT_KMER_MAX_BASES ? kmerCodes(sequence, k) : null;
  const cardinality = codes ? codes.length : estimateCardinality(signature);

  return { id, signature, cardinality, k, codes };
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

  /**
   * Containment of `queryId` within `referenceId`. Asymmetric.
   *
   * Returns the method and uncertainty alongside the number, not a bare figure:
   * a caller that renders "88% contained" has to be able to tell a counted
   * result from an estimate that could be half a unit out.
   */
  containment(queryId: string, referenceId: string): ContainmentResult | null {
    const q = this.sketches.get(queryId);
    const r = this.sketches.get(referenceId);
    if (!q || !r) return null;
    return containmentOf(q, r);
  }

  /**
   * The largest containment of `queryId` within any other sketch, with the
   * reference that achieved it. This is the shape environmental provenance
   * needs for a novelty score: novelty is 1 − maxContainment.
   */
  maxContainment(queryId: string): (ContainmentResult & { referenceId: string }) | null {
    const q = this.sketches.get(queryId);
    if (!q) return null;
    let best: (ContainmentResult & { referenceId: string }) | null = null;
    for (const [id, sketch] of this.sketches) {
      if (id === queryId) continue;
      const result = containmentOf(q, sketch);
      if (!best || result.containment > best.containment) best = { ...result, referenceId: id };
    }
    return best;
  }
}
