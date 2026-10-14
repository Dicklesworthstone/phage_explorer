/**
 * Self-homology dot plot computation. Scores use the full window denominator.
 * `ambiguity: 'literal'` (the existing low-level/WASM contract) compares symbols,
 * including IUPAC complements. `ambiguity: 'exclude'` measures resolved A/C/G/T
 * matches only: unknown bases keep their coordinates but never add evidence.
 * Scientific displays should explicitly choose the latter interpretation.
 * Resolved DNA uses exact 32-position bit-parallel counts. Literal non-ACGT
 * symbols retain their scalar matching contract; neither path samples bases.
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

/** Row-major worker output. Rounding occurs only when writing Float32 values,
 * exactly as in the existing grid-to-transfer-buffer adapter.
 */
export interface DotPlotBuffers {
  directValues: Float32Array;
  invertedValues: Float32Array;
  bins: number;
  window: number;
}

type WriteCell = (row: number, column: number, direct: number, inverted: number) => void;
interface DotPlotPlan { sequence: string; literal: boolean; bins: number; window: number }

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

interface PackedBases {
  low: Uint32Array;
  high: Uint32Array;
  valid: Uint32Array;
}

function packedBases(words: number): PackedBases {
  return { low: new Uint32Array(words), high: new Uint32Array(words), valid: new Uint32Array(words) };
}

/** Equality in two bit planes compares 32 bases at once. The validity plane
 * keeps unknown positions in the denominator without counting them as A.
 */
function packSequence(sequence: string): { forward: PackedBases; reverse: PackedBases } {
  // One zero sentinel permits unaligned reads of the final partial word.
  const words = Math.ceil(sequence.length / 32) + 1;
  const forward = packedBases(words);
  const reverse = packedBases(words);
  for (let i = 0; i < sequence.length; i++) {
    let code: number;
    switch (sequence.charCodeAt(i)) {
      case 65: case 97: code = 0; break;
      case 67: case 99: code = 1; break;
      case 71: case 103: code = 2; break;
      case 84: case 116: code = 3; break;
      default: continue;
    }
    const word = i >>> 5;
    const bit = 1 << (i & 31);
    forward.low[word] |= (code & 1) ? bit : 0;
    forward.high[word] |= (code & 2) ? bit : 0;
    forward.valid[word] |= bit;
    const reversed = sequence.length - 1 - i;
    const reverseWord = reversed >>> 5;
    const reverseBit = 1 << (reversed & 31);
    reverse.low[reverseWord] |= (code & 1) ? 0 : reverseBit;
    reverse.high[reverseWord] |= (code & 2) ? 0 : reverseBit;
    reverse.valid[reverseWord] |= reverseBit;
  }
  return { forward, reverse };
}

function readPackedWord(plane: Uint32Array, word: number, shift: number): number {
  // JS masks shift counts modulo 32, so aligned reads need a separate branch.
  return shift === 0 ? plane[word] : (plane[word] >>> shift) | (plane[word + 1] << (32 - shift));
}

function countBits(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  value = (value + (value >>> 4)) & 0x0f0f0f0f;
  return Math.imul(value, 0x01010101) >>> 24;
}

/** O(sequence length + bins^2 * ceil(window / 32)) work, O(sequence length)
 * packed storage. Align only the current row, not bins copies of the genome.
 */
function computePackedDotPlot(sequence: string, starts: readonly number[], window: number, write: WriteCell): void {
  const { forward, reverse } = packSequence(sequence);
  const words = Math.ceil(window / 32);
  const row = packedBases(words);
  const reverseRow = packedBases(words);
  const tailMask = window % 32 === 0 ? -1 : -1 >>> (32 - window % 32);
  const bins = starts.length;
  for (let i = 0; i < bins; i++) {
    const start = starts[i];
    const reverseStart = sequence.length - start - window;
    for (let k = 0; k < words; k++) {
      const word = (start >>> 5) + k;
      const reverseWord = (reverseStart >>> 5) + k;
      row.low[k] = readPackedWord(forward.low, word, start & 31);
      row.high[k] = readPackedWord(forward.high, word, start & 31);
      row.valid[k] = readPackedWord(forward.valid, word, start & 31);
      reverseRow.low[k] = readPackedWord(reverse.low, reverseWord, reverseStart & 31);
      reverseRow.high[k] = readPackedWord(reverse.high, reverseWord, reverseStart & 31);
      reverseRow.valid[k] = readPackedWord(reverse.valid, reverseWord, reverseStart & 31);
    }
    row.valid[words - 1] &= tailMask;
    reverseRow.valid[words - 1] &= tailMask;
    for (let j = i; j < bins; j++) {
      const shift = starts[j] & 31;
      const startWord = starts[j] >>> 5;
      let directMatches = 0;
      let invertedMatches = 0;
      for (let k = 0; k < words; k++) {
        const low = readPackedWord(forward.low, startWord + k, shift);
        const high = readPackedWord(forward.high, startWord + k, shift);
        const valid = readPackedWord(forward.valid, startWord + k, shift);
        directMatches += countBits(~((row.low[k] ^ low) | (row.high[k] ^ high)) & row.valid[k] & valid);
        invertedMatches += countBits(~((reverseRow.low[k] ^ low) | (reverseRow.high[k] ^ high)) & reverseRow.valid[k] & valid);
      }
      const direct = directMatches / window;
      const inverted = invertedMatches / window;
      write(i, j, direct, inverted);
    }
  }
}

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

