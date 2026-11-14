/** Local mutational assays and accepted results belong to one disposable worker job. */
import { analysisJson, parseAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import {
  EPISTASIS_ASSAY_METHOD, validateEpistasisAssayDataset, parseEpistasisAssayDataset, resolveEpistasisAssayOptions,
  createEpistasisAssayExperiment, replayEpistasisAssayExperiment,
  type EpistasisAssayDataset, type EpistasisAssayOptions,
} from '../../../core/src/analysis/epistasis-evidence';

export const EPISTASIS_FILE_LIMIT = 10 * 1024 * 1024;
export type EpistasisAssayResult = Awaited<ReturnType<typeof createEpistasisAssayExperiment>>['result'];
export type EpistasisEvidenceRequest =
  | { kind: 'import' | 'replay'; content: string }
  | { kind: 'analyze'; dataset: EpistasisAssayDataset; options: EpistasisAssayOptions };
export interface EpistasisEvidenceResult {
  dataset: EpistasisAssayDataset;
  options: EpistasisAssayOptions;
  result: EpistasisAssayResult | null;
  record: AnalysisRecord | null;
  verified: boolean;
}
export type EpistasisEvidenceMessage =
  | { kind: 'progress'; phase: string }
  | { kind: 'result'; result: EpistasisEvidenceResult }
  | { kind: 'error'; message: string };

export function epistasisInputText(content: unknown): string {
  if (typeof content !== 'string' || content.length > EPISTASIS_FILE_LIMIT
    || new TextEncoder().encode(content).length > EPISTASIS_FILE_LIMIT) {
    throw new Error('Epistasis input exceeds the 10 MiB file limit.');
  }
  return content.replace(/^\uFEFF/, '');
}
export async function readEpistasisEvidenceFile(file: Pick<File, 'size' | 'arrayBuffer'>): Promise<string> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > EPISTASIS_FILE_LIMIT) {
    throw new Error('Epistasis input exceeds the 10 MiB file limit.');
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > EPISTASIS_FILE_LIMIT) throw new Error('Epistasis input exceeds the 10 MiB file limit.');
  return epistasisInputText(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Shared by the real worker and its tests; importing a dataset performs no fitting. */
export async function executeEpistasisEvidenceRequest(request: EpistasisEvidenceRequest,
  progress: (phase: string) => void = () => {}): Promise<EpistasisEvidenceResult> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported epistasis operation.');
  if (request.kind === 'analyze') {
    const dataset = validateEpistasisAssayDataset(request.dataset);
    const options = resolveEpistasisAssayOptions(request.options);
    progress('Computing supplied wild-type, single and double mutant contrasts');
    const experiment = await createEpistasisAssayExperiment(dataset, options, progress);
    return { ...experiment, options, verified: false };
  }
  if (request.kind !== 'import' && request.kind !== 'replay') throw new Error('Unsupported epistasis operation.');
  const content = epistasisInputText(request.content);
  const value: unknown = JSON.parse(content);
  if (request.kind === 'replay' || value && typeof value === 'object' && 'format' in value && value.format === 'phage-explorer-analysis') {
    progress('Recomputing saved assay contrasts and uncertainty from the exact observations');
    const experiment = await replayEpistasisAssayExperiment(content, progress);
    return { ...experiment, options: resolveEpistasisAssayOptions(experiment.record.parameters), verified: true };
  }
  progress('Checking assay identity, residue substitutions and replicate measurements');
  return { dataset: parseEpistasisAssayDataset(content), options: resolveEpistasisAssayOptions(),
    result: null, record: null, verified: false };
}

