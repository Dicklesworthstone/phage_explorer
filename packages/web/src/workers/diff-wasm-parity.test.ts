/**
 * Diff WASM Parity Tests
 *
 * Ensures WASM myers_diff and equal_len_diff produce results consistent
 * with the JS implementation for known inputs.
 *
 * @see phage_explorer-kyo0.3
 */

import { describe, expect, it } from 'bun:test';

const wasm = await import('@phage/wasm-compute');
if (typeof wasm.default === 'function') {
  await wasm.default();
}

function encodeAscii(sequence: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(sequence);
  }

  const out = new Uint8Array(sequence.length);
  for (let i = 0; i < sequence.length; i++) {
    out[i] = sequence.charCodeAt(i) & 0xff;
  }
  return out;
}

/**
 * Simple JS diff for equal-length sequences (parity reference).
 * Returns mask with 0=match, 1=mismatch.
 */
function jsEqualLenDiff(
  seqA: string,
  seqB: string
): { mask: Uint8Array; matches: number; mismatches: number } {
  if (seqA.length !== seqB.length) {
    throw new Error('Sequences must have equal length');
  }

  const n = seqA.length;
  const mask = new Uint8Array(n);
  let matches = 0;
  let mismatches = 0;

  for (let i = 0; i < n; i++) {
    if (seqA[i] === seqB[i]) {
      matches++;
    } else {
      mask[i] = 1;
      mismatches++;
    }
  }

  return { mask, matches, mismatches };
}

describe('equal_len_diff (WASM) parity', () => {
  it('matches JS for identical sequences', () => {
    const seq = 'ACGTACGT';
    const bytesA = encodeAscii(seq);
    const bytesB = encodeAscii(seq);

    const expected = jsEqualLenDiff(seq, seq);
    const result = wasm.equal_len_diff(bytesA, bytesB);

    try {
      expect(result.matches).toBe(expected.matches);
      expect(result.mismatches).toBe(expected.mismatches);
      expect(new Uint8Array(result.mask_a)).toEqual(expected.mask);
    } finally {
      result.free();
    }
  });

  it('matches JS for sequences with mismatches', () => {
    const seqA = 'ACGTACGT';
    const seqB = 'ACGTXCXT'; // 2 mismatches at positions 4 and 6
    const bytesA = encodeAscii(seqA);
    const bytesB = encodeAscii(seqB);

    const expected = jsEqualLenDiff(seqA, seqB);
    const result = wasm.equal_len_diff(bytesA, bytesB);

    try {
      expect(result.matches).toBe(expected.matches);
      expect(result.mismatches).toBe(expected.mismatches);
      expect(new Uint8Array(result.mask_a)).toEqual(expected.mask);
    } finally {
      result.free();
    }
  });

  it('handles all mismatches', () => {
    const seqA = 'AAAA';
    const seqB = 'TTTT';
    const bytesA = encodeAscii(seqA);
    const bytesB = encodeAscii(seqB);

    const result = wasm.equal_len_diff(bytesA, bytesB);

    try {
      expect(result.matches).toBe(0);
      expect(result.mismatches).toBe(4);
      // All positions should be marked as mismatch (1)
      expect(new Uint8Array(result.mask_a)).toEqual(new Uint8Array([1, 1, 1, 1]));
    } finally {
      result.free();
    }
  });
});

