import type { ReadingFrame, ViewMode, PhageFull } from '@phage-explorer/core';
import type { PhageRepository } from '../db/types';

export interface PhageSelection {
  index: number;
  phage: PhageFull;
  sequence: string;
}
export interface PhageSelectionSnapshot {
  repository: PhageRepository | null;
  selection: PhageSelection | null;
  pendingIndex: number | null;
  error: { index: number; message: string } | null;
}
export interface SelectionView {
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  scrollPosition: number;
  selectedGeneId: number | null;
}
export interface PhageSelectionOptions {
  signal?: AbortSignal;
  /** A peer request reports its failure in Multi-Tab Sync, outside the user's Retry flow. */
  background?: boolean;
  /** A verified position is published together with its complete, still-owned source. */
  verify?: (selection: PhageSelection) => Promise<SelectionView | void>;
}
interface Operation {
  repository: PhageRepository;
  index: number;
  controller: AbortController;
}

function cancelled(): DOMException { return new DOMException('Genome selection superseded.', 'AbortError'); }
function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** One complete genome and its annotations, owned by one repository snapshot.
 * A pending or failed navigation leaves the last accepted selection intact.
 * Changing repositories retires that selection before any new reads begin.
 */
export class PhageSelectionSession {
  private snapshot: PhageSelectionSnapshot = { repository: null, selection: null, pendingIndex: null, error: null };
  private operation: Operation | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onChange?: (next: PhageSelectionSnapshot, previous: PhageSelectionSnapshot, view?: SelectionView) => void) {}

  getSnapshot = (): PhageSelectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: PhageSelectionSnapshot, view?: SelectionView): void {
    const previous = this.snapshot;
    this.snapshot = next;
    // The app commits its shared phage/index state before notifying readers of
    // the matching sequence. Neither store can expose half of a new selection.
    this.onChange?.(next, previous, view);
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener();
  }
  private stop(): void {
    const previous = this.operation;
    this.operation = null;
    previous?.controller.abort();
  }
  setRepository(repository: PhageRepository | null): void {
    if (repository === this.snapshot.repository) return;
    this.stop();
    this.publish({ repository, selection: null, pendingIndex: null, error: null });
  }
  cancel(): void {
    if (!this.operation) return;
    this.stop();
    this.publish({ ...this.snapshot, pendingIndex: null });
  }
  /** Arrow navigation advances from the requested target, even while it loads. */
  navigationIndex(): number { return this.snapshot.pendingIndex ?? this.snapshot.selection?.index ?? 0; }
  private owns(operation: Operation): boolean {
    return this.operation === operation && this.snapshot.repository === operation.repository && !operation.controller.signal.aborted;
  }

  select = async (index: number, expectedPhageId?: number, options: PhageSelectionOptions = {}): Promise<boolean> => {
    const repository = this.snapshot.repository;
    if (!repository || !Number.isSafeInteger(index) || index < 0 || options.signal?.aborted) return false;
    this.stop();
    const operation: Operation = { repository, index, controller: new AbortController() };
    this.operation = operation;
    const abort = () => { if (this.operation === operation) this.cancel(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.publish({ ...this.snapshot, pendingIndex: index, error: null });
    const signal = operation.controller.signal;
    try {
      if (!this.owns(operation)) return false;
      const loaded = await wait(repository.getPhageByIndex(index), signal);
      if (!this.owns(operation)) return false;
      if (!loaded) throw new Error('This genome is unavailable. Retry the selection or choose another genome.');
      if (expectedPhageId !== undefined && loaded.id !== expectedPhageId) {
        throw new Error('The selected genome no longer matches the catalog. Reload the database before selecting it again.');
      }
      // Repository caches must not be able to mutate annotations during an
      // asynchronous sequence read and silently change the accepted experiment.
      const phage = structuredClone(loaded);
      const length = await wait(repository.getFullGenomeLength(phage.id), signal);
      if (!this.owns(operation)) return false;
      if (!Number.isSafeInteger(length) || length < 1 || (phage.genomeLength !== null && phage.genomeLength !== length)) {
        throw new Error('Genome annotations and sequence length disagree. The previous selection is unchanged.');
      }
      // Missing legacy summary metadata is not a disagreement. Derive it from
      // the actual repository length on the owned clone, never the cached row.
      if (phage.genomeLength === null) phage.genomeLength = length;
      const sequence = await wait(repository.getSequenceWindow(phage.id, 0, length), signal);
      if (!this.owns(operation)) return false;
      if (typeof sequence !== 'string' || sequence.length !== length || !/^[ACGTRYSWKMBDHVN]+$/i.test(sequence)) {
        throw new Error('The complete genome sequence could not be read. Retry when its data are available.');
      }
      const selection = { index, phage, sequence };
      const view = options.verify ? await wait(options.verify(selection), signal) : undefined;
      if (!this.owns(operation)) return false;
      this.operation = null;
      this.publish({ repository, selection, pendingIndex: null, error: null }, view || undefined);
      // Neighbor loading is optional; an offline neighbor must never invalidate
      // the selected genome or create an unhandled rejection.
      void Promise.resolve().then(() => {
        if (this.snapshot.repository === repository && this.snapshot.selection === selection) return repository.prefetchAround(index, 2);
      }).catch(() => {});
      return this.snapshot.repository === repository && this.snapshot.selection === selection;
    } catch (cause) {
      if (!this.owns(operation)) return false;
      this.operation = null;
      this.publish({ ...this.snapshot, pendingIndex: null,
        error: options.background ? null : { index, message: cause instanceof Error ? cause.message : 'Could not load this genome. Retry the selection.' } });
      return false;
    } finally { options.signal?.removeEventListener('abort', abort); }
  };
}
