import { describe, expect, it } from 'bun:test';
import { computeHilbertGC, generateHilbertPoints, hilbertD2XY } from './hilbert';

describe('Hilbert curve', () => {
  it('hilbertD2XY > order=1 matches expected 2x2 traversal', () => {
    expect(hilbertD2XY(1, 0)).toEqual({ x: 0, y: 0 });
    expect(hilbertD2XY(1, 1)).toEqual({ x: 0, y: 1 });
    expect(hilbertD2XY(1, 2)).toEqual({ x: 1, y: 1 });
    expect(hilbertD2XY(1, 3)).toEqual({ x: 1, y: 0 });
  });

  it('generateHilbertPoints > returns interleaved coordinates', () => {
    const pts = generateHilbertPoints(4, 1);
    expect(Array.from(pts)).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
  });

  it('computeHilbertGC > sparse mapping assigns 0/1 for A/T vs G/C', () => {
    const { grid, size } = computeHilbertGC('ACGT', 1);
    expect(size).toBe(2);
    expect(Array.from(grid)).toEqual([0, 0, 1, 1]);
  });

  it('computeHilbertGC > binning mode averages multiple bases per cell', () => {
    const { grid, size } = computeHilbertGC('GGGGAAAA', 1);
    expect(size).toBe(2);
    expect(Array.from(grid)).toEqual([1, 0, 1, 0]);
  });
});

