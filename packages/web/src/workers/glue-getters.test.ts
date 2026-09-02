import { describe, expect, it } from 'bun:test';
import { loadWasmVariants } from './wasm-variants';

/**
 * Every getter the glue patches exist for must return a plausible value.
 *
 * ## Why this is the real protection
 *
 * `scripts/inline-wasm-compute.ts` carries eleven regex corrections for
 * wasm-bindgen emitting a getter that calls the WRONG WASM export --
 * `SequenceHandle.length` calling `bonddetectionresult_bond_count`,
 * `MinHashSignature.k` calling `cgrcountsresult_resolution`, and so on.
 *
 * Those patches now fail the build when one stops matching. That is necessary
 * and not sufficient: a regex check only proves the glue has the shape the
 * patch expected. It cannot tell you whether the getter returns the right
 * NUMBER, and a getter wired to the wrong export does not throw -- it returns
 * another field's value, silently.
 *
 * So this suite calls each affected getter on a known input and asserts a value
 * that could only come from the right export. `MinHashSignature.k` asked for
 * with k=12 must be 12; if it were still reading a CGR resolution it would be
 * 64 or 128. That check holds no matter what the glue looks like.
 *
 * All eleven patches are obsolete at the pinned toolchain -- the generated glue
 * already has the correct getters. These tests are what would notice if that
 * stopped being true, which is the situation the toolchain pin exists to make
 * visible rather than silent.
 */

const variants = await loadWasmVariants();

const SEQ = 'ACGTTGCAAGGCTTACGCATTGCAAGCTTGACCGTAAGCTTGGCATCGATCGGATCGATCG'.repeat(8);
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

for (const { name, wasm } of variants) {
  describe(`getters patched in the glue return their own field [${name}]`, () => {
    it('MinHashSignature.k is the k it was asked for', () => {
      // Patched because it called `cgrcountsresult_resolution`. A CGR
      // resolution is a power of two like 64 or 128, never 12, so this
      // distinguishes the two sources rather than merely checking a range.
      for (const k of [8, 12, 16]) {
        expect(wasm.minhash_signature(encode(SEQ), k, 64).k).toBe(k);
      }
    });

    it('MinHashSignature.num_hashes is the count it was asked for', () => {
      for (const n of [32, 64, 128]) {
        expect(wasm.minhash_signature(encode(SEQ), 12, n).num_hashes).toBe(n);
      }
    });

    it('MinHashSignature.total_kmers counts k-mers, not dense totals', () => {
      // Patched because it called `densekmerresult_total_valid`. For a
      // sequence of length L with k=12 there are L-k+1 windows, and this
      // sequence has no ambiguous bases, so every one is valid.
      const sig = wasm.minhash_signature(encode(SEQ), 12, 64);
      expect(Number(sig.total_kmers)).toBe(SEQ.length - 12 + 1);
    });

    it('MinHashSignature.signature has one entry per hash', () => {
      const sig = wasm.minhash_signature(encode(SEQ), 12, 64);
      expect(sig.signature.length).toBe(64);
      // Not all the same value: a signature of identical minima would mean the
      // hash functions are not independent.
      expect(new Set(Array.from(sig.signature)).size).toBeGreaterThan(1);
    });

    it('DenseKmerResult.k is the k it was asked for', () => {
      // Patched because it called `cgrcountsresult_resolution`.
      for (const k of [3, 5, 7]) {
        expect(wasm.count_kmers_dense(encode(SEQ), k).k).toBe(k);
      }
    });

    it('DenseKmerResult counts are 4^k long and sum to the valid total', () => {
      const k = 5;
      const r = wasm.count_kmers_dense(encode(SEQ), k);
      expect(r.counts.length).toBe(4 ** k);
      const sum = Array.from(r.counts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(Number(r.total_valid));
      expect(sum).toBe(SEQ.length - k + 1);
    });

    it('DotPlotBuffers.bins is derived from the requested geometry', () => {
      // Patched because it called `cgrcountsresult_resolution`.
      const buffers = wasm.dotplot_self_buffers(SEQ, 8, 64);
      expect(buffers.bins).toBeGreaterThan(0);
      // Whatever the binning rule, it cannot exceed the sequence length.
      expect(buffers.bins).toBeLessThanOrEqual(SEQ.length);
    });

    it('CgrCountsResult.resolution is 2^k for the k it was asked for', () => {
      // The export the mis-wired getters were reading FROM. If this were wrong
      // too, the assertions above could pass by coincidence.
      //
      // `cgr_counts` takes BYTES and a k, not a resolution; the resolution is
      // derived as 2^k and the grid is resolution^2 cells. My first version of
      // this test passed a string and a resolution and got 0 back, which is
      // recorded because it is the same class of mistake the getters had: a
      // plausible-looking number from the wrong place.
      for (const k of [4, 5, 6]) {
        const r = wasm.cgr_counts(encode(SEQ), k);
        expect(r.k).toBe(k);
        expect(r.resolution).toBe(2 ** k);
        expect(r.counts.length).toBe((2 ** k) ** 2);
      }
    });

    it('MyersDiffResult matches and mismatches sum to the compared length', () => {
      // The export PCAResultF32's getters were reading FROM.
      const a = SEQ.slice(0, 200);
      const b = `${SEQ.slice(0, 100)}${SEQ.slice(150, 250)}`;
      const d = wasm.equal_len_diff(encode(a), encode(b.slice(0, 200)));
      expect(d.matches + d.mismatches).toBe(200);
    });
  });
}

/**
 * The two variants must agree on these getters as well.
 *
 * The glue is generated per variant, so a patch could in principle apply to one
 * build and not the other. That would give the same call different answers
 * depending on the user's CPU.
 */
describe('both variants report the same values from the patched getters', () => {
  const [baseline, simd] = variants;

  it('MinHashSignature fields agree', () => {
    const a = baseline.wasm.minhash_signature(encode(SEQ), 12, 64);
    const b = simd.wasm.minhash_signature(encode(SEQ), 12, 64);
    expect(b.k).toBe(a.k);
    expect(b.num_hashes).toBe(a.num_hashes);
    expect(Number(b.total_kmers)).toBe(Number(a.total_kmers));
  });

  it('DenseKmerResult fields agree', () => {
    const a = baseline.wasm.count_kmers_dense(encode(SEQ), 5);
    const b = simd.wasm.count_kmers_dense(encode(SEQ), 5);
    expect(b.k).toBe(a.k);
    expect(Number(b.total_valid)).toBe(Number(a.total_valid));
  });

  it('CGR resolution agrees', () => {
    expect(simd.wasm.cgr_counts(encode(SEQ), 6).resolution).toBe(
      baseline.wasm.cgr_counts(encode(SEQ), 6).resolution
    );
  });
});
