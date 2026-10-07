/** Portable GC-skew experiments. Counts preserve the viewer's inclusive G-C
 * prefix and first-extremum tie convention; a zero denominator is unavailable.
 */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisField, type AnalysisRecord } from '../analysis-result';

export const GC_SKEW_LIMITS = { bases: 5000000, window: 1000000, windows: 20000 } as const;
export interface GCSkewOptions { windowSize?: number; stepSize?: number }
export interface ResolvedGCSkewOptions { windowSize: number; stepSize: number }
export interface GCSkewWindow {
  start: number; end: number; g: number; c: number; resolvedBases: number;
  skew: number | null; cumulative: number;
}
export interface GCSkewScan {
  windows: GCSkewWindow[];
  sequenceLength: number; resolvedBases: number; gcBases: number;
  originPosition: number | null; terminusPosition: number | null;
}
export const GC_SKEW_METHOD = { id: 'sequence-gc-skew', version: '2',
  implementation: 'TypeScript exact rolling nucleotide counts; inclusive per-base G-minus-C prefix' };
const REFERENCE = { id: 'gc-skew-counting-conventions', version: '1',
  description: 'Linear complete windows; (G-C)/(G+C); inclusive per-base G-C prefix at each window start; first sampled extrema. No replication reference or measurements.' };
