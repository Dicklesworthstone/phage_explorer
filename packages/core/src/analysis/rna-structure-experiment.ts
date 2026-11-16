/** Portable, replayable RNA interval experiments. No catalog or network lookup is performed. */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { reverseComplement } from '../codons';
import { analyzeRNAStructure, resolveRNAStructureOptions, RNA_PAIRING_METHOD, RNA_STRUCTURE_LIMITS,
  type RNAStructureAnalysis, type RNAStructureOptions } from './rna-structure';

export interface RNAIntervalSource {
  name: string;
  accession: string | null;
  source: 'catalog' | 'local';
  coordinateSystem: 'genome-forward' | 'cds-transcript';
  sourceLength: number;
  /** Zero-based, half-open in the declared source coordinate system. */
  start: number;
  end: number;
  /** Direction within this interval; CDS input is already in transcript order. */
  strand: '+' | '-';
  gene: string | null;
}
export interface RNAStructureRequest {
  sequence: string;
  source: RNAIntervalSource;
  options: RNAStructureOptions;
}
export interface RNAStructureWorkResult {
  /** The normalized, independently owned source and parameters that produced this result. */
  request: RNAStructureRequest;
  analysis: RNAStructureAnalysis;
  record: AnalysisRecord;
}

/** User coordinates are one-based inclusive; computation/export coordinates are half-open. */
export function parseRNAInterval(startText: string, endText: string, length: number,
  coding = false): { start: number; end: number } {
  if (!/^[1-9]\d*$/.test(startText) || !/^[1-9]\d*$/.test(endText)) {
    throw new Error('Enter whole-number positions starting at 1. Both endpoints are included.');
  }
  const start = Number(startText) - 1, end = Number(endText);
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > length) throw new Error('Choose an interval within the loaded sequence, with end at or after start.');
  if (end - start > RNA_STRUCTURE_LIMITS.sequenceBases) {
    throw new Error('Select at most ' + RNA_STRUCTURE_LIMITS.sequenceBases.toLocaleString() + ' bases. No sequence was truncated.');
  }
  if (coding && start % 3 !== 0) throw new Error('Start a coding interval at a codon boundary: 1, 4, 7, and so on.');
  return { start, end };
}

/** Map result-relative intervals to the original forward/transcript coordinates. */
export function mapRNAInterval(source: RNAIntervalSource, start: number, end: number): { start: number; end: number } {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.end - source.start) {
    throw new Error('RNA result coordinates lie outside the analyzed interval.');
  }
  return source.strand === '+' ? { start: source.start + start, end: source.start + end }
    : { start: source.end - end, end: source.end - start };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
const abort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('RNA analysis cancelled.', 'AbortError');
};

/** Validate before work starts and copy every mutable input; source metadata cannot relabel a later result. */
export function validateRNAStructureRequest(value: unknown): RNAStructureRequest {
  if (!object(value) || Object.keys(value).sort().join('|') !== 'options|sequence|source' || !object(value.source)) {
    throw new Error('Invalid RNA interval request.');
  }
  const source = value.source;
  if (Object.keys(source).sort().join('|') !== 'accession|coordinateSystem|end|gene|name|source|sourceLength|start|strand'
    || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 2000
    || !['catalog', 'local'].includes(source.source as string) || !['genome-forward', 'cds-transcript'].includes(source.coordinateSystem as string)
    || !['+', '-'].includes(source.strand as string) || source.accession !== null && (typeof source.accession !== 'string' || !source.accession.trim())
    || source.gene !== null && (typeof source.gene !== 'string' || !source.gene.trim())) throw new Error('Invalid RNA interval source.');
  if (![source.start, source.end, source.sourceLength].every(Number.isSafeInteger)) throw new Error('RNA source coordinates must be integers.');
  const coding = source.coordinateSystem === 'cds-transcript';
  parseRNAInterval(String((source.start as number) + 1), String(source.end), source.sourceLength as number, coding);
  if (coding && (source.strand !== '+' || source.gene === null) || !coding && source.gene !== null) {
    throw new Error('CDS input requires its gene and transcript-order sequence.');
  }
  if (typeof value.sequence !== 'string' || value.sequence.length !== (source.end as number) - (source.start as number)
    || /[^ACGTRYSWKMBDHVN]/i.test(value.sequence)) throw new Error('RNA interval bases must exactly match the declared length and use IUPAC DNA.');
  if (!object(value.options) || Object.keys(value.options).some(key => !['windowSize', 'stepSize', 'frame', 'includeSynonymousStress', 'minLoopSize', 'allowWobble'].includes(key))) {
    throw new Error('Unsupported RNA interval options.');
  }
  const options = resolveRNAStructureOptions(value.options as RNAStructureOptions);
  if (options.includeSynonymousStress && !coding) throw new Error('Synonymous scores require an explicitly selected coding sequence.');
  if (options.frame !== 0) throw new Error('RNA workspace intervals begin at the selected CDS codon boundary.');
  return { sequence: value.sequence.toUpperCase(), source: { ...source } as unknown as RNAIntervalSource, options };
}

