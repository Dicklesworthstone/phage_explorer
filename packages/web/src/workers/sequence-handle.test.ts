/**
 * SequenceHandle Parity & Integration Tests
 *
 * Verifies that SequenceHandle accessors (gc_skew, cumulative_gc_skew, windowed_entropy,
 * count_kmers, minhash, dotplot_self, length, valid_count, encoded_bytes) produce
 * results bit-identical / equivalent to their standalone kernel counterparts.
 *
 * @see phage_explorer-9vk4.7
 * @see phage_explorer-kalm.7
 */

import { describe, expect, it } from 'bun:test';
import { loadWasmVariants } from './wasm-variants';

const variants = await loadWasmVariants();
const SEQ = 'ACGTTGCAAGGCTTACGCATTGCAAGCTTGACCGTAAGCTTGGCATCGATCGGATCGATCG'.repeat(4);
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

for (const { name, wasm } of variants) {
  describe(`SequenceHandle comprehensive parity [${name}]`, () => {
    it('creates handle and verifies length, valid_count, and encoded_bytes', () => {
      const bytes = encode('ACGTNacgt');
      const handle = new wasm.SequenceHandle(bytes);
      try {
        expect(handle.length).toBe(9);
        expect(handle.valid_count).toBe(8); // 8 valid ACGT bases + 1 N

        const encoded = handle.encoded_bytes;
        expect(encoded.length).toBe(9);
        // A=0, C=1, G=2, T=3, N=4
        expect(Array.from(encoded)).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3]);
      } finally {
        handle.free();
      }
    });

    it('gc_skew matches standalone compute_gc_skew', () => {
      const bytes = encode(SEQ);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const windowSize = 20;
        const stepSize = 5;
        const fromHandle = handle.gc_skew(windowSize, stepSize);
        const fromKernel = wasm.compute_gc_skew(SEQ, windowSize, stepSize);

        expect(fromHandle.length).toBe(fromKernel.length);
        expect(fromHandle.length).toBeGreaterThan(0);
        for (let i = 0; i < fromHandle.length; i++) {
          expect(fromHandle[i]).toBeCloseTo(fromKernel[i], 10);
        }
      } finally {
        handle.free();
      }
    });

    it('cumulative_gc_skew matches standalone compute_cumulative_gc_skew', () => {
      const bytes = encode(SEQ);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const fromHandle = handle.cumulative_gc_skew();
        const fromKernel = wasm.compute_cumulative_gc_skew(SEQ);

        expect(fromHandle.length).toBe(fromKernel.length);
        expect(fromHandle.length).toBe(SEQ.length);
        for (let i = 0; i < fromHandle.length; i++) {
          expect(fromHandle[i]).toBe(fromKernel[i]);
        }
      } finally {
        handle.free();
      }
    });

    it('windowed_entropy matches compute_windowed_entropy_acgt', () => {
      const bytes = encode(SEQ);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const windowSize = 16;
        const stepSize = 4;
        const fromHandle = handle.windowed_entropy(windowSize, stepSize);
        const fromKernel = wasm.compute_windowed_entropy_acgt(SEQ, windowSize, stepSize);

        expect(fromHandle.length).toBe(fromKernel.length);
        expect(fromHandle.length).toBeGreaterThan(0);
        for (let i = 0; i < fromHandle.length; i++) {
          expect(fromHandle[i]).toBeCloseTo(fromKernel[i], 10);
        }
      } finally {
        handle.free();
      }
    });

    it('count_kmers matches standalone count_kmers_dense', () => {
      const bytes = encode(SEQ);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        for (const k of [3, 4, 5]) {
          const resHandle = handle.count_kmers(k);
          const resKernel = wasm.count_kmers_dense(bytes, k);

          expect(resHandle.k).toBe(resKernel.k);
          expect(Number(resHandle.total_valid)).toBe(Number(resKernel.total_valid));
          expect(resHandle.counts.length).toBe(resKernel.counts.length);
          for (let i = 0; i < resHandle.counts.length; i++) {
            expect(resHandle.counts[i]).toBe(resKernel.counts[i]);
          }
        }
      } finally {
        handle.free();
      }
    });

    it('minhash produces canonical signatures matching minhash_signature_canonical', () => {
      const bytes = encode(SEQ);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const sigHandle = handle.minhash(64, 8);
        const sigKernel = wasm.minhash_signature_canonical(bytes, 8, 64);

        expect(sigHandle.k).toBe(sigKernel.k);
        expect(sigHandle.num_hashes).toBe(sigKernel.num_hashes);
        expect(sigHandle.signature.length).toBe(sigKernel.signature.length);
        for (let i = 0; i < sigHandle.signature.length; i++) {
          expect(sigHandle.signature[i]).toBe(sigKernel.signature[i]);
        }
      } finally {
        handle.free();
      }
    });

    it('dotplot_self matches dotplot_self_buffers', () => {
      const bytes = encode(SEQ);
      const handle = new wasm.SequenceHandle(bytes);
      try {
        const dpHandle = handle.dotplot_self(16, 8);
        const dpKernel = wasm.dotplot_self_buffers(bytes, 16, 8);

        expect(dpHandle.bins).toBe(dpKernel.bins);
        expect(dpHandle.window).toBe(dpKernel.window);
        expect(dpHandle.direct.length).toBe(dpKernel.direct.length);
        expect(dpHandle.inverted.length).toBe(dpKernel.inverted.length);
        for (let i = 0; i < dpHandle.direct.length; i++) {
          expect(dpHandle.direct[i]).toBeCloseTo(dpKernel.direct[i], 6);
          expect(dpHandle.inverted[i]).toBeCloseTo(dpKernel.inverted[i], 6);
        }
      } finally {
        handle.free();
      }
    });
  });
}
