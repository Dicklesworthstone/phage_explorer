/** Session-only private imports. Disk input is parsed off-thread; accepting a review is explicit. */
import { Worker } from 'node:worker_threads';
import { open } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { exportLocalGenomeBundle, GENOME_IMPORT_LIMITS, type GenomeImportResult, type LocalGenome, type LocalGenomeView } from '../../core/src/genome-import';
import type { PhageFull, PhageSummary } from '../../core/src/types';
import { createLocalGenomeRepository, mergeLocalGenomes } from '../../db-runtime/src/local-genomes';
import type { PhageRepository } from '../../db-runtime/src/types';

declare const PHAGE_LOCAL_GENOME_WORKER: string | undefined;

export const terminalGenomeLabel = (value: string): string =>
  stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '�');
function displayGenome(genome: LocalGenome): LocalGenome {
  const copy = structuredClone(genome);
  // Display copies only: original source, annotations and export identity stay untouched.
  for (const key of ['name', 'accession', 'description', 'host', 'family', 'morphology', 'lifecycle'] as const) {
    const value = copy.phage[key];
    if (typeof value === 'string') copy.phage[key] = terminalGenomeLabel(value);
  }
  for (const gene of copy.phage.genes) for (const key of ['name', 'locusTag', 'product'] as const) {
    if (gene[key] !== null) gene[key] = terminalGenomeLabel(gene[key]);
  }
  return copy;
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Local genome operation cancelled.', 'AbortError');
}
/** Each call owns its worker; cancellation cannot terminate another import. */
export function loadTerminalGenomeFile(path: string, signal: AbortSignal): Promise<GenomeImportResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Local genome operation cancelled.', 'AbortError')); return; }
    let worker: Worker;
    try { worker = new Worker(new URL(typeof PHAGE_LOCAL_GENOME_WORKER === 'string' ? PHAGE_LOCAL_GENOME_WORKER : './local-genome-import.worker.ts', import.meta.url), { workerData: { path } }); }
    catch (cause) { reject(cause); return; }
    let settled = false;
    const finish = (result?: GenomeImportResult, cause?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      // Retain the error listener until termination; an error arriving after cancellation is harmless.
      void worker.terminate().catch(() => {});
      if (cause) reject(cause); else resolve(result!);
    };
    const cancel = () => finish(undefined, new DOMException('Local genome operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.on('error', cause => finish(undefined, cause));
    worker.on('messageerror', () => finish(undefined, new Error('Could not read genome import worker response.')));
    worker.on('exit', () => finish(undefined, new Error('Genome import worker exited without a result.')));
    worker.on('message', (message: unknown) => {
      const value = message as { kind?: string; result?: GenomeImportResult; message?: string } | null;
      if (value?.kind === 'result' && Array.isArray(value.result?.genomes) && value.result.genomes.length > 0) finish(value.result);
      else finish(undefined, new Error(value?.kind === 'error' && typeof value.message === 'string' ? value.message : 'Invalid genome import response.'));
    });
  });
}

