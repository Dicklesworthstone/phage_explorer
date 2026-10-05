/**
 * Self-homology dot plot computation.
 *
 * Downsamples the genome into bins and compares equally sized windows in
 * direct and reverse-complement orientations. Scores are resolved A/C/G/T
 * matches divided by the full window length, NOT identity conditional on
 * observed bases. Unknown bases retain their coordinates but never match.
 *
 * Designed to be light enough for TUI rendering (O(bins^2 * window)).
 */

export interface DotCell {
  direct: number;   // 0..1 resolved matches / window length
  inverted: number; // 0..1 resolved reverse-complement matches / window length
}

export interface DotPlotResult {
  grid: DotCell[][];
  bins: number;
  window: number;
}

export interface DotPlotConfig {
  bins?: number;      // integer resolution, 1..1024 (default 120)
  window?: number;    // positive integer window size (default max(20, seqLen / bins))
}

export function computeDotPlot(sequence: string, config: DotPlotConfig = {}): DotPlotResult {
  if (sequence.length === 0) {
    return { grid: [], bins: 0, window: 0 };
  }

  const bins = config.bins ?? 120;
  // A quadratic matrix must have a bounded, integral dimension. Reject bad
  // parameters before allocating rather than returning partial/NaN results.
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > 1024) {
    throw new RangeError('Dot plot bins must be an integer between 1 and 1024');
  }
  if (config.window !== undefined && (!Number.isSafeInteger(config.window) || config.window < 1)) {
    throw new RangeError('Dot plot window must be a positive integer');
  }

  const len = sequence.length;
  const window = Math.min(len, config.window ?? Math.max(20, Math.floor(len / bins) || len));

  // Encode once without filtering or Unicode uppercasing: either can move
  // downstream coordinates. Codes 0..3 complement via XOR 3; 4 is unobserved.
  const bases = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    switch (sequence.charCodeAt(i)) {
      case 65: case 97: bases[i] = 0; break;  // A/a
      case 67: case 99: bases[i] = 1; break;  // C/c
      case 71: case 103: bases[i] = 2; break; // G/g
      case 84: case 116: bases[i] = 3; break; // T/t
      default: bases[i] = 4;
    }
  }

  // First window starts at 0; last starts at len-window, not len-len/bins.
  const step = bins > 1 ? (len - window) / (bins - 1) : 0;
  const starts = Array.from({ length: bins }, (_, i) => Math.floor(i * step));
  const grid: DotCell[][] = Array.from({ length: bins }, () => new Array<DotCell>(bins));

  for (let i = 0; i < bins; i++) {
    for (let j = i; j < bins; j++) {
      let directMatches = 0;
      let invertedMatches = 0;
      for (let k = 0; k < window; k++) {
        const a = bases[starts[i] + k];
        const b = bases[starts[j] + k];
        const reverseA = bases[starts[i] + window - 1 - k];
        if (a < 4 && a === b) directMatches++;
        if (reverseA < 4 && (reverseA ^ 3) === b) invertedMatches++;
      }
      const direct = directMatches / window;
      const inverted = invertedMatches / window;
      grid[i][j] = { direct, inverted };
      if (i !== j) grid[j][i] = { direct, inverted };
    }
  }

  return { grid, bins, window };
}
