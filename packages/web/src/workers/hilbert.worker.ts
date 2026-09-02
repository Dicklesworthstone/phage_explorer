/// <reference lib="webworker" />

import * as Comlink from 'comlink';
import { getWasmCompute } from '../lib/wasm-loader';

type RGB = { r: number; g: number; b: number };

export interface HilbertWorkerResult {
  order: number;
  size: number;
  buffer: Uint8ClampedArray;
  coverage: number;
}

export interface CgrWorkerResult {
  grid: Uint32Array;
  resolution: number;
  k: number;
  maxCount: number;
  totalPoints: number;
  entropy: number;
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

function calculateOrder(length: number): number {
  const order = Math.ceil(Math.log(Math.max(length, 1)) / Math.log(4));
  // Cap to keep allocations bounded (2048^2 RGBA = ~16MB).
  return Math.min(Math.max(order, 4), 11);
}

function renderHilbert(sequence: string, colors: Record<string, RGB>): HilbertWorkerResult {
  // Input validation
  if (!sequence || typeof sequence !== 'string') {
    throw new Error('Invalid sequence: must be a non-empty string');
  }
  if (!colors || typeof colors !== 'object') {
    throw new Error('Invalid colors: must be a color map object');
  }

  const order = calculateOrder(sequence.length);
  const size = 1 << order;
  const totalPixels = size * size;
  const bg = colors['N'] ?? { r: 0, g: 0, b: 0 };

  const buffer = new Uint8ClampedArray(totalPixels * 4);

  // Fill background
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    buffer[idx] = bg.r;
    buffer[idx + 1] = bg.g;
    buffer[idx + 2] = bg.b;
    buffer[idx + 3] = 255;
  }

  const maxIdx = Math.min(sequence.length, totalPixels);
  for (let i = 0; i < maxIdx; i++) {
    const { x, y } = d2xy(size, i);
    const nucleotide = sequence[i] ?? 'N';
    const color = colors[nucleotide] ?? bg;
    const idx = (y * size + x) * 4;
    buffer[idx] = color.r;
    buffer[idx + 1] = color.g;
    buffer[idx + 2] = color.b;
    buffer[idx + 3] = 255;
  }

  return {
    order,
    size,
    buffer,
    coverage: totalPixels > 0 ? maxIdx / totalPixels : 0,
  };
}

export interface HilbertWorkerAPI {
  render(sequence: string, colors: Record<string, RGB>): Promise<HilbertWorkerResult>;
  renderCgr(sequence: string, k: number): Promise<CgrWorkerResult>;
}

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function packColors(colors: Record<string, RGB>): Uint8Array {
  const keys = ['A', 'C', 'G', 'T', 'N'] as const;
  const out = new Uint8Array(keys.length * 3);
  for (let i = 0; i < keys.length; i++) {
    const c = colors[keys[i]] ?? colors.N ?? { r: 0, g: 0, b: 0 };
    out[i * 3] = c.r & 255;
    out[i * 3 + 1] = c.g & 255;
    out[i * 3 + 2] = c.b & 255;
  }
  return out;
}

async function renderHilbertWasm(sequence: string, colors: Record<string, RGB>): Promise<HilbertWorkerResult> {
  const order = calculateOrder(sequence.length);
  const size = 1 << order;
  const totalPixels = size * size;
  const maxIdx = Math.min(sequence.length, totalPixels);

  const wasm = await getWasmCompute();
  const hilbertRgba = (wasm as unknown as { hilbert_rgba?: (seq: Uint8Array, order: number, colors: Uint8Array) => Uint8Array } | null)
    ?.hilbert_rgba;

  if (!wasm || typeof hilbertRgba !== 'function') {
    throw new Error('hilbert_rgba not available');
  }

  const seqBytes = textEncoder
    ? textEncoder.encode(sequence)
    : Uint8Array.from(sequence, (c) => c.charCodeAt(0) & 255);

  const palette = packColors(colors);
  const wasmBytes = hilbertRgba(seqBytes, order, palette);
  if (!wasmBytes || wasmBytes.byteLength === 0) {
    throw new Error('Empty buffer from hilbert_rgba');
  }

  // IMPORTANT: never transfer a view into WASM memory; copy into an owned buffer first.
  const owned = new Uint8ClampedArray(wasmBytes);

  return {
    order,
    size,
    buffer: owned,
    coverage: totalPixels > 0 ? maxIdx / totalPixels : 0,
  };
}