const canonical = (value: unknown) => JSON.stringify(analysisJson(value));
function integer(value: unknown, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}
export function resolveGCSkewOptions(options: GCSkewOptions = {}): ResolvedGCSkewOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['windowSize', 'stepSize'].includes(key))) throw new Error('Unsupported GC-skew options.');
  const windowSize = integer(options.windowSize ?? 500, GC_SKEW_LIMITS.window, 'Window size');
  return { windowSize, stepSize: integer(options.stepSize ?? Math.max(1, Math.floor(windowSize / 4)), GC_SKEW_LIMITS.bases, 'Step size') };
}
function sequenceInput(sequence: string): void {
  if (typeof sequence !== 'string' || sequence.length > GC_SKEW_LIMITS.bases || /[^ACGTRYSWKMBDHVN]/i.test(sequence)) {
    throw new Error('GC skew requires at most 5,000,000 IUPAC DNA bases without gaps or formatting characters.');
  }
}
/** O(sequence length + windows), including when windows overlap or have gaps. */
export function analyzeGCSkew(sequence: string, settings: GCSkewOptions = {}): GCSkewScan {
  sequenceInput(sequence);
  const { windowSize, stepSize } = resolveGCSkewOptions(settings);
  const count = sequence.length < windowSize ? 0 : Math.floor((sequence.length - windowSize) / stepSize) + 1;
  if (count > GC_SKEW_LIMITS.windows) throw new Error('GC-skew output exceeds 20,000 windows. Increase the step size.');
  const base = (position: number) => sequence.charCodeAt(position) & ~32;
  let resolvedBases = 0, gcBases = 0;
  for (let i = 0; i < sequence.length; i++) {
    const code = base(i);
    if (code === 71 || code === 67) gcBases++;
    if (code === 65 || code === 67 || code === 71 || code === 84) resolvedBases++;
  }
  const windows: GCSkewWindow[] = [];
  let left = 0, right = 0, g = 0, c = 0, resolved = 0, prefixIndex = 0, prefix = 0;
  const adjust = (position: number, direction: number) => {
    const code = base(position);
    if (code === 71) g += direction;
    else if (code === 67) c += direction;
    if (code === 65 || code === 67 || code === 71 || code === 84) resolved += direction;
  };
  for (let start = 0; start + windowSize <= sequence.length; start += stepSize) {
    const end = start + windowSize;
    while (right < end) adjust(right++, 1);
    while (left < start) adjust(left++, -1);
    while (prefixIndex <= start) {
      const code = base(prefixIndex++);
      if (code === 71) prefix++; else if (code === 67) prefix--;
    }
    windows.push({ start, end, g, c, resolvedBases: resolved, skew: g + c ? (g - c) / (g + c) : null, cumulative: prefix });
  }
  let minimum = 0, maximum = 0;
  for (let i = 1; i < windows.length; i++) {
    if (windows[i].cumulative < windows[minimum].cumulative) minimum = i;
    if (windows[i].cumulative > windows[maximum].cumulative) maximum = i;
  }
  const informative = windows.length >= 2 && windows.some(window => window.g + window.c > 0);
  return { windows, sequenceLength: sequence.length, resolvedBases, gcBases,
    originPosition: informative ? windows[minimum].start : null,
    terminusPosition: informative ? windows[maximum].start : null };
}
export async function createGCSkewRecord(sequence: string, settings: GCSkewOptions = {},
  context: { accession: string | null; source: 'local' | 'catalog' } = { accession: null, source: 'local' }): Promise<AnalysisRecord> {
  const options = resolveGCSkewOptions(settings), scan = analyzeGCSkew(sequence, options);
  const coverage = { available: scan.resolvedBases, total: scan.sequenceLength, unit: 'bases' as const };
  const windowLimits = ['Coordinates are 0-based and half-open. Only complete linear windows are sampled; circular-origin windows are not included.',
    'Each zero-GC window has null skew, never a measured zero. Ambiguous bases do not count as A, C, G or T.',
    'Cumulative values are inclusive per-base G-C counts sampled at window starts, not sums of window skew.'];
  const extremum = (label: string, value: number | null): AnalysisField => value === null
    ? { label, kind: 'unavailable', units: null, value: null, coverage: { ...coverage, available: 0 },
      missingInputs: ['At least two sampled complete windows, including a window with G or C.'],
      limitations: ['A sequence-composition extremum is not an experimentally established replication location.'] }
    : { label, kind: 'sequence-score', units: 'base-pairs', value, coverage,
      limitations: ['First sampled extremum of the inclusive G-C prefix; ties and flat profiles are not evidence of a unique replication location.'] };
  return createAnalysisRecord({ method: GC_SKEW_METHOD, inputs: [{ id: 'sequence', ...context,
    description: 'Exact nucleotide string; case and IUPAC ambiguity are retained in the portable experiment.', data: sequence }],
  parameters: { ...options }, seed: null, references: [REFERENCE], fields: {
    windows: { label: 'GC-skew windows and nucleotide counts', kind: 'sequence-score', units: 'records', value: analysisJson(scan.windows),
      coverage: { available: scan.windows.filter(window => window.skew !== null).length, total: scan.windows.length, unit: 'records' }, limitations: windowLimits },
    summary: { label: 'Sequence and sampled-window coverage', kind: 'sequence-score', units: 'records', coverage,
      value: { sequenceLength: scan.sequenceLength, resolvedBases: scan.resolvedBases, gcBases: scan.gcBases,
        sampledWindows: scan.windows.length, definedSkewWindows: scan.windows.filter(window => window.skew !== null).length },
      limitations: ['Sampling and sequence content do not establish replication mechanism or origin.'] },
    originPosition: extremum('Cumulative-minimum candidate', scan.originPosition),
    terminusPosition: extremum('Cumulative-maximum candidate', scan.terminusPosition),
  } });
}
/** Checksums and envelope checks are prerequisites, not numerical verification. */
export async function parseGCSkewRecord(content: string): Promise<{ record: AnalysisRecord; sequence: string; options: ResolvedGCSkewOptions }> {
  const record = await parseAnalysisRecord(content, { methodId: GC_SKEW_METHOD.id, methodVersion: GC_SKEW_METHOD.version });
  if (canonical(record.method) !== canonical(GC_SKEW_METHOD) || canonical(record.references) !== canonical([REFERENCE]) || record.seed !== null) {
    throw new Error('GC-skew method, reference version or seed is incompatible.');
  }
  const input = record.inputs[0];
  if (record.inputs.length !== 1 || input.id !== 'sequence' || typeof input.data !== 'string' || !['local', 'catalog'].includes(input.source)) {
    throw new Error('GC-skew replay requires one exact local or catalog sequence.');
  }
  sequenceInput(input.data);
  const options = resolveGCSkewOptions(record.parameters);
  if (canonical(options) !== canonical(record.parameters)) throw new Error('Both GC-skew parameters must be explicit.');
  return { record, sequence: input.data, options };
}
/** A valid-checksum forged result is rejected after fresh counting. */
export async function replayGCSkewRecord(content: string): Promise<AnalysisRecord> {
  const saved = await parseGCSkewRecord(content);
  const fresh = await createGCSkewRecord(saved.sequence, saved.options, {
    accession: saved.record.inputs[0].accession, source: saved.record.inputs[0].source as 'local' | 'catalog' });
  if (fresh.resultId !== saved.record.resultId) throw new Error('Fresh GC-skew counts or evidence differ from the saved experiment.');
  return fresh;
}
/** Export only a verified producer/replay result. Empty skew cells mean unavailable. */
export function exportGCSkewTsv(record: AnalysisRecord): string {
  if (canonical(record.method) !== canonical(GC_SKEW_METHOD) || !Array.isArray(record.fields.windows?.value)) throw new Error('Expected a portable GC-skew result.');
  const rows = record.fields.windows.value as unknown as GCSkewWindow[];
  return [`# method=${record.method.id}; version=${record.method.version}; result=${record.resultId}; inputSha256=${record.inputs[0].sha256}`,
    `# windowSize=${record.parameters.windowSize}; stepSize=${record.parameters.stepSize}; complete linear windows; empty gc_skew cells are unavailable`,
    'start_0based\tend_exclusive\tg_count\tc_count\tresolved_bases\tgc_skew\tinclusive_cumulative_g_minus_c',
    ...rows.map(row => [row.start, row.end, row.g, row.c, row.resolvedBases, row.skew ?? '', row.cumulative].join('\t'))].join('\n') + '\n';
}
