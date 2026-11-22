import {
  prepareSelectedCds, selectedCdsExport, type GeneInfo, type SelectedCdsSource,
  type SelectedCdsResult, type SelectedCdsExportKind, type SelectedCdsExport,
} from '@phage-explorer/core';

export interface SelectedCdsSnapshot {
  source: SelectedCdsSource | null;
  gene: GeneInfo | null;
  loading: boolean;
  result: SelectedCdsResult | null;
  error: string | null;
}

function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Selected CDS changed.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** A source and gene replacement retires every old preview/export before hashing completes. */
export class SelectedCdsSession {
  private snapshot: SelectedCdsSnapshot = { source: null, gene: null, loading: false, result: null, error: null };
  private controller: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly prepare = prepareSelectedCds) {}
  getSnapshot = (): SelectedCdsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(next: SelectedCdsSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener();
  }
  clear = (): void => {
    this.controller?.abort();
    this.controller = null;
    this.publish({ source: null, gene: null, loading: false, result: null, error: null });
  };
  select = async (source: SelectedCdsSource, gene: GeneInfo): Promise<boolean> => {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ source, gene, loading: true, result: null, error: null });
    try {
      if (this.controller !== controller || controller.signal.aborted) return false;
      const result = await wait(this.prepare(source, gene), controller.signal);
      if (this.controller !== controller || controller.signal.aborted) return false;
      this.controller = null;
      this.publish({ source, gene, loading: false, result, error: null });
      return true;
    } catch (cause) {
      if (this.controller !== controller || controller.signal.aborted) return false;
      this.controller = null;
      this.publish({ source, gene, loading: false, result: null,
        error: cause instanceof Error ? cause.message : 'This CDS could not be prepared. Retry the inspection.' });
      return false;
    }
  };
  export(kind: SelectedCdsExportKind, source: SelectedCdsSource, gene: GeneInfo): SelectedCdsExport | null {
    return this.snapshot.source === source && this.snapshot.gene === gene && this.snapshot.result
      ? selectedCdsExport(this.snapshot.result, kind) : null;
  }
}
