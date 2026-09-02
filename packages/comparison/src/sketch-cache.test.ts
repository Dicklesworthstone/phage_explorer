import { describe, expect, it, beforeAll } from 'bun:test';
import {
  SketchCache,
  buildSketch,
  kmerSet,
  exactJaccard,
  exactContainment,
  estimateJaccard,
  estimateContainment,
  estimateCardinality,
} from './sketch-cache';
import { initMinHashWasm, isMinHashWasmAvailable, MINHASH_DEFAULT_K } from './hgt-tracer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

/**
 * The point of these tests is not that the functions run. It is that the
 * ESTIMATED values track the EXACT ones.
 *
 * The overlays this module serves previously displayed invented numbers that
 * looked plausible. An estimator that quietly drifts is the same failure with
 * extra steps, so every estimate here is checked against a brute-force set
 * computation rather than against a hand-written expectation.
 */

/** Deterministic sequence over all four bases with a target GC fraction. */
function biasedSequence(length: number, gcFraction: number, seed: number): string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    const r = next();
    if (r < gcFraction / 2) out.push('G');
    else if (r < gcFraction) out.push('C');
    else if (r < gcFraction + (1 - gcFraction) / 2) out.push('A');
    else out.push('T');
  }
  return out.join('');
}

beforeAll(async () => {
  await initMinHashWasm();
});

describe('exact k-mer set operations', () => {
  it('counts distinct k-mers, not total windows', () => {
    // 'AAAAA' at k=4 has two windows but only one distinct k-mer.
    expect(kmerSet('AAAAA', 4).size).toBe(1);
    // ACGTACGT has 5 windows (ACGT CGTA GTAC TACG ACGT) but ACGT repeats,
    // so 4 are distinct. Distinct is what containment divides by.
    expect(kmerSet('ACGTACGT', 4).size).toBe(4);
  });

  it('skips windows containing ambiguous bases rather than guessing', () => {
    // The kernel resets rolling state on an ambiguous base; the exact path
    // must agree or the two would disagree on the same input.
    //
    // Flanks are deliberately different here. With identical flanks the
    // assertion would pass even if every N-spanning window were wrongly
    // included, because they would all collapse to the same k-mer.
    expect(kmerSet('ACGTNGGCC', 4).size).toBe(2); // ACGT and GGCC only
    expect(kmerSet('NNNN', 4).size).toBe(0);
    // No window can span the N: a 9-base string at k=4 has 6 windows, and
    // four of them touch position 4.
    expect(kmerSet('ACGTNGGCC', 4).size).toBeLessThan(6);
  });

  it('returns an empty set when the sequence is shorter than k', () => {
    expect(kmerSet('ACG', 4).size).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(kmerSet('acgtacgt', 4)).toEqual(kmerSet('ACGTACGT', 4));
  });

  it('computes Jaccard against hand-checkable sets', () => {
    const a = kmerSet('ACGTACGT', 4); // 4 distinct
    expect(exactJaccard(a, a)).toBe(1);
    expect(exactJaccard(a, kmerSet('GGGGGGGG', 4))).toBe(0);
    expect(exactJaccard(new Set(), new Set())).toBe(1);
    expect(exactJaccard(a, new Set())).toBe(0);
  });
});

describe('containment is asymmetric where Jaccard is not', () => {
  // This is the distinction the module exists for. A small genome fully
  // present inside a large one has containment 1 and low Jaccard; reporting
  // the Jaccard as "containment" says "absent" for something entirely present.
  const smallSeq = biasedSequence(2000, 0.5, 11);
  const largeSeq = biasedSequence(40000, 0.5, 22) + smallSeq + biasedSequence(40000, 0.5, 33);

  const small = kmerSet(smallSeq);
  const large = kmerSet(largeSeq);

  it('reports the small genome as fully contained in the large one', () => {
    expect(exactContainment(small, large)).toBeCloseTo(1, 2);
  });

  it('does not report the large genome as contained in the small one', () => {
    expect(exactContainment(large, small)).toBeLessThan(0.1);
  });

  it('would have understated the relationship badly if Jaccard were used', () => {
    // Guards the guard: proves the two measures genuinely differ here, so the
    // asymmetry assertions above are not vacuous.
    const j = exactJaccard(small, large);
    expect(j).toBeLessThan(0.2);
    expect(exactContainment(small, large) - j).toBeGreaterThan(0.7);
  });

  it('Jaccard is symmetric', () => {
    expect(exactJaccard(small, large)).toBeCloseTo(exactJaccard(large, small), 10);
  });
});

