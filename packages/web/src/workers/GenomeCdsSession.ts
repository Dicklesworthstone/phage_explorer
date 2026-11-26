/** Exact local genome sources and accepted exports belong to one current selection. */
import { analysisJson, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import type { GenomeInput } from '../../../core/src/genome-import';
import {
  GENOME_CDS_LIMITS, GENOME_CDS_METHOD, createGenomeCdsExperiment, replayGenomeCdsExperiment,
  exportGenomeCdsFasta, exportGenomeCdsTable, type GenomeCdsExperiment, type GenomeCdsOptions,
} from '../../../core/src/genome-cds-export';

export interface GenomeCdsSelection { contentId: string; input: GenomeInput }
export type GenomeCdsRequest = { kind: 'analyze'; input: GenomeInput; options: GenomeCdsOptions }
  | { kind: 'replay'; content: string };
export interface GenomeCdsWorkResult { experiment: GenomeCdsExperiment; verified: boolean }
export type GenomeCdsMessage = { kind: 'progress'; phase: string }
  | { kind: 'result'; value: GenomeCdsWorkResult } | { kind: 'error'; message: string };
export type GenomeCdsDownloadKind = 'json' | 'tsv' | 'cds' | 'protein';

function checkContent(content: unknown): asserts content is string {
  if (typeof content !== 'string' || content.length > GENOME_CDS_LIMITS.recordBytes
    || new TextEncoder().encode(content).length > GENOME_CDS_LIMITS.recordBytes) throw new Error('CDS input exceeds the 10 MiB limit.');
}
export async function executeGenomeCdsRequest(request: GenomeCdsRequest,
  progress: (phase: string) => void = () => {}): Promise<GenomeCdsWorkResult> {
  if (!request || typeof request !== 'object') throw new Error('Unsupported genome CDS request.');
  if (request.kind === 'analyze') {
    progress('Reparsing the exact source and reconstructing annotated CDS');
    return { experiment: await createGenomeCdsExperiment(request.input, request.options), verified: false };
  }
  if (request.kind === 'replay') {
    checkContent(request.content);
    progress('Recomputing saved CDS and proteins from their embedded source');
    return { experiment: await replayGenomeCdsExperiment(request.content.replace(/^\uFEFF/, '')), verified: true };
  }
  throw new Error('Unsupported genome CDS operation.');
}

export interface GenomeCdsWorker {
  postMessage(request: GenomeCdsRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<GenomeCdsMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface GenomeCdsSnapshot {
  scope: GenomeCdsSelection | null;
  accepted: GenomeCdsWorkResult | null;
  acceptedScope: GenomeCdsSelection | null;
  busy: boolean;
  phase: string;
  error: string | null;
  notice: string | null;
}
const abortError = () => new DOMException('Genome CDS work cancelled.', 'AbortError');
const same = (left: unknown, right: unknown) => JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right));
const sameSelection = (left: GenomeCdsSelection, right: GenomeCdsSelection) => left.contentId === right.contentId
  && left.input.name === right.input.name && left.input.text === right.input.text;
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      cause => { signal.removeEventListener('abort', abort); reject(cause); });
    if (signal.aborted) abort();
  });
}

/** Failed or cancelled replacements retain accepted evidence. Selection ownership
 * is checked again at download time, so a retired result cannot become a new genome's export.
 */
