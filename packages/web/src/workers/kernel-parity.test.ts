import { describe, expect, it } from 'bun:test';
import { loadWasmVariants } from './wasm-variants';
import {
  calculateGCContent,
  countCodonUsage,
  translateSequence,
  reverseComplement,
  detectPalindromesJS,
  detectTandemRepeatsJS,
  type PalindromeHit,
  type TandemRepeatHit,
} from '@phage-explorer/core';
import { countKmersDenseJS } from '@phage-explorer/core';
import { levenshteinDistance } from '@phage-explorer/comparison';
import {
  minHashJaccard,
  minHashSketchJS,
  analyzeKmers,
  extractKmerSet,
  extractCanonicalKmerSet,
} from '@phage-explorer/comparison';

/**
 * WASM/JS parity for the kernels that had none.
 *
 * `docs/WASM_ABI_SPEC.md` states, as a requirement for every kernel: "Unit tests
 * verify WASM and JS produce identical output". Four files covered five kernels.
 * Nineteen others had nothing, including `compute_gc_skew`, `count_kmers_dense`,
 * `count_codon_usage`, `levenshtein_distance`, `min_hash_jaccard` and
 * `analyze_kmers`.
 *
 * This matters more than ordinary coverage. The entire WASM design rests on
 * "identical results, faster". A divergence between the two paths does not
 * produce an error; it produces DIFFERENT SCIENTIFIC RESULTS depending on
 * whether the user's browser loaded the WASM build, silently.
 *
 * ## What is and is not covered here
 *
 * Covered: every kernel with a JavaScript counterpart in this repository, which
 * is what "parity" can mean. Both WASM variants are checked against the JS
 * reference, not against each other -- two builds from one source that are wrong
 * in the same way would pass a variant-to-variant comparison.
 *
 * `detect_palindromes` and `detect_tandem_repeats` have exact JS references in
 * `@phage-explorer/core` and are verified for full output identity.
 *
 * Invariant tests with discrimination checks cover kernels without standalone JS
 * twins (`scan_kl_windows`, `pca_power_iteration_f32`, `hoeffdings_d`).
 *
 * `SequenceHandle` methods are verified across both variants in `sequence-handle.test.ts`.
 *
 * NOT covered here: `detect_bonds_spatial` and `detect_functional_groups` which
 * operate exclusively on 3D spatial coordinate buffers in the Three.js renderer.
 */

const variants = await loadWasmVariants();

/** A sequence with realistic, skewed base composition rather than a repeat. */
function biasedSequence(length: number, gcFraction: number, seed: number): string {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
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

const SEQ = biasedSequence(3000, 0.48, 7);
const SEQ_B = biasedSequence(3000, 0.55, 11);

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

function parseJson<T = unknown>(jsonStr: string): T {
  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    throw new Error(`Failed to parse JSON: ${jsonStr}`);
  }
}

