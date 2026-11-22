/** Disposable-worker ownership for private aligned-site calculations and fresh replay. */
import {
  COMPATIBILITY_LIMITS, COMPATIBILITY_METHOD, createCompatibilityExperiment, replayCompatibilityExperiment,
  validateCompatibilityInput, resolveCompatibilityOptions, isIncompatiblePair,
  type CompatibilityInput, type CompatibilityOptions, type CompatibilityExperiment,
} from '../../../core/src/analysis/alignment-compatibility';
import { analysisJson, serializeAnalysisRecord } from '../../../core/src/analysis-result';

export type AlignmentCompatibilityRequest =
  | { kind: 'analyze'; input: CompatibilityInput; options?: CompatibilityOptions }
  | { kind: 'replay'; content: string };
export interface AlignmentCompatibilityWork extends CompatibilityExperiment { verified: boolean }
export type AlignmentCompatibilityMessage = { kind: 'progress'; phase: string }
  | { kind: 'result'; value: AlignmentCompatibilityWork } | { kind: 'error'; message: string };
export interface AlignmentCompatibilityWorker {
  postMessage: (request: AlignmentCompatibilityRequest) => void; terminate: () => void;
  onmessage: ((event: MessageEvent<AlignmentCompatibilityMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export async function executeCompatibilityRequest(request: AlignmentCompatibilityRequest, progress: (phase: string) => void = () => {}): Promise<AlignmentCompatibilityWork> {
  if (request?.kind === 'replay') {
    progress('Checking saved identities and recomputing every eligible site pair');
    return { ...await replayCompatibilityExperiment(request.content), verified: true };
  }
  if (request?.kind !== 'analyze') throw new Error('Unsupported aligned-site compatibility operation.');
  progress('Validating exact aligned DNA and counting all four haplotypes for every eligible pair');
  return { ...await createCompatibilityExperiment(request.input, request.options), verified: false };
}
const abort = () => new DOMException('Aligned-site analysis cancelled', 'AbortError');
function abortable<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value?: T, error?: Error) => {
      if (settled) return; settled = true; clearTimeout(deadline); signal.removeEventListener('abort', stop);
      if (error) reject(error); else resolve(value!);
    };
    const stop = () => finish(undefined, abort());
    const deadline = setTimeout(() => finish(undefined, new Error('Local alignment or experiment read timed out. Retry the file import.')), timeoutMs);
    if (signal.aborted) { void promise.catch(() => {}); stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => finish(value), cause => finish(undefined, cause instanceof Error ? cause : new Error(String(cause))));
  });
}
export async function readCompatibilityFile(file: Pick<File, 'size' | 'arrayBuffer'>, signal: AbortSignal, maximum: number = COMPATIBILITY_LIMITS.recordBytes): Promise<string> {
  if (signal.aborted) throw abort();
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maximum) throw new Error('Local file is empty or exceeds the ' + maximum / (1024 * 1024) + ' MiB limit.');
  const buffer = await abortable(file.arrayBuffer(), signal);
  if (signal.aborted) throw abort();
  if (buffer.byteLength > maximum || buffer.byteLength !== file.size) throw new Error('Local file size changed or exceeds the permitted limit.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error('Local file must be valid UTF-8 text.'); }
}
/** The owned worker performs scientific computation and fresh replay. This
 * boundary checks render shape and source/result binding before publishing. */
