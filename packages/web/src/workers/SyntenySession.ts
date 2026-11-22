/** An owned worker for live annotation pairs or self-contained saved experiments. */
import type { PhageFull } from '../../../core/src/types';
import type { PhageRepository } from '../db/types';
import { analysisJson, serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { SYNTENY_EXPERIMENT_METHOD, validateSyntenyInput, type SyntenyExperiment, type SyntenyExperimentInput } from '../../../comparison/src/synteny-experiment';
import type { SyntenyRequest, SyntenyWorkerJob, SyntenyWorkerMessage } from './synteny-worker';

export interface SyntenyWorker {
  postMessage: (request: SyntenyWorkerJob) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<SyntenyWorkerMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
const cancelled = () => new DOMException('Synteny analysis cancelled.', 'AbortError');
const defaultFactory = (): SyntenyWorker => new Worker(new URL('./synteny-worker.ts', import.meta.url), { type: 'module' });

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, maximum = Infinity): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const integer = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && finite(value, maximum);
function indices(row: Record<string, unknown>, start: string, end: string, length: number): boolean {
  return integer(row[start], length - 1) && integer(row[end], length - 1) && Number(row[end]) >= Number(row[start]);
}

/** Validate everything consumed by the plot, tables, evidence details and exports.
 * This is transport/shape validation, not a second alignment on the UI thread.
 */
function validateReply(value: unknown, job: SyntenyWorkerJob): SyntenyExperiment {
  const invalid = (): never => { throw new Error('Synteny worker returned an incomplete or inconsistent experiment.'); };
  if (!object(value)) invalid();
  const experiment = value as unknown as SyntenyExperiment;
  const input = validateSyntenyInput(experiment.input), result = experiment.result;
  const n = input.genesQuery.length, m = input.genesReference.length;
  if (!object(result) || !object(result.heatmap) || !object(result.stats) || !object(result.analysis)) invalid();
  const { heatmap, stats, analysis, blocksBp } = result;
  if (heatmap.rows !== n || heatmap.cols !== m || !Array.isArray(heatmap.values) || heatmap.values.length !== n * m
    || heatmap.values.some(score => !finite(score, 1)) || !finite(heatmap.min, 1) || !finite(heatmap.max, 1) || heatmap.min > heatmap.max
    || !Array.isArray(blocksBp) || !integer(stats.blockCount, n * m) || stats.blockCount !== blocksBp.length
    || !finite(stats.globalScore, 1) || !finite(stats.scsScore, 1) || !finite(stats.dtwDistance)
    || !integer(stats.coverageQuery, input.query.length) || !integer(stats.coverageReference, input.reference.length)
    || !integer(stats.inversionCount, blocksBp.length) || !integer(stats.translocationCount, blocksBp.length)
    || !integer(stats.indelCount, blocksBp.length)) invalid();
  for (const block of blocksBp) {
    if (!object(block) || !indices(block, 'startIdxQuery', 'endIdxQuery', n) || !indices(block, 'startIdxReference', 'endIdxReference', m)
      || !integer(block.startBpQuery, input.query.length) || !integer(block.endBpQuery, input.query.length) || block.endBpQuery <= block.startBpQuery
      || !integer(block.startBpReference, input.reference.length) || !integer(block.endBpReference, input.reference.length)
      || block.endBpReference <= block.startBpReference || !finite(block.score, 1)
      || block.orientation !== 'forward' && block.orientation !== 'reverse') invalid();
  }
  if (!finite(analysis.globalScore, 1) || !finite(analysis.scsScore, 1) || !finite(analysis.dtwDistance)
    || !Array.isArray(analysis.blocks) || analysis.blocks.length !== blocksBp.length
    || analysis.blocks.some(block => !object(block) || !indices(block, 'startIdxA', 'endIdxA', n)
      || !indices(block, 'startIdxB', 'endIdxB', m) || !finite(block.score, 1)
      || block.orientation !== 'forward' && block.orientation !== 'reverse')
    || !Array.isArray(analysis.breakpoints) || analysis.breakpoints.some(index => !integer(index, n - 1))
    || !Array.isArray(analysis.breakpointDetails) || analysis.breakpointDetails.some(row => !object(row)
      || !integer(row.idxA, n - 1) || !integer(row.idxB, m - 1)
      || !integer(row.prevBlockIdx, blocksBp.length - 1) || !integer(row.nextBlockIdx, blocksBp.length - 1)
      || typeof row.description !== 'string' || !['inversion', 'translocation', 'indel'].includes(row.type))
    || !Array.isArray(analysis.warpingPath) || analysis.warpingPath.length > n + m
    || analysis.warpingPath.some(pair => !Array.isArray(pair) || pair.length !== 2 || !integer(pair[0], n - 1) || !integer(pair[1], m - 1))) invalid();

  // The existing serializer validates every metadata/field context read by
  // AnalysisRecordDetails and enforces its 10 MiB portable-output limit.
  serializeAnalysisRecord(experiment.record);
  const record = experiment.record;
  if (record.method.id !== SYNTENY_EXPERIMENT_METHOD.id || record.method.version !== SYNTENY_EXPERIMENT_METHOD.version
    || record.method.implementation !== SYNTENY_EXPERIMENT_METHOD.implementation || record.inputs.length !== 2
    || record.fields.synteny?.kind !== 'sequence-score' || record.fields.synteny.units !== 'records'
    || JSON.stringify(analysisJson(record.fields.synteny.value)) !== JSON.stringify(analysisJson(result))) invalid();
  for (const [index, role] of ['query', 'reference'].entries()) {
    const name = role as 'query' | 'reference', row = record.inputs[index];
    if (row.id !== name || row.source !== input[name].source || row.accession !== input[name].accession
      || JSON.stringify(analysisJson(row.data)) !== JSON.stringify(analysisJson({ genome: input[name],
        genes: name === 'query' ? input.genesQuery : input.genesReference }))) invalid();
  }
  if (job.kind === 'analyze' && JSON.stringify(input) !== JSON.stringify(analysisJson(job.input))) {
    throw new Error('Synteny worker returned a result for different annotation inputs.');
  }
  if (job.kind === 'replay') {
    const submitted: unknown = JSON.parse(job.content);
    if (!object(submitted) || record.cacheKey !== submitted.cacheKey || record.resultId !== submitted.resultId) {
      throw new Error('Synteny worker returned a result for a different saved experiment.');
    }
  }
  return experiment;
}

export function runSyntenyTask(input: SyntenyRequest, signal?: AbortSignal, timeoutMs = 300000,
  createWorker: () => SyntenyWorker = defaultFactory, progress: (phase: string) => void = () => {}): Promise<SyntenyExperiment> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { reject(new Error('Synteny timeout must be a positive integer.')); return; }
    let worker: SyntenyWorker, job: SyntenyWorkerJob;
    try {
      job = { ...structuredClone(input), jobId: crypto.randomUUID() };
      worker = createWorker();
    } catch (cause) { reject(cause); return; }
    let settled = false;
    const finish = (error?: Error, value?: SyntenyExperiment) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      try { worker.terminate(); } catch { /* Preserve the original outcome if cleanup fails. */ }
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Synteny worker timed out. Retry the analysis.')), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = event => {
      if (settled) return;
      try {
        const message = event.data;
        if (!message || message.jobId !== job.jobId) { finish(new Error('Synteny worker returned a result for a different request.')); return; }
        if (message.kind === 'progress' && typeof message.phase === 'string') { progress(message.phase); return; }
        if (message.kind === 'error' && typeof message.message === 'string') { finish(new Error(message.message || 'Synteny computation failed.')); return; }
        if (message.kind !== 'result') { finish(new Error('Synteny worker returned no complete response.')); return; }
        finish(undefined, validateReply(message.value, job));
      } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
    };
    worker.onerror = event => { event.preventDefault(); finish(new Error('The synteny worker failed. Retry the analysis.')); };
    worker.onmessageerror = () => finish(new Error('The synteny worker returned unreadable data. Retry the analysis.'));
    try { if (signal?.aborted) onAbort(); else worker.postMessage(job); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

function readRequest<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (cause?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (cause !== undefined) reject(cause); else resolve(value!);
    };
    const cancel = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Synteny source read timed out. Retry with the selected sources.')), timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    void work.then(value => {
      try { finish(undefined, structuredClone(value)); } catch (cause) { finish(cause); }
    }, cause => finish(cause ?? new Error('Synteny input could not be read.')));
    if (signal.aborted) cancel();
  });
}

