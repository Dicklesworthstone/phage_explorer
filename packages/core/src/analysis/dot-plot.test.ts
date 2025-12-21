import { describe, expect, it } from 'bun:test';
import { computeDotPlot } from './dot-plot';

describe('Dot plot', () => {
  it('computeDotPlot > empty sequence returns empty grid', () => {
    expect(computeDotPlot('')).toEqual({ grid: [], bins: 0, window: 0 });
  });

  it('computeDotPlot > produces bins x bins grid with expected direct/inverted identities', () => {
    // With explicit window=2, bins=2:
    // bin0 window = "AC", bin1 window = "GT"
    // reverseComplement("AC") = "GT"
    // reverseComplement("GT") = "AC"
    const result = computeDotPlot('ACGT', { bins: 2, window: 2 });
    expect(result.bins).toBe(2);
    expect(result.window).toBe(2);
    expect(result.grid).toHaveLength(2);
    expect(result.grid[0]).toHaveLength(2);
    expect(result.grid[1]).toHaveLength(2);

    expect(result.grid[0]![0]).toEqual({ direct: 1, inverted: 0 });
    expect(result.grid[0]![1]).toEqual({ direct: 0, inverted: 1 });
    expect(result.grid[1]![0]).toEqual({ direct: 0, inverted: 1 });
    expect(result.grid[1]![1]).toEqual({ direct: 1, inverted: 0 });
  });
});

