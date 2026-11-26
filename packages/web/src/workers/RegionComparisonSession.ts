/** Source-owned exact interval comparisons, independent of the whole-genome metrics. */
import { analysisJson, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../../../core/src/analysis-result';
import { exportCatalogGenomeSnapshot, GENOME_IMPORT_LIMITS, type GenomeInput, type LocalGenome } from '../../../core/src/genome-import';
import type { PhageSummary } from '../../../core/src/types';
import {
  createRegionComparisonExperiment, replayRegionComparisonExperiment, exportRegionComparisonFasta, exportRegionComparisonTsv,
  REGION_COMPARISON_LIMITS, REGION_COMPARISON_METHOD, REGION_COMPARISON_REFERENCES,
  type RegionComparisonExperiment, type RegionComparisonOptions,
} from '../../../comparison/src/region-comparison-experiment';
import type { PhageRepository } from '../db';

export interface RegionComparisonScope {
  repository: Pick<PhageRepository, 'getPhageById' | 'getFullGenomeLength' | 'getSequenceWindow' | 'getOfflineDataset'> | null;
  phageA: PhageSummary | null;
  phageB: PhageSummary | null;
  localA: LocalGenome | null;
  localB: LocalGenome | null;
}
export type RegionComparisonRequest = {
  kind: 'analyze'; inputA: GenomeInput; inputB: GenomeInput; options: RegionComparisonOptions;
} | { kind: 'replay'; content: string };
export interface RegionComparisonWorkResult { experiment: RegionComparisonExperiment; verified: boolean }
export type RegionComparisonMessage = { kind: 'progress'; phase: string }
  | { kind: 'result'; value: RegionComparisonWorkResult } | { kind: 'error'; message: string };
export type RegionComparisonDownload = 'json' | 'tsv' | 'fasta';
export interface RegionComparisonWorker {
  postMessage(request: RegionComparisonRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RegionComparisonMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
interface RegionComparisonSnapshot {
  scope: RegionComparisonScope | null;
  accepted: RegionComparisonWorkResult | null;
  busy: boolean;
  phase: string;
  error: string | null;
  notice: string | null;
}
const abortError = () => new DOMException('Region comparison cancelled.', 'AbortError');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left: unknown, right: unknown) => JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right));
const integer = (value: unknown, maximum: number, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(row => typeof row === 'string');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function checkContent(content: unknown): asserts content is string {
  if (typeof content !== 'string' || content.length > REGION_COMPARISON_LIMITS.recordBytes
    || new TextEncoder().encode(content).length > REGION_COMPARISON_LIMITS.recordBytes) throw new Error('Region comparison input exceeds 10 MiB.');
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    void pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value); },
      error => { signal.removeEventListener('abort', cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}
function sourceIdentity(scope: RegionComparisonScope): string {
  const selected = (phage: PhageSummary | null) => phage ? {
    id: phage.id, accession: phage.accession, name: phage.name, genomeLength: phage.genomeLength, localGenome: phage.localGenome ?? null,
  } : null;
  return JSON.stringify(analysisJson({
    a: selected(scope.phageA), b: selected(scope.phageB),
    localA: scope.localA ? { id: scope.localA.phage.localGenome?.contentId, input: scope.localA.original } : null,
    localB: scope.localB ? { id: scope.localB.phage.localGenome?.contentId, input: scope.localB.original } : null,
  }));
}

/** Retain each complete accepted source input, with explicit record selection.
 * Catalog sources are captured as explicitly labelled snapshots with complete bases.
 */
export async function readRegionComparisonPair(scope: RegionComparisonScope, signal: AbortSignal):
Promise<{ inputA: GenomeInput; inputB: GenomeInput; recordA: string | null; recordB: string | null }> {
  if (signal.aborted) throw abortError();
  const selected = [
    { phage: structuredClone(scope.phageA), local: scope.localA ? {
      source: structuredClone(scope.localA.phage.localGenome), input: structuredClone(scope.localA.original),
    } : null },
    { phage: structuredClone(scope.phageB), local: scope.localB ? {
      source: structuredClone(scope.localB.phage.localGenome), input: structuredClone(scope.localB.original),
    } : null },
  ];
  const repository = scope.repository;
  const version = () => repository?.getOfflineDataset?.()?.describe().contentVersion ?? null;
  const contentVersion = version();
  const check = () => {
    if (signal.aborted) throw abortError();
    if (version() !== contentVersion) throw new Error('The catalog changed during region capture. Run the current selection again.');
  };
  const inputs = await Promise.all(selected.map(async ({ phage, local }, index) => {
    const label = index === 0 ? 'A' : 'B';
    if (!phage) throw new Error('Choose source genome ' + label + ' before comparing regions.');
    if (phage.localGenome) {
      if (!local || !local.source || local.source.contentId !== phage.localGenome.contentId
        || local.source.sequenceSha256 !== phage.localGenome.sequenceSha256) {
        throw new Error('The complete original input for source ' + label + ' is no longer available. Import it again.');
      }
      checkContent(local.input.text);
      return { input: local.input, record: phage.localGenome.contentId };
    }
    if (!repository) throw new Error('The catalog is unavailable. Import local sources or reopen a saved region comparison.');
    const loaded = await abortable(repository.getPhageById(phage.id), signal); check();
    if (!loaded || loaded.localGenome || loaded.id !== phage.id || loaded.accession !== phage.accession
      || loaded.genomeLength !== phage.genomeLength) throw new Error('The loaded catalog source ' + label + ' differs from the selected genome.');
    const captured = structuredClone(loaded);
    const length = await abortable(repository.getFullGenomeLength(captured.id), signal); check();
    if (!integer(length, GENOME_IMPORT_LIMITS.bases, 1) || captured.genomeLength !== length) {
      throw new Error('Catalog region comparison requires the complete declared source, within 5,000,000 bases.');
    }
    const sequence = await abortable(repository.getSequenceWindow(captured.id, 0, length), signal); check();
    if (sequence.length !== length) throw new Error('The complete catalog sequence could not be captured for source ' + label + '.');
    const input = await abortable(exportCatalogGenomeSnapshot(captured, sequence, { contentVersion }), signal); check();
    return { input, record: null };
  }));
  check();
  return { inputA: inputs[0].input, inputB: inputs[1].input, recordA: inputs[0].record, recordB: inputs[1].record };
}

export async function executeRegionComparisonRequest(request: RegionComparisonRequest,
  progress: (phase: string) => void = () => {}): Promise<RegionComparisonWorkResult> {
  if (request?.kind === 'analyze') {
    progress('Reparsing both original sources and aligning the selected strands');
    return { experiment: await createRegionComparisonExperiment(request.inputA, request.inputB, request.options), verified: false };
  }
  if (request?.kind === 'replay') {
    checkContent(request.content);
    progress('Recomputing the saved source regions and complete alignment');
    return { experiment: await replayRegionComparisonExperiment(request.content.replace(/^\uFEFF/, '')), verified: true };
  }
  throw new Error('Unsupported region comparison operation.');
}

/** Validate transport, record identity and coordinate/render shape. Numerical
 * recomputation stays in the owned worker, including every standalone replay.
 */
async function validateReply(value: RegionComparisonWorkResult, request: RegionComparisonRequest,
  saved: AnalysisRecord | null): Promise<RegionComparisonWorkResult> {
  const invalid = (): never => { throw new Error('Region comparison worker returned inconsistent source or alignment evidence.'); };
  if (!object(value) || value.verified !== (request.kind === 'replay') || !object(value.experiment)) invalid();
  const experiment = value.experiment, { inputA, inputB, options, result } = experiment;
  if (!object(options) || !object(result)) invalid();
  const record = await parseAnalysisRecord(serializeAnalysisRecord(experiment.record),
    { methodId: REGION_COMPARISON_METHOD.id, methodVersion: REGION_COMPARISON_METHOD.version });
  if (!same(record.method, REGION_COMPARISON_METHOD) || !same(record.references, REGION_COMPARISON_REFERENCES)
    || record.seed !== null || record.inputs.length !== 2 || !same(record.parameters, options)
    || record.fields.comparison?.kind !== 'sequence-score' || record.fields.comparison.units !== 'records'
    || !same(record.fields.comparison.value, result)) invalid();
  const sides = [
    { input: inputA, source: result.sourceA, region: result.regionA, selected: options.regionA, record: options.recordA },
    { input: inputB, source: result.sourceB, region: result.regionB, selected: options.regionB, record: options.recordB },
  ];
  for (const [i, side] of sides.entries()) {
    const { input, source, region, selected } = side, stored = record.inputs[i];
    if (!object(input) || typeof input.name !== 'string' || typeof input.text !== 'string'
      || !object(source) || typeof source.name !== 'string' || typeof source.accession !== 'string'
      || !digest(source.contentId) || !digest(source.sequenceSha256)
      || !integer(source.genomeLength, GENOME_IMPORT_LIMITS.bases, 1)
      || !['fasta', 'genbank', 'catalog-snapshot'].includes(source.format)
      || !['linear', 'circular', 'unknown'].includes(source.topology)
      || side.record !== source.contentId || !object(region) || !object(selected)
      || !integer(region.start, source.genomeLength) || !integer(region.end, source.genomeLength, region.start + 1)
      || region.end - region.start > REGION_COMPARISON_LIMITS.regionBases || !['+', '-'].includes(region.strand)
      || typeof region.sequence !== 'string' || region.sequence.length !== region.end - region.start
      || /[^ACGTRYSWKMBDHVN]/.test(region.sequence)
      || !same(selected, { start: region.start, end: region.end, strand: region.strand })
      || stored.id !== (i === 0 ? 'genomeA' : 'genomeB') || stored.source !== 'local'
      || stored.accession !== source.accession || !same(stored.data, input)) invalid();
  }
  if (request.kind === 'analyze') {
    if (!same(inputA, request.inputA) || !same(inputB, request.inputB)
      || !same(options.regionA, request.options.regionA) || !same(options.regionB, request.options.regionB)
      || request.options.recordA != null && options.recordA !== request.options.recordA
      || request.options.recordB != null && options.recordB !== request.options.recordB) invalid();
  } else if (!saved || record.resultId !== saved.resultId || record.cacheKey !== saved.cacheKey) invalid();
  const { stats, runs, alignedA, alignedB } = result, n = result.regionA.sequence.length, m = result.regionB.sequence.length;
  if (!object(stats) || !(['lengthA', 'lengthB', 'alignmentColumns', 'matches', 'substitutions', 'insertions',
    'deletions', 'distance', 'ambiguousColumns'] as const).every(key => integer(stats[key], n + m))
    || stats.lengthA !== n || stats.lengthB !== m || typeof stats.identity !== 'number' || !Number.isFinite(stats.identity)
    || typeof alignedA !== 'string' || typeof alignedB !== 'string' || alignedA.length !== alignedB.length
    || alignedA.length !== stats.alignmentColumns || /[^ACGTRYSWKMBDHVN-]/.test(alignedA + alignedB)
    || alignedA.replace(/-/g, '') !== result.regionA.sequence || alignedB.replace(/-/g, '') !== result.regionB.sequence
    || !Array.isArray(runs) || !runs.length || !strings(result.annotationWarnings) || !strings(result.limitations)) invalid();
  const sourceInterval = (start: number, end: number, side: typeof result.regionA) =>
    side.strand === '+' ? [side.start + start, side.start + end] : [side.end - end, side.end - start];
  let endA = 0, endB = 0;
  for (const run of runs) {
    if (!object(run) || !['match', 'substitution', 'insertion', 'deletion'].includes(run.operation)
      || run.startA !== endA || run.startB !== endB || !integer(run.endA, n, endA) || !integer(run.endB, m, endB)
      || !same([run.sourceStartA, run.sourceEndA], sourceInterval(run.startA, run.endA, result.regionA))
      || !same([run.sourceStartB, run.sourceEndB], sourceInterval(run.startB, run.endB, result.regionB))) invalid();
    const lengthA = run.endA - run.startA, lengthB = run.endB - run.startB;
    if (run.operation === 'insertion' ? lengthA !== 0 || lengthB < 1
      : run.operation === 'deletion' ? lengthA < 1 || lengthB !== 0 : lengthA < 1 || lengthA !== lengthB) invalid();
    endA = run.endA; endB = run.endB;
  }
  if (endA !== n || endB !== m) invalid();
  for (const [annotations, region, source] of [
    [result.annotationsA, result.regionA, result.sourceA], [result.annotationsB, result.regionB, result.sourceB],
  ] as const) {
    if (!Array.isArray(annotations) || annotations.length > REGION_COMPARISON_LIMITS.annotationRows) invalid();
    for (const annotation of annotations) {
      if (!object(annotation) || !object(annotation.gene)) invalid();
      const gene = annotation.gene;
      if (!Number.isSafeInteger(gene.id)
        || !(['name', 'locusTag', 'product', 'type'] as const).every(key => gene[key] === null || typeof gene[key] === 'string')
        || typeof annotation.fullyContained !== 'boolean' || !Array.isArray(annotation.segments) || !annotation.segments.length) invalid();
      for (const segment of annotation.segments) if (!object(segment)
        || !integer(segment.sourceStart, source.genomeLength) || !integer(segment.sourceEnd, source.genomeLength, segment.sourceStart + 1)
        || !integer(segment.regionStart, region.sequence.length) || !integer(segment.regionEnd, region.sequence.length, segment.regionStart + 1)
        || !same([segment.sourceStart, segment.sourceEnd], sourceInterval(segment.regionStart, segment.regionEnd, region))
        || ![null, '+', '-'].includes(segment.sourceStrand) || ![null, '+', '-'].includes(segment.regionStrand)) invalid();
    }
  }
  return value;
}

/** One session owns capture, worker, replay and downloads. A cancelled or failed
 * replacement leaves the previous result intact; changing sources revokes it.
 */
export class RegionComparisonSession {
  private active = false;
  private scope: RegionComparisonScope | null = null;
  private operation: AbortController | null = null;
  private acceptedIdentity: string | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: RegionComparisonSnapshot = { scope: null, accepted: null, busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => RegionComparisonWorker, private readonly timeoutMs = 300000) {}
  getSnapshot = (): RegionComparisonSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<RegionComparisonSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener();
  }
  activate = (): void => { if (!this.active) { this.active = true; this.publish({}); } };
  deactivate = (): void => { this.active = false; this.cancel(); };
  setScope = (scope: RegionComparisonScope): void => {
    if (this.scope === scope) return;
    this.cancel(); this.scope = scope; this.acceptedIdentity = null;
    this.publish({ scope, accepted: null, error: null, notice: null });
  };
  cancel = (): void => {
    const owner = this.operation; this.operation = null; owner?.abort();
    this.publish({ busy: false, phase: '', ...(owner ? { notice: this.snapshot.accepted
      ? 'Region comparison cancelled. Previous accepted evidence preserved.' : 'Region comparison cancelled. No partial result accepted.' } : {}) });
  };
  getAccepted = (scope: RegionComparisonScope): RegionComparisonWorkResult | null =>
    this.active && this.scope === scope && this.snapshot.scope === scope ? this.snapshot.accepted : null;
  export = (scope: RegionComparisonScope, kind: RegionComparisonDownload): { content: string; filename: string; mimeType: string } | null => {
    const accepted = this.getAccepted(scope);
    if (!accepted || this.snapshot.busy || sourceIdentity(scope) !== this.acceptedIdentity) return null;
    const experiment = accepted.experiment, stem = 'phage-region-' + experiment.record.resultId.slice(0, 12);
    if (kind === 'json') return { content: serializeAnalysisRecord(experiment.record), filename: stem + '.json', mimeType: 'application/json' };
    if (kind === 'tsv') return { content: exportRegionComparisonTsv(experiment), filename: stem + '.tsv', mimeType: 'text/tab-separated-values' };
    if (kind === 'fasta') return { content: exportRegionComparisonFasta(experiment), filename: stem + '.fasta', mimeType: 'text/plain' };
    throw new Error('Unsupported region comparison download format.');
  };
  analyze = (scope: RegionComparisonScope, regions: Pick<RegionComparisonOptions, 'regionA' | 'regionB'>): Promise<boolean> => {
    const captured = structuredClone(regions);
    return this.run(scope, async signal => {
      const pair = await readRegionComparisonPair(scope, signal);
      return { kind: 'analyze', inputA: pair.inputA, inputB: pair.inputB,
        options: { ...captured, recordA: pair.recordA, recordB: pair.recordB } };
    });
  };
  replay = (scope: RegionComparisonScope, content: string | ((signal: AbortSignal) => Promise<string>)): Promise<boolean> =>
    this.run(scope, async signal => ({ kind: 'replay', content: typeof content === 'function' ? await content(signal) : content }));
  private async run(scope: RegionComparisonScope, build: (signal: AbortSignal) => Promise<RegionComparisonRequest>): Promise<boolean> {
    if (!this.active || this.scope !== scope) return false;
    let identity: string;
    try {
      if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('Region comparison timeout must be a positive integer.');
      identity = sourceIdentity(scope);
    } catch (cause) { this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
    this.cancel();
    if (!this.active || this.scope !== scope) return false;
    const owner = new AbortController(); this.operation = owner;
    const owns = () => this.active && this.scope === scope && this.operation === owner;
    const current = () => owns() && !owner.signal.aborted;
    const checkSource = () => {
      if (sourceIdentity(scope) !== identity) throw new Error('The selected source changed during capture. Run the current selection again.');
    };
    let expired = false;
    const timer = setTimeout(() => { if (owns()) { expired = true; owner.abort(); } }, this.timeoutMs);
    try {
      this.publish({ busy: true, phase: 'Reading exact source inputs', error: null, notice: null });
      if (!current()) return false;
      checkSource();
      const request = structuredClone(await abortable(build(owner.signal), owner.signal));
      if (!current()) return false;
      checkSource();
      let saved: AnalysisRecord | null = null;
      if (request.kind === 'replay') {
        checkContent(request.content);
        saved = await abortable(parseAnalysisRecord(request.content.replace(/^\uFEFF/, ''),
          { methodId: REGION_COMPARISON_METHOD.id, methodVersion: REGION_COMPARISON_METHOD.version }), owner.signal);
      }
      if (!current()) return false;
      const value = await new Promise<RegionComparisonWorkResult>((resolve, reject) => {
        const worker = this.factory(); let done = false, validating = false;
        const finish = (result?: RegionComparisonWorkResult, error?: Error) => {
          if (done) return; done = true;
          owner.signal.removeEventListener('abort', cancel);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* Publication ownership is still relinquished. */ }
          if (error) reject(error); else resolve(result!);
        };
        const cancel = () => finish(undefined, abortError());
        owner.signal.addEventListener('abort', cancel, { once: true });
        worker.onmessage = event => {
          if (done || validating || !current()) return;
          const message = event.data;
          try {
            if (message?.kind === 'progress' && typeof message.phase === 'string') { this.publish({ phase: message.phase }); return; }
            if (message?.kind === 'error' && typeof message.message === 'string') { finish(undefined, new Error(message.message)); return; }
            if (message?.kind !== 'result') throw new Error('Unexpected region comparison worker response.');
            const captured = structuredClone(message.value); validating = true;
            void validateReply(captured, request, saved).then(result => {
              if (!done && current()) { checkSource(); finish(result); }
            }).catch(cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
          } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
        };
        worker.onerror = () => finish(undefined, new Error('The region comparison worker failed. Run again to retry.'));
        worker.onmessageerror = () => finish(undefined, new Error('The region comparison worker response could not be read.'));
        try { if (owner.signal.aborted) cancel(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      checkSource(); this.acceptedIdentity = identity;
      this.publish({ accepted: value, notice: value.verified
        ? 'Saved source regions, strands and complete alignment verified by fresh computation.'
        : 'Exact source-region alignment complete. Accepted coordinates and exports belong to these captured sources.' });
      return true;
    } catch (cause) {
      if (owns()) this.publish({ error: expired ? 'Region comparison timed out. Choose shorter intervals or retry.'
        : cause instanceof Error ? cause.message : String(cause),
      notice: this.snapshot.accepted ? 'Previous accepted evidence preserved.' : 'No new comparison was accepted.' });
      return false;
    } finally {
      clearTimeout(timer); owner.abort();
      if (owns()) { this.operation = null; this.publish({ busy: false, phase: '' }); }
    }
  }
}
