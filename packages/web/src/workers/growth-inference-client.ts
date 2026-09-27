import type { GrowthRequest, GrowthMessage, GrowthWorkResult } from './growth-inference.worker';
export type GrowthWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;

/** One file read + one computation. Abort also prevents a delayed read from creating a worker. */
export function runGrowthWork(
  request: GrowthRequest | Promise<GrowthRequest>, signal: AbortSignal,
  report: (message: string) => void = () => {},
  createWorker: () => GrowthWorker = () => new Worker(new URL('./growth-inference.worker.ts', import.meta.url), { type: 'module' }),
): Promise<GrowthWorkResult> {
  return new Promise((resolve, reject) => {
    let worker: GrowthWorker | null = null, done = false;
    const finish = (value?: GrowthWorkResult, cause?: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', cancel);
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
      if (cause) reject(cause); else resolve(value!);
    };
    const cancel = () => finish(undefined, new DOMException('Growth operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    // Always observe the input promise, including when it rejects after cancellation.
    void Promise.resolve(request).then(value => {
      if (done || signal.aborted) return;
      worker = createWorker();
      if (done || signal.aborted) { worker.terminate(); return; }
      worker.onmessage = (event: MessageEvent<GrowthMessage>) => {
        if (done || signal.aborted) return;
        const message = event.data;
        if (!message || typeof message !== 'object') { finish(undefined, new Error('Unexpected growth-worker response.')); return; }
        if (message.kind === 'progress' && typeof message.message === 'string') {
          try { report(message.message); }
          catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
        } else if (message.kind === 'result' && message.value && typeof message.value === 'object') finish(message.value);
        else if (message.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
        else finish(undefined, new Error('Unexpected growth-worker response.'));
      };
      worker.onerror = () => finish(undefined, new Error('Growth worker failed. The previous data and result were preserved.'));
      worker.onmessageerror = () => finish(undefined, new Error('Growth worker response could not be decoded.'));
      if (signal.aborted) cancel(); else worker.postMessage(value);
    }).catch(cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
  });
}
