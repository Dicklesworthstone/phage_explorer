/**
 * Self-homology dot plot computation. Scores use the full window denominator.
 * `ambiguity: 'literal'` (the existing low-level/WASM contract) compares symbols,
 * including IUPAC complements. `ambiguity: 'exclude'` measures resolved A/C/G/T
 * matches only: unknown bases keep their coordinates but never add evidence.
 * Scientific displays should explicitly choose the latter interpretation.
 * Resolved DNA uses exact 32-position bit-parallel counts. Literal non-ACGT
 * symbols retain their scalar matching contract; neither path samples bases.
 */

import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';

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
function computePackedDotPlot(sequence: string, starts: readonly number[], window: number, write: WriteCell,
  otherSequence?: string, otherStarts: readonly number[] = starts): void {
  const { forward, reverse } = packSequence(sequence);
  const target = otherSequence === undefined ? forward : packSequence(otherSequence).forward;
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
    for (let j = otherSequence === undefined ? i : 0; j < otherStarts.length; j++) {
      const shift = otherStarts[j] & 31;
      const startWord = otherStarts[j] >>> 5;
      let directMatches = 0;
      let invertedMatches = 0;
      for (let k = 0; k < words; k++) {
        const low = readPackedWord(target.low, startWord + k, shift);
        const high = readPackedWord(target.high, startWord + k, shift);
        const valid = readPackedWord(target.valid, startWord + k, shift);
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
function scalarWindows(seq: string, starts: readonly number[], window: number, literal: boolean) {
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

  return { bases, complements, offsets };
}

/** The same encoder and counting contract serve both self and cross-genome plots. */
function computeScalarDotPlot(seq: string, starts: readonly number[], window: number, literal: boolean, write: WriteCell,
  otherSequence?: string, otherStarts: readonly number[] = starts): void {
  const { bases, complements, offsets } = scalarWindows(seq, starts, window, literal);
  const target = otherSequence === undefined ? { bases, offsets } : scalarWindows(otherSequence, otherStarts, window, literal);
  for (let i = 0; i < starts.length; i++) {
    const start = offsets[i];
    const reverseEnd = start + window - 1;
    for (let j = otherSequence === undefined ? i : 0; j < otherStarts.length; j++) {
      const otherStart = target.offsets[j];
      let directMatches = 0;
      let invertedMatches = 0;
      // Keep the policy branch outside the per-base loop. Literal symbols
      // require equality only; resolved evidence additionally needs validity.
      if (literal) {
        for (let k = 0; k < window; k++) {
          const b = target.bases[otherStart + k];
          if (bases[start + k] === b) directMatches++;
          if (complements[reverseEnd - k] === b) invertedMatches++;
        }
      } else {
        for (let k = 0; k < window; k++) {
          const a = bases[start + k];
          const b = target.bases[otherStart + k];
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

export interface PairwiseDotPlotBuffers extends DotPlotBuffers {
  /** Counts, not scores: a cross-genome diagonal is not input coverage. */
  rowResolvedPerWindow: number[];
  columnResolvedPerWindow: number[];
}

function sampledWindowGroups(length: number, bins: number, window: number) {
  const starts: number[] = [], boundaries: number[] = [];
  for (let i = 0; i < bins; i++) {
    const start = getDotPlotWindowRange(length, bins, window, i).start;
    if (start !== starts[starts.length - 1]) { starts.push(start); boundaries.push(i); }
  }
  boundaries.push(bins);
  return { starts, boundaries };
}

/** Sliding counts visit only covered positions and preserve ambiguity coordinates. */
function resolvedWindowCounts(sequence: string, bins: number, window: number): number[] {
  const counts: number[] = [];
  let previousStart = 0, previousEnd = 0, count = 0;
  const resolved = (i: number) => {
    const code = sequence.charCodeAt(i) | 32;
    return code === 97 || code === 99 || code === 103 || code === 116 ? 1 : 0;
  };
  for (let i = 0; i < bins; i++) {
    const { start, end } = getDotPlotWindowRange(sequence.length, bins, window, i);
    for (let p = previousStart; p < Math.min(start, previousEnd); p++) count -= resolved(p);
    for (let p = Math.max(start, previousEnd); p < end; p++) count += resolved(p);
    counts.push(count); previousStart = start; previousEnd = end;
  }
  return counts;
}

/** Compare ordered, independently sampled genome axes. Unlike a self plot the
 * matrix is not generally symmetric. The common window fits BOTH sequences;
 * all positions in it remain in the denominator, including unresolved bases.
 */
export function computePairwiseDotPlotBuffers(rowSequence: string, columnSequence: string,
  config: DotPlotConfig = {}): PairwiseDotPlotBuffers {
  if (config.ambiguity !== undefined && config.ambiguity !== 'exclude') {
    throw new RangeError('Pairwise dot plots require resolved-base scoring.');
  }
  const length = Math.min(rowSequence.length, columnSequence.length);
  if (length === 0) return { bins: 0, window: 0, directValues: new Float32Array(), invertedValues: new Float32Array(),
    rowResolvedPerWindow: [], columnResolvedPerWindow: [] };
  const { bins } = prepareDotPlot(rowSequence, { ...config, ambiguity: 'exclude' });
  const window = Math.min(length, config.window ?? Math.max(20, Math.floor(length / bins)));
  const rows = sampledWindowGroups(rowSequence.length, bins, window);
  const columns = sampledWindowGroups(columnSequence.length, bins, window);
  const directValues = new Float32Array(bins * bins), invertedValues = new Float32Array(bins * bins);
  const emit: WriteCell = (i, j, direct, inverted) => {
    for (let row = rows.boundaries[i]; row < rows.boundaries[i + 1]; row++) {
      for (let col = columns.boundaries[j]; col < columns.boundaries[j + 1]; col++) {
        directValues[row * bins + col] = direct;
        invertedValues[row * bins + col] = inverted;
      }
    }
  };
  const scalarWork = rows.starts.length * columns.starts.length * window;
  if (window >= 32 && scalarWork > rowSequence.length + columnSequence.length) {
    computePackedDotPlot(rowSequence, rows.starts, window, emit, columnSequence, columns.starts);
  } else {
    computeScalarDotPlot(rowSequence, rows.starts, window, false, emit, columnSequence, columns.starts);
  }
  return { bins, window, directValues, invertedValues,
    rowResolvedPerWindow: resolvedWindowCounts(rowSequence, bins, window),
    columnResolvedPerWindow: resolvedWindowCounts(columnSequence, bins, window) };
}

// Portable experiments use the viewer's full resolution range. The low-level
// matrix APIs keep their existing 1024-bin contract; an export never silently
// reduces it to fit the shared AnalysisRecord size budget.
export const DOT_PLOT_EXPERIMENT_LIMITS = { bases: 5_000_000, bins: 200 } as const;
export const DOT_PLOT_METHOD = {
  id: 'sequence-dot-plot', version: '1',
  implementation: 'TypeScript exact resolved-window comparisons with Float32 matrix output',
};
const DOT_PLOT_REFERENCES = [{
  id: 'bundled-resolved-dot-plot', version: '1',
  description: 'Sampled linear windows; resolved A/C/G/T matches divided by full window length. No external biological reference.',
}];

export interface DotPlotExperimentInput {
  sequence: string;
  accession: string | null;
  source: 'catalog' | 'local';
}
export interface DotPlotExperiment extends DotPlotBuffers { record: AnalysisRecord }

function snapshotDotPlotInput(input: DotPlotExperimentInput): DotPlotExperimentInput {
  const { sequence, accession, source } = input;
  if (typeof sequence !== 'string' || sequence.length < 1 || sequence.length > DOT_PLOT_EXPERIMENT_LIMITS.bases
      || /[^ACGTURYSWKMBDHVN]/i.test(sequence)) {
    throw new Error('Dot plot experiments require 1–5,000,000 exact IUPAC nucleotide symbols.');
  }
  if (!/[ACGT]/i.test(sequence)) throw new Error('No resolved A/C/G/T bases available for dot plot.');
  if (!['catalog', 'local'].includes(source) || !(accession === null
      || typeof accession === 'string' && accession.trim().length > 0 && accession.length <= 2000)) {
    throw new Error('Dot plot experiments require local or catalog input identity.');
  }
  return { sequence, accession, source };
}

function dotPlotExperimentConfig(sequenceLength: number, config: DotPlotConfig): Required<DotPlotConfig> {
  if (Object.keys(config).some(key => !['bins', 'window', 'ambiguity'].includes(key))) {
    throw new Error('Unsupported dot plot experiment parameters.');
  }
  const bins = config.bins ?? 120;
  const window = config.window ?? Math.min(sequenceLength, Math.max(20, Math.floor(sequenceLength / bins)));
  if (!Number.isSafeInteger(bins) || bins < 1 || bins > DOT_PLOT_EXPERIMENT_LIMITS.bins
      || !Number.isSafeInteger(window) || window < 1 || window > sequenceLength
      || config.ambiguity !== undefined && config.ambiguity !== 'exclude') {
    throw new Error('Dot plot experiments support 1–200 bins, an in-bounds positive window, and resolved-base scoring only.');
  }
  return { bins, window, ambiguity: 'exclude' };
}

const dotPlotJsonEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));

/**
 * Recompute before creating a portable result. Supplying the displayed matrix
 * also verifies that the exported experiment represents exactly what was seen,
 * rather than quietly replacing a preview, another input or a divergent backend.
 * No network, filesystem or browser globals are used; run in a worker for cancel.
 */
export async function createDotPlotExperiment(
  input: DotPlotExperimentInput, config: DotPlotConfig = {}, displayed?: DotPlotBuffers,
): Promise<DotPlotExperiment> {
  const source = snapshotDotPlotInput(input);
  const parameters = dotPlotExperimentConfig(source.sequence.length, config);
  const result = computeDotPlotBuffers(source.sequence, parameters);
  if (displayed && (displayed.bins !== result.bins || displayed.window !== result.window
      || !(displayed.directValues instanceof Float32Array) || !(displayed.invertedValues instanceof Float32Array)
      || displayed.directValues.length !== result.directValues.length || displayed.invertedValues.length !== result.invertedValues.length
      || !result.directValues.every((value, i) => value === displayed.directValues[i])
      || !result.invertedValues.every((value, i) => value === displayed.invertedValues[i]))) {
    throw new Error('Displayed dot plot differs from the exact recomputation. Rerun the analysis before exporting.');
  }
  let resolved = 0;
  for (let i = 0; i < source.sequence.length; i++) {
    const code = source.sequence.charCodeAt(i) | 32;
    if (code === 97 || code === 99 || code === 103 || code === 116) resolved++;
  }
  const coverage = { available: resolved, total: source.sequence.length, unit: 'bases' as const };
  const windows = Array.from({ length: result.bins }, (_, i) =>
    getDotPlotWindowRange(source.sequence.length, result.bins, result.window, i));
  // The diagonal is resolved_count/window. With at most 5M bases, Float32
  // rounding changes the recovered count by less than 0.15, so round is exact.
  const resolvedPerWindow = windows.map((_, i) => Math.round(result.directValues[i * result.bins + i] * result.window));
  const limitations = [
    'Row-major Float32 scores use the full window denominator. U and ambiguity symbols retain their coordinates but never count as matches.',
    'Sampled linear windows can overlap or skip bases. Similarity is not an exact alignment, exhaustive repeat call or biological mechanism.',
  ];
  const record = await createAnalysisRecord({
    method: DOT_PLOT_METHOD,
    inputs: [{ id: 'sequence', accession: source.accession, source: source.source,
      description: 'Exact nucleotide string supplied to the dot plot; SHA-256 identifies its canonical JSON encoding.', data: source.sequence }],
    parameters: { ...parameters }, seed: null, references: DOT_PLOT_REFERENCES,
    fields: {
      windows: { label: 'Sampled windows on both matrix axes', kind: 'sequence-score', units: 'records',
        value: analysisJson(windows), coverage, limitations: ['Zero-based, end-exclusive intervals in bin order; no circular-origin wrap.'] },
      direct: { label: 'Direct resolved-match scores', kind: 'sequence-score', units: 'fraction',
        value: Array.from(result.directValues), coverage, limitations },
      inverted: { label: 'Reverse-complement resolved-match scores', kind: 'sequence-score', units: 'fraction',
        value: Array.from(result.invertedValues), coverage, limitations },
      resolvedPerWindow: { label: 'Resolved A/C/G/T bases per sampled window', kind: 'sequence-score', units: 'count',
        value: resolvedPerWindow, coverage, limitations: ['Counts describe input coverage, not biological certainty.'] },
    },
  });
  return { ...result, record };
}

/** Structural contract for already parsed/generated records, not checksum verification. */
function dotPlotRecordParameters(record: AnalysisRecord): Required<DotPlotConfig> {
  if (!dotPlotJsonEqual(record.method, DOT_PLOT_METHOD) || record.seed !== null
      || !dotPlotJsonEqual(record.references, DOT_PLOT_REFERENCES)
      || record.inputs.length !== 1 || record.inputs[0].id !== 'sequence'
      || Object.keys(record.parameters).sort().join('|') !== 'ambiguity|bins|window'
      || record.parameters.ambiguity !== 'exclude'
      || typeof record.parameters.bins !== 'number' || typeof record.parameters.window !== 'number'
      || typeof record.inputs[0].data !== 'string') {
    throw new Error('Incompatible dot plot method, inputs, parameters, seed or reference versions.');
  }
  const input = record.inputs[0];
  snapshotDotPlotInput({ sequence: input.data as string, accession: input.accession, source: input.source as 'catalog' | 'local' });
  const parameters = dotPlotExperimentConfig((input.data as string).length, record.parameters as unknown as DotPlotConfig);
  const fields = record.fields;
  if (Object.keys(fields).sort().join('|') !== 'direct|inverted|resolvedPerWindow|windows'
      || Object.values(fields).some(field => field.kind !== 'sequence-score')
      || fields.direct.units !== 'fraction' || fields.inverted.units !== 'fraction'
      || fields.windows.units !== 'records' || fields.resolvedPerWindow.units !== 'count'
      || !Array.isArray(fields.windows.value) || fields.windows.value.length !== parameters.bins
      || !Array.isArray(fields.resolvedPerWindow.value) || fields.resolvedPerWindow.value.length !== parameters.bins
      || ![fields.direct, fields.inverted].every(field => Array.isArray(field.value)
        && field.value.length === parameters.bins * parameters.bins
        && field.value.every(value => typeof value === 'number' && value >= 0 && value <= 1 && Math.fround(value) === value))) {
    throw new Error('Dot plot experiment has invalid matrix or coverage fields.');
  }
  return parameters;
}

/** Verify all hashes, exact selected bases and freshly computed outputs before restoring anything. */
export async function replayDotPlotExperiment(
  content: string, input: DotPlotExperimentInput,
): Promise<DotPlotExperiment & { exactRecord: boolean }> {
  // Capture the caller's selection before the parser's first asynchronous hash.
  const selected = snapshotDotPlotInput(input);
  const saved = await parseAnalysisRecord(content, { methodId: DOT_PLOT_METHOD.id, methodVersion: DOT_PLOT_METHOD.version });
  const parameters = dotPlotRecordParameters(saved);
  if (saved.inputs[0].data !== selected.sequence) {
    throw new Error('Saved dot plot sequence does not match the selected genome. Load its exact source before replaying.');
  }
  const fresh = await createDotPlotExperiment(selected, parameters);
  if (!dotPlotJsonEqual(saved.fields, fresh.record.fields)) {
    throw new Error('Recomputed dot plot matrices, sampled coordinates or evidence differ from the saved experiment.');
  }
  return { ...fresh, exactRecord: saved.resultId === fresh.record.resultId };
}

/**
 * Tabular export of a generated/verified record. Untrusted JSON must first go
 * through replayDotPlotExperiment. No nucleotide sequence or free-text labels
 * are included; numeric coordinates and stable identities are spreadsheet-safe.
 */
export function exportDotPlotExperimentTsv(record: AnalysisRecord): string {
  const { bins, window } = dotPlotRecordParameters(record);
  const sequenceLength = (record.inputs[0].data as string).length;
  const direct = record.fields.direct.value as number[];
  const inverted = record.fields.inverted.value as number[];
  const lines = [
    '# Dot plot resolved-match scores; coordinates are zero-based, end-exclusive.',
    `# result_id\t${record.resultId}`, `# sequence_json_sha256\t${record.inputs[0].sha256}`,
    'row\tcolumn\ty_start\ty_end\tx_start\tx_end\tdirect_score\tinverted_score',
  ];
  for (let row = 0; row < bins; row++) {
    const y = getDotPlotWindowRange(sequenceLength, bins, window, row);
    for (let col = 0; col < bins; col++) {
      const x = getDotPlotWindowRange(sequenceLength, bins, window, col);
      lines.push([row, col, y.start, y.end, x.start, x.end, direct[row * bins + col], inverted[row * bins + col]].join('\t'));
    }
  }
  return `${lines.join('\n')}\n`;
}

export const PAIRWISE_DOT_PLOT_METHOD = {
  id: 'sequence-pairwise-dot-plot', version: '1',
  implementation: 'TypeScript exact resolved-window comparisons with Float32 matrix output',
};
const PAIRWISE_DOT_PLOT_REFERENCES = [{
  id: 'bundled-pairwise-resolved-dot-plot', version: '1',
  description: 'Ordered row/Y and column/X sequences, independently sampled linear windows of equal length; no external biological reference.',
}];
export interface PairwiseDotPlotExperiment extends PairwiseDotPlotBuffers { record: AnalysisRecord }

/** Ordered axes are part of the experiment identity. Renaming them is not a
 * license to swap sequences, reuse a self matrix or reinterpret its diagonal.
 */
export async function createPairwiseDotPlotExperiment(rowInput: DotPlotExperimentInput, columnInput: DotPlotExperimentInput,
  config: DotPlotConfig = {}, displayed?: DotPlotBuffers): Promise<PairwiseDotPlotExperiment> {
  const row = snapshotDotPlotInput(rowInput), column = snapshotDotPlotInput(columnInput);
  if (row.sequence.length + column.sequence.length > DOT_PLOT_EXPERIMENT_LIMITS.bases) {
    throw new Error('Pairwise dot plot experiments allow at most 5,000,000 total input bases.');
  }
  const parameters = dotPlotExperimentConfig(Math.min(row.sequence.length, column.sequence.length), config);
  const result = computePairwiseDotPlotBuffers(row.sequence, column.sequence, parameters);
  if (displayed && (displayed.bins !== result.bins || displayed.window !== result.window
      || !(displayed.directValues instanceof Float32Array) || !(displayed.invertedValues instanceof Float32Array)
      || displayed.directValues.length !== result.directValues.length || displayed.invertedValues.length !== result.invertedValues.length
      || !result.directValues.every((value, i) => value === displayed.directValues[i])
      || !result.invertedValues.every((value, i) => value === displayed.invertedValues[i]))) {
    throw new Error('Displayed pairwise dot plot differs from the exact recomputation. Rerun both inputs before exporting.');
  }
  const coverageOf = (sequence: string) => ({ available: resolvedWindowCounts(sequence, 1, sequence.length)[0],
    total: sequence.length, unit: 'bases' as const });
  const rowCoverage = coverageOf(row.sequence), columnCoverage = coverageOf(column.sequence);
  const coverage = { available: rowCoverage.available + columnCoverage.available,
    total: rowCoverage.total + columnCoverage.total, unit: 'bases' as const };
  const limitations = [
    'Row-major Float32 scores count resolved A/C/G/T matches divided by the common full window length. U and ambiguity symbols never add matching evidence.',
    'The inverted score compares the reverse complement of the row/Y window with the forward column/X window.',
    'Sampled linear windows may overlap or skip positions. These scores are not alignments, variant calls, calibrated homology probabilities or biological validation.',
  ];
  const windows = (sequence: string) => Array.from({ length: result.bins }, (_, i) =>
    getDotPlotWindowRange(sequence.length, result.bins, result.window, i));
  const record = await createAnalysisRecord({
    method: PAIRWISE_DOT_PLOT_METHOD,
    inputs: [
      { id: 'rowSequence', accession: row.accession, source: row.source,
        description: 'Exact row/Y nucleotide sequence; its canonical JSON encoding is hashed.', data: row.sequence },
      { id: 'columnSequence', accession: column.accession, source: column.source,
        description: 'Exact column/X nucleotide sequence; its canonical JSON encoding is hashed.', data: column.sequence },
    ],
    parameters: { ...parameters }, seed: null, references: PAIRWISE_DOT_PLOT_REFERENCES,
    fields: {
      rowWindows: { label: 'Row/Y sampled windows', kind: 'sequence-score', units: 'records', value: analysisJson(windows(row.sequence)),
        coverage: rowCoverage, limitations: ['Zero-based, end-exclusive row-input coordinates; no circular-origin wrapping.'] },
      columnWindows: { label: 'Column/X sampled windows', kind: 'sequence-score', units: 'records', value: analysisJson(windows(column.sequence)),
        coverage: columnCoverage, limitations: ['Zero-based, end-exclusive column-input coordinates; no circular-origin wrapping.'] },
      direct: { label: 'Direct resolved-match scores', kind: 'sequence-score', units: 'fraction',
        value: Array.from(result.directValues), coverage, limitations },
      inverted: { label: 'Reverse-complement resolved-match scores', kind: 'sequence-score', units: 'fraction',
        value: Array.from(result.invertedValues), coverage, limitations },
      rowResolvedPerWindow: { label: 'Resolved bases per row/Y window', kind: 'sequence-score', units: 'count',
        value: result.rowResolvedPerWindow, coverage: rowCoverage, limitations: ['Input coverage, not the cross-genome diagonal or biological confidence.'] },
      columnResolvedPerWindow: { label: 'Resolved bases per column/X window', kind: 'sequence-score', units: 'count',
        value: result.columnResolvedPerWindow, coverage: columnCoverage, limitations: ['Input coverage, not the cross-genome diagonal or biological confidence.'] },
    },
  });
  return { ...result, record };
}

function pairwiseRecordParameters(record: AnalysisRecord): Required<DotPlotConfig> {
  if (!dotPlotJsonEqual(record.method, PAIRWISE_DOT_PLOT_METHOD) || record.seed !== null
      || !dotPlotJsonEqual(record.references, PAIRWISE_DOT_PLOT_REFERENCES)
      || record.inputs.length !== 2 || record.inputs[0].id !== 'rowSequence' || record.inputs[1].id !== 'columnSequence'
      || Object.keys(record.parameters).sort().join('|') !== 'ambiguity|bins|window'
      || record.parameters.ambiguity !== 'exclude' || typeof record.parameters.bins !== 'number' || typeof record.parameters.window !== 'number') {
    throw new Error('Incompatible pairwise dot plot method, ordered inputs, parameters or references.');
  }
  const sources = record.inputs.map(input => snapshotDotPlotInput({ sequence: input.data as string,
    accession: input.accession, source: input.source as 'local' | 'catalog' }));
  if (sources[0].sequence.length + sources[1].sequence.length > DOT_PLOT_EXPERIMENT_LIMITS.bases) throw new Error('Pairwise input exceeds 5,000,000 total bases.');
  const parameters = dotPlotExperimentConfig(Math.min(...sources.map(source => source.sequence.length)), record.parameters as unknown as DotPlotConfig);
  const f = record.fields;
  if (Object.keys(f).sort().join('|') !== 'columnResolvedPerWindow|columnWindows|direct|inverted|rowResolvedPerWindow|rowWindows'
      || Object.values(f).some(field => field.kind !== 'sequence-score')
      || ![f.rowWindows, f.columnWindows].every(field => field.units === 'records' && Array.isArray(field.value) && field.value.length === parameters.bins)
      || ![f.rowResolvedPerWindow, f.columnResolvedPerWindow].every(field => field.units === 'count' && Array.isArray(field.value)
        && field.value.length === parameters.bins && field.value.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= parameters.window))
      || ![f.direct, f.inverted].every(field => field.units === 'fraction' && Array.isArray(field.value)
        && field.value.length === parameters.bins * parameters.bins && field.value.every(n => typeof n === 'number' && n >= 0 && n <= 1 && Math.fround(n) === n))) {
    throw new Error('Invalid pairwise dot plot matrices, axis coordinates or coverage.');
  }
  return parameters;
}

/** Recompute all evidence against BOTH selected inputs, in their recorded order. */
export async function replayPairwiseDotPlotExperiment(content: string, rowInput: DotPlotExperimentInput,
  columnInput: DotPlotExperimentInput): Promise<PairwiseDotPlotExperiment & { exactRecord: boolean }> {
  const row = snapshotDotPlotInput(rowInput), column = snapshotDotPlotInput(columnInput);
  const saved = await parseAnalysisRecord(content, { methodId: PAIRWISE_DOT_PLOT_METHOD.id, methodVersion: PAIRWISE_DOT_PLOT_METHOD.version });
  const parameters = pairwiseRecordParameters(saved);
  if (saved.inputs[0].data !== row.sequence || saved.inputs[1].data !== column.sequence) {
    throw new Error('Saved pairwise dot plot does not match both selected genome axes. Load the exact row and column sources before replaying.');
  }
  const fresh = await createPairwiseDotPlotExperiment(row, column, parameters);
  if (!dotPlotJsonEqual(saved.fields, fresh.record.fields)) throw new Error('Recomputed pairwise matrices, axis coordinates or coverage differ from the saved experiment.');
  return { ...fresh, exactRecord: saved.resultId === fresh.record.resultId };
}

/** Only generated/verified records belong here. Untrusted JSON must be replayed first. */
export function exportPairwiseDotPlotExperimentTsv(record: AnalysisRecord): string {
  const { bins, window } = pairwiseRecordParameters(record);
  const direct = record.fields.direct.value as number[], inverted = record.fields.inverted.value as number[];
  const rowCounts = record.fields.rowResolvedPerWindow.value as number[], columnCounts = record.fields.columnResolvedPerWindow.value as number[];
  const lines = ['# Pairwise resolved-match scores; coordinates are zero-based, end-exclusive.',
    `# result_id\t${record.resultId}`, `# row_sequence_json_sha256\t${record.inputs[0].sha256}`,
    `# column_sequence_json_sha256\t${record.inputs[1].sha256}`,
    'row\tcolumn\ty_start\ty_end\tx_start\tx_end\ty_resolved\tx_resolved\tdirect_score\tinverted_score'];
  for (let row = 0; row < bins; row++) {
    const y = getDotPlotWindowRange((record.inputs[0].data as string).length, bins, window, row);
    for (let col = 0; col < bins; col++) {
      const x = getDotPlotWindowRange((record.inputs[1].data as string).length, bins, window, col);
      lines.push([row, col, y.start, y.end, x.start, x.end, rowCounts[row], columnCounts[col], direct[row * bins + col], inverted[row * bins + col]].join('\t'));
    }
  }
  return `${lines.join('\n')}\n`;
}