function renderCgr(sequence: string, k: number): CgrWorkerResult {
  if (typeof sequence !== 'string') {
    throw new Error('Invalid sequence: must be a string');
  }
  if (!Number.isFinite(k)) {
    throw new Error('Invalid k: must be a finite number');
  }

  // Guardrail: keep allocations bounded (2048^2 u32 = 16MB).
  const kInt = Math.max(0, Math.min(11, Math.floor(k)));
  const resolution = 2 ** kInt;
  const grid = new Uint32Array(resolution * resolution);
  let maxCount = 0;
  let totalPoints = 0;

  let x = 0.5;
  let y = 0.5;
  const seq = sequence.toUpperCase();

  for (let i = 0; i < seq.length; i++) {
    const char = seq[i];
    let cornerX: 0 | 1;
    let cornerY: 0 | 1;

    if (char === 'A') {
      cornerX = 0;
      cornerY = 0;
    } else if (char === 'T') {
      cornerX = 1;
      cornerY = 0;
    } else if (char === 'C') {
      cornerX = 0;
      cornerY = 1;
    } else if (char === 'G') {
      cornerX = 1;
      cornerY = 1;
    } else {
      continue;
    }

    x = (x + cornerX) / 2;
    y = (y + cornerY) / 2;

    if (i >= kInt - 1) {
      // Clamp independently to prevent row wrapping artifacts at x=1.0 or y=1.0
      const gridX = Math.min(Math.floor(x * resolution), resolution - 1);
      const gridY = Math.min(Math.floor(y * resolution), resolution - 1);
      const idx = gridY * resolution + gridX;

      const next = (grid[idx] += 1);
      if (next > maxCount) maxCount = next;
      totalPoints += 1;
    }
  }

  let entropy = 0;
  if (totalPoints > 0) {
    for (let i = 0; i < grid.length; i++) {
      const count = grid[i];
      if (count === 0) continue;
      const p = count / totalPoints;
      entropy -= p * Math.log2(p);
    }
  }

  return {
    grid,
    resolution,
    k: kInt,
    maxCount,
    totalPoints,
    entropy,
  };
}

async function renderCgrWasm(sequence: string, k: number): Promise<CgrWorkerResult> {
  const wasm = await getWasmCompute();
  const cgrCounts = (wasm as unknown as { cgr_counts?: (seq: Uint8Array, k: number) => unknown } | null)?.cgr_counts;
  if (!wasm || typeof cgrCounts !== 'function') {
    throw new Error('cgr_counts not available');
  }

  // Guardrail: keep allocations bounded, and keep k stable across JS/WASM paths.
  const kInt = Math.max(0, Math.min(11, Math.floor(k)));

  const seqBytes = textEncoder
    ? textEncoder.encode(sequence)
    : Uint8Array.from(sequence, (c) => c.charCodeAt(0) & 255);

  const result = cgrCounts(seqBytes, kInt);
  try {
    const r = result as {
      readonly counts: Uint32Array;
      readonly resolution: number;
      readonly k: number;
      readonly max_count: number;
      readonly total_points: number;
      readonly entropy: number;
    };

    if (!r.counts || r.counts.byteLength === 0 || r.resolution <= 0) {
      throw new Error('Empty result from cgr_counts');
    }

    return {
      grid: r.counts,
      resolution: r.resolution,
      k: r.k,
      maxCount: r.max_count,
      totalPoints: r.total_points,
      entropy: r.entropy,
    };
  } finally {
    // wasm-bindgen class instances must be freed to avoid leaking WASM memory.
    (result as { free?: () => void } | null)?.free?.();
  }
}

const api: HilbertWorkerAPI = {
  async render(sequence, colors) {
    try {
      // Prefer WASM for the hot mapping loop; fall back to JS on failure.
      const result = await renderHilbertWasm(sequence, colors).catch(() => renderHilbert(sequence, colors));

      // Validate buffer before transfer to prevent race condition with detached buffer
      if (!result.buffer || !result.buffer.buffer || result.buffer.buffer.byteLength === 0) {
        throw new Error('Invalid buffer generated');
      }

      // Only transfer if buffer is valid and not already detached
      const arrayBuffer = result.buffer.buffer;
      if (arrayBuffer.byteLength > 0) {
        return Comlink.transfer(result, [arrayBuffer]);
      }

      // Fallback: return without transfer if buffer is problematic
      return result;
    } catch (error) {
      // Do NOT return a success-shaped constant here. Returning
      // { order: 4, size: 16, coverage: 0 } made a failed computation render as
      // a real result: the overlay displayed "Curve order 4" and a blank image
      // with no indication that anything had gone wrong, and the caller's own
      // error handling could never fire. Propagate instead; Comlink forwards
      // the rejection to the caller, which already renders an error state.
      console.error('Hilbert render error:', error);
      throw new Error(
        `Hilbert curve render failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
  async renderCgr(sequence, k) {
    try {
      const result = await renderCgrWasm(sequence, k).catch(() => renderCgr(sequence, k));
      const arrayBuffer = result.grid.buffer;
      if (arrayBuffer.byteLength > 0) {
        return Comlink.transfer(result, [arrayBuffer]);
      }
      return result;
    } catch (error) {
      // Same reasoning as renderHilbert: a zeroed result rendered as
      // "Shannon entropy 0.000" over an empty plot, which reads as a real
      // measurement rather than a failure. The CGR overlay already catches and
      // shows an error state (CGROverlay.tsx), so let the rejection reach it.
      console.error('CGR render error:', error);
      throw new Error(
        `CGR render failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

Comlink.expose(api);
