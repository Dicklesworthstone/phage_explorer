import { describe, expect, it } from 'bun:test';
import { computeCGR } from '@phage-explorer/core';

import { loadWasmVariants } from './wasm-variants';

/**
 * Runs against BOTH builds. The suite used to import '@phage/wasm-compute',
 * which resolves to the baseline `pkg/`, while the loader prefers `pkg-simd/`.
 * The variant that runs in production was never tested.
 */
const variants = await loadWasmVariants();

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

function encodeBase(byte: number): 0 | 1 | 2 | 3 | 4 {
  // Mirror wasm-compute encode_base(): A=0, C=1, G=2, T/U=3, N/other=4
  if (byte === 65 || byte === 97) return 0; // A/a
  if (byte === 67 || byte === 99) return 1; // C/c
  if (byte === 71 || byte === 103) return 2; // G/g
  if (byte === 84 || byte === 116 || byte === 85 || byte === 117) return 3; // T/t/U/u
  return 4;
}

function rot(n: number, x: number, y: number, rx: number, ry: number): { x: number; y: number } {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    return { x: y, y: x };
  }
  return { x, y };
}

function d2xy(size: number, d: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let t = d;
  for (let s = 1; s < size; s <<= 1) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    const rotated = rot(s, x, y, rx, ry);
    x = rotated.x + s * rx;
    y = rotated.y + s * ry;
    t >>= 2;
  }
  return { x, y };
}

function hilbertRgbaJs(seqBytes: Uint8Array, order: number, colorsRgb: Uint8Array): Uint8Array {
  const size = 1 << order;
  const totalPixels = size * size;

  const out = new Uint8Array(totalPixels * 4);
  const bgR = colorsRgb[12] ?? 0;
  const bgG = colorsRgb[13] ?? 0;
  const bgB = colorsRgb[14] ?? 0;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    out[idx] = bgR;
    out[idx + 1] = bgG;
    out[idx + 2] = bgB;
    out[idx + 3] = 255;
  }

  const maxIdx = Math.min(seqBytes.length, totalPixels);
  for (let i = 0; i < maxIdx; i++) {
    const raw = seqBytes[i] ?? 78; // 'N'
    const code = raw <= 4 ? raw : encodeBase(raw);
    const c = Math.min(code, 4) * 3;
    const { x, y } = d2xy(size, i);
    const idx = (y * size + x) * 4;
    out[idx] = colorsRgb[c] ?? bgR;
    out[idx + 1] = colorsRgb[c + 1] ?? bgG;
    out[idx + 2] = colorsRgb[c + 2] ?? bgB;
    out[idx + 3] = 255;
  }

  return out;
}

function expectUint8ArrayEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`Uint8Array mismatch at ${i}: got ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

function expectCountsMatch(actual: Uint32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    const e = expected[i] ?? 0;
    if (actual[i] !== e) {
      throw new Error(`Count mismatch at ${i}: got ${actual[i]}, expected ${e}`);
    }
  }
}

for (const { name, wasm } of variants) {
describe(`hilbert_rgba (WASM) parity [${name}]`, () => {
  it('matches JS reference (ACGT, order=4)', () => {
    const sequence = 'ACGT';
    const order = 4;
    const colors = new Uint8Array([
      1, 2, 3, // A
      4, 5, 6, // C
      7, 8, 9, // G
      10, 11, 12, // T
      13, 14, 15, // N (background)
    ]);

    const bytes = encodeAscii(sequence);
    const expected = hilbertRgbaJs(bytes, order, colors);
    const actual = wasm.hilbert_rgba(bytes, order, colors);
    expectUint8ArrayEqual(actual, expected);
  });

  it('matches JS reference for lowercase + ambiguous (order=4)', () => {
    const sequence = 'acgtnN';
    const order = 4;
    const colors = new Uint8Array([
      21, 22, 23, // A
      24, 25, 26, // C
      27, 28, 29, // G
      30, 31, 32, // T
      33, 34, 35, // N
    ]);

    const bytes = encodeAscii(sequence);
    const expected = hilbertRgbaJs(bytes, order, colors);
    const actual = wasm.hilbert_rgba(bytes, order, colors);
    expectUint8ArrayEqual(actual, expected);
  });
});
}

for (const { name, wasm } of variants) {
describe(`cgr_counts (WASM) parity [${name}]`, () => {
  it('matches core computeCGR for empty sequence (k=2)', () => {
    const expected = computeCGR('', 2);

    const res = wasm.cgr_counts(encodeAscii(''), 2);
    try {
      expect(res.resolution).toBe(expected.resolution);
      expect(res.k).toBe(expected.k);
      expect(res.max_count).toBe(expected.maxCount);
      expect(res.total_points).toBe(expected.totalPoints);
      expect(res.entropy).toBe(expected.entropy);

      expectCountsMatch(res.counts, expected.grid);
    } finally {
      res.free();
    }
  });

  it('matches core computeCGR for transient removal (AAAAAA, k=3)', () => {
    const sequence = 'AAAAAA';
    const k = 3;
    const expected = computeCGR(sequence, k);

    const res = wasm.cgr_counts(encodeAscii(sequence), k);
    try {
      expect(res.resolution).toBe(expected.resolution);
      expect(res.k).toBe(expected.k);
      expect(res.max_count).toBe(expected.maxCount);
      expect(res.total_points).toBe(expected.totalPoints);
      expect(Math.abs(res.entropy - expected.entropy)).toBeLessThan(1e-9);

      expectCountsMatch(res.counts, expected.grid);
    } finally {
      res.free();
    }
  });

  it('matches core computeCGR for skipping non-ACGT (ANNT, k=1)', () => {
    const sequence = 'ANNT';
    const k = 1;
    const expected = computeCGR(sequence, k);

    const res = wasm.cgr_counts(encodeAscii(sequence), k);
    try {
      expect(res.total_points).toBe(expected.totalPoints);
      expect(res.max_count).toBe(expected.maxCount);
      expectCountsMatch(res.counts, expected.grid);
    } finally {
      res.free();
    }
  });
});
}
