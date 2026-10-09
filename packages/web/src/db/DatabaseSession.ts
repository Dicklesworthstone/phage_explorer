/** Shared lifetime for live SQLite handles, not serializable React Query data. */
import type { DatabaseLoadProgress, PhageRepository } from './types';

export interface DatabaseSessionLoader {
  load(options: { forceDownload: boolean }): Promise<PhageRepository>;
  /** Owns all handles, including a load completing after cancellation. */
  close(): Promise<void>;
}
export type DatabaseSessionLoaderFactory = (url: string, progress: (value: DatabaseLoadProgress) => void) => DatabaseSessionLoader;
export interface DatabaseSessionSnapshot {
  repository: PhageRepository | null;
  isLoading: boolean;
  isFetching: boolean;
  progress: DatabaseLoadProgress | null;
  error: string | null;
  isCached: boolean;
}
const empty = (): DatabaseSessionSnapshot => ({ repository: null, isLoading: false, isFetching: false,
  progress: null, error: null, isCached: false });
const aborted = (): DOMException => new DOMException('Database request superseded or released.', 'AbortError');
function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  });
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
interface Candidate { loader: DatabaseSessionLoader; closing: Promise<void> | null }
interface Resource {
  candidate: Candidate;
  repository: PhageRepository;
  readers: number;
  calls: number;
  current: boolean;
  disposed: boolean;
  progress: DatabaseLoadProgress | null;
  cached: boolean;
}
interface Operation { controller: AbortController; force: boolean; candidate: Candidate | null; done: Promise<void> }
interface Reader { notify: () => void; resource: Resource | null }
export interface DatabaseSessionObserver {
  subscribe(notify: () => void): () => void;
  getSnapshot(): DatabaseSessionSnapshot;
  /** Call after React commits this snapshot, not during render. */
  commit(repository: PhageRepository | null): void;
}

/**
 * One accepted immutable repository snapshot, one owned load/refresh, many readers.
 * Refresh never closes a snapshot still displayed by a reader or used by a query.
 * Final unsubscribe releases resources after one task (StrictMode can reattach).
 */
