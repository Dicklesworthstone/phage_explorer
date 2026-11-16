/** Owned browser workers for the shared portable RNA interval method. */
import { analysisJson, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { RNA_PAIRING_METHOD } from '../../../core/src/analysis/rna-structure';
import { validateRNAStructureRequest, mapRNAInterval, type RNAStructureRequest,
  type RNAStructureWorkResult } from '../../../core/src/analysis/rna-structure-experiment';
export { executeRNAStructureRequest, parseRNAStructureRecord, replayRNAStructureRecord, exportRNAStructureTsv,
  parseRNAInterval, mapRNAInterval, type RNAIntervalSource, type RNAStructureRequest,
  type RNAStructureWorkResult } from '../../../core/src/analysis/rna-structure-experiment';

const same = (a: unknown, b: unknown) => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));

export type RNAStructureMessage = { kind: 'result'; result: RNAStructureWorkResult }
  | { kind: 'error'; message: string };
export interface RNAStructureWorker {
  postMessage(request: RNAStructureRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RNAStructureMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

/** Bound and cancel local reads before decoding or starting a worker. A provider
 * that ignores cancellation can never install its late file contents.
 */
export function readRNAExperimentFile(file: { size: number; arrayBuffer: () => Promise<ArrayBuffer> }, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (content?: string, error?: Error) => {
      if (done) return; done = true;
      signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(content!);
    };
    const cancel = () => finish(undefined, new DOMException('RNA import cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10 * 1024 * 1024) {
      finish(undefined, new Error('RNA experiment must be a nonempty UTF-8 JSON file of at most 10 MiB.')); return;
    }
    void Promise.resolve().then(() => { if (!done) return file.arrayBuffer(); })
      .then(buffer => {
        if (done) return;
        if (!buffer || buffer.byteLength < 1 || buffer.byteLength > 10 * 1024 * 1024) {
          throw new Error('RNA experiment must be a nonempty UTF-8 JSON file of at most 10 MiB.');
        }
        finish(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      }).catch(cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
  });
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
  /** Optional saved evidence must match the freshly computed record in full.
   * It is snapshotted before worker execution and is never rebaselined.
   */
  run = async (input: RNAStructureRequest, saved?: AnalysisRecord): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    try {
      const request = validateRNAStructureRequest(structuredClone(input));
      const expected = saved === undefined ? null : structuredClone(saved);
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
              if (expected !== null && !same(record, expected)) {
                throw new Error('Recomputed RNA structures or evidence differ from the saved experiment.');
              }
              finish({ request, analysis: value.analysis, record });
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
