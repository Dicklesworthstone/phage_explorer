/**
 * Self-homology dot plot computation. Scores use the full window denominator.
 * `ambiguity: 'literal'` (the existing low-level/WASM contract) compares symbols,
 * including IUPAC complements. `ambiguity: 'exclude'` measures resolved A/C/G/T
 * matches only: unknown bases keep their coordinates but never add evidence.
 * Scientific displays should explicitly choose the latter interpretation.
 * Complexity is O(bins^2 * window).
 */

export interface DotCell {
  direct: number;   // 0..1 matches / full window length
  inverted: number; // 0..1 reverse-complement matches / full window length
}

export interface DotPlotResult {
  grid: DotCell[][];
  bins: number;
  window: number;
}

export interface DotPlotConfig {
  bins?: number;      // integer resolution, 1..1024 (default 120)
  window?: number;    // positive integer window size (default max(20, seqLen / bins))
  ambiguity?: 'literal' | 'exclude'; // default literal; exclude for resolved DNA evidence
}

// Uppercase complements, including IUPAC symbols, for literal-symbol matching.
const COMPLEMENTS: Readonly<Record<string, string>> = {
  A: 'T', T: 'A', G: 'C', C: 'G', N: 'N', R: 'Y', Y: 'R', S: 'S', W: 'W',
  K: 'M', M: 'K', B: 'V', D: 'H', H: 'D', V: 'B',
};

/** The actual sampled window, in 0-based, half-open sequence coordinates. */
export function getDotPlotWindowRange(
  sequenceLength: number, bins: number, window: number, binIndex: number
): { start: number; end: number } {
  if (!Number.isSafeInteger(sequenceLength) || sequenceLength < 1
      || !Number.isSafeInteger(bins) || bins < 1 || bins > 1024
      || !Number.isSafeInteger(window) || window < 1 || window > sequenceLength
      || !Number.isSafeInteger(binIndex) || binIndex < 0 || binIndex >= bins) {
    throw new RangeError('Invalid dot plot window coordinates');
  }
  const step = bins > 1 ? (sequenceLength - window) / (bins - 1) : 0;
  const start = Math.min(sequenceLength - window, Math.floor(binIndex * step));
  return { start, end: start + window };
}

export function computeDotPlot(sequence: string, config: DotPlotConfig = {}): DotPlotResult {
  if (sequence.length === 0) return { grid: [], bins: 0, window: 0 };

  const bins = config.bins ?? 120;
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > 1024) {
    throw new RangeError('Dot plot bins must be an integer between 1 and 1024');
  }
  if (config.window !== undefined && (!Number.isSafeInteger(config.window) || config.window < 1)) {
    throw new RangeError('Dot plot window must be a positive integer');
  }
  const ambiguity = config.ambiguity ?? 'literal';
  if (ambiguity !== 'literal' && ambiguity !== 'exclude') {
    throw new RangeError('Dot plot ambiguity must be literal or exclude');
  }
  const literal = ambiguity === 'literal';
  // Preserve the literal API's case normalization. Resolved evidence never
  // filters or Unicode-uppercases the input: either can move coordinates.
  const seq = literal ? sequence.toUpperCase() : sequence;
  const len = seq.length;
  const window = Math.min(len, config.window ?? Math.max(20, Math.floor(len / bins) || len));
  const bases = new Uint16Array(len);
  const complements = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    if (literal) {
      bases[i] = seq.charCodeAt(i);
      complements[i] = (COMPLEMENTS[seq[i]] ?? seq[i]).charCodeAt(0);
    } else {
      let code = 4;
      switch (seq.charCodeAt(i)) {
        case 65: case 97: code = 0; break;
        case 67: case 99: code = 1; break;
        case 71: case 103: code = 2; break;
        case 84: case 116: code = 3; break;
      }
      bases[i] = code;
      complements[i] = code < 4 ? code ^ 3 : 4;
    }
  }

  const starts = Array.from({ length: bins }, (_, i) => getDotPlotWindowRange(len, bins, window, i).start);
  const grid: DotCell[][] = Array.from({ length: bins }, () => new Array<DotCell>(bins));
  for (let i = 0; i < bins; i++) {
    for (let j = i; j < bins; j++) {
      let directMatches = 0;
      let invertedMatches = 0;
      for (let k = 0; k < window; k++) {
        const a = bases[starts[i] + k];
        const b = bases[starts[j] + k];
        const reverseA = complements[starts[i] + window - 1 - k];
        if ((literal || a < 4) && a === b) directMatches++;
        if ((literal || reverseA < 4) && reverseA === b) invertedMatches++;
      }
      const direct = directMatches / window;
      const inverted = invertedMatches / window;
      grid[i][j] = { direct, inverted };
      if (i !== j) grid[j][i] = { direct, inverted };
    }
  }
  return { grid, bins, window };
}