export interface EpistasisEvidenceWorker {
  postMessage(request: EpistasisEvidenceRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<EpistasisEvidenceMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export interface EpistasisEvidenceSnapshot {
  accepted: EpistasisEvidenceResult | null;
  busy: boolean;
  phase: string | null;
  error: string | null;
  notice: string | null;
}
const cancelled = () => new DOMException('Epistasis operation cancelled.', 'AbortError');
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

/** Validate the transport's source/result binding without duplicating the worker's calculation. */
async function validateReply(result: EpistasisEvidenceResult, request: EpistasisEvidenceRequest): Promise<void> {
  if (!result || typeof result !== 'object' || typeof result.verified !== 'boolean') throw new Error('Invalid epistasis worker reply.');
  const dataset = validateEpistasisAssayDataset(result.dataset);
  const options = resolveEpistasisAssayOptions(result.options);
  if (!same(dataset, result.dataset) || !same(options, result.options)) throw new Error('Epistasis worker reply is not canonical.');
  if (request.kind === 'analyze' && (!same(dataset, validateEpistasisAssayDataset(request.dataset))
    || !same(options, resolveEpistasisAssayOptions(request.options)))) {
    throw new Error('Epistasis reply changed the submitted assay or analysis settings.');
  }
  let saved: AnalysisRecord | null = null;
  if (request.kind === 'import' || request.kind === 'replay') {
    const content = epistasisInputText(request.content), value = JSON.parse(content);
    if (value?.format === 'phage-explorer-analysis') {
      saved = await parseAnalysisRecord(content, { methodId: EPISTASIS_ASSAY_METHOD.id, methodVersion: EPISTASIS_ASSAY_METHOD.version });
      if (!same(saved.inputs[0]?.data, dataset) || !same(saved.parameters, options)) throw new Error('Epistasis reply changed the saved input or settings.');
    } else if (request.kind === 'replay' || !same(parseEpistasisAssayDataset(content), dataset)) {
      throw new Error('Epistasis reply does not match the imported assay.');
    }
  }
  const expectedAnalysis = request.kind === 'analyze' || saved !== null;
  const hasResult = result.result !== null && typeof result.result === 'object' && !Array.isArray(result.result);
  const hasRecord = result.record !== null && typeof result.record === 'object' && !Array.isArray(result.record);
  if (result.verified !== (saved !== null) || (expectedAnalysis
    ? !hasResult || !hasRecord : result.result !== null || result.record !== null)) {
    throw new Error('Unexpected epistasis analysis state.');
  }
  if (result.record) {
    const record = await parseAnalysisRecord(JSON.stringify(result.record), { methodId: EPISTASIS_ASSAY_METHOD.id, methodVersion: EPISTASIS_ASSAY_METHOD.version });
    if (!same(record.method, EPISTASIS_ASSAY_METHOD) || !same(record.parameters, options) || record.seed !== options.seed
      || record.inputs.length !== 1 || record.inputs[0].id !== 'assay'
      || record.inputs[0].source !== dataset.source.kind || record.inputs[0].accession !== dataset.protein.accession
      || !same(record.inputs[0].data, dataset) || !same(record.fields.result?.value, result.result)
      || record.fields.result.kind !== (dataset.source.kind === 'demo' ? 'demo' : 'fitted-estimate')
      || record.fields.observations?.kind !== (dataset.source.kind === 'demo' ? 'demo' : 'observation')
      || !same(record.fields.observations?.value, result.result?.observations)
      || saved !== null && saved.resultId !== record.resultId) {
      throw new Error('Epistasis evidence differs from its source, method or accepted result identity.');
    }
  }
}

export class EpistasisEvidenceSession {
  private active = false;
  private operation: AbortController | null = null;
  private snapshot: EpistasisEvidenceSnapshot = { accepted: null, busy: false, phase: null, error: null, notice: null };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly factory: () => EpistasisEvidenceWorker) {}
  getSnapshot = (): EpistasisEvidenceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  private publish(update: Partial<EpistasisEvidenceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  cancel = (): void => {
    const prior = this.operation; this.operation = null; prior?.abort();
    this.publish({ busy: false, phase: null, ...(prior ? { notice: 'Cancelled. The accepted assay and result are unchanged.' } : {}) });
  };
  importFile = (file: Pick<File, 'size' | 'arrayBuffer'>): Promise<boolean> =>
    this.run(async () => ({ kind: 'import', content: await readEpistasisEvidenceFile(file) }));

  run = async (input: EpistasisEvidenceRequest | ((signal: AbortSignal) => Promise<EpistasisEvidenceRequest>)): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    this.publish({ busy: true, phase: 'Reading local assay input', error: null, notice: null });
    try {
      const captured = typeof input === 'function' ? input : structuredClone(input);
      const request = await abortable(typeof captured === 'function'
        ? captured(owner.signal).then(value => structuredClone(value)) : Promise.resolve(captured), owner.signal);
      if (!current()) return false;
      const result = await new Promise<EpistasisEvidenceResult>((resolve, reject) => {
        const worker = this.factory(); let done = false, validating = false;
        const finish = (value?: EpistasisEvidenceResult, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', abort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* The job still relinquishes ownership. */ }
          if (error) reject(error); else resolve(value!);
        };
        const abort = () => finish(undefined, cancelled());
        owner.signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
          if (done || validating || !current()) return;
          const message = event.data;
          if (message?.kind === 'progress' && typeof message.phase === 'string') { this.publish({ phase: message.phase }); return; }
          if (message?.kind === 'error' && typeof message.message === 'string') { finish(undefined, new Error(message.message)); return; }
          if (message?.kind !== 'result') { finish(undefined, new Error('Unsupported epistasis worker response.')); return; }
          validating = true;
          void validateReply(message.result, request).then(() => {
            if (!done && current()) finish(message.result);
          }, cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
        };
        worker.onerror = event => { event.preventDefault(); finish(undefined, new Error('Epistasis worker failed: ' + event.message)); };
        worker.onmessageerror = () => finish(undefined, new Error('Epistasis worker response could not be decoded.'));
        try { if (owner.signal.aborted) abort(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.publish({ accepted: result, notice: result.verified
        ? 'Verified replay: the supplied observations reproduce the saved contrasts, uncertainty and complete identity.'
        : result.result ? 'Analysis complete. Results and exports belong to the accepted assay and settings.'
        : 'Dataset loaded. Review its protein, source, scale and replicate design before analyzing.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'Epistasis operation failed.' });
      return false;
    } finally {
      if (current()) { this.operation = null; this.publish({ busy: false, phase: null }); }
    }
  };
}