/** Read the exact selected pair without changing the explorer or requesting bases.
 * Missing annotation-release metadata stays explicit; labels are never a digest.
 */
export function readSyntenyPair(repository: Pick<PhageRepository, 'getPhageById' | 'getAnnotationMeta'>,
  selected: PhageFull, referenceId: number, signal: AbortSignal, timeoutMs = 30000): Promise<SyntenyExperimentInput> {
  if (signal.aborted) return Promise.reject(cancelled());
  return readRequest((async () => {
    if (referenceId === selected.id) throw new Error('Select a reference different from the current query.');
    const selectedId = selected.id, accession = selected.accession, contentId = selected.localGenome?.contentId ?? null;
    const [queryRead, referenceRead] = await Promise.all([
      repository.getPhageById(selectedId), repository.getPhageById(referenceId),
    ]);
    if (signal.aborted) throw cancelled();
    if (!queryRead || !referenceRead) throw new Error('A selected genome is no longer available. Select the genomes again.');
    if (queryRead.id !== selectedId || queryRead.accession !== accession || referenceRead.id !== referenceId
      || (queryRead.localGenome?.contentId ?? null) !== contentId) throw new Error('The loaded annotations do not match the selected sources.');
    if (!queryRead.genes?.length || !referenceRead.genes?.length) throw new Error('Both phages need gene annotations for synteny analysis');
    const query = structuredClone(queryRead), reference = structuredClone(referenceRead);
    let pfamMetadata: Record<string, unknown> | null = null;
    if ((!query.localGenome || !reference.localGenome) && repository.getAnnotationMeta) {
      try { pfamMetadata = await repository.getAnnotationMeta('pfam_domains'); } catch { /* A missing release is recorded as null. */ }
    }
    if (signal.aborted) throw cancelled();
    const descriptor = (phage: PhageFull) => ({ id: phage.id, name: phage.name, accession: phage.accession,
      length: phage.genomeLength, source: phage.localGenome ? 'local' : 'catalog',
      contentId: phage.localGenome?.contentId ?? null,
      annotationMetadata: phage.localGenome ? null : analysisJson(pfamMetadata) });
    return validateSyntenyInput({ query: descriptor(query), reference: descriptor(reference),
      genesQuery: query.genes, genesReference: reference.genes });
  })(), signal, timeoutMs);
}