describe('myers_diff (WASM) correctness', () => {
  it('handles identical sequences', () => {
    const seq = 'ACGTACGT';
    const bytes = encodeAscii(seq);

    const result = wasm.myers_diff(bytes, bytes);

    try {
      expect(result.matches).toBe(seq.length);
      expect(result.mismatches).toBe(0);
      expect(result.insertions).toBe(0);
      expect(result.deletions).toBe(0);
      expect(result.edit_distance).toBe(0);
    } finally {
      result.free();
    }
  });

  it('detects single insertion', () => {
    const seqA = 'ACGT';
    const seqB = 'ACXGT'; // X inserted

    const result = wasm.myers_diff(encodeAscii(seqA), encodeAscii(seqB));

    try {
      expect(result.insertions).toBe(1);
      expect(result.deletions).toBe(0);
      expect(result.edit_distance).toBe(1);
    } finally {
      result.free();
    }
  });

  it('detects single deletion', () => {
    const seqA = 'ACXGT'; // X will be deleted
    const seqB = 'ACGT';

    const result = wasm.myers_diff(encodeAscii(seqA), encodeAscii(seqB));

    try {
      expect(result.deletions).toBe(1);
      expect(result.insertions).toBe(0);
      expect(result.edit_distance).toBe(1);
    } finally {
      result.free();
    }
  });

  it('handles empty sequences', () => {
    const empty = new Uint8Array(0);
    const seq = encodeAscii('ACGT');

    // Empty vs empty
    const result1 = wasm.myers_diff(empty, empty);
    try {
      expect(result1.matches).toBe(0);
      expect(result1.edit_distance).toBe(0);
    } finally {
      result1.free();
    }

    // Non-empty vs empty (all deletions)
    const result2 = wasm.myers_diff(seq, empty);
    try {
      expect(result2.deletions).toBe(4);
      expect(result2.edit_distance).toBe(4);
    } finally {
      result2.free();
    }

    // Empty vs non-empty (all insertions)
    const result3 = wasm.myers_diff(empty, seq);
    try {
      expect(result3.insertions).toBe(4);
      expect(result3.edit_distance).toBe(4);
    } finally {
      result3.free();
    }
  });

  it('is case-insensitive for DNA bases', () => {
    const upper = 'ACGT';
    const lower = 'acgt';

    const result = wasm.myers_diff(encodeAscii(upper), encodeAscii(lower));

    try {
      expect(result.matches).toBe(4);
      expect(result.mismatches).toBe(0);
      expect(result.edit_distance).toBe(0);
    } finally {
      result.free();
    }
  });

  it('treats U as T', () => {
    const dna = 'ACGT';
    const rna = 'ACGU';

    const result = wasm.myers_diff(encodeAscii(dna), encodeAscii(rna));

    try {
      expect(result.matches).toBe(4);
      expect(result.edit_distance).toBe(0);
    } finally {
      result.free();
    }
  });

  it('treats N as never matching', () => {
    const seqA = 'ACNT';
    const seqB = 'ACNT';

    const result = wasm.myers_diff(encodeAscii(seqA), encodeAscii(seqB));

    try {
      // N doesn't match N, so Myers finds it as an indel pair
      // 3 matches (A, C, T) and some edit operations for the N position
      expect(result.matches).toBe(3);
      // Identity is less than 1 because N position doesn't match
      expect(result.identity).toBeLessThan(1.0);
    } finally {
      result.free();
    }
  });
});

describe('myers_diff (WASM) guardrails', () => {
  it('truncates when edit distance exceeds limit', () => {
    // Create sequences that differ significantly
    const seqA = 'A'.repeat(100);
    const seqB = 'T'.repeat(100);

    // Use the limited version with a low max_d
    const result = wasm.myers_diff_with_limit(
      encodeAscii(seqA),
      encodeAscii(seqB),
      5 // Very low limit
    );

    try {
      expect(result.truncated).toBe(true);
      expect(result.error).toBeTruthy();
    } finally {
      result.free();
    }
  });

  it('handles maximum allowed edit distance', () => {
    // Two similar sequences with known small edit distance
    const seqA = 'ACGTACGT';
    const seqB = 'ACGTXCGT'; // 1 substitution = 1 delete + 1 insert in Myers

    const result = wasm.myers_diff_with_limit(
      encodeAscii(seqA),
      encodeAscii(seqB),
      10000 // Default limit
    );

    try {
      expect(result.truncated).toBe(false);
      // Myers counts substitution as delete + insert = 2 edits
      expect(result.edit_distance).toBe(2);
      expect(result.insertions).toBe(1);
      expect(result.deletions).toBe(1);
    } finally {
      result.free();
    }
  });
});

describe('myers_diff (WASM) identity calculation', () => {
  it('returns 1.0 for identical sequences', () => {
    const seq = 'ACGTACGT';
    const bytes = encodeAscii(seq);

    const result = wasm.myers_diff(bytes, bytes);

    try {
      expect(result.identity).toBeCloseTo(1.0, 5);
    } finally {
      result.free();
    }
  });

  it('calculates identity correctly for partial matches', () => {
    const seqA = 'AAAA';
    const seqB = 'AATT'; // Myers: 2 matches, 2 deletions (AA), 2 insertions (TT)

    const result = wasm.myers_diff(encodeAscii(seqA), encodeAscii(seqB));

    try {
      // Myers sees this as: match AA, then delete AA, insert TT
      // identity = matches / (matches + mismatches + ins + del) = 2 / (2+0+2+2) = 1/3
      expect(result.matches).toBe(2);
      expect(result.insertions).toBe(2);
      expect(result.deletions).toBe(2);
      expect(result.identity).toBeCloseTo(1/3, 5);
    } finally {
      result.free();
    }
  });
});
