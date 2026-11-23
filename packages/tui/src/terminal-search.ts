/** Native ownership for the same search producer used by the browser.
 * Each scan has its own worker, deadline and cancellation; no input is uploaded.
 */
import * as Comlink from 'comlink';
import type { PhageRepository } from '@phage-explorer/db-runtime';
import { isSearchResponse, type SearchFeature, type SearchRequest, type SearchResponse, type SearchWorkerAPI } from '../../web/src/workers/types';

declare const PHAGE_SEARCH_WORKER: string | undefined;

export const TERMINAL_SEARCH_LIMITS = { bases: 5_000_000, query: 10_000, results: 500, timeoutMs: 15_000 } as const;
export interface TerminalSearchSource { sequence: string; features: SearchFeature[]; topology: 'linear' | 'circular' | 'unknown' }

function cancelled(): DOMException { return new DOMException('Search cancelled.', 'AbortError'); }
function check(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }

/** Repository calls do not all support AbortSignal. Stop waiting promptly and
 * leave late replies detached from the accepted source.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Read annotations and the complete sequence for the selected repository/genome. */
export async function loadTerminalSearchSource(
  repository: PhageRepository, phageId: number, signal: AbortSignal,
  timeoutMs = TERMINAL_SEARCH_LIMITS.timeoutMs as number,
): Promise<TerminalSearchSource> {
  check(signal);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Search deadline must be a positive integer.');
  const operation = new AbortController();
  const cancel = () => operation.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; operation.abort(); }, timeoutMs);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const length = await abortable(repository.getFullGenomeLength(phageId), operation.signal);
    check(operation.signal);
    if (!Number.isSafeInteger(length) || length < 1 || length > TERMINAL_SEARCH_LIMITS.bases) {
      throw new Error('Search requires a complete genome of 1–5,000,000 bases.');
    }
    const [sequence, genes, phage] = await abortable(Promise.all([
      repository.getSequenceWindow(phageId, 0, length), repository.getGenes(phageId), repository.getPhageById(phageId),
    ]), operation.signal);
    check(operation.signal);
    if (sequence.length !== length) throw new Error('The complete genome could not be read. Retry before searching.');
    if (!phage || phage.id !== phageId) throw new Error('The selected genome is no longer available. Retry before searching.');
    return { sequence, topology: phage.localGenome?.topology ?? 'unknown', features: genes.map(gene => ({ id: gene.id, start: gene.startPos, end: gene.endPos,
      strand: gene.strand === '+' || gene.strand === '-' ? gene.strand : 'both',
      name: gene.name && gene.locusTag && gene.name !== gene.locusTag ? `${gene.name} (${gene.locusTag})` : gene.name || gene.locusTag,
      product: gene.product, type: gene.type ?? 'CDS' })) };
  } catch (cause) {
    if (timedOut) throw new Error('Reading the complete genome timed out. Retry the search.');
    throw cause;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/** Bundling embeds the existing browser search worker in the standalone binary.
 * Bun's Web Worker supports the same Comlink endpoint as the browser worker.
 */
export function runTerminalSearch(
  request: SearchRequest,
  signal: AbortSignal,
  timeoutMs = TERMINAL_SEARCH_LIMITS.timeoutMs as number,
  createWorker: () => Worker = () => new Worker(new URL(typeof PHAGE_SEARCH_WORKER === 'string'
    ? PHAGE_SEARCH_WORKER : '../../web/src/workers/search.worker.ts', import.meta.url), { type: 'module' }),
): Promise<SearchResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      reject(new Error('Search deadline must be a positive integer.')); return;
    }
    if (!request.query.trim() || request.query.length > TERMINAL_SEARCH_LIMITS.query) {
      reject(new Error('Search queries must contain 1–10,000 characters.')); return;
    }
    if (request.sequence.length < 1 || request.sequence.length > TERMINAL_SEARCH_LIMITS.bases) {
      reject(new Error('Search requires a complete genome of 1–5,000,000 bases.')); return;
    }
    const limit = request.options?.maxResults ?? TERMINAL_SEARCH_LIMITS.results;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TERMINAL_SEARCH_LIMITS.results) {
      reject(new Error('Terminal search returns at most 500 results.')); return;
    }
    let worker: Worker;
    try { worker = createWorker(); } catch (cause) { reject(cause); return; }
    const api = Comlink.wrap<SearchWorkerAPI>(worker);
    let settled = false;
    const finish = (error: Error | null, result?: SearchResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.removeEventListener('error', failure);
      worker.removeEventListener('messageerror', failure);
      try { api[Comlink.releaseProxy](); } catch { /* The failed endpoint may already be gone. */ }
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(cancelled());
    const failure = () => finish(new Error('The search worker failed. Retry the search.'));
    const timer = setTimeout(() => finish(new Error('Search timed out. Use a shorter query or smaller genome.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('error', failure);
    worker.addEventListener('messageerror', failure);
    if (signal.aborted) { abort(); return; }
    void Promise.resolve().then(() => api.runSearch(request)).then(result => {
      if (!isSearchResponse(request, result) || result.hits.length > limit) {
        finish(new Error('The search worker returned mismatched or invalid results.')); return;
      }
      finish(null, result);
    }).catch(cause => finish(cause instanceof Error ? cause : new Error(String(cause))));
  });
}
