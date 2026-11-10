/** Atomic accepted inputs and disposable workers for environmental evidence. */
import { analysisJson, parseAnalysisRecord } from '../../../core/src/analysis-result';
import { ENVIRONMENTAL_METHOD, validateEnvironmentalDataset } from '../../../core/src/analysis/environmental-evidence';
import { ENVIRONMENTAL_FILE_LIMIT, environmentalInputText, type EnvironmentalRequest,
  type EnvironmentalWorkResult, type EnvironmentalWorkerMessage } from './environmental-runtime';

export interface EnvironmentalWorker {
  postMessage(request: EnvironmentalRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<EnvironmentalWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export interface EnvironmentalSnapshot {
  accepted: EnvironmentalWorkResult | null;
  loading: boolean;
  phase: string | null;
  error: string | null;
  notice: string | null;
}
const cancelled = () => new DOMException('Environmental operation cancelled.', 'AbortError');
const same = (a: unknown, b: unknown) => JSON.stringify(analysisJson(a)) === JSON.stringify(analysisJson(b));
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      cause => { signal.removeEventListener('abort', abort); reject(cause); });
    if (signal.aborted) abort();
  });
}

export async function readEnvironmentalFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > ENVIRONMENTAL_FILE_LIMIT) {
    throw new Error('Environmental input exceeds the 10 MiB file limit.');
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > ENVIRONMENTAL_FILE_LIMIT) throw new Error('Environmental input exceeds the 10 MiB file limit.');
  return environmentalInputText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** The worker owns calculation; the UI checks transport and record identity. */
async function validateReply(result: EnvironmentalWorkResult, request: EnvironmentalRequest): Promise<void> {
  if (!result || typeof result !== 'object' || typeof result.verified !== 'boolean') throw new Error('Invalid environmental worker reply.');
  const dataset = validateEnvironmentalDataset(result.dataset);
  if (!same(dataset, result.dataset)) throw new Error('Environmental reply contains a noncanonical dataset.');
  if (request.kind === 'analyze' && !same(dataset, validateEnvironmentalDataset(request.dataset))) {
    throw new Error('Environmental reply does not match the submitted dataset.');
  }
  let savedId: string | null = null;
  if (request.kind === 'import' || request.kind === 'replay') {
    const text = environmentalInputText(request.content);
    const value = JSON.parse(text);
    if (value?.format === 'phage-explorer-analysis') {
      const saved = await parseAnalysisRecord(text, { methodId: ENVIRONMENTAL_METHOD.id, methodVersion: ENVIRONMENTAL_METHOD.version });
      savedId = saved.resultId;
      if (!same(saved.inputs[0]?.data, dataset)) throw new Error('Environmental reply changed the saved input.');
    } else if (request.kind === 'replay' || !same(validateEnvironmentalDataset(value), dataset)) {
      throw new Error('Environmental reply does not match the imported dataset.');
    }
  }
  const expectedAnalysis = request.kind === 'analyze' || savedId !== null;
  if (result.verified !== (savedId !== null) || expectedAnalysis !== (result.analysis !== null)
    || expectedAnalysis !== (result.record !== null)) throw new Error('Environmental reply has an unexpected analysis state.');
  if (result.record) {
    const record = await parseAnalysisRecord(JSON.stringify(result.record), { methodId: ENVIRONMENTAL_METHOD.id, methodVersion: ENVIRONMENTAL_METHOD.version });
    if (!same(record.method, ENVIRONMENTAL_METHOD) || record.seed !== null || !same(record.parameters, {})
      || record.inputs.length !== 1 || record.inputs[0].id !== 'dataset' || record.inputs[0].source !== dataset.source.kind
      || record.inputs[0].accession !== dataset.query.accession || !same(record.inputs[0].data, dataset)
      || !same(record.fields.environment?.value, result.analysis) || savedId !== null && savedId !== record.resultId) {
      throw new Error('Environmental evidence differs from its input, method or accepted result identity.');
    }
  }
}

export class EnvironmentalSession {
  private active = false;
  private operation: AbortController | null = null;
  private snapshot: EnvironmentalSnapshot = { accepted: null, loading: false, phase: null, error: null, notice: null };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly factory: () => EnvironmentalWorker) {}
  getSnapshot = (): EnvironmentalSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  private publish(update: Partial<EnvironmentalSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  cancel = (): void => {
    const prior = this.operation; this.operation = null; prior?.abort();
    this.publish({ loading: false, phase: null, ...(prior ? { notice: 'Cancelled. The last accepted dataset and result are unchanged.' } : {}) });
  };
  importFile = (file: Pick<File, 'size' | 'arrayBuffer'>): Promise<boolean> =>
    this.run(async () => ({ kind: 'import', content: await readEnvironmentalFile(file) }));

  run = async (input: EnvironmentalRequest | ((signal: AbortSignal) => Promise<EnvironmentalRequest>)): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    this.publish({ loading: true, phase: 'Reading environmental input', error: null, notice: null });
    try {
      const captured = typeof input === 'function' ? input : structuredClone(input);
      const request = await abortable(typeof captured === 'function'
        ? captured(owner.signal).then(value => structuredClone(value)) : Promise.resolve(captured), owner.signal);
      if (!current()) return false;
      const result = await new Promise<EnvironmentalWorkResult>((resolve, reject) => {
        const worker = this.factory(); let done = false, validating = false;
        const finish = (value?: EnvironmentalWorkResult, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', abort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* The operation still relinquishes ownership. */ }
          if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(undefined, cancelled());
        owner.signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
          if (done || validating || !current()) return;
          const message = event.data;
          if (message?.kind === 'progress' && typeof message.phase === 'string') { this.publish({ phase: message.phase }); return; }
          if (message?.kind === 'error' && typeof message.message === 'string') { finish(undefined, new Error(message.message)); return; }
          if (message?.kind !== 'result') { finish(undefined, new Error('Unsupported environmental worker response.')); return; }
          validating = true;
          void validateReply(message.result, request).then(() => {
            if (!done && current()) finish(message.result);
          }, cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
        };
        worker.onerror = event => { event.preventDefault(); finish(undefined, new Error(`Environmental worker failed: ${event.message}`)); };
        worker.onmessageerror = () => finish(undefined, new Error('Environmental worker response could not be decoded.'));
        try { if (owner.signal.aborted) abort(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.publish({ accepted: result, notice: result.verified
        ? 'Verified replay: fresh sample summaries and the complete saved identity match.'
        : result.analysis ? 'Analysis complete. Display and exports refer to these exact samples.'
        : 'Dataset loaded. Review its query, source and measurements, then analyze.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'Environmental operation failed.' });
      return false;
    } finally {
      if (current()) { this.operation = null; this.publish({ loading: false, phase: null }); }
    }
  };
}
