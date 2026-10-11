/** Local aligned-DNA workspace; synchronous inference runs only in a disposable worker. */
import type { AlignedPhylogenyExperiment, PhylogenyOptions, PhylogenySource } from '../../../core/src/analysis/aligned-phylogeny';
import type { OutgroupRooting, RootedPhylogenyExperiment } from '../../../core/src/analysis/phylogeny-rooting';

/** Keep original inference distinct from the optional, user-conditioned root record. */
export interface AlignedPhylogenyWorkResult extends AlignedPhylogenyExperiment {
  rooting?: Pick<RootedPhylogenyExperiment, 'record' | 'result'>;
}
function withRoot(rooted: RootedPhylogenyExperiment): AlignedPhylogenyWorkResult {
  return { ...rooted.unrooted, rooting: { record: rooted.record, result: rooted.result } };
}

export type AlignedPhylogenyRequest =
  | { kind: 'infer'; source: PhylogenySource; options: PhylogenyOptions }
  | { kind: 'replay'; content: string }
  | { kind: 'root'; content: string; rooting: OutgroupRooting };
export type AlignedPhylogenyMessage =
  | { kind: 'progress'; phase: string }
  | { kind: 'result'; experiment: AlignedPhylogenyWorkResult; verified: boolean }
  | { kind: 'error'; message: string };