export class GenomeCdsSession {
  private active = false;
  private scope: GenomeCdsSelection | null = null;
  private operation: AbortController | null = null;
  private acceptedSelection: GenomeCdsSelection | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: GenomeCdsSnapshot = { scope: null, accepted: null, acceptedScope: null,
    busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => GenomeCdsWorker) {}
  getSnapshot = (): GenomeCdsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<GenomeCdsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  setScope = (scope: GenomeCdsSelection | null): void => {
    if (this.scope === scope) return;
    this.scope = scope; this.cancel();
    this.publish({ scope, error: null, notice: scope ? 'Prepare an export for this exact local genome, or replay its saved CDS JSON.' : 'Import and choose a local genome first.' });
  };
  cancel = (): void => {
    const old = this.operation; this.operation = null; old?.abort();
    this.publish({ busy: false, phase: '', ...(old ? { notice: this.snapshot.acceptedScope === this.scope && this.snapshot.accepted
      ? 'CDS work cancelled. Previous accepted export preserved.' : 'CDS work cancelled. No partial export was accepted.' } : {}) });
  };
  getAccepted = (scope: GenomeCdsSelection | null): GenomeCdsWorkResult | null =>
    this.active && scope && this.scope === scope && this.snapshot.acceptedScope === scope
      && this.acceptedSelection && sameSelection(scope, this.acceptedSelection) ? this.snapshot.accepted : null;
  export = (scope: GenomeCdsSelection, kind: GenomeCdsDownloadKind): { content: string; filename: string; mimeType: string } | null => {
    const accepted = this.getAccepted(scope);
    if (!accepted || this.snapshot.busy) return null;
    const experiment = accepted.experiment;
    const stem = `phage-cds-${experiment.result.source.contentId.slice(0, 12)}-${experiment.record.resultId.slice(0, 12)}`;
    if (kind === 'json') return { content: serializeAnalysisRecord(experiment.record), filename: stem + '.json', mimeType: 'application/json' };
    if (kind === 'tsv') return { content: exportGenomeCdsTable(experiment), filename: stem + '.tsv', mimeType: 'text/tab-separated-values' };
    if (kind === 'cds' || kind === 'protein') return { content: exportGenomeCdsFasta(experiment, kind),
      filename: stem + (kind === 'cds' ? '.fna' : '.faa'), mimeType: 'text/plain' };
    throw new Error('Unsupported genome CDS download format.');
  };
  run = async (scope: GenomeCdsSelection,
    input: GenomeCdsRequest | ((signal: AbortSignal) => Promise<GenomeCdsRequest>)): Promise<boolean> => {
    if (!this.active || this.scope !== scope) return false;
    let selection: GenomeCdsSelection, captured: typeof input;
    try {
      // Capture caller-owned data before any subscriber notification or await.
      selection = structuredClone(scope); captured = typeof input === 'function' ? input : structuredClone(input);
    } catch (cause) { this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
    const old = this.operation; this.operation = null; old?.abort();
    if (!this.active || this.scope !== scope) return false;
    const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.scope === scope && this.operation === owner && !owner.signal.aborted;
    const sourceCurrent = () => {
      if (!sameSelection(scope, selection)) throw new Error('The selected source changed. Prepare the current local genome again.');
    };
    try {
      if (!/^[a-f0-9]{64}$/.test(selection.contentId)) throw new Error('Choose an exact imported genome content ID.');
      checkContent(selection.input.text);
      this.publish({ busy: true, phase: 'Reading exact local CDS inputs', error: null, notice: null });
      if (!current()) return false;
      const request = await abortable(typeof captured === 'function'
        ? captured(owner.signal).then(value => structuredClone(value)) : Promise.resolve(captured), owner.signal);
      if (!current()) return false;
      sourceCurrent();
      let saved: AnalysisRecord | null = null;
      let expectedOptions: unknown = null;
      if (request.kind === 'analyze') {
        if (!same(request.input, selection.input) || request.options?.record !== selection.contentId) throw new Error('CDS request differs from the selected exact source.');
        const ids = request.options.geneIds ?? null;
        if (ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > GENOME_CDS_LIMITS.rows
          || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length)) throw new Error('Invalid mapped CDS selection.');
        expectedOptions = { record: selection.contentId, geneIds: ids === null ? null : [...ids].sort((a, b) => a - b) };
      } else if (request.kind === 'replay') {
        checkContent(request.content);
        saved = await abortable(parseAnalysisRecord(request.content.replace(/^\uFEFF/, ''),
          { methodId: GENOME_CDS_METHOD.id, methodVersion: GENOME_CDS_METHOD.version }), owner.signal);
        if (saved.parameters.record !== selection.contentId) throw new Error('Saved CDS export belongs to a different genome. Choose its exact imported record before replay.');
      } else throw new Error('Unsupported genome CDS operation.');
      if (!current()) return false;
      sourceCurrent();
      const value = await new Promise<GenomeCdsWorkResult>((resolve, reject) => {
        const worker = this.factory(); let done = false, validating = false;
        const finish = (result?: GenomeCdsWorkResult, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', abort);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* The operation still relinquishes ownership. */ }
          if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(undefined, abortError());
        owner.signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
          if (done || validating || !current()) return;
          const message = event.data;
          try {
            if (message?.kind === 'progress' && typeof message.phase === 'string') { this.publish({ phase: message.phase }); return; }
            if (message?.kind === 'error' && typeof message.message === 'string') { finish(undefined, new Error(message.message)); return; }
            if (message?.kind !== 'result' || message.value?.verified !== (request.kind === 'replay')) throw new Error('Unexpected genome CDS worker response.');
            const result = structuredClone(message.value), experiment = result.experiment;
            if (!experiment?.record || !experiment.result || !experiment.options || !experiment.input) throw new Error('Incomplete genome CDS worker response.');
            validating = true;
            void parseAnalysisRecord(JSON.stringify(experiment.record), { methodId: GENOME_CDS_METHOD.id, methodVersion: GENOME_CDS_METHOD.version }).then(record => {
              if (done || !current()) return;
              sourceCurrent();
              if (!same(record.method, GENOME_CDS_METHOD) || record.seed !== null || record.inputs.length !== 1
                || record.inputs[0].id !== 'genome' || record.inputs[0].source !== 'local'
                || record.inputs[0].accession !== experiment.result.source.accession
                || !same(record.inputs[0].data, experiment.input) || !same(record.parameters, experiment.options)
                || record.fields.cds?.kind !== 'sequence-score' || record.fields.cds.units !== 'records'
                || !same(record.fields.cds.value, experiment.result)
                || experiment.result.source.contentId !== selection.contentId || experiment.options.record !== selection.contentId
                || (request.kind === 'analyze' && (!same(experiment.input, selection.input) || !same(experiment.options, expectedOptions)))
                || (saved !== null && (record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey))) {
                throw new Error('CDS worker reply differs from its selected source, submitted options or saved result identity.');
              }
              finish(result);
            }).catch(cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
          } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
        };
        worker.onerror = () => finish(undefined, new Error('The CDS export worker failed. Retry or use the native genome-cds command.'));
        worker.onmessageerror = () => finish(undefined, new Error('The CDS export worker response could not be read.'));
        try { if (owner.signal.aborted) abort(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      sourceCurrent(); this.acceptedSelection = selection;
      this.publish({ accepted: value, acceptedScope: scope, notice: value.verified
        ? 'Verified CDS replay: exact source, selection, sequences and unavailable reasons agree.'
        : 'Annotated CDS export prepared. Review available sequences and unavailable reasons before downloading.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause),
        notice: this.getAccepted(scope) ? 'Previous accepted export preserved.' : 'No new export was accepted.' });
      return false;
    } finally {
      if (current()) { this.operation = null; this.publish({ busy: false, phase: '' }); }
    }
  };
}
