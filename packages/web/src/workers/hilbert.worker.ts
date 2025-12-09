/// <reference lib="webworker" />

import * as Comlink from 'comlink';

type RGB = { r: number; g: number; b: number };

export interface HilbertWorkerResult {
  order: number;
  size: number;
  buffer: Uint8ClampedArray;
  coverage: number;
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
  return Math.min(Math.max(order, 4), 12);
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
  render(sequence: string, colors: Record<string, RGB>): HilbertWorkerResult;
}

const api: HilbertWorkerAPI = {
  render(sequence, colors) {
    try {
      const result = renderHilbert(sequence, colors);

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
      console.error('Hilbert render error:', error);
      // Return empty result on error rather than crashing
      return {
        order: 4,
        size: 16,
        buffer: new Uint8ClampedArray(16 * 16 * 4),
        coverage: 0,
      };
    }
  },
};

Comlink.expose(api);