function checkedWork(value: AlignmentCompatibilityWork, request: AlignmentCompatibilityRequest): AlignmentCompatibilityWork {
  if (!value || typeof value.verified !== 'boolean') throw new Error('Missing compatibility result.');
  const input = validateCompatibilityInput(value.input), result = value.result, record = value.record;
  if (!result || !Number.isSafeInteger(result.alignmentColumns) || result.alignmentColumns < 1 || result.alignmentColumns > COMPATIBILITY_LIMITS.columns) throw new Error('Invalid alignment dimensions.');
  const options = resolveCompatibilityOptions(value.options, result.alignmentColumns);
  const same = (left: unknown, right: unknown) => JSON.stringify(analysisJson(left)) === JSON.stringify(analysisJson(right));
  if (!same(options, result.options) || !Array.isArray(result.taxa) || result.taxa.length < 4 || result.taxa.length > COMPATIBILITY_LIMITS.taxa
      || result.taxa.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(id)) || new Set(result.taxa).size !== result.taxa.length
      || !Array.isArray(result.sites) || result.sites.length > COMPATIBILITY_LIMITS.eligibleSites || !Array.isArray(result.pairs)
      || !Array.isArray(result.warnings) || !result.warnings.length || result.warnings.some(warning => typeof warning !== 'string')) throw new Error('Invalid compatibility result shape.');
  const seen = new Set<number>();
  const column = (position: number) => {
    if (!Number.isSafeInteger(position) || position < options.start || position >= options.end || seen.has(position)) throw new Error('Invalid or duplicated alignment coordinate.');
    seen.add(position);
  };
  for (const [index, site] of result.sites.entries()) {
    if (!site || !Array.isArray(site.alleles) || site.alleles.length !== 2 || site.alleles.some(allele => typeof allele !== 'string' || !/^[ACGT]$/.test(allele))
      || site.alleles[0] >= site.alleles[1] || !Array.isArray(site.counts) || site.counts.length !== 2
      || site.counts.some(count => !Number.isSafeInteger(count) || count < 2) || site.counts[0] + site.counts[1] !== result.taxa.length
      || typeof site.assignments !== 'string' || site.assignments.length !== result.taxa.length || /[^01]/.test(site.assignments)
      || [...site.assignments].filter(allele => allele === '0').length !== site.counts[0]
      || index > 0 && result.sites[index - 1].column >= site.column) throw new Error('Invalid eligible-site evidence.');
    column(site.column);
  }
  for (const reason of ['missing', 'monomorphic', 'multiallelic', 'singleton'] as const) {
    if (!Array.isArray(result.excluded?.[reason])) throw new Error('Missing exclusion coverage.');
    for (const position of result.excluded[reason]) column(position);
  }
  if (seen.size !== options.end - options.start || result.pairs.length !== result.sites.length * (result.sites.length - 1) / 2) throw new Error('Incomplete site or pair coverage.');
  let pairIndex = 0, incompatible = 0;
  for (let left = 0; left < result.sites.length; left++) for (let right = left + 1; right < result.sites.length; right++) {
    const pair = result.pairs[pairIndex++];
    if (!Array.isArray(pair) || pair.length !== 6 || pair[0] !== left || pair[1] !== right || pair.slice(2).some(count => !Number.isSafeInteger(count) || count < 0)
      || pair.slice(2).reduce((sum, count) => sum + count, 0) !== result.taxa.length) throw new Error('Invalid pair haplotypes.');
    if (isIncompatiblePair(pair)) incompatible++;
  }
  if (!same(result.coverage, { selectedColumns: seen.size, completeColumns: seen.size - result.excluded.missing.length,
    eligibleColumns: result.sites.length, comparedPairs: result.pairs.length, incompatiblePairs: incompatible })
    || result.status !== (result.sites.length < 2 ? 'insufficient-sites' : incompatible ? 'incompatibility-observed' : 'no-incompatibility-observed')) throw new Error('Inconsistent compatibility summary.');
  serializeAnalysisRecord(record); // Includes every AnalysisRecordDetails render field.
  if (!same(record.method, COMPATIBILITY_METHOD) || record.seed !== null || record.inputs.length !== 1 || record.inputs[0].id !== 'alignment'
      || record.inputs[0].source !== input.source.kind || !same(record.inputs[0].data, input) || !same(record.parameters, options)
      || Object.keys(record.fields).length !== 1 || !same(record.fields.compatibility?.value, result)
      || record.fields.compatibility.kind !== (input.source.kind === 'demo' ? 'demo' : 'sequence-score')) throw new Error('Unbound compatibility result.');
  if (request.kind === 'analyze') {
    if (value.verified || !same(validateCompatibilityInput(request.input), input)
        || !same(resolveCompatibilityOptions(request.options, result.alignmentColumns), options)) throw new Error('Compatibility worker returned a different source or interval.');
  } else if (request.kind === 'replay') {
    if (!value.verified || typeof request.content !== 'string' || request.content.length > COMPATIBILITY_LIMITS.recordBytes
        || serializeAnalysisRecord(JSON.parse(request.content.replace(/^\uFEFF/, ''))) !== serializeAnalysisRecord(record)) throw new Error('Compatibility worker returned a different saved experiment.');
  } else throw new Error('Unsupported compatibility request.');
  return value;
}
export interface AlignmentCompatibilitySnapshot {
  accepted: AlignmentCompatibilityWork | null; busy: boolean; phase: string; error: string | null; notice: string | null;
}
export class AlignmentCompatibilitySession {
  private active = false;
  private operation: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: AlignmentCompatibilitySnapshot = { accepted: null, busy: false, phase: '', error: null, notice: null };
  constructor(private readonly factory: () => AlignmentCompatibilityWorker, private readonly readTimeoutMs = 30_000) {
    if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > 30_000) throw new Error('Read timeout must be 1–30,000 milliseconds.');
  }
  getSnapshot = (): AlignmentCompatibilitySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<AlignmentCompatibilitySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update }; for (const listener of this.listeners) listener();
  }
  activate = (): void => { this.active = true; };
  deactivate = (): void => { this.active = false; this.cancel(); };
  cancel = (): void => {
    const old = this.operation; this.operation = null; old?.abort();
    this.publish({ busy: false, phase: '', ...(old ? { notice: 'Aligned-site work cancelled; the previous accepted experiment was preserved.' } : {}) });
  };
  run = async (input: AlignmentCompatibilityRequest | ((signal: AbortSignal) => Promise<AlignmentCompatibilityRequest>)): Promise<boolean> => {
    if (!this.active) return false;
    // Capture direct inputs before cancellation can notify a mutable view subscriber.
    let captured: typeof input;
    try { captured = typeof input === 'function' ? input : structuredClone(input); }
    catch (cause) { this.cancel(); this.publish({ error: cause instanceof Error ? cause.message : String(cause) }); return false; }
    this.cancel(); const owner = new AbortController(); this.operation = owner;
    const current = () => this.active && this.operation === owner && !owner.signal.aborted;
    try {
      const pending = typeof captured === 'function' ? Promise.resolve().then(() => {
        if (!current()) throw abort(); return captured(owner.signal);
      }) : Promise.resolve(captured);
      const reading = abortable(pending.then(value => structuredClone(value)), owner.signal, this.readTimeoutMs);
      this.publish({ busy: true, phase: 'Reading exact local alignment or saved experiment', error: null, notice: null });
      const request = await reading;
      if (!current()) return false;
      const value = await new Promise<AlignmentCompatibilityWork>((resolve, reject) => {
        const worker = this.factory(); let done = false;
        const finish = (result?: AlignmentCompatibilityWork, error?: Error) => {
          if (done) return; done = true; clearTimeout(deadline); owner.signal.removeEventListener('abort', stop);
          worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
          try { worker.terminate(); } catch { /* Cancellation must settle even if provider cleanup throws. */ }
          if (error) reject(error); else resolve(result!);
        };
        const stop = () => finish(undefined, abort());
        const deadline = setTimeout(() => finish(undefined, new Error('Aligned-site worker timed out. Choose a smaller interval and retry.')), 120_000);
        owner.signal.addEventListener('abort', stop, { once: true });
        worker.onmessage = event => {
          if (done || !current()) return;
          try {
            const message = event.data;
            if (message?.kind === 'progress' && typeof message.phase === 'string') this.publish({ phase: message.phase });
            else if (message?.kind === 'result') finish(checkedWork(message.value, request));
            else if (message?.kind === 'error' && typeof message.message === 'string') finish(undefined, new Error(message.message));
            else finish(undefined, new Error('Unexpected aligned-site worker response.'));
          } catch { finish(undefined, new Error('Unexpected or unbound aligned-site worker response.')); }
        };
        worker.onerror = () => finish(undefined, new Error('Aligned-site worker failed; retry the local calculation.'));
        worker.onmessageerror = () => finish(undefined, new Error('Aligned-site worker response could not be read.'));
        try { if (owner.signal.aborted) stop(); else worker.postMessage(request); }
        catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      });
      if (!current()) return false;
      this.publish({ accepted: value, notice: value.verified
        ? 'Fresh aligned-site calculation matches the complete saved experiment. Verified replay.'
        : 'Exact aligned-site evidence calculated. Review coverage and the four haplotype counts.' });
      return true;
    } catch (cause) {
      if (current()) this.publish({ error: cause instanceof Error ? cause.message : String(cause) });
      return false;
    } finally {
      if (current()) { this.operation = null; owner.abort(); this.publish({ busy: false, phase: '' }); }
    }
  };
}