export interface SyntenySnapshot {
  accepted: SyntenyExperiment | null;
  acceptedScope: object | null;
  activeScope: object | null;
  verified: boolean;
  busy: boolean;
  phase: string;
  error: string | null;
  notice: string | null;
}
export class SyntenySession {
  private active = false;
  private owner: { controller: AbortController; scope: object } | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SyntenySnapshot = { accepted: null, acceptedScope: null, activeScope: null, verified: false,
    busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => SyntenyWorker = defaultFactory,
    private readonly timeoutMs = 300000, private readonly readTimeoutMs = 30000) {}
  getSnapshot = (): SyntenySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<SyntenySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (scope?: object): void => {
    const owner = this.owner;
    if (!owner || scope && owner.scope !== scope) return;
    this.owner = null; owner.controller.abort();
    this.publish({ busy: false, activeScope: null, phase: '', notice: 'Synteny work cancelled; previous accepted evidence is unchanged.' });
  };
  run = async (scope: object, input: SyntenyRequest | ((signal: AbortSignal) => Promise<SyntenyRequest>)): Promise<boolean> => {
    if (!this.active) return false;
    this.cancel();
    const owner = { controller: new AbortController(), scope }; this.owner = owner;
    const signal = owner.controller.signal;
    const current = () => this.active && this.owner === owner && !signal.aborted;
    this.publish({ busy: true, activeScope: scope, phase: 'Reading exact annotation inputs', error: null, notice: null });
    try {
      const request = await readRequest(typeof input === 'function' ? input(signal) : Promise.resolve(structuredClone(input)), signal, this.readTimeoutMs);
      if (!current()) return false;
      const accepted = await runSyntenyTask(request, signal, this.timeoutMs, this.factory,
        phase => { if (current()) this.publish({ phase }); });
      if (!current()) return false;
      this.publish({ accepted, acceptedScope: scope, verified: request.kind === 'replay',
        notice: request.kind === 'replay' ? 'Saved annotations and complete result verified by fresh computation.' : 'Exact annotation comparison accepted.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : 'Synteny analysis failed.' });
      return false;
    } finally {
      if (current()) { this.owner = null; this.publish({ busy: false, activeScope: null, phase: '' }); }
    }
  };
}