export interface TerminalGenomeAccepted {
  repository: PhageRepository;
  phages: PhageSummary[];
  selected: PhageFull;
  view: LocalGenomeView;
}
export interface TerminalGenomeSnapshot {
  repository: PhageRepository;
  localCount: number;
  localBases: number;
  busy: 'reading' | 'adding' | 'saving' | null;
  review: GenomeImportResult | null;
  error: string | null;
  notice: string | null;
}
export class TerminalGenomeSession {
  private genomes: LocalGenome[];
  private operation: AbortController | null = null;
  private closed = false;
  private listeners = new Set<() => void>();
  private state: TerminalGenomeSnapshot;
  constructor(private readonly base: PhageRepository | null, initial: readonly LocalGenome[] = [],
    private readonly load: (path: string, signal: AbortSignal) => Promise<GenomeImportResult> = loadTerminalGenomeFile) {
    this.genomes = structuredClone([...initial]);
    this.state = { repository: this.repository(this.genomes), localCount: initial.length,
      localBases: initial.reduce((sum, genome) => sum + genome.sequence.length, 0),
      busy: null, review: null, error: null, notice: null };
  }
  private repository(genomes: readonly LocalGenome[]): PhageRepository {
    return createLocalGenomeRepository(this.base, genomes.map(displayGenome));
  }
  getSnapshot = (): TerminalGenomeSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<TerminalGenomeSnapshot>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  private begin(busy: NonNullable<TerminalGenomeSnapshot['busy']>): AbortController {
    if (this.closed) throw new Error('Local genome session is closed.');
    if (this.operation) throw new Error('Cancel the current local genome operation first.');
    const controller = new AbortController();
    this.operation = controller;
    this.publish({ busy, error: null, notice: null });
    return controller;
  }
  private current(controller: AbortController): boolean {
    return this.operation === controller && !controller.signal.aborted && !this.closed;
  }
  cancel = (): void => {
    const operation = this.operation;
    this.operation = null;
    operation?.abort();
    this.publish({ busy: null, ...(operation ? { notice: 'Cancelled; the accepted genomes and view are unchanged.' } : {}) });
  };
  discardReview = (): void => { this.cancel(); this.publish({ review: null, error: null }); };
  prepare = async (path: string): Promise<void> => {
    const controller = this.begin('reading');
    // Never leave an old review under the name of a new, failed source.
    this.publish({ review: null });
    try {
      const result = await this.load(path, controller.signal);
      if (this.current(controller)) this.publish({ review: structuredClone(result), notice: 'Parsed for review only. Nothing has been added.' });
    } catch (cause) {
      if (this.current(controller)) this.publish({ error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)) });
    } finally {
      if (this.current(controller)) { this.operation = null; this.publish({ busy: null }); }
    }
  };
  /** The host's install callback must apply its state synchronously and atomically. */
  accept = async (allowCollisions: boolean, install: (accepted: TerminalGenomeAccepted) => void): Promise<boolean> => {
    const review = this.state.review;
    if (!review) throw new Error('Read and review a genome input first.');
    const controller = this.begin('adding');
    try {
      const catalog = await this.base?.listPhages() ?? [];
      check(controller.signal);
      const next = mergeLocalGenomes(this.genomes, structuredClone(review), catalog, allowCollisions);
      const selected = next.find(genome => genome.phage.localGenome?.contentId === review.view?.contentId) ?? review.genomes[0];
      const view: LocalGenomeView = review.view ? { ...review.view } : {
        contentId: selected.phage.localGenome!.contentId, viewMode: 'dna', readingFrame: 0, scrollPosition: 0,
      };
      const positions = view.viewMode === 'aa' ? Math.ceil(selected.sequence.length / 3) : selected.sequence.length;
      if (view.scrollPosition < 0 || view.scrollPosition >= positions) throw new Error('Saved position is outside the selected sequence view.');
      const repository = this.repository(next);
      const phages = [...catalog, ...next.map(genome => displayGenome(genome).phage)];
      if (!this.current(controller)) return false;
      install({ repository, phages, selected: displayGenome(selected).phage, view });
      this.genomes = next;
      this.publish({ repository, localCount: next.length, localBases: next.reduce((sum, genome) => sum + genome.sequence.length, 0),
        review: null, notice: 'Local records accepted. The curated catalog was not modified.' });
      return true;
    } catch (cause) {
      if (this.current(controller)) this.publish({ error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)) });
      return false;
    } finally {
      if (this.current(controller)) { this.operation = null; this.publish({ busy: null }); }
    }
  };
  exportBundle = (view?: LocalGenomeView): string => {
    if (!this.genomes.length) throw new Error('No local genomes are available to export.');
    if (view) {
      const genome = this.genomes.find(item => item.phage.localGenome?.contentId === view.contentId);
      const positions = genome ? view.viewMode === 'aa' ? Math.ceil(genome.sequence.length / 3) : genome.sequence.length : 0;
      if (!genome || !['dna', 'aa', 'dual'].includes(view.viewMode) || ![0, 1, 2, -1, -2, -3].includes(view.readingFrame)
        || !Number.isSafeInteger(view.scrollPosition) || view.scrollPosition < 0 || view.scrollPosition >= positions) throw new Error('Current local view cannot be represented in this bundle.');
    }
    const content = exportLocalGenomeBundle(this.genomes, view);
    if (new TextEncoder().encode(content).length > GENOME_IMPORT_LIMITS.bytes) throw new Error('Local bundle exceeds 10 MiB.');
    return content;
  };
  save = async (path: string, view?: LocalGenomeView): Promise<boolean> => {
    const controller = this.begin('saving');
    try {
      if (!path || /[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new Error('Provide a new output path without control characters.');
      const content = this.exportBundle(view); // capture and validate BEFORE creating a file
      check(controller.signal);
      const file = await open(path, 'wx', 0o600);
      try { check(controller.signal); await file.writeFile(content, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      check(controller.signal);
      if (this.current(controller)) this.publish({ notice: 'Saved the original inputs and current local view. No existing file was overwritten.' });
      return true;
    } catch (cause) {
      if (this.current(controller)) this.publish({ error: terminalGenomeLabel(cause instanceof Error ? cause.message : String(cause)) });
      return false;
    } finally {
      if (this.current(controller)) { this.operation = null; this.publish({ busy: null }); }
    }
  };
  close = async (): Promise<void> => {
    if (this.closed) return;
    this.closed = true;
    this.cancel();
    await this.base?.close();
  };
}
