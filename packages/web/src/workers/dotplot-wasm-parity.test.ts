import { describe, expect, it } from 'bun:test';
import { computeDotPlot } from '@phage-explorer/core';

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

function flattenCore(sequence: string, bins: number, window?: number): { bins: number; window: number; direct: Float32Array; inverted: Float32Array } {
  const result = computeDotPlot(sequence, window === undefined ? { bins } : { bins, window });
  const outBins = result.bins;

  const direct = new Float32Array(outBins * outBins);
  const inverted = new Float32Array(outBins * outBins);

  for (let i = 0; i < outBins; i++) {
    for (let j = 0; j < outBins; j++) {
      const idx = i * outBins + j;
      const cell = result.grid[i]![j]!;
      direct[idx] = cell.direct;
      inverted[idx] = cell.inverted;
    }
  }

  return { bins: outBins, window: result.window, direct, inverted };
}

function expectFloat32ArrayClose(actual: Float32Array, expected: Float32Array, tol = 1e-6): void {
  expect(actual.length).toBe(expected.length);

  for (let i = 0; i < actual.length; i++) {
    const diff = Math.abs(actual[i]! - expected[i]!);
    if (diff > tol) {
      throw new Error(`Float32Array mismatch at ${i}: got ${actual[i]}, expected ${expected[i]} (|diff|=${diff})`);
    }
  }
}

for (const { name, wasm } of variants) {
describe(`dotplot_self_buffers (WASM) parity [${name}]`, () => {
  it('matches core computeDotPlot (ACGT, bins=2, window=2)', () => {
    const sequence = 'ACGT';
    const bins = 2;
    const window = 2;

    const expected = flattenCore(sequence, bins, window);

    const res = wasm.dotplot_self_buffers(encodeAscii(sequence), bins, window);
    try {
      expect(res.bins).toBe(expected.bins);
      expect(res.window).toBe(expected.window);

      expectFloat32ArrayClose(res.direct, expected.direct);
      expectFloat32ArrayClose(res.inverted, expected.inverted);
    } finally {
      res.free();
    }
  });

  it('matches core computeDotPlot for IUPAC ambiguity codes (RY, bins=2, window=1)', () => {
    const sequence = 'RY';
    const bins = 2;
    const window = 1;

    const expected = flattenCore(sequence, bins, window);

    const res = wasm.dotplot_self_buffers(encodeAscii(sequence), bins, window);
    try {
      expect(res.bins).toBe(expected.bins);
      expect(res.window).toBe(expected.window);

      expectFloat32ArrayClose(res.direct, expected.direct);
      expectFloat32ArrayClose(res.inverted, expected.inverted);
    } finally {
      res.free();
    }
  });

  it('matches core computeDotPlot default window derivation (window=0 in WASM)', () => {
    const sequence = 'ACGT'.repeat(40); // len=160
    const bins = 10;

    const expected = flattenCore(sequence, bins);

    const res = wasm.dotplot_self_buffers(encodeAscii(sequence), bins, 0);
    try {
      expect(res.bins).toBe(expected.bins);
      expect(res.window).toBe(expected.window);

      expectFloat32ArrayClose(res.direct, expected.direct);
      expectFloat32ArrayClose(res.inverted, expected.inverted);
    } finally {
      res.free();
    }
  });
});
}