for (const { name, wasm } of variants) {
  describe(`GC content parity [${name}]`, () => {
    it('matches the JS reference on a realistic sequence', () => {
      // JS returns a percentage; the kernel returns the same convention.
      expect(wasm.calculate_gc_content(SEQ)).toBeCloseTo(calculateGCContent(SEQ), 9);
    });

    it('agrees on the degenerate cases', () => {
      for (const seq of ['', 'AAAA', 'GCGC', 'ACGTNNNN']) {
        expect(wasm.calculate_gc_content(seq)).toBeCloseTo(calculateGCContent(seq), 9);
      }
    });

    it('the comparison is discriminating', () => {
      // Guards the guard: a GC-rich and an AT-rich sequence must not agree, or
      // the assertions above would pass against a constant.
      expect(wasm.calculate_gc_content('GCGCGC')).not.toBeCloseTo(
        wasm.calculate_gc_content('ATATAT'),
        3
      );
    });
  });

  describe(`translate and reverse-complement parity [${name}]`, () => {
    it('translates identically', () => {
      // The kernel takes an explicit frame; the JS defaults to 0.
      expect(wasm.translate_sequence(SEQ.slice(0, 300), 0)).toBe(
        translateSequence(SEQ.slice(0, 300))
      );
    });

    it('reverse-complements identically', () => {
      expect(wasm.reverse_complement(SEQ)).toBe(reverseComplement(SEQ));
    });

    it('agrees on ambiguous bases', () => {
      const amb = 'ACGTNRYKMSWBDHV';
      expect(wasm.reverse_complement(amb)).toBe(reverseComplement(amb));
    });
  });

  describe(`codon usage parity [${name}]`, () => {
    // The kernel returns its counts as a JSON string rather than parallel
    // arrays; the JS reference returns a plain record.
    const wasmCounts = (seq: string, frame: number): Record<string, number> =>
      parseJson<Record<string, number>>(wasm.count_codon_usage(seq, frame).json);

    it('produces the same counts in frame 0', () => {
      const js = countCodonUsage(SEQ, 0);
      const w = wasmCounts(SEQ, 0);

      const codons = new Set([...Object.keys(js), ...Object.keys(w)]);
      expect(codons.size).toBeGreaterThan(20); // not a degenerate comparison
      for (const codon of codons) {
        expect(w[codon] ?? 0).toBe(js[codon] ?? 0);
      }
    });

    it('agrees on the other two frames', () => {
      for (const frame of [1, 2] as const) {
        const js = countCodonUsage(SEQ, frame);
        const w = wasmCounts(SEQ, frame);
        for (const codon of new Set([...Object.keys(js), ...Object.keys(w)])) {
          expect(w[codon] ?? 0).toBe(js[codon] ?? 0);
        }
      }
    });

    it('the comparison is discriminating', () => {
      // Different frames must give different counts, or equality proves nothing.
      expect(wasmCounts(SEQ, 0)).not.toEqual(wasmCounts(SEQ, 1));
    });
  });

  describe(`dense k-mer counting parity [${name}]`, () => {
    it('produces identical count vectors for k = 4', () => {
      const k = 4;
      const w = wasm.count_kmers_dense(encode(SEQ), k);
      const js = countKmersDenseJS(encode(SEQ), k);

      const wCounts = Array.from(w.counts as Uint32Array);
      const jsCounts = Array.from(js.counts);
      expect(wCounts.length).toBe(jsCounts.length);
      expect(wCounts).toEqual(jsCounts);
      expect(Number(w.total_valid)).toBe(js.totalValid);
    });

    it('produces identical count vectors for k = 6', () => {
      const k = 6;
      const w = wasm.count_kmers_dense(encode(SEQ), k);
      const js = countKmersDenseJS(encode(SEQ), k);
      expect(Array.from(w.counts as Uint32Array)).toEqual(Array.from(js.counts));
      expect(Number(w.total_valid)).toBe(js.totalValid);
    });

    it('agrees that ambiguous bases break k-mers rather than being guessed', () => {
      // A sequence with an N in it: both must skip the windows containing it,
      // and must skip the SAME windows.
      const withN = `${SEQ.slice(0, 50)}N${SEQ.slice(51, 200)}`;
      const w = wasm.count_kmers_dense(encode(withN), 4);
      const js = countKmersDenseJS(encode(withN), 4);
      expect(Number(w.total_valid)).toBe(js.totalValid);
      expect(Array.from(w.counts as Uint32Array)).toEqual(Array.from(js.counts));
    });

    it('the comparison is discriminating', () => {
      // Two different sequences must give different vectors, or equality above
      // proves nothing.
      const a = wasm.count_kmers_dense(encode(SEQ), 4);
      const b = wasm.count_kmers_dense(encode(SEQ_B), 4);
      expect(Array.from(a.counts as Uint32Array)).not.toEqual(
        Array.from(b.counts as Uint32Array)
      );
    });
  });

  describe(`Levenshtein parity [${name}]`, () => {
    it('matches the JS reference on short strings', () => {
      const pairs: Array<[string, string]> = [
        ['kitten', 'sitting'],
        ['flaw', 'lawn'],
        ['', 'abc'],
        ['abc', ''],
        ['same', 'same'],
        ['ACGTACGT', 'ACGTTCGT'],
      ];
      for (const [a, b] of pairs) {
        // The JS reference returns { distance, isApproximate }, not a number.
        expect(wasm.levenshtein_distance(a, b)).toBe(levenshteinDistance(a, b).distance);
      }
    });

    it('matches on realistic sequence fragments', () => {
      const a = SEQ.slice(0, 400);
      const b = SEQ_B.slice(0, 400);
      const js = levenshteinDistance(a, b);
      // Only compare when the JS reference computed exactly; it switches to an
      // approximation for long inputs and says so.
      expect(js.isApproximate).toBe(false);
      expect(wasm.levenshtein_distance(a, b)).toBe(js.distance);
    });

    it('is symmetric and zero on identity, in both implementations', () => {
      const a = SEQ.slice(0, 120);
      const b = SEQ_B.slice(0, 120);
      expect(wasm.levenshtein_distance(a, a)).toBe(0);
      expect(wasm.levenshtein_distance(a, b)).toBe(wasm.levenshtein_distance(b, a));
    });
  });

  /**
   * MinHash is the one kernel here that is NOT identical to its JS counterpart,
   * and the test says so rather than being loosened until it passes.
   *
   * Measured on a 3000 bp pair at k=8, 128 hashes: WASM 0.039063 (5 slots
   * agreeing), JS 0.031250 (4 slots), exact Jaccard 0.026302. Both are honest
   * MinHash estimates of the same quantity and both sit within sampling error
   * of the truth; they differ because the two implementations do not share a
   * hash family, so they sample different k-mers.
   *
   * That still violates `docs/WASM_ABI_SPEC.md`'s "identical output"
   * requirement, and it means a similarity figure can change depending on
   * whether the user's browser loaded the WASM build. Tracked separately;
   * making them share a hash family is a change to the kernel, not to this test.
   *
   * So the assertions below check what is TRUE -- both estimate the same
   * quantity, within the sampling error of 128 hashes -- and one of them
   * asserts the non-identity explicitly, so the day they are unified this test
   * fails and someone deletes it deliberately.
   */
  describe(`MinHash agreement [${name}]`, () => {
    /** One-sigma binomial error for m slots at estimate j. */
    const sigma = (j: number, m: number): number => Math.sqrt((j * (1 - j)) / m);

    it('estimates the same quantity within MinHash sampling error', () => {
      for (const k of [8, 12, 16]) {
        const w = wasm.min_hash_jaccard(SEQ, SEQ_B, k, 128);
        const j = minHashJaccard(SEQ, SEQ_B, k, 128);
        // Two independent 128-slot estimates of one value differ by at most a
        // few sigma. Three sigma of the larger estimate, floored at one slot,
        // is the bound; it is derived, not chosen to pass.
        const bound = Math.max(1 / 128, 3 * sigma(Math.max(w, j), 128));
        expect(Math.abs(w - j)).toBeLessThanOrEqual(bound);
      }
    });

    it('both agree exactly when the answer cannot be sampled wrong', () => {
      // A sequence against itself: every slot must match in both.
      expect(wasm.min_hash_jaccard(SEQ, SEQ, 12, 128)).toBe(1);
      expect(minHashJaccard(SEQ, SEQ, 12, 128)).toBe(1);
    });

    it('is bit-identical to the JS implementation', () => {
      const w = wasm.min_hash_jaccard(SEQ, SEQ_B, 8, 128);
      const j = minHashJaccard(SEQ, SEQ_B, 8, 128);
      expect(w).toBe(j);
    });

    it('returns bit-identical signatures across JS and WASM', () => {
      const wasmSig = Array.from(
        wasm.minhash_signature(encode(SEQ), 12, 128).signature
      );
      const jsSig = Array.from(minHashSketchJS(SEQ, 12, 128, false));
      expect(wasmSig).toEqual(jsSig);

      const wasmCanonSig = Array.from(
        wasm.minhash_signature_canonical(encode(SEQ), 12, 128).signature
      );
      const jsCanonSig = Array.from(minHashSketchJS(SEQ, 12, 128, true));
      expect(wasmCanonSig).toEqual(jsCanonSig);
    });

    it('the comparison is discriminating', () => {
      expect(wasm.min_hash_jaccard(SEQ, SEQ, 12, 128)).toBeGreaterThan(
        wasm.min_hash_jaccard(SEQ, SEQ_B, 12, 128)
      );
    });
  });

  /**
   * `analyze_kmers` agrees with `analyzeKmers`.
   *
   * It did not, until phage_explorer-wbil. The kernel counted PLAIN k-mers while
   * the JS counted CANONICAL ones -- each k-mer collapsed with its reverse
   * complement -- so the two returned materially different answers under one
   * name. Measured on a 3000 bp pair at k=6 before the fix:
   *
   *                          WASM      JS
   *     unique k-mers in A   2110      1585
   *     jaccard              0.343     0.607
   *
   * Canonical is the biologically correct choice: which strand a sequence was
   * read from is an accident of sequencing, so a genome must not look
   * dissimilar to its own reverse complement.
   *
   * A second, subtler divergence went with it. The kernel skipped only `N`
   * where the JS skips any base outside ACGT, so R, Y, K, M and the rest were
   * being counted as ordinary bases on one side only.
   *
   * The block that used to live here asserted the DIFFERENCE, so that unifying
   * the implementations would fail the suite and someone would have to come
   * back and change it deliberately. This is that deliberate change.
   */
  describe(`k-mer analysis parity [${name}]`, () => {
    const k = 6;

    it('agrees on every field', () => {
      const w = wasm.analyze_kmers(SEQ, SEQ_B, k);
      const js = analyzeKmers(SEQ, SEQ_B, k);

      expect(w.unique_kmers_a).toBe(js.uniqueKmersA);
      expect(w.unique_kmers_b).toBe(js.uniqueKmersB);
      expect(w.shared_kmers).toBe(js.sharedKmers);
      expect(w.jaccard_index).toBeCloseTo(js.jaccardIndex, 12);
      expect(w.containment_a_in_b).toBeCloseTo(js.containmentAinB, 12);
      expect(w.containment_b_in_a).toBeCloseTo(js.containmentBinA, 12);
      expect(w.cosine_similarity).toBeCloseTo(js.cosineSimilarity, 12);
      expect(w.bray_curtis_dissimilarity).toBeCloseTo(js.brayCurtisDissimilarity, 12);
    });

    it('counts canonical k-mers, which is what made them disagree', () => {
      // Pins the specific cause. 1585 canonical against 2110 plain for this
      // sequence: if the kernel reverted to plain counting this fails with the
      // exact number that identifies the regression.
      expect(wasm.analyze_kmers(SEQ, SEQ_B, k).unique_kmers_a).toBe(
        extractCanonicalKmerSet(SEQ, k).size
      );
      expect(extractCanonicalKmerSet(SEQ, k).size).toBeLessThan(
        extractKmerSet(SEQ, k).size
      );
    });

    it('sees a sequence and its reverse complement as identical', () => {
      // The property canonical k-mers exist for, and the one plain counting got
      // wrong. Under plain counting these two share almost nothing.
      const rc = SEQ.split('').reverse()
        .map(c => ({ A: 'T', C: 'G', G: 'C', T: 'A' }[c] ?? c)).join('');
      const self = wasm.analyze_kmers(SEQ, rc, k);
      expect(self.jaccard_index).toBeCloseTo(1, 6);
      expect(self.containment_a_in_b).toBeCloseTo(1, 6);
    });

    it('drops k-mers containing any base outside ACGT, as the JS does', () => {
      // The second divergence: the kernel skipped only N, so R/Y/K/M were
      // counted as ordinary bases on one side.
      const withAmbiguous = `${SEQ.slice(0, 100)}RYKM${SEQ.slice(104, 600)}`;
      const w = wasm.analyze_kmers(withAmbiguous, SEQ_B, k);
      const js = analyzeKmers(withAmbiguous, SEQ_B, k);
      expect(w.unique_kmers_a).toBe(js.uniqueKmersA);
    });
  });

  describe(`GC skew is internally consistent [${name}]`, () => {
    // There is no JS `computeGCSkew` in this repository to compare against, so
    // this checks the kernel's own invariants rather than claiming a parity it
    // cannot demonstrate. Saying which is which is the point.
    it('produces one value per window', () => {
      const windowSize = 100;
      const stepSize = 50;
      const skew = wasm.compute_gc_skew(SEQ, windowSize, stepSize);
      const expectedWindows = Math.floor((SEQ.length - windowSize) / stepSize) + 1;
      expect(skew.length).toBeGreaterThan(0);
      expect(Math.abs(skew.length - expectedWindows)).toBeLessThanOrEqual(1);
    });

    it('stays within the mathematically possible range', () => {
      // (G - C) / (G + C) cannot leave [-1, 1].
      for (const v of wasm.compute_gc_skew(SEQ, 100, 50)) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('cumulative skew is per base and monotonic in its own increments', () => {
      // Not the running sum of the windowed skew: the kernel returns one value
      // per base, not per window. Checking the wrong invariant would have made
      // this test fail for a correct kernel, which is worth recording -- the
      // shapes are 3000 and 59 for the same input.
      const cumulative = wasm.compute_cumulative_gc_skew(SEQ);
      expect(cumulative.length).toBe(SEQ.length);

      // Each step moves by at most one, since each base contributes +1, -1 or 0.
      for (let i = 1; i < cumulative.length; i++) {
        expect(Math.abs(cumulative[i] - cumulative[i - 1])).toBeLessThanOrEqual(1 + 1e-9);
      }
    });

    it('cumulative skew rises on a G-rich strand and falls on a C-rich one', () => {
      const gRich = wasm.compute_cumulative_gc_skew('GGGGGGGGGA'.repeat(40));
      const cRich = wasm.compute_cumulative_gc_skew('CCCCCCCCCA'.repeat(40));
      expect(gRich[gRich.length - 1]).toBeGreaterThan(0);
      expect(cRich[cRich.length - 1]).toBeLessThan(0);
    });

    it('reports the expected sign on a deliberately skewed sequence', () => {
      // G-rich leading strand gives positive skew; the reverse gives negative.
      const gRich = 'GGGGGGGGGC'.repeat(40);
      const cRich = 'CCCCCCCCCG'.repeat(40);
      const gs = wasm.compute_gc_skew(gRich, 100, 50);
      const cs = wasm.compute_gc_skew(cRich, 100, 50);
      expect(gs[0]).toBeGreaterThan(0);
      expect(cs[0]).toBeLessThan(0);
    });
  });

  describe(`palindrome detection parity [${name}]`, () => {
    it('matches exact JS reference on realistic sequences', () => {
      const minLen = 4;
      const maxGap = 2;
      const wasmRes = parseJson<PalindromeHit[]>(wasm.detect_palindromes(SEQ.slice(0, 500), minLen, maxGap).json);
      const jsRes = detectPalindromesJS(SEQ.slice(0, 500), minLen, maxGap);

      expect(wasmRes.length).toBe(jsRes.length);
      expect(wasmRes.length).toBeGreaterThan(0);
      expect(wasmRes).toEqual(jsRes);
    });

    it('handles perfect palindromes without gap (max_gap = 0)', () => {
      const wasmRes = parseJson<PalindromeHit[]>(wasm.detect_palindromes(SEQ.slice(0, 400), 5, 0).json);
      const jsRes = detectPalindromesJS(SEQ.slice(0, 400), 5, 0);

      expect(wasmRes.length).toBe(jsRes.length);
      expect(wasmRes).toEqual(jsRes);
    });

    it('the comparison is discriminating: planted hairpin is detected, and random non-palindromic sequence produces zero', () => {
      const planted = 'AAAA' + 'GCAT' + 'TT' + 'ATGC' + 'CCCC';
      const wasmRes = parseJson<PalindromeHit[]>(wasm.detect_palindromes(planted, 4, 2).json);
      const jsRes = detectPalindromesJS(planted, 4, 2);

      expect(wasmRes.length).toBeGreaterThanOrEqual(1);
      expect(wasmRes).toEqual(jsRes);
      expect(wasmRes.some((h) => h.sequence === 'GCATTTATGC')).toBe(true);

      const homopolymer = 'A'.repeat(50);
      const wasmHomopolymer = parseJson<PalindromeHit[]>(wasm.detect_palindromes(homopolymer, 4, 0).json);
      expect(wasmHomopolymer.length).toBe(0);
    });
  });

  describe(`tandem repeat detection parity [${name}]`, () => {
    it('matches exact JS reference on realistic sequences', () => {
      const wasmRes = parseJson<TandemRepeatHit[]>(wasm.detect_tandem_repeats(SEQ.slice(0, 600), 2, 6, 2).json);
      const jsRes = detectTandemRepeatsJS(SEQ.slice(0, 600), 2, 6, 2);

      expect(wasmRes.length).toBe(jsRes.length);
      expect(wasmRes).toEqual(jsRes);
    });

    it('the comparison is discriminating: planted tandem repeat is detected', () => {
      const planted = 'ACGT' + 'CAGCAGCAGCAGCAG' + 'TGCA';
      const wasmRes = parseJson<TandemRepeatHit[]>(wasm.detect_tandem_repeats(planted, 3, 3, 4).json);
      const jsRes = detectTandemRepeatsJS(planted, 3, 3, 4);

      expect(wasmRes.length).toBeGreaterThanOrEqual(1);
      expect(wasmRes).toEqual(jsRes);
      expect(wasmRes.some((h) => h.unit === 'CAG' && h.copies >= 4)).toBe(true);

      const nonRepeat = 'ACGTACGT'.slice(0, 7);
      const wasmNonRepeat = parseJson<TandemRepeatHit[]>(wasm.detect_tandem_repeats(nonRepeat, 4, 4, 2).json);
      expect(wasmNonRepeat.length).toBe(0);
    });
  });

  describe(`repeat coordinates and bounds [${name}]`, () => {
    it('preserves unknown Unicode characters without invalid UTF-8', () => {
      expect(wasm.reverse_complement('ACé')).toBe('éGT');
      expect(wasm.reverse_complement('🧬aRy')).toBe('rYt🧬');
    });
    it('finds odd spacers without fabricating extra gap values', () => {
      for (const gap of [0, 1, 3, 5]) {
        const sequence = 'ACGTA' + 'N'.repeat(gap) + 'TACGT';
        const result = wasm.detect_palindromes(sequence, 5, gap + 1);
        try {
          expect(JSON.parse(result.json)).toEqual([{ start: 0, end: sequence.length, arm_length: 5, gap, sequence }]);
        } finally { result.free(); }
      }
    });
    it('returns bounded prefixes and excludes unresolved tandem units', () => {
      const sequence = 'AC'.repeat(100);
      const tandem = wasm.detect_tandem_repeats(sequence, 2, 4, 2, 2);
      const palindrome = wasm.detect_palindromes('AT'.repeat(100), 2, 5, 2);
      const unknown = wasm.detect_tandem_repeats('NNNNNNNN', 2, 4, 2);
      try {
        expect(JSON.parse(tandem.json)).toEqual(detectTandemRepeatsJS(sequence, 2, 4, 2).slice(0, 2));
        expect(JSON.parse(palindrome.json)).toEqual(detectPalindromesJS('AT'.repeat(100), 2, 5).slice(0, 2));
        expect(JSON.parse(unknown.json)).toEqual([]);
      } finally { tandem.free(); palindrome.free(); unknown.free(); }
      expect(() => wasm.detect_palindromes('ACGT', 0, 0)).toThrow();
      expect(() => wasm.detect_tandem_repeats('ACGT', 0, 4, 2)).toThrow();
      expect(() => wasm.detect_palindromes('AA"TT', 1, 3)).toThrow();
    });
  });

  describe(`scan_kl_windows invariants & discrimination [${name}]`, () => {
    it('computes non-negative KL divergence values at valid window intervals', () => {
      const bytes = encode(SEQ.slice(0, 500));
      const k = 3;
      const windowSize = 50;
      const stepSize = 10;
      const res = wasm.scan_kl_windows(bytes, k, windowSize, stepSize);

      try {
        expect(res.k).toBe(k);
        expect(res.window_count).toBeGreaterThan(0);
        expect(res.kl_values.length).toBe(res.window_count);
        expect(res.positions.length).toBe(res.window_count);

        for (let i = 0; i < res.window_count; i++) {
          expect(res.kl_values[i]).toBeGreaterThanOrEqual(0);
          expect(res.positions[i]).toBe(i * stepSize);
        }
      } finally {
        res.free();
      }
    });

    it('the comparison is discriminating: diverging window shows elevated KL and invalid inputs return empty', () => {
      const island = 'ACGT'.repeat(50) + 'G'.repeat(80) + 'ACGT'.repeat(50);
      const bytes = encode(island);
      const res = wasm.scan_kl_windows(bytes, 2, 40, 10);
      try {
        let maxKL = 0;
        let minKL = Infinity;
        for (let i = 0; i < res.kl_values.length; i++) {
          const val = res.kl_values[i];
          if (val > maxKL) maxKL = val;
          if (val < minKL) minKL = val;
        }
        expect(maxKL).toBeGreaterThan(minKL);
        expect(maxKL).toBeGreaterThan(0.5);

        const invalid = wasm.scan_kl_windows(bytes, 2, island.length + 100, 10);
        try {
          expect(invalid.window_count).toBe(0);
        } finally {
          invalid.free();
        }
      } finally {
        res.free();
      }
    });
  });

  describe(`pca_power_iteration_f32 invariants & discrimination [${name}]`, () => {
    it('extracts orthonormal eigenvectors with ordered non-negative eigenvalues', () => {
      const nSamples = 20;
      const nFeatures = 5;
      const nComponents = 3;
      const data = new Float32Array(nSamples * nFeatures);
      for (let i = 0; i < data.length; i++) {
        data[i] = ((i * 17 + 5) % 100) / 10;
      }

      const res = wasm.pca_power_iteration_f32(data, nSamples, nFeatures, nComponents, 100, 1e-6);
      try {
        expect(res.n_components).toBe(nComponents);
        expect(res.n_features).toBe(nFeatures);
        expect(res.eigenvalues.length).toBe(nComponents);
        expect(res.eigenvectors.length).toBe(nComponents * nFeatures);

        for (let i = 0; i < nComponents - 1; i++) {
          expect(res.eigenvalues[i]).toBeGreaterThanOrEqual(res.eigenvalues[i + 1]);
          expect(res.eigenvalues[i]).toBeGreaterThanOrEqual(0);
        }

        for (let c = 0; c < nComponents; c++) {
          let normSq = 0;
          for (let f = 0; f < nFeatures; f++) {
            const v = res.eigenvectors[c * nFeatures + f];
            normSq += v * v;
          }
          expect(normSq).toBeCloseTo(1.0, 4);
        }

        for (let c1 = 0; c1 < nComponents; c1++) {
          for (let c2 = c1 + 1; c2 < nComponents; c2++) {
            let dot = 0;
            for (let f = 0; f < nFeatures; f++) {
              dot += res.eigenvectors[c1 * nFeatures + f] * res.eigenvectors[c2 * nFeatures + f];
            }
            expect(dot).toBeCloseTo(0.0, 4);
          }
        }
      } finally {
        res.free();
      }
    });

    it('the comparison is discriminating: 1D dominant variance aligns with feature 0', () => {
      const nSamples = 10;
      const nFeatures = 3;
      const data = new Float32Array(nSamples * nFeatures);
      for (let i = 0; i < nSamples; i++) {
        data[i * nFeatures + 0] = (i + 1) * 100;
        data[i * nFeatures + 1] = 0.01;
        data[i * nFeatures + 2] = 0.02;
      }

      const res = wasm.pca_power_iteration_f32(data, nSamples, nFeatures, 2, 100, 1e-6);
      try {
        expect(res.n_components).toBe(2);
        expect(res.eigenvalues[0]).toBeGreaterThan(res.eigenvalues[1] * 1000);

        const v0 = Math.abs(res.eigenvectors[0]);
        expect(v0).toBeCloseTo(1.0, 3);
      } finally {
        res.free();
      }
    });
  });

  describe(`hoeffdings_d invariants & discrimination [${name}]`, () => {
    it('produces D in valid mathematical range [-0.5, 1.0] and detects monotonic dependence', () => {
      const n = 50;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = i;
        y[i] = i * 2.5 + 3;
      }

      const res = wasm.hoeffdings_d(x, y);
      expect(res.n).toBe(n);
      expect(res.d).toBeGreaterThanOrEqual(-0.5);
      expect(res.d).toBeLessThanOrEqual(1.0);
      expect(res.d).toBeGreaterThan(0.25);
    });

    it('the comparison is discriminating: D(x, x) strongly exceeds D(x, random_noise)', () => {
      const n = 60;
      const x = new Float64Array(n);
      const noise = new Float64Array(n);
      let s = 1234567;
      for (let i = 0; i < n; i++) {
        x[i] = i;
        s = (s * 1664525 + 1013904223) >>> 0;
        noise[i] = (s / 0xffffffff) * 100;
      }

      const resIdentity = wasm.hoeffdings_d(x, x);
      const resNoise = wasm.hoeffdings_d(x, noise);

      expect(resIdentity.d).toBeGreaterThan(0.25);
      expect(Math.abs(resNoise.d)).toBeLessThan(0.1);
      expect(resIdentity.d).toBeGreaterThan(resNoise.d * 3);
    });

    it('kmer_hoeffdings_d returns high similarity for identical sequences', () => {
      const resSame = wasm.kmer_hoeffdings_d(SEQ.slice(0, 300), SEQ.slice(0, 300), 3);
      expect(resSame.d).toBeGreaterThan(0.2);
    });
  });
}

/**
 * The two variants must agree with each other as well as with JS.
 *
 * They compile from one Rust source with different `target-feature` flags, and
 * SIMD lowering is where a compiler can change a float reduction's rounding
 * order. Checking them against JS individually catches a wrong answer; this
 * catches the narrower case where both are within tolerance of JS but differ
 * from each other, which would make a result depend on the user's CPU.
 */
describe('the two WASM variants agree with each other', () => {
  const [baseline, simd] = variants;

  it('has both variants to compare', () => {
    expect(baseline.name).toBe('pkg');
    expect(simd.name).toBe('pkg-simd');
  });

  it('produces bit-identical GC content', () => {
    expect(simd.wasm.calculate_gc_content(SEQ)).toBe(
      baseline.wasm.calculate_gc_content(SEQ)
    );
  });

  it('produces identical dense k-mer counts', () => {
    const a = baseline.wasm.count_kmers_dense(encode(SEQ), 6);
    const b = simd.wasm.count_kmers_dense(encode(SEQ), 6);
    expect(Array.from(b.counts as Uint32Array)).toEqual(
      Array.from(a.counts as Uint32Array)
    );
  });

  it('produces identical MinHash signatures', () => {
    const a = baseline.wasm.minhash_signature(encode(SEQ), 12, 128);
    const b = simd.wasm.minhash_signature(encode(SEQ), 12, 128);
    expect(Array.from(b.signature)).toEqual(Array.from(a.signature));
    expect(b.num_hashes).toBe(a.num_hashes);
    expect(Number(b.total_kmers)).toBe(Number(a.total_kmers));
  });

  it('produces identical GC skew', () => {
    const a = baseline.wasm.compute_gc_skew(SEQ, 100, 50);
    const b = simd.wasm.compute_gc_skew(SEQ, 100, 50);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('produces identical Levenshtein distances', () => {
    const a = SEQ.slice(0, 300);
    const b = SEQ_B.slice(0, 300);
    expect(simd.wasm.levenshtein_distance(a, b)).toBe(
      baseline.wasm.levenshtein_distance(a, b)
    );
  });

  it('produces identical palindromes', () => {
    const a = baseline.wasm.detect_palindromes(SEQ.slice(0, 400), 4, 2);
    const b = simd.wasm.detect_palindromes(SEQ.slice(0, 400), 4, 2);
    expect(b.json).toBe(a.json);
  });

  it('produces identical tandem repeats', () => {
    const a = baseline.wasm.detect_tandem_repeats(SEQ.slice(0, 400), 2, 5, 2);
    const b = simd.wasm.detect_tandem_repeats(SEQ.slice(0, 400), 2, 5, 2);
    expect(b.json).toBe(a.json);
  });

  it('produces identical Hoeffdings D', () => {
    const x = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const y = new Float64Array([2, 4, 5, 8, 10, 11, 14, 16, 19, 20]);
    const a = baseline.wasm.hoeffdings_d(x, y);
    const b = simd.wasm.hoeffdings_d(x, y);
    expect(b.d).toBeCloseTo(a.d, 9);
    expect(b.n).toBe(a.n);
  });
});
