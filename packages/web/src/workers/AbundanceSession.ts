/** One local abundance workspace; replacement is atomic and only one worker is active. */
import type { AbundanceRequest, AbundanceWorkResult, AbundanceWorkerMessage } from './abundance-runtime';

export interface AbundanceSnapshot {
  accepted: AbundanceWorkResult | null;
  loading: boolean;
  phase: string | null;
  error: string | null;
  notice: string | null;
}
type Endpoint = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
type Operation = { worker: Endpoint | null; finish: (() => void) | null };

export class AbundanceSession {
  private active = false;
  private operation: Operation | null = null;
  private snapshot: AbundanceSnapshot = { accepted: null, loading: false, phase: null, error: null, notice: null };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly createWorker: () => Endpoint) {}
  getSnapshot = (): AbundanceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  private publish(update: Partial<AbundanceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private stop(): void {
    const op = this.operation;
    this.operation = null;
    if (op?.worker) {
      op.worker.onmessage = null; op.worker.onerror = null; op.worker.onmessageerror = null;
      op.worker.terminate();
    }
    op?.finish?.();
  }
  cancel = (): void => {
    const pending = this.operation !== null;
    this.stop();
    this.publish({ loading: false, phase: null, ...(pending ? { notice: 'Cancelled. The last accepted dataset and result are unchanged.' } : {}) });
  };
  run = async (request: AbundanceRequest | Promise<AbundanceRequest>): Promise<void> => {
    // Observe rejected file reads even if an old/unmounted UI invokes this method.
    if (!this.active) { await Promise.resolve(request).catch(() => {}); return; }
    this.stop();
    const op: Operation = { worker: null, finish: null };
    this.operation = op;
    const current = () => this.active && this.operation === op;
    this.publish({ loading: true, phase: 'Reading local input', error: null, notice: null });
    try {
      const submitted = request instanceof Promise ? await request : structuredClone(request);
      if (!current()) return;
      const worker = this.createWorker(); op.worker = worker;
      await new Promise<void>((resolve, reject) => {
        op.finish = resolve;
        worker.onmessage = (event: MessageEvent<AbundanceWorkerMessage>) => {
          if (!current()) return;
          const message = event.data;
          if (message.kind === 'progress') this.publish({ phase: message.phase });
          else if (message.kind === 'error') reject(new Error(message.message));
          else if (message.kind === 'result') {
            this.publish({ accepted: message.result, notice: message.result.verified
              ? 'Verified replay: recomputed values and complete analysis identity match.'
              : message.result.analysis ? 'Analysis complete. Display and exports use these submitted parameters.'
              : 'Dataset loaded. Review the parameters, then run the analysis.' });
            resolve();
          } else reject(new Error('Unsupported abundance worker response.'));
        };
        worker.onerror = event => { event.preventDefault(); reject(new Error(`Abundance worker failed: ${event.message}`)); };
        worker.onmessageerror = () => reject(new Error('Could not deserialize the abundance worker response.'));
        worker.postMessage(structuredClone(submitted));
      });
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'Abundance operation failed.' });
    } finally {
      if (current()) { this.stop(); this.publish({ loading: false, phase: null }); }
    }
  };
}
