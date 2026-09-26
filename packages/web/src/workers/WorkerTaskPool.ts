/** Bounded, FIFO worker scheduling with cancellation of queued and running work. */
interface PendingTask<K, R> {
  kind: K;
  execute: (resource: R) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  entry?: PoolEntry<K, R>;
  settled: boolean;
}

interface PoolEntry<K, R> {
  kind: K;
  resource: R;
  lastUsed: number;
  task: PendingTask<K, R> | null;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * A resource belongs to exactly one task until that task settles. Cancellation
 * destroys a running worker: posting a cancel message cannot interrupt a
 * synchronous WASM/JavaScript calculation already executing in that worker.
 */
export class WorkerTaskPool<K, R> {
  private readonly entries = new Set<PoolEntry<K, R>>();
  private readonly pending: PendingTask<K, R>[] = [];
  private draining = false;
  private disposed = false;

  constructor(
    private readonly capacity: number,
    private readonly create: (kind: K) => R,
    private readonly destroy: (resource: R) => void,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Worker pool capacity must be a positive safe integer.');
    }
  }

  run<T>(kind: K, execute: (resource: R) => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(abortError('Worker pool has been disposed.'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError('Worker task aborted.'));

    return new Promise<T>((resolve, reject) => {
      const task: PendingTask<K, R> = {
        kind, execute, resolve: value => resolve(value as T), reject, signal, settled: false,
      };
      task.onAbort = () => this.finish(task, false, signal?.reason ?? abortError('Worker task aborted.'), true);
      this.pending.push(task);
      signal?.addEventListener('abort', task.onAbort, { once: true });
      this.drain();
    });
  }

  /** Reject a task when the browser reports an error outside its RPC promise. */
  invalidate(resource: R, error: Error): void {
    const entry = [...this.entries].find(candidate => candidate.resource === resource);
    if (!entry) return;
    if (entry.task) this.finish(entry.task, false, error, true);
    else {
      this.remove(entry);
      this.drain();
    }
  }

  getStats(): { total: number; busy: number; queued: number; byType: Map<K, { total: number; busy: number }> } {
    const byType = new Map<K, { total: number; busy: number }>();
    let busy = 0;
    for (const entry of this.entries) {
      const counts = byType.get(entry.kind) ?? { total: 0, busy: 0 };
      counts.total++;
      if (entry.task) { counts.busy++; busy++; }
      byType.set(entry.kind, counts);
    }
    return { total: this.entries.size, busy, queued: this.pending.length, byType };
  }

  /** Keep one warm worker of each kind, without ever interrupting active work. */
  pruneIdle(idleTimeout: number, now = Date.now()): void {
    const counts = this.getStats().byType;
    for (const entry of this.entries) {
      const count = counts.get(entry.kind)!;
      if (!entry.task && now - entry.lastUsed > idleTimeout && count.total > 1) {
        this.remove(entry);
        count.total--;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const reason = abortError('Worker pool has been disposed.');
    for (const task of [...this.pending]) this.finish(task, false, reason, false);
    for (const entry of [...this.entries]) {
      if (entry.task) this.finish(entry.task, false, reason, false);
      this.remove(entry);
    }
  }

  private remove(entry: PoolEntry<K, R>): void {
    // Remove ownership before termination; an error/late RPC cannot release it twice.
    if (!this.entries.delete(entry)) return;
    try { this.destroy(entry.resource); } catch { /* Cleanup must not strand queued promises. */ }
  }

  private finish(task: PendingTask<K, R>, success: boolean, value: unknown, discard: boolean): void {
    if (task.settled) return;
    task.settled = true;
    if (task.onAbort) task.signal?.removeEventListener('abort', task.onAbort);
    const index = this.pending.indexOf(task);
    if (index !== -1) this.pending.splice(index, 1);
    if (task.entry) {
      task.entry.task = null;
      task.entry.lastUsed = Date.now();
      if (discard) this.remove(task.entry);
    }
    if (success) task.resolve(value);
    else task.reject(value);
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (this.pending.length > 0 && !this.disposed) {
        const task = this.pending[0];
        let entry = [...this.entries].find(candidate => candidate.kind === task.kind && !candidate.task);
        if (!entry && this.entries.size >= this.capacity) {
          // At the global cap, replace an idle worker of the other kind. A
          // one-worker configuration must still run both analyses and simulations.
          const idle = [...this.entries].find(candidate => !candidate.task);
          if (!idle) break;
          this.remove(idle);
        }
        this.pending.shift();
        if (!entry) {
          try {
            entry = { kind: task.kind, resource: this.create(task.kind), lastUsed: Date.now(), task: null };
            this.entries.add(entry);
          } catch (error) {
            this.finish(task, false, error, false);
            continue;
          }
        }
        entry.task = task;
        task.entry = entry;
        try {
          Promise.resolve(task.execute(entry.resource)).then(
            value => this.finish(task, true, value, false),
            error => this.finish(task, false, error, true),
          );
        } catch (error) {
          this.finish(task, false, error, true);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