function prepareDotPlot(sequence: string, config: DotPlotConfig): DotPlotPlan {
  if (sequence.length === 0) return { sequence, literal: true, bins: 0, window: 0 };

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
  return { sequence: seq, literal, bins, window };
}

function runDotPlot(plan: DotPlotPlan, write: WriteCell): void {
  const { sequence, bins, window, literal } = plan;
  if (bins === 0) return;
  // Multiple bins may describe the same window, especially when a large
  // requested window is clamped to the genome. Compute each distinct pair
  // once, but still emit independent cells at the requested resolution.
  const starts: number[] = [];
  const boundaries: number[] = [];
  for (let i = 0; i < bins; i++) {
    const start = getDotPlotWindowRange(sequence.length, bins, window, i).start;
    if (start !== starts[starts.length - 1]) {
      starts.push(start);
      boundaries.push(i);
    }
  }
  boundaries.push(bins);
  const emit: WriteCell = starts.length === bins ? (i, j, direct, inverted) => {
    write(i, j, direct, inverted);
    if (i !== j) write(j, i, direct, inverted);
  } : (i, j, direct, inverted) => {
    for (let row = boundaries[i]; row < boundaries[i + 1]; row++) {
      for (let column = boundaries[j]; column < boundaries[j + 1]; column++) {
        write(row, column, direct, inverted);
        if (i !== j) write(column, row, direct, inverted);
      }
    }
  };
  // Short windows do not amortize packing. Literal ambiguity/Unicode remains
  // on the original symbol-comparison path rather than changing its meaning.
  // Sparse samples also need not encode an entire, otherwise unused genome.
  const scalarWork = starts.length * (starts.length + 1) / 2 * window;
  if (window >= 32 && starts.length > 1 && scalarWork > sequence.length && (!literal || !/[^ACGT]/.test(sequence))) {
    computePackedDotPlot(sequence, starts, window, emit);
  } else {
    computeScalarDotPlot(sequence, starts, window, literal, emit);
  }
}

export function computeDotPlot(sequence: string, config: DotPlotConfig = {}): DotPlotResult {
  const plan = prepareDotPlot(sequence, config);
  const grid: DotCell[][] = Array.from({ length: plan.bins }, () => new Array<DotCell>(plan.bins));
  runDotPlot(plan, (i, j, direct, inverted) => { grid[i][j] = { direct, inverted }; });
  return { grid, bins: plan.bins, window: plan.window };
}

/** Compute directly into transferable arrays instead of allocating a matrix
 * of objects and then copying it. The grid API retains full Number precision.
 */
export function computeDotPlotBuffers(sequence: string, config: DotPlotConfig = {}): DotPlotBuffers {
  const plan = prepareDotPlot(sequence, config);
  const directValues = new Float32Array(plan.bins * plan.bins);
  const invertedValues = new Float32Array(plan.bins * plan.bins);
  runDotPlot(plan, (i, j, direct, inverted) => {
    const index = i * plan.bins + j;
    directValues[index] = direct;
    invertedValues[index] = inverted;
  });
  return { directValues, invertedValues, bins: plan.bins, window: plan.window };
}

/** Keep the small-window/literal hot loop separate from packed dispatch. */
function computeScalarDotPlot(seq: string, starts: readonly number[], window: number, literal: boolean, write: WriteCell): void {
  const len = seq.length;
  const bins = starts.length;
  const sparse = bins * window < len;
  const size = sparse ? bins * window : len;
  const bases = new Uint16Array(size);
  const complements = new Uint16Array(size);
  const offsets = sparse ? starts.map((_, i) => i * window) : starts;
  const ranges = sparse ? starts.map((start, i) => ({ start, end: start + window, target: i * window }))
    : [{ start: 0, end: len, target: 0 }];
  for (const range of ranges) {
    for (let position = range.start; position < range.end; position++) {
      const i = range.target + position - range.start;
      if (literal) {
        bases[i] = seq.charCodeAt(position);
        complements[i] = (COMPLEMENTS[seq[position]] ?? seq[position]).charCodeAt(0);
      } else {
        let code = 4;
        switch (seq.charCodeAt(position)) {
          case 65: case 97: code = 0; break;
          case 67: case 99: code = 1; break;
          case 71: case 103: code = 2; break;
          case 84: case 116: code = 3; break;
        }
        bases[i] = code;
        complements[i] = code < 4 ? code ^ 3 : 4;
      }
    }
  }

  for (let i = 0; i < bins; i++) {
    const start = offsets[i];
    const reverseEnd = start + window - 1;
    for (let j = i; j < bins; j++) {
      const otherStart = offsets[j];
      let directMatches = 0;
      let invertedMatches = 0;
      // Keep the policy branch outside the per-base loop. Literal symbols
      // require equality only; resolved evidence additionally needs validity.
      if (literal) {
        for (let k = 0; k < window; k++) {
          const b = bases[otherStart + k];
          if (bases[start + k] === b) directMatches++;
          if (complements[reverseEnd - k] === b) invertedMatches++;
        }
      } else {
        for (let k = 0; k < window; k++) {
          const a = bases[start + k];
          const b = bases[otherStart + k];
          const reverseA = complements[reverseEnd - k];
          if (a < 4 && a === b) directMatches++;
          if (reverseA < 4 && reverseA === b) invertedMatches++;
        }
      }
      const direct = directMatches / window;
      const inverted = invertedMatches / window;
      write(i, j, direct, inverted);
    }
  }
}