describe('MinHash estimates track the exact values', () => {
  it('requires WASM to have come up, or these tests prove nothing', () => {
    expect(isMinHashWasmAvailable()).toBe(true);
  });

  it('estimates cardinality within MinHash error of the true distinct count', () => {
    for (const length of [5000, 20000, 60000]) {
      const seq = biasedSequence(length, 0.5, length);
      const sketch = buildSketch(String(length), seq);
      expect(sketch).not.toBeNull();
      const exact = kmerSet(seq).size;
      const estimated = estimateCardinality(sketch!.signature);
      // 128 hashes gives a relative standard error around 1/sqrt(128) ~ 9%.
      // Allow 3x that as a stable bound rather than a tight one that flakes.
      expect(Math.abs(estimated - exact) / exact).toBeLessThan(0.3);
    }
  });

  it('estimates Jaccard close to the exact Jaccard', () => {
    const a = biasedSequence(30000, 0.5, 1);
    // Share a real prefix so the two genuinely overlap by a known amount.
    const b = a.slice(0, 15000) + biasedSequence(15000, 0.5, 2);

    const sa = buildSketch('a', a)!;
    const sb = buildSketch('b', b)!;
    const exact = exactJaccard(kmerSet(a), kmerSet(b));
    const estimated = estimateJaccard(sa.signature, sb.signature);

    expect(exact).toBeGreaterThan(0.2); // the case is meaningful, not degenerate
    expect(Math.abs(estimated - exact)).toBeLessThan(0.1);
  });

  it('estimates containment close to the exact containment', () => {
    const smallSeq = biasedSequence(4000, 0.5, 7);
    const largeSeq = biasedSequence(30000, 0.5, 8) + smallSeq + biasedSequence(30000, 0.5, 9);

    const small = buildSketch('small', smallSeq)!;
    const large = buildSketch('large', largeSeq)!;

    const exact = exactContainment(kmerSet(smallSeq), kmerSet(largeSeq));
    const estimated = estimateContainment(small, large);

    expect(exact).toBeGreaterThan(0.9);
    expect(Math.abs(estimated - exact)).toBeLessThan(0.25);
  });

  it('estimated containment stays asymmetric', () => {
    const smallSeq = biasedSequence(4000, 0.5, 7);
    const largeSeq = biasedSequence(30000, 0.5, 8) + smallSeq + biasedSequence(30000, 0.5, 9);
    const small = buildSketch('small', smallSeq)!;
    const large = buildSketch('large', largeSeq)!;

    expect(estimateContainment(small, large)).toBeGreaterThan(
      estimateContainment(large, small)
    );
  });

  it('reports no similarity between unrelated sequences', () => {
    const a = buildSketch('a', biasedSequence(20000, 0.3, 101))!;
    const b = buildSketch('b', biasedSequence(20000, 0.7, 202))!;
    expect(estimateJaccard(a.signature, b.signature)).toBeLessThan(0.05);
  });

  it('reports a sequence as identical to itself', () => {
    const seq = biasedSequence(20000, 0.5, 55);
    const a = buildSketch('a', seq)!;
    const b = buildSketch('b', seq)!;
    expect(estimateJaccard(a.signature, b.signature)).toBe(1);
    expect(estimateContainment(a, b)).toBeCloseTo(1, 1);
  });
});