export interface AlignedPhylogenyWorker {
  postMessage(request: AlignedPhylogenyRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<AlignedPhylogenyMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export interface AlignedPhylogenySnapshot {
  accepted: AlignedPhylogenyWorkResult | null;
  verified: boolean;
  busy: boolean;
  phase: string;
  error: string | null;
}

/** Worker and tests call the real inference/replay APIs. No cached result is installed on replay. */
export async function executeAlignedPhylogenyRequest(request: AlignedPhylogenyRequest,
  progress: (phase: string) => void = () => {}): Promise<AlignedPhylogenyWorkResult> {
  const { createAlignedPhylogenyExperiment, replayAlignedPhylogenyExperiment } = await import('../../../core/src/analysis/aligned-phylogeny');
  if (!request || typeof request !== 'object') throw new Error('Unsupported aligned-phylogeny request.');
  if (request.kind === 'infer') {
    progress('Checking aligned DNA and computing distances, tree and requested site resampling');
    return createAlignedPhylogenyExperiment(request.source, request.options);
  }
  if (request.kind === 'replay' || request.kind === 'root') {
    if (typeof request.content !== 'string' || request.content.length > 10 * 1024 * 1024
      || new TextEncoder().encode(request.content).length > 10 * 1024 * 1024) throw new Error('Saved phylogeny exceeds the 10 MiB limit.');
    const content = request.content.replace(/^\uFEFF/, '');
    if (request.kind === 'root') {
      progress('Recomputing the original tree and recording the explicit outgroup root');
      const { rootAlignedPhylogenyExperiment } = await import('../../../core/src/analysis/phylogeny-rooting');
      return withRoot(await rootAlignedPhylogenyExperiment(content, request.rooting));
    }
    const value: unknown = JSON.parse(content);
    const method = value && typeof value === 'object' && 'method' in value ? value.method : null;
    if (method && typeof method === 'object' && 'id' in method && method.id === 'explicit-outgroup-rooted-nj') {
      progress('Recomputing the original inference and the saved root hypothesis');
      const { replayRootedPhylogenyExperiment } = await import('../../../core/src/analysis/phylogeny-rooting');
      return withRoot(await replayRootedPhylogenyExperiment(content));
    }
    progress('Verifying exact input identities and independently recomputing the saved tree');
    return replayAlignedPhylogenyExperiment(content);
  }
  throw new Error('Unsupported aligned-phylogeny operation.');
}

/** Fatal UTF-8 decoding, not File.text() replacement characters inside private sequence data. */
export async function readAlignedPhylogenyFile(file: Pick<File, 'size' | 'arrayBuffer'>, maximum: number): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum) {
    throw new Error(`Input exceeds the ${maximum}-byte limit.`);
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > maximum) throw new Error(`Input exceeds the ${maximum}-byte limit.`);
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function cancelled(): DOMException { return new DOMException('Aligned phylogeny cancelled.', 'AbortError'); }
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

/** One owner per file-read/inference operation, including during React strict-mode remounts. */
export class AlignedPhylogenySession {
  private active = false;
  private operation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: AlignedPhylogenySnapshot = { accepted: null, verified: false, busy: false, phase: '', error: null };
  constructor(private readonly factory: () => AlignedPhylogenyWorker) {}
  getSnapshot = (): AlignedPhylogenySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<AlignedPhylogenySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const previous = this.operation; this.operation = null; previous?.abort();
    this.publish({ busy: false, phase: previous ? 'Cancelled. No partial inference was accepted.' : '' });
  };
  /** Edits cannot leave a previous result/export labeled as the new draft. */
  invalidate = (): void => {
    this.cancel(); this.publish({ accepted: null, verified: false, error: null, phase: '' });
  };
  run = async (input: AlignedPhylogenyRequest | (() => Promise<AlignedPhylogenyRequest>)): Promise<boolean> => {
    if (!this.active) return false;
    // A root is a derivative of an accepted inference, not an input edit. Keep
    // the original visible if the new hypothesis fails or is cancelled.
    if (typeof input !== 'function' && input.kind === 'root') { this.cancel(); this.publish({ error: null, phase: '' }); }
    else this.invalidate();
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    this.publish({ busy: true, phase: 'Reading local alignment or saved experiment' });
    try {
      // Clone immediate inputs before yielding, and clone delayed inputs once their read finishes.
      const pending = typeof input === 'function' ? input().then(value => structuredClone(value)) : Promise.resolve(structuredClone(input));
      const request = await untilCancelled(pending, owner.signal);
      if (!current()) return false;
      const experiment = await new Promise<AlignedPhylogenyWorkResult>((resolve, reject) => {
        const worker = this.factory(); let done = false;
        const finish = (value?: AlignedPhylogenyWorkResult, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', onAbort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* Termination failure must not strand this operation. */ }
          if (error) reject(error); else resolve(value!);
        };
        const onAbort = () => finish(undefined, cancelled());
        owner.signal.addEventListener('abort', onAbort, { once: true });
        worker.onmessage = event => {
          if (done || !current()) return;
          const message = event.data;
          if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
          else if (message?.kind === 'result' && message.verified === (request.kind === 'replay')
            && message.experiment?.record?.method?.id === 'aligned-dna-neighbor-joining'
            && Array.isArray(message.experiment.result?.tree?.nodes)
            && (request.kind !== 'root' || !!message.experiment.rooting)
            && (request.kind !== 'infer' || !message.experiment.rooting)
            && (!message.experiment.rooting || (message.experiment.rooting.record?.method?.id === 'explicit-outgroup-rooted-nj'
              && message.experiment.rooting.result?.sourceResultId === message.experiment.record.resultId))) finish(message.experiment);
          else if (message?.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
          else finish(undefined, new Error('Unexpected aligned-phylogeny worker response.'));
        };
        worker.onerror = () => finish(undefined, new Error('Aligned-phylogeny worker failed. Retry the local operation.'));
        worker.onmessageerror = () => finish(undefined, new Error('Aligned-phylogeny response could not be read.'));
        try { if (owner.signal.aborted) onAbort(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.publish({ accepted: experiment, verified: request.kind === 'replay', phase: request.kind === 'replay'
        ? experiment.rooting ? 'Replay verified: original inference and explicit root hypothesis match.' : 'Replay verified: recomputed tree and complete evidence identity match.'
        : experiment.rooting ? 'Explicit root hypothesis computed. The original unrooted inference is retained.' : 'Unrooted tree computed. Inspect coverage, branch lengths and split support.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause), phase: '' });
      return false;
    } finally {
      if (current()) { this.operation = null; this.publish({ busy: false }); }
    }
  };
}
