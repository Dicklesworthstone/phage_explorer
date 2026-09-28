/** A local host-model experiment; no dependency on the currently selected phage. */
import { analyzeHostMetabolism, createHostFluxRecord, parseCobraHostModel, replayHostFluxRecord,
  resolveHostFluxOptions, validateHostModelInput, type HostFluxOptions, type HostFluxResult,
  type HostModelInput, type HostModelSource, type HostNetwork } from '../../../core/src/analysis/host-metabolism';
import { parseAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { analyzeHostGeneKnockouts, createHostGeneRecord, replayHostGeneRecord, HOST_KNOCKOUT_METHOD, type HostGeneResult } from '../../../core/src/analysis/host-gene-knockout';

export type HostMetabolismRequest =
  | { kind: 'import'; content: string }
  | { kind: 'prepare'; content: string; source: HostModelSource; medium: HostModelInput['medium'] }
  | { kind: 'analyze'; input: HostModelInput; options: Partial<HostFluxOptions> }
  | { kind: 'knockout'; input: HostModelInput; options: unknown };
export interface HostMetabolismWork { input: HostModelInput; network: HostNetwork; options: HostFluxOptions;
  result: HostFluxResult | null; record: AnalysisRecord | null; verified: boolean; geneResult?: HostGeneResult }
export type HostMetabolismMessage = { kind: 'progress'; phase: string } | { kind: 'result'; value: HostMetabolismWork } | { kind: 'error'; message: string };

export async function executeHostMetabolismRequest(request: HostMetabolismRequest, progress: (phase: string) => void = () => {}): Promise<HostMetabolismWork> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported host-model request.');
  progress('Validating model, medium and source evidence');
  let input: HostModelInput;
  if (request.kind === 'import' || request.kind === 'prepare') {
    const limit = request.kind === 'prepare' ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
    if (typeof request.content !== 'string' || new TextEncoder().encode(request.content).length > limit) throw new Error('Host-model input exceeds the file size limit.');
    const content = request.content.replace(/^\uFEFF/, '');
    const decoded: unknown = JSON.parse(content);
    if (request.kind === 'import' && decoded && typeof decoded === 'object' && 'format' in decoded && decoded.format === 'phage-explorer-analysis') {
      progress('Verifying saved identities and recomputing model scenarios');
      const saved = await parseAnalysisRecord(content);
      if (saved.method.id === HOST_KNOCKOUT_METHOD.id) {
        const replay = await replayHostGeneRecord(content, progress);
        return { input: replay.input, network: parseCobraHostModel(replay.input.cobra), options: resolveHostFluxOptions(),
          result: null, geneResult: replay.result, record: replay.record, verified: true };
      }
      const replay = await replayHostFluxRecord(content, progress);
      return { ...replay, network: parseCobraHostModel(replay.input.cobra), options: replay.result.options, verified: true };
    }
    input = validateHostModelInput(request.kind === 'prepare'
      ? { format: 'phage-explorer-host-model', version: 1, source: request.source, medium: request.medium, cobra: decoded } : decoded);
  } else if (request.kind === 'analyze') {
    input = validateHostModelInput(request.input);
    const result = analyzeHostMetabolism(input, request.options, progress);
    progress('Binding source model, medium, mappings and numerical results');
    return { input, network: parseCobraHostModel(input.cobra), options: result.options, result,
      record: await createHostFluxRecord(input, result), verified: false };
  } else if (request.kind === 'knockout') {
    input = validateHostModelInput(request.input);
    const geneResult = analyzeHostGeneKnockouts(input, request.options, progress);
    return { input, network: parseCobraHostModel(input.cobra), options: resolveHostFluxOptions(),
      result: null, geneResult, record: await createHostGeneRecord(input, geneResult), verified: false };
  } else throw new Error('Unsupported host-model operation.');
  return { input, network: parseCobraHostModel(input.cobra), options: resolveHostFluxOptions(), result: null, record: null, verified: false };
}
export interface HostMetabolismWorker {
  postMessage: (request: HostMetabolismRequest) => void; terminate: () => void;
  onmessage: ((event: MessageEvent<HostMetabolismMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null; onmessageerror: ((event: MessageEvent) => void) | null;
}
interface Snapshot { accepted: HostMetabolismWork | null; busy: boolean; phase: string; error: string | null; notice: string | null }
const abort = () => new DOMException('Host-model work cancelled', 'AbortError');
function readable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abort());
    if (signal.aborted) { void work.catch(() => {}); reject(abort()); return; }
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
      error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}
export class HostMetabolismSession {
  private active = false;
  private owner: AbortController | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { accepted: null, busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => HostMetabolismWorker) {}
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<Snapshot>): void { this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener(); }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const old = this.owner; this.owner = null; old?.abort();
    this.publish({ busy: false, phase: '', ...(old ? { notice: 'Host-model work cancelled; accepted evidence was preserved.' } : {}) });
  };
  run = async (input: HostMetabolismRequest | Promise<HostMetabolismRequest>): Promise<void> => {
    if (!this.active) { if (input instanceof Promise) void input.catch(() => {}); return; }
    this.cancel(); const owner = new AbortController(); this.owner = owner;
    const current = () => this.active && this.owner === owner && !owner.signal.aborted;
    this.publish({ busy: true, error: null, notice: null, phase: 'Reading local model input' });
    try {
      const request = await readable(input instanceof Promise ? input.then(value => structuredClone(value)) : Promise.resolve(structuredClone(input)), owner.signal);
      if (!current()) return;
      const value = await new Promise<HostMetabolismWork>((resolve, reject) => {
        const worker = this.factory(); let done = false;
        const finish = (value?: HostMetabolismWork, error?: Error) => {
          if (done) return; done = true; owner.signal.removeEventListener('abort', cancel); worker.terminate();
          if (error) reject(error); else resolve(value!);
        };
        const cancel = () => finish(undefined, abort()); owner.signal.addEventListener('abort', cancel, { once: true });
        worker.onmessage = event => {
          if (done || !current()) return;
          const message = event.data;
          if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
          else if (message?.kind === 'result' && message.value?.input && message.value.network && message.value.options) finish(message.value);
          else if (message?.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
          else finish(undefined, new Error('Unexpected host-model worker response.'));
        };
        worker.onerror = () => finish(undefined, new Error('Host-model worker failed. Retry the local operation.'));
        worker.onmessageerror = () => finish(undefined, new Error('Host-model worker response could not be read.'));
        try { if (owner.signal.aborted) cancel(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (current()) this.publish({ accepted: value, notice: value.verified
        ? 'Verified host-model replay: fresh scenarios, flux ranges and complete evidence identity match.'
        : value.record ? 'Host-model scenarios computed. Inspect each solver status and the recorded assumptions.' : 'Host model loaded. Review source and medium, then run the model.' });
    } catch (cause) { if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); }
    finally { if (current()) { this.owner = null; this.publish({ busy: false, phase: '' }); } }
  };
}