describe('SketchCache', () => {
  const genomes: Array<[string, string]> = [
    ['lambda', biasedSequence(20000, 0.5, 1)],
    ['t4', biasedSequence(20000, 0.35, 2)],
    ['p22', biasedSequence(20000, 0.47, 3)],
  ];

  it('computes each sketch exactly once', () => {
    const cache = new SketchCache();
    for (const [id, seq] of genomes) cache.getOrBuild(id, seq);
    for (const [id, seq] of genomes) cache.getOrBuild(id, seq); // second pass
    for (const [id, seq] of genomes) cache.getOrBuild(id, seq); // third pass

    expect(cache.size).toBe(3);
    // The reuse guarantee, asserted rather than assumed. Without it every
    // overlay open would re-sketch the whole catalogue.
    expect(cache.computations).toBe(3);
  });

  it('ranks neighbours and never returns the query itself', () => {
    const cache = new SketchCache();
    // Give lambda a genuine relative so the ranking has a right answer.
    const lambdaSeq = genomes[0][1];
    cache.getOrBuild('lambda', lambdaSeq);
    cache.getOrBuild('lambda-relative', lambdaSeq.slice(0, 14000) + biasedSequence(6000, 0.5, 99));
    cache.getOrBuild('unrelated', biasedSequence(20000, 0.8, 404));

    const near = cache.nearest('lambda', 5);
    expect(near.map(n => n.id)).not.toContain('lambda');
    expect(near[0].id).toBe('lambda-relative');
    expect(near[0].similarity).toBeGreaterThan(near[near.length - 1].similarity);
  });

  it('finds the reference with the highest containment', () => {
    const cache = new SketchCache();
    const insert = biasedSequence(3000, 0.5, 77);
    cache.getOrBuild('query', insert);
    cache.getOrBuild('host', biasedSequence(25000, 0.5, 88) + insert);
    cache.getOrBuild('stranger', biasedSequence(25000, 0.5, 999));

    const best = cache.maxContainment('query');
    expect(best).not.toBeNull();
    expect(best!.referenceId).toBe('host');
    expect(best!.containment).toBeGreaterThan(0.5);
  });

  it('returns null rather than a misleading zero for unknown ids', () => {
    const cache = new SketchCache();
    expect(cache.containment('nope', 'also-nope')).toBeNull();
    expect(cache.maxContainment('nope')).toBeNull();
    expect(cache.nearest('nope')).toEqual([]);
    expect(cache.get('nope')).toBeNull();
  });

  it('refuses to sketch a sequence it cannot sketch', () => {
    const cache = new SketchCache();
    // Shorter than k: a zeroed sketch would compare as dissimilar to
    // everything, which is a silent wrong answer. Null forces the caller to
    // handle it.
    expect(cache.getOrBuild('tiny', 'ACG')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('clears', () => {
    const cache = new SketchCache();
    cache.getOrBuild('a', genomes[0][1]);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.computations).toBe(0);
  });

  it('uses the shared k so signatures stay comparable', () => {
    const cache = new SketchCache();
    const s = cache.getOrBuild('a', genomes[0][1]);
    expect(s!.k).toBe(MINHASH_DEFAULT_K);
  });
});

/**
 * Real-genome check.
 *
 * The synthetic tests above prove the estimator is internally consistent. This
 * one proves it produces a scientifically correct answer on the actual
 * catalogue, which is the claim that matters. It is skipped when the database
 * is absent (a fresh clone before `bun run build:db`).
 */
const DB_PATH = join(import.meta.dir, '../../web/public/phage.db');
const realDescribe = existsSync(DB_PATH) ? describe : describe.skip;

realDescribe('against the shipped catalogue', () => {
  const db = new Database(DB_PATH, { readonly: true });
  const phages = db.query('SELECT id, slug FROM phages ORDER BY id').all() as {
    id: number;
    slug: string;
  }[];
  const sequenceOf = (id: number): string =>
    (
      db
        .query('SELECT sequence FROM sequences WHERE phage_id = ? ORDER BY chunk_index')
        .all(id) as { sequence: string }[]
    )
      .map(c => c.sequence)
      .join('');

  // Built once and shared. Each test used to construct its own cache over all
  // 24 genomes, which passed standalone but exceeded the default 5s timeout
  // under full-suite load -- the same "test does too much work" failure this
  // suite has already hit once. Sharing is also closer to how the app uses it.
  const cache = new SketchCache();

  // 60s, not the 5s default. This reads a 10 MB SQLite database and computes
  // MinHash signatures for all 24 genomes -- about 0.8s idle, but several times
  // that on a loaded machine. The work is legitimate, so the budget is raised
  // rather than the coverage cut. Correctness here does not depend on speed.
  beforeAll(async () => {
    await initMinHashWasm();
    for (const p of phages) cache.getOrBuild(p.slug, sequenceOf(p.id));
  }, 60_000);

  it('sketches every catalogue genome exactly once', () => {
    // Re-request every genome; nothing should be recomputed.
    for (const p of phages) cache.getOrBuild(p.slug, sequenceOf(p.id));
    expect(cache.size).toBe(24);
    expect(cache.computations).toBe(24);
  }, 30_000);

  it('estimates lambda k-mer cardinality within MinHash error of the exact count', async () => {
    await initMinHashWasm();
    const lambda = sequenceOf(phages.find(p => p.slug === 'lambda')!.id);
    const exact = kmerSet(lambda).size;
    const estimated = estimateCardinality(buildSketch('lambda', lambda)!.signature);
    expect(exact).toBeGreaterThan(40000); // ~48.5 kb genome, mostly distinct
    expect(Math.abs(estimated - exact) / exact).toBeLessThan(0.3);
  }, 30_000);

  it('finds P22 as lambda\'s closest relative in the catalogue', () => {
    // Lambda and P22 are lambdoid phages that genuinely share mosaic segments;
    // this is a real biological relationship, not a property of the estimator.
    // If a future change to k, hash count or encoding breaks the method, this
    // is the assertion that notices.
    const nearest = cache.nearest('lambda', 3);
    expect(nearest[0].id).toBe('p22');
    expect(nearest[0].similarity).toBeGreaterThan(nearest[1].similarity);
  });

  it('reports containment above Jaccard for a real pair, as it must', async () => {
    await initMinHashWasm();
    const lambda = sequenceOf(phages.find(p => p.slug === 'lambda')!.id);
    const p22 = sequenceOf(phages.find(p => p.slug === 'p22')!.id);
    const a = buildSketch('lambda', lambda)!;
    const b = buildSketch('p22', p22)!;
    expect(estimateContainment(a, b)).toBeGreaterThan(estimateJaccard(a.signature, b.signature));
  });
});
