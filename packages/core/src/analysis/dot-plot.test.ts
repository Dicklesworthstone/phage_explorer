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

  it('does not invent direct or inverted matches from unresolved bases', () => {
    for (const sequence of ['NNNN', 'RYRY', 'SSWW', '----', 'uuuu', '????']) {
      const result = computeDotPlot(sequence, { bins: 3, window: 2 });
      for (const row of result.grid) {
        for (const cell of row) expect(cell).toEqual({ direct: 0, inverted: 0 });
      }
    }
  });

  it('keeps unresolved positions in the denominator and preserves lowercase matches', () => {
    // AN vs NT: the direct diagonal has one observed base out of two;
    // RC(AN) vs NT has one resolved complementary match, not two N matches.
    const result = computeDotPlot('anNt', { bins: 2, window: 2 });
    expect(result.grid[0]![0]).toEqual({ direct: 0.5, inverted: 0 });
    expect(result.grid[0]![1]).toEqual({ direct: 0, inverted: 0.5 });
    expect(result.grid[1]![0]).toEqual(result.grid[0]![1]);
    expect(result.grid[1]![1]).toEqual({ direct: 0.5, inverted: 0 });
  });

  it('uses overlapping windows including the terminal base without compressing unknowns', () => {
    // Starts 0,1,2,3: AC, CN, NG, GT. The middle windows are not CG.
    const result = computeDotPlot('ACNGT', { bins: 4, window: 2 });
    expect(result.grid[0]![3]).toEqual({ direct: 0, inverted: 1 });
    expect(result.grid[1]![1].direct).toBe(0.5);
    expect(result.grid[2]![2].direct).toBe(0.5);
    expect(result.grid[1]![2].inverted).toBe(0.5);
  });

  it('preserves coordinates for non-ASCII input rather than expanding uppercase characters', () => {
    // Uppercasing the entire input would expand ß into SS and shift the last window.
    const result = computeDotPlot('AßT', { bins: 3, window: 1 });
    expect(result.grid[0]![2].inverted).toBe(1);
    expect(result.grid[1]![1]).toEqual({ direct: 0, inverted: 0 });
  });

  it('supports a single bin and clamps oversized windows to the full sequence', () => {
    expect(computeDotPlot('ACGT', { bins: 1, window: 100 })).toEqual({
      bins: 1, window: 4, grid: [[{ direct: 1, inverted: 1 }]],
    });
    const short = computeDotPlot('a', { bins: 3 });
    expect(short.window).toBe(1);
    for (const row of short.grid) {
      for (const cell of row) expect(cell).toEqual({ direct: 1, inverted: 0 });
    }
  });

  it('rejects invalid or unbounded dimensions before allocating a matrix', () => {
    for (const bins of [0, -1, 1.5, NaN, Infinity, 1025, Number.MAX_SAFE_INTEGER]) {
      expect(() => computeDotPlot('ACGT', { bins })).toThrow(RangeError);
    }
    for (const window of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => computeDotPlot('ACGT', { window })).toThrow(RangeError);
    }
  });

  it('agrees with an independent literal-window oracle for all 625 A/C/G/T/N four-mers', () => {
    const alphabet = 'ACGTN';
    const complement: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A' };
    for (let code = 0; code < 625; code++) {
      let n = code;
      let sequence = '';
      for (let k = 0; k < 4; k++) {
        sequence += alphabet[n % 5];
        n = Math.floor(n / 5);
      }
      // Three length-two windows have independently known starts 0, 1, 2.
      const windows = [sequence.slice(0, 2), sequence.slice(1, 3), sequence.slice(2, 4)];
      const result = computeDotPlot(sequence, { bins: 3, window: 2 });
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const a = windows[i];
          const b = windows[j];
          let direct = 0;
          let inverted = 0;
          for (let k = 0; k < 2; k++) {
            if (complement[a[k]] && a[k] === b[k]) direct++;
            if (complement[a[1 - k]] === b[k]) inverted++;
          }
          expect(result.grid[i]![j]).toEqual({ direct: direct / 2, inverted: inverted / 2 });
        }
      }
    }
  });
});