export class DatabaseSession {
  private snapshot = empty();
  private current: Resource | null = null;
  private operation: Operation | null = null;
  private readonly readers = new Set<Reader>();
  private readonly resources = new Map<PhageRepository, Resource>();
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly factory: DatabaseSessionLoaderFactory,
    private readonly retryDelayMs = 1000) {
    if (!url || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) throw new Error('Invalid database session configuration.');
  }
  getSnapshot = (): DatabaseSessionSnapshot => this.snapshot;
  private publish(update: Partial<DatabaseSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const reader of [...this.readers]) if (this.readers.has(reader)) reader.notify();
  }
  createObserver(): DatabaseSessionObserver {
    let reader: Reader | null = null;
    return {
      getSnapshot: this.getSnapshot,
      subscribe: notify => {
        if (reader) throw new Error('Database observer is already subscribed.');
        if (this.releaseTimer !== null) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
        const attached: Reader = { notify, resource: this.current };
        reader = attached;
        if (attached.resource) attached.resource.readers++;
        this.readers.add(attached);
        return () => {
          if (reader !== attached) return;
          reader = null;
          this.readers.delete(attached);
          if (attached.resource) { attached.resource.readers--; this.collect(attached.resource); }
          if (!this.readers.size) {
            this.releaseTimer = setTimeout(() => {
              this.releaseTimer = null;
              if (!this.readers.size) this.release();
            }, 0);
          }
        };
      },
      commit: repository => {
        if (!reader) return;
        const next = repository ? this.resources.get(repository) : null;
        // An abandoned concurrent render must not resurrect a released snapshot.
        if (repository && (!next || next.disposed)) return;
        if (next === reader.resource) return;
        if (next) next.readers++;
        const previous = reader.resource;
        reader.resource = next ?? null;
        if (previous) { previous.readers--; this.collect(previous); }
      },
    };
  }
  private close(candidate: Candidate): Promise<void> {
    if (!candidate.closing) {
      // Mark ownership released before invoking potentially synchronous cleanup.
      candidate.closing = Promise.resolve().then(() => candidate.loader.close()).catch(() => {
        // Cleanup failure cannot make the released handle reusable.
      });
    }
    return candidate.closing;
  }
  private collect(resource: Resource): void {
    if (resource.current || resource.readers || resource.calls || resource.disposed) return;
    resource.disposed = true;
    this.resources.delete(resource.repository);
    void this.close(resource.candidate);
  }
  private borrow(raw: PhageRepository, candidate: Candidate, progress: DatabaseLoadProgress | null): Resource {
    const resource: Resource = { candidate, repository: raw, readers: 0, calls: 0, current: true, disposed: false,
      progress, cached: progress?.cached ?? false };
    const nested = new WeakMap<object, object>();
    const invoke = (target: object, fn: (...args: unknown[]) => unknown, args: unknown[]): unknown => {
      if (resource.disposed || (!resource.current && !resource.readers)) throw aborted();
      resource.calls++;
      const finished = () => { resource.calls--; this.collect(resource); };
      try {
        const value = Reflect.apply(fn, target, args);
        if (value && typeof (value as PromiseLike<unknown>).then === 'function') return Promise.resolve(value).finally(finished);
        finished(); return value;
      } catch (error) { finished(); throw error; }
    };
    const wrap = <T extends object>(target: T, repository: boolean): T => new Proxy(target, {
      get: (target, key) => {
        // Hooks lend access. Only this session owns the loader; a consumer must
        // not close another component's database through a composition proxy.
        if (repository && key === 'close') return () => Promise.resolve();
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        const method = value as (...args: unknown[]) => unknown;
        if (repository && key === 'getOfflineDataset') return () => {
          const access = invoke(target, method, []) as object | undefined;
          if (!access) return access;
          let borrowed = nested.get(access);
          if (!borrowed) { borrowed = wrap(access, false); nested.set(access, borrowed); }
          return borrowed;
        };
        return (...args: unknown[]) => {
          // Neighbor warming is speculative. Offline/retired neighbors cannot
          // fail the already displayed genome or create an unhandled rejection.
          // Explicit genome queries still propagate every error.
          if (repository && key === 'prefetchAround') return Promise.resolve()
            .then(() => invoke(target, method, args)).then(() => {}, () => {});
          try { return invoke(target, method, args); }
          catch (error) {
            // Repository query methods and offline operations return promises;
            // keep errors awaitable even when the borrowed snapshot was retired.
            if (repository || !['describe', 'plan'].includes(String(key))) return Promise.reject(error);
            throw error;
          }
        };
      },
    });
    resource.repository = wrap(raw, true);
    this.resources.set(resource.repository, resource);
    return resource;
  }
  private owns(operation: Operation): boolean { return this.operation === operation && !operation.controller.signal.aborted; }
  private cancel(): void {
    const previous = this.operation;
    this.operation = null;
    if (previous) {
      previous.controller.abort();
      if (previous.candidate) void this.close(previous.candidate);
    }
  }
  private release(): void {
    this.cancel();
    const previous = this.current;
    this.current = null;
    if (previous) { previous.current = false; this.collect(previous); }
    this.snapshot = empty();
  }
  /** Idempotent initial load; joins any current refresh rather than downgrading it. */
  load = (): Promise<void> => {
    if (!this.readers.size) return Promise.reject(aborted());
    if (this.operation) return this.operation.done;
    if (this.current) return Promise.resolve();
    return this.start(false);
  };
  /** Concurrent forced refreshes join. A forced refresh supersedes an ordinary load. */
  reload = (): Promise<void> => {
    if (!this.readers.size) return Promise.reject(aborted());
    if (this.operation?.force) return this.operation.done;
    this.cancel();
    return this.start(true);
  };
  private start(force: boolean): Promise<void> {
    const operation: Operation = { controller: new AbortController(), force, candidate: null, done: Promise.resolve() };
    operation.done = Promise.resolve().then(() => this.execute(operation));
    this.operation = operation;
    this.publish({ isLoading: !this.current, isFetching: true, error: null,
      progress: { stage: 'checking', percent: 0, message: force ? 'Preparing a verified database replacement...' : 'Starting database load...' } });
    // Auto-loading hooks may unsubscribe before they attach an error handler.
    void operation.done.catch(() => {});
    return operation.done;
  }
  private async execute(operation: Operation): Promise<void> {
    const signal = operation.controller.signal;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.owns(operation)) throw aborted();
        let candidate: Candidate | null = null;
        let accepted: Resource | null = null;
        let progress: DatabaseLoadProgress | null = null;
        let cached = false;
        try {
          const loader = this.factory(this.url, next => {
            const copy = { ...next };
            progress = copy;
            if (next.cached !== undefined) cached = next.cached;
            if (accepted) accepted.progress = copy;
            if (accepted ? this.current === accepted && !this.operation
              : this.owns(operation) && (!candidate || operation.candidate === candidate && !candidate.closing)) this.publish({ progress: copy });
          });
          candidate = { loader, closing: null }; operation.candidate = candidate;
          const raw = await wait(Promise.resolve().then(() => {
            if (!this.owns(operation)) throw aborted();
            return loader.load({ forceDownload: operation.force });
          }), signal);
          if (!this.owns(operation)) throw aborted();
          accepted = this.borrow(raw, candidate, progress);
          accepted.cached = cached;
          const previous = this.current;
          this.current = accepted;
          this.operation = null;
          if (previous) previous.current = false;
          this.publish({ repository: accepted.repository, isLoading: false, isFetching: false, error: null,
            isCached: accepted.cached, progress: accepted.progress ?? { stage: 'ready', percent: 100, message: 'Verified database ready.' } });
          if (previous) this.collect(previous);
          return;
        } catch (error) {
          // Failed cleanup is not allowed to strand the error or retry indefinitely.
          if (candidate) void this.close(candidate);
          if (!this.owns(operation)) throw aborted();
          if (attempt === 1) throw error;
          operation.candidate = null;
          await pause(this.retryDelayMs, signal);
        }
      }
    } catch (error) {
      if (this.owns(operation)) {
        this.operation = null;
        const message = error instanceof Error ? error.message : 'Database load failed.';
        this.publish({ isLoading: false, isFetching: false, error: message,
          progress: this.current ? { ...(this.current.progress ?? {}), stage: 'ready', percent: 100, updateStatus: 'failed',
            message: `Refresh failed; the previous verified database remains open. ${message}` }
            : { stage: 'error', percent: 0, message } });
      }
      throw error;
    }
  }
}

// QueryClient (or another explicit owner) scopes datasets; no live SQL handle is
// placed in QueryCache. Weak values also avoid retaining abandoned render-only sessions.
const scopes = new WeakMap<object, Map<string, WeakRef<DatabaseSession>>>();
export function getDatabaseSession(scope: object, url: string, factory: DatabaseSessionLoaderFactory): DatabaseSession {
  let sessions = scopes.get(scope);
  if (!sessions) { sessions = new Map(); scopes.set(scope, sessions); }
  for (const [key, reference] of sessions) if (!reference.deref()) sessions.delete(key);
  let session = sessions.get(url)?.deref();
  if (!session) { session = new DatabaseSession(url, factory); sessions.set(url, new WeakRef(session)); }
  return session;
}
