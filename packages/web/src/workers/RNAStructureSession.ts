/** Bounded RNA interval analysis in an owned worker. Inputs never leave the device. */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord,
  type AnalysisRecord } from '../../../core/src/analysis-result';
import { reverseComplement } from '../../../core/src/codons';
import { analyzeRNAStructure, resolveRNAStructureOptions, RNA_PAIRING_METHOD, RNA_STRUCTURE_LIMITS,
  type RNAStructureAnalysis, type RNAStructureOptions } from '../../../core/src/analysis/rna-structure';

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
  analysis: RNAStructureAnalysis;
  record: AnalysisRecord;
}
export type RNAStructureMessage = { kind: 'result'; result: RNAStructureWorkResult }
  | { kind: 'error'; message: string };
export interface RNAStructureWorker {
  postMessage(request: RNAStructureRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RNAStructureMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
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
const same = (a: unknown, b: unknown) => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
function validateRequest(input: RNAStructureRequest): RNAStructureRequest {
  if (!object(input) || Object.keys(input).sort().join('|') !== 'options|sequence|source' || !object(input.source)) throw new Error('Invalid RNA interval request.');
  const source = input.source;
  if (Object.keys(source).sort().join('|') !== 'accession|coordinateSystem|end|gene|name|source|sourceLength|start|strand'
    || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 2000
    || !['catalog', 'local'].includes(source.source) || !['genome-forward', 'cds-transcript'].includes(source.coordinateSystem)
    || !['+', '-'].includes(source.strand) || source.accession !== null && (typeof source.accession !== 'string' || !source.accession.trim())
    || source.gene !== null && (typeof source.gene !== 'string' || !source.gene.trim())) throw new Error('Invalid RNA interval source.');
  if (![source.start, source.end, source.sourceLength].every(Number.isSafeInteger)) throw new Error('RNA source coordinates must be integers.');
  const coding = source.coordinateSystem === 'cds-transcript';
  parseRNAInterval(String(source.start + 1), String(source.end), source.sourceLength, coding);
  if (coding && (source.strand !== '+' || source.gene === null) || !coding && source.gene !== null) throw new Error('CDS input requires its gene and transcript-order sequence.');
  if (typeof input.sequence !== 'string' || input.sequence.length !== source.end - source.start
    || /[^ACGTRYSWKMBDHVN]/i.test(input.sequence)) throw new Error('RNA interval bases must exactly match the declared length and use IUPAC DNA.');
  if (!object(input.options) || Object.keys(input.options).some(key => !['windowSize', 'stepSize', 'frame', 'includeSynonymousStress', 'minLoopSize', 'allowWobble'].includes(key))) {
    throw new Error('Unsupported RNA interval options.');
  }
  const options = resolveRNAStructureOptions(input.options);
  if (options.includeSynonymousStress && !coding) throw new Error('Synonymous scores require an explicitly selected coding sequence.');
  if (options.frame !== 0) throw new Error('RNA workspace intervals begin at the selected CDS codon boundary.');
  return { sequence: input.sequence.toUpperCase(), source: { ...source }, options };
}

export async function executeRNAStructureRequest(input: RNAStructureRequest): Promise<RNAStructureWorkResult> {
  const request = validateRequest(input);
  const sequence = request.source.strand === '+' ? request.sequence : reverseComplement(request.sequence);
  const analysis = analyzeRNAStructure(sequence, request.options);
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
  return { analysis, record };
}

interface RNAStructureSnapshot {
  /** Caller identity is an opaque generation token, never a source for displayed evidence. */
  input: RNAStructureRequest | null;
  request: RNAStructureRequest | null;
  accepted: RNAStructureWorkResult | null;
  busy: boolean;
  error: string | null;
  cancelled: boolean;
}

/** Every run owns its worker and its accepted source. Late replies cannot replace newer input. */
export class RNAStructureSession {
  private active = false;
  private operation: AbortController | null = null;
  private listeners = new Set<() => void>();
  private snapshot: RNAStructureSnapshot = { input: null, request: null, accepted: null, busy: false, error: null, cancelled: false };
  constructor(private readonly factory: () => RNAStructureWorker) {}
  getSnapshot = (): RNAStructureSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<RNAStructureSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener(); 
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const previous = this.operation; this.operation = null; previous?.abort();
    if (previous) this.publish({ busy: false, cancelled: true });
  };
  run = async (input: RNAStructureRequest): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    try {
      const request = validateRequest(structuredClone(input));
      this.publish({ input, request, accepted: null, busy: true, error: null, cancelled: false });
      if (!current()) return false;
      const result = await new Promise<RNAStructureWorkResult>((resolve, reject) => {
        let worker: RNAStructureWorker | null = null, done = false, validating = false;
        const finish = (value?: RNAStructureWorkResult, cause?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', abort);
          if (worker) {
            worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
            try { worker.terminate(); } catch { /* Ownership still ends. */ }
          }
          if (cause) reject(cause); else resolve(value!);
        };
        const abort = () => finish(undefined, new DOMException('RNA analysis cancelled.', 'AbortError'));
        owner.signal.addEventListener('abort', abort, { once: true });
        if (!current()) { abort(); return; }
        try {
          worker = this.factory();
          // A factory may synchronously cancel its own request.
          if (!current() || done) { worker.terminate(); abort(); return; }
          worker.onmessage = event => {
            if (!current() || done || validating) return;
            const message = event.data;
            if (message?.kind === 'error' && typeof message.message === 'string') { finish(undefined, new Error(message.message)); return; }
            if (message?.kind !== 'result' || !message.result || !message.result.record || !message.result.analysis) {
              finish(undefined, new Error('Unexpected RNA worker response.')); return;
            }
            validating = true;
            void (async () => {
              const value = message.result;
              const record = await parseAnalysisRecord(serializeAnalysisRecord(value.record),
                { methodId: RNA_PAIRING_METHOD.id, methodVersion: RNA_PAIRING_METHOD.version });
              if (!current() || done) return;
              if (record.inputs.length !== 1 || record.inputs[0].id !== 'rnaInterval'
                || record.inputs[0].source !== request.source.source || record.inputs[0].accession !== request.source.accession
                || !same(record.inputs[0].data, { sequence: request.sequence, source: request.source })
                || record.method.implementation !== 'typescript'
                || !same(record.parameters, request.options) || !same(value.analysis.parameters, request.options)
                || !same(value.analysis.method, RNA_PAIRING_METHOD) || value.analysis.coverage?.sequenceBases !== request.sequence.length
                || !same(record.fields.analysis?.value, value.analysis)) {
                throw new Error('RNA result does not match the submitted interval and parameters.');
              }
              for (const window of value.analysis.windows) mapRNAInterval(request.source, window.start, window.end);
              for (const motif of value.analysis.regulatoryHypotheses) mapRNAInterval(request.source, motif.start, motif.end);
              finish({ analysis: value.analysis, record });
            })().catch(cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
          };
          worker.onerror = () => finish(undefined, new Error('RNA worker failed; no partial result was accepted.'));
          worker.onmessageerror = () => finish(undefined, new Error('RNA worker response could not be decoded.'));
          worker.postMessage(request);
        } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.operation = null;
      this.publish({ accepted: result, busy: false, error: null });
      return true;
    } catch (cause) {
      if (!current()) return false;
      this.operation = null;
      this.publish({ input, request: this.snapshot.input === input ? this.snapshot.request : null,
        accepted: null, busy: false, error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  };
}