/** The numerical producer and version-1 evidence envelope are identical in browser and terminal. */
export async function executeRNAStructureRequest(input: RNAStructureRequest, signal?: AbortSignal): Promise<RNAStructureWorkResult> {
  abort(signal);
  const request = validateRNAStructureRequest(input);
  const sequence = request.source.strand === '+' ? request.sequence : reverseComplement(request.sequence);
  const analysis = analyzeRNAStructure(sequence, request.options);
  abort(signal);
  const record = await createAnalysisRecord({
    method: { id: RNA_PAIRING_METHOD.id, version: RNA_PAIRING_METHOD.version, implementation: 'typescript' },
    inputs: [{ id: 'rnaInterval', accession: request.source.accession, source: request.source.source,
      description: request.source.name, data: analysisJson({ sequence: request.sequence, source: request.source }) }],
    parameters: analysisJson(analysis.parameters) as AnalysisRecord['parameters'], seed: null,
    references: [{ id: 'maximum-noncrossing-pairing', version: '1980', description: RNA_PAIRING_METHOD.reference }],
    fields: { analysis: { kind: 'sequence-score', label: 'Exact bounded maximum-pairing intervals and motif observations', units: 'records',
      coverage: { available: request.sequence.length, total: request.source.sourceLength, unit: 'bases' },
      limitations: [RNA_PAIRING_METHOD.limitations,
        'Only the explicitly selected interval is analyzed. Interval ends are not asserted to be transcript or genome termini.',
        'Motifs and synonymous pairing-score differences are uncalibrated descriptive results, not functional, fitness or thermodynamic predictions.'],
      value: analysisJson(analysis) } },
  });
  abort(signal);
  return { request, analysis, record };
}

/**
 * Recover a bounded request from a saved record without trusting its reported structures.
 * This checks source/parameter identity and content integrity; only replay verifies the computation.
 */
export async function parseRNAStructureRecord(content: string, signal?: AbortSignal): Promise<{
  request: RNAStructureRequest; record: AnalysisRecord;
}> {
  abort(signal);
  const record = await parseAnalysisRecord(content, { methodId: RNA_PAIRING_METHOD.id, methodVersion: RNA_PAIRING_METHOD.version });
  abort(signal);
  if (record.method.implementation !== 'typescript' || record.inputs.length !== 1 || record.seed !== null
    || Object.keys(record.fields).join('|') !== 'analysis'
    || !same(record.references, [{ id: 'maximum-noncrossing-pairing', version: '1980', description: RNA_PAIRING_METHOD.reference }])) {
    throw new Error('Saved RNA analysis has an incompatible method, references or result fields.');
  }
  const input = record.inputs[0];
  if (input.id !== 'rnaInterval' || !object(input.data) || Object.keys(input.data).sort().join('|') !== 'sequence|source') {
    throw new Error('Saved RNA analysis requires its exact interval sequence and source.');
  }
  const request = validateRNAStructureRequest({ sequence: input.data.sequence, source: input.data.source, options: record.parameters });
  if (input.source !== request.source.source || input.accession !== request.source.accession || input.description !== request.source.name
    || !same(input.data, { sequence: request.sequence, source: request.source }) || !same(record.parameters, request.options)) {
    throw new Error('Saved RNA source identity or resolved parameters do not match the supplied interval.');
  }
  return { request, record };
}

/** Freshly recompute every structure, score and motif. Rehashing forged outputs cannot make replay succeed. */
export async function replayRNAStructureRecord(content: string, signal?: AbortSignal): Promise<RNAStructureWorkResult> {
  const saved = await parseRNAStructureRecord(content, signal);
  const fresh = await executeRNAStructureRequest(saved.request, signal);
  abort(signal);
  if (fresh.record.cacheKey !== saved.record.cacheKey || fresh.record.resultId !== saved.record.resultId) {
    throw new Error('Recomputed RNA structures, scores, coverage or evidence differ from the saved result.');
  }
  return fresh;
}
